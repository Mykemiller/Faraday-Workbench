/* Workbench Admin tab · subscriber and product management.
 *
 * Moved here from the League Office (/league-office/subscribers). Gated like the
 * other Workbench routes: shared secret in WORKBENCH_REFRESH_SECRET, sent as
 * x-workbench-key, fail-closed when unset. Reads and writes use the service key
 * held server-side; the browser never sees it.
 *
 *   GET                       -> { subscribers[], plans[] }
 *   GET  ?id=<uuid>           -> { subscriber, teams[], access, plans[], audit[] }
 *   POST { action, subscriberId, reason, tier? }
 *        action: 'pause' | 'rejoin' | 'set_tier'
 *
 * Every write adds one lo_audit_log row (domain 'subscribers'), so the League
 * Office Audit Log keeps showing the history it always showed.
 *
 * "Products" today means Live Agent access: live_agent_plan (tiers) and
 * live_agent_token_ledger (one row per subscriber). Mailing lists have no table
 * yet and are deliberately not faked here.
 */
'use strict';

const { refuseUnlessKeyed, sb, readJson } = require('./_wb.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['pause', 'rejoin', 'set_tier']);
const SUB_COLS = 'id,email,handle,active,play_streak,last_seen_at,created_at';

/** Distinct teams per subscriber. team_memberships is season-keyed (one row per
 *  subscriber, team and season), so counting rows over-counts anyone who stayed
 *  on a team across seasons. */
function teamCounts(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    if (!seen.has(r.subscriber_id)) seen.set(r.subscriber_id, new Set());
    seen.get(r.subscriber_id).add(r.team_id);
  }
  const out = {};
  for (const [id, set] of seen) out[id] = set.size;
  return out;
}

/** Pure validation of a write request. Returns { error } or { ok, ... }. */
function parseAction(body, plans) {
  const action = String(body.action || '');
  const subscriberId = String(body.subscriberId || '');
  const reason = String(body.reason || '').trim();
  if (!ACTIONS.has(action)) return { error: 'action must be pause, rejoin or set_tier' };
  if (!UUID.test(subscriberId)) return { error: 'subscriberId must be a uuid' };
  if (!reason) return { error: 'A reason is required.' };
  if (reason.length > 500) return { error: 'reason must be 500 characters or fewer' };
  if (action === 'set_tier') {
    const tier = String(body.tier || '');
    if (!(plans || []).some((p) => p.tier === tier)) return { error: 'Unknown tier: ' + (tier || '(none)') };
    return { ok: true, action, subscriberId, reason, tier };
  }
  return { ok: true, action, subscriberId, reason };
}

async function rest(path, key, init) {
  const r = await sb('/rest/v1/' + path, key, init);
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((j && (j.message || j.hint)) || 'HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
  return j;
}

async function audit(key, row) {
  await rest('lo_audit_log', key, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ staff_email: 'workbench', domain: 'subscribers', target_type: 'dc_subscriber', reversible: true, ...row })
  });
}

async function listPlans(key) {
  return rest('live_agent_plan?select=tier,entitled,monthly_tokens&order=monthly_tokens.asc', key);
}

async function handleGet(req, res, key) {
  const id = req.query && req.query.id;
  const plans = await listPlans(key);
  if (!id) {
    const [subs, mem, ledger] = await Promise.all([
      rest(`dc_subscribers?select=${SUB_COLS}&order=created_at.desc`, key),
      rest('team_memberships?select=subscriber_id,team_id&pending=is.false', key),
      rest('live_agent_token_ledger?select=subscriber_id,tier', key)
    ]);
    const counts = teamCounts(mem);
    const tiers = Object.fromEntries(ledger.map((l) => [l.subscriber_id, l.tier]));
    return res.status(200).json({
      subscribers: subs.map((s) => ({ ...s, teams: counts[s.id] || 0, tier: tiers[s.id] || 'free' })),
      plans
    });
  }
  if (!UUID.test(String(id))) return res.status(400).json({ error: 'id must be a uuid' });
  const [subs, mem, teams, ledger, log] = await Promise.all([
    rest(`dc_subscribers?id=eq.${id}&select=${SUB_COLS}`, key),
    rest(`team_memberships?subscriber_id=eq.${id}&select=team_id,pending`, key),
    rest('teams?select=id,name,captain_id', key),
    rest(`live_agent_token_ledger?subscriber_id=eq.${id}&select=tier,balance,cycle_month`, key),
    rest(`lo_audit_log?target_id=eq.${id}&domain=eq.subscribers&select=at,action,reason,staff_email&order=at.desc&limit=10`, key)
  ]);
  if (!subs.length) return res.status(404).json({ error: 'No subscriber with that id' });
  const names = new Map(teams.map((t) => [t.id, t]));
  const seen = new Set();
  const myTeams = [];
  for (const m of mem) {
    if (seen.has(m.team_id)) continue;
    seen.add(m.team_id);
    const t = names.get(m.team_id);
    myTeams.push({ name: t ? t.name : '—', captain: !!(t && t.captain_id === id), pending: !!m.pending });
  }
  const l = ledger[0] || null;
  return res.status(200).json({
    subscriber: subs[0],
    teams: myTeams,
    access: { liveAgent: l ? { tier: l.tier, balance: l.balance, cycle: l.cycle_month } : { tier: 'free', balance: 0, cycle: null } },
    plans,
    audit: log
  });
}

async function handlePost(req, res, key) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const plans = await listPlans(key);
  const p = parseAction(body, plans);
  if (p.error) return res.status(400).json({ error: p.error });

  if (p.action === 'pause' || p.action === 'rejoin') {
    const active = p.action === 'rejoin';
    const before = await rest(`dc_subscribers?id=eq.${p.subscriberId}&select=active`, key);
    if (!before.length) return res.status(404).json({ error: 'No subscriber with that id' });
    await rest(`dc_subscribers?id=eq.${p.subscriberId}`, key, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ active })
    });
    await audit(key, { action: 'subscriber.' + p.action, target_id: p.subscriberId, reason: p.reason, before: before[0], after: { active } });
    return res.status(200).json({ ok: true, message: active ? 'Account reinstated.' : 'Account paused.' });
  }

  // set_tier: upsert the Live Agent ledger row. A brand-new row is seeded with the
  // plan's monthly grant; an existing balance is left alone and rolls on the
  // normal monthly cycle (live_agent_debit owns balance math).
  const exists = await rest(`dc_subscribers?id=eq.${p.subscriberId}&select=id`, key);
  if (!exists.length) return res.status(404).json({ error: 'No subscriber with that id' });
  const cur = await rest(`live_agent_token_ledger?subscriber_id=eq.${p.subscriberId}&select=tier,balance`, key);
  const plan = plans.find((x) => x.tier === p.tier);
  const before = cur[0] ? { tier: cur[0].tier } : { tier: 'free' };
  if (before.tier === p.tier && cur[0]) return res.status(200).json({ ok: true, message: 'Already on ' + p.tier + '.' });
  if (cur[0]) {
    await rest(`live_agent_token_ledger?subscriber_id=eq.${p.subscriberId}`, key, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ tier: p.tier, updated_at: new Date().toISOString() })
    });
  } else {
    await rest('live_agent_token_ledger', key, {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ subscriber_id: p.subscriberId, tier: p.tier, balance: plan.monthly_tokens })
    });
  }
  await audit(key, { action: 'subscriber.set_live_agent_tier', target_id: p.subscriberId, reason: p.reason, before, after: { tier: p.tier } });
  return res.status(200).json({ ok: true, message: 'Live Agent tier set to ' + p.tier + '.' });
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseUnlessKeyed(req, res)) return;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set on this deployment.' });
  try {
    return req.method === 'GET' ? await handleGet(req, res, key) : await handlePost(req, res, key);
  } catch (e) {
    return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message });
  }
}

module.exports = handler;
module.exports.teamCounts = teamCounts;
module.exports.parseAction = parseAction;
