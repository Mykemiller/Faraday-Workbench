/* Workbench Admin tab · ISpyaDC access (FDY-42).
 *
 * All ISpyaDC user management happens here. The table of record is
 * public.ispyadc_access in ISpyaDC's OWN Supabase project (not the Faraday
 * estate project the other routes talk to), reached through two server-only
 * variables on the workbench deployment:
 *
 *   ISPYADC_SUPABASE_URL        e.g. https://<ref>.supabase.co
 *   ISPYADC_SERVICE_ROLE_KEY    service role key for that project
 *
 * Gated like every other Workbench route: shared secret in
 * WORKBENCH_REFRESH_SECRET, sent as x-workbench-key, fail-closed when unset.
 * When the two ISpyaDC variables are missing the route answers
 * { configured: false, missing: [names] } so the page can say so — no crash,
 * no secret in the message. Nothing here sets those values.
 *
 *   GET                       -> { configured, grants[], audit[] }   (audit = last 50)
 *   POST { action, actor, email?, id?, role?, expiresAt?, note? }
 *        action: 'add' | 'set_role' | 'set_expiry' | 'revoke' | 'restore'
 *
 * Every write also inserts one ispyadc_access_audit row with the operator's
 * email as actor. The Workbench has no sign-in of its own (the key is shared),
 * so the actor is the "Acting as" email the operator types on the page; it is
 * validated as an email and recorded as given.
 */
'use strict';

const { refuseUnlessKeyed, readJson } = require('./_wb.js');

const ACTIONS = new Set(['add', 'set_role', 'set_expiry', 'revoke', 'restore']);
const ROLES = new Set(['admin', 'tester', 'user']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TESTER_DEFAULT_DAYS = 14;
const GRANT_COLS = 'id,email,role,status,expires_at,note,added_by,created_at,updated_at';

/* ---- pure helpers (unit-tested) ---------------------------------------- */

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL.test(email) && email.length <= 254;
}

/** YYYY-MM-DD, `days` after `today` (UTC date arithmetic). */
function addDays(today, days) {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Default expiry for a new grant: testers get 14 days; everyone else none. */
function defaultExpiry(role, today) {
  return role === 'tester' ? addDays(today, TESTER_DEFAULT_DAYS) : null;
}

/** A YYYY-MM-DD expiry means "end of that day, UTC"; null/'' means no expiry. */
function expiryToTimestamp(dateOrNull) {
  if (dateOrNull === null || dateOrNull === undefined || dateOrNull === '') return null;
  const s = String(dateOrNull);
  if (!DATE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return undefined; // invalid
  return s + 'T23:59:59Z';
}

/** What the page shows for a grant right now. */
function grantState(g, now) {
  if (g.status === 'revoked') return 'revoked';
  if (g.expires_at && Date.parse(g.expires_at) <= now.getTime()) return 'expired';
  return 'active';
}

/** Pure validation of a write request. Returns { error } or { ok, ... }. */
function parseWrite(body, today) {
  const action = String(body.action || '');
  const actor = normalizeEmail(body.actor);
  if (!ACTIONS.has(action)) return { error: 'action must be add, set_role, set_expiry, revoke or restore' };
  if (!isValidEmail(actor)) return { error: 'actor must be the email address you are acting as' };
  const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, 500) || null;

  if (action === 'add') {
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return { error: 'That does not look like an email address.' };
    const role = String(body.role || '');
    if (!ROLES.has(role)) return { error: 'role must be admin, tester or user' };
    // Omitted expiry = the role's default (14 days for a tester, none otherwise);
    // an explicit empty string = no expiry.
    const date = body.expiresAt === undefined ? defaultExpiry(role, today) : body.expiresAt;
    const expiresAt = expiryToTimestamp(date);
    if (expiresAt === undefined) return { error: 'expiresAt must be a date (YYYY-MM-DD) or empty' };
    return { ok: true, action, actor, email, role, expiresAt, note };
  }

  const id = String(body.id || '');
  if (!UUID.test(id)) return { error: 'id must be a uuid' };
  if (action === 'set_role') {
    const role = String(body.role || '');
    if (!ROLES.has(role)) return { error: 'role must be admin, tester or user' };
    return { ok: true, action, actor, id, role, note };
  }
  if (action === 'set_expiry') {
    const expiresAt = expiryToTimestamp(body.expiresAt);
    if (expiresAt === undefined) return { error: 'expiresAt must be a date (YYYY-MM-DD) or empty to clear' };
    return { ok: true, action, actor, id, expiresAt, note };
  }
  return { ok: true, action, actor, id, note };
}

/* ---- ISpyaDC project client -------------------------------------------- */

function ispyConfig(env) {
  const missing = [];
  if (!env.ISPYADC_SUPABASE_URL) missing.push('ISPYADC_SUPABASE_URL');
  if (!env.ISPYADC_SERVICE_ROLE_KEY) missing.push('ISPYADC_SERVICE_ROLE_KEY');
  if (missing.length) return { configured: false, missing };
  return { configured: true, url: String(env.ISPYADC_SUPABASE_URL).replace(/\/+$/, ''), key: env.ISPYADC_SERVICE_ROLE_KEY };
}

async function rest(cfg, path, init) {
  const r = await fetch(`${cfg.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      ...(init && init.headers)
    }
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((j && (j.message || j.hint)) || 'HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
  return j;
}

async function audit(cfg, row) {
  await rest(cfg, 'ispyadc_access_audit', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row)
  });
}

const pick = (g) => (g ? { role: g.role, status: g.status, expires_at: g.expires_at, note: g.note } : null);

async function handleGet(res, cfg) {
  const [grants, auditRows] = await Promise.all([
    rest(cfg, `ispyadc_access?select=${GRANT_COLS}&order=created_at.desc`),
    rest(cfg, 'ispyadc_access_audit?select=id,email,action,old_value,new_value,actor,at&order=at.desc&limit=50')
  ]);
  const now = new Date();
  return res.status(200).json({
    configured: true,
    grants: grants.map((g) => ({ ...g, state: grantState(g, now) })),
    audit: auditRows
  });
}

async function handlePost(req, res, cfg) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const today = new Date().toISOString().slice(0, 10);
  const p = parseWrite(body, today);
  if (p.error) return res.status(400).json({ error: p.error });

  if (p.action === 'add') {
    const dup = await rest(cfg, `ispyadc_access?email=eq.${encodeURIComponent(p.email)}&select=${GRANT_COLS}`);
    if (dup.length) {
      const d = dup[0];
      return res.status(409).json({ error: `${p.email} already has a grant (${d.role}, ${grantState(d, new Date())}). Edit, restore or revoke that row instead.` });
    }
    const row = { email: p.email, role: p.role, status: 'active', expires_at: p.expiresAt, note: p.note, added_by: p.actor };
    const ins = await rest(cfg, 'ispyadc_access', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row)
    });
    const created = ins[0] || row;
    await audit(cfg, { email: p.email, action: 'add', old_value: null, new_value: pick(created), actor: p.actor });
    return res.status(200).json({ ok: true, message: `Added ${p.email} as ${p.role}${p.expiresAt ? ' until ' + p.expiresAt.slice(0, 10) : ''}.` });
  }

  const cur = await rest(cfg, `ispyadc_access?id=eq.${p.id}&select=${GRANT_COLS}`);
  if (!cur.length) return res.status(404).json({ error: 'No grant with that id' });
  const before = cur[0];
  let patch, action, message;
  if (p.action === 'set_role') {
    if (before.role === p.role) return res.status(200).json({ ok: true, message: `${before.email} is already ${p.role}.` });
    patch = { role: p.role }; action = 'update'; message = `${before.email} is now ${p.role}.`;
  } else if (p.action === 'set_expiry') {
    patch = { expires_at: p.expiresAt }; action = 'update';
    message = p.expiresAt ? `${before.email} now expires ${p.expiresAt.slice(0, 10)}.` : `${before.email} no longer expires.`;
  } else if (p.action === 'revoke') {
    if (before.status === 'revoked') return res.status(200).json({ ok: true, message: `${before.email} is already revoked.` });
    patch = { status: 'revoked' }; action = 'revoke'; message = `Revoked ${before.email}.`;
  } else {
    if (before.status === 'active') return res.status(200).json({ ok: true, message: `${before.email} is already active.` });
    patch = { status: 'active' }; action = 'restore'; message = `Restored ${before.email}.`;
  }
  if (p.note !== null) patch.note = p.note;
  const upd = await rest(cfg, `ispyadc_access?id=eq.${p.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  const after = upd[0] || { ...before, ...patch };
  await audit(cfg, { email: before.email, action, old_value: pick(before), new_value: pick(after), actor: p.actor });
  return res.status(200).json({ ok: true, message });
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseUnlessKeyed(req, res)) return;
  const cfg = ispyConfig(process.env);
  if (!cfg.configured) {
    // Not an error: the page renders a clear "not configured" state. Names only.
    return res.status(200).json({ configured: false, missing: cfg.missing, grants: [], audit: [] });
  }
  try {
    return req.method === 'GET' ? await handleGet(res, cfg) : await handlePost(req, res, cfg);
  } catch (e) {
    return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 502).json({ error: e.message });
  }
}

module.exports = handler;
module.exports.normalizeEmail = normalizeEmail;
module.exports.isValidEmail = isValidEmail;
module.exports.defaultExpiry = defaultExpiry;
module.exports.expiryToTimestamp = expiryToTimestamp;
module.exports.grantState = grantState;
module.exports.parseWrite = parseWrite;
module.exports.ispyConfig = ispyConfig;
module.exports.TESTER_DEFAULT_DAYS = TESTER_DEFAULT_DAYS;
