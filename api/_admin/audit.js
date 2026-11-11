/* /api/admin/audit (FDY-287, FDY-292 ADM-1.5). Owner only. The audit timeline.
 *
 *   GET   ?actor= &app= &person= &setting= &source=admin|league_office &before=<iso>
 *         admin_audit and lo_audit_log merged, newest first, 100 per page (`next` = the cursor for older rows).
 *         Every row carries before, after and the optional reason, and says whether it can be reverted.
 *   POST  { id: 'a:<admin_audit id>', reason?, linearIssue? }   revert
 *         A revert is a NEW change made through the audited function that made the original, so it writes a
 *         NEW audit row. History is never edited. It runs only while the current state still equals what the
 *         row left behind. Irreversible rows, and League Office rows, refuse with 409.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const { requireFresh } = require('../_auth.js');
const A = require('./audit-logic.js');

const COLS = 'id,at,actor,actor_verified,product,subject_email,action,reason,old_value,new_value,via';
const LO_COLS = 'id,at,staff_email,domain,action,reason,target_type,target_id,before,after,reversible,reverts_id,reverted_by';
const PAGE = 100, FETCH = PAGE + 1;   // one more than a page, to know whether older rows exist (the top 100 of two logs is inside the top 100 of each)
const enc = encodeURIComponent;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function read(path, key) {
  const r = await sb('/rest/v1/' + path, key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = r.status; throw e; }
  return j;
}

async function list(req, res, ctx) {
  const f = A.parseFilters(req.query || {});
  if (f.error) return res.status(400).json({ error: f.error });

  // admin_audit side
  let admin = [], adminNone = false;
  if (f.source !== 'league_office') {
    let p = `admin_audit?select=${COLS}&order=at.desc&limit=${FETCH}`;
    if (f.app) p += `&product=eq.${enc(f.app)}`;
    if (f.person) p += `&subject_email=ilike.${enc('*' + f.person + '*')}`;
    if (f.setting) p += '&action=eq.app.setting';
    if (f.before) p += `&at=lt.${enc(f.before)}`;
    if (f.actor) {
      if (EMAIL.test(f.actor)) {   // admin_audit stores a person id; find the person this address is
        let ids = [];
        try { ids = (await read(`estate_people?select=id,email&email_normalised=eq.${enc(f.actor)}&limit=1`, ctx.key)).map((x) => x.id); } catch (e) { ids = []; }
        if (ids.length) p += `&actor=in.(${ids.join(',')})`; else adminNone = true;
      } else if (A.UUID.test(f.actor)) p += `&actor=eq.${f.actor}`;
      else p += `&actor=ilike.${enc('*' + f.actor + '*')}`;
    }
    if (!adminNone) {
      try { admin = await read(p, ctx.key); } catch (e) { return res.status(502).json({ error: 'The audit trail could not be read.' }); }
    }
  }
  // lo_audit_log side: League Office may not be reachable in every project; its absence never hides admin_audit
  let lo = [], loMissing = false;
  if (f.source !== 'admin' && !f.setting) {
    let p = `lo_audit_log?select=${LO_COLS}&order=at.desc&limit=${FETCH}`;
    if (f.app) p += `&domain=eq.${enc(f.app)}`;
    if (f.person) p += `&target_id=ilike.${enc('*' + f.person + '*')}`;
    if (f.before) p += `&at=lt.${enc(f.before)}`;
    if (f.actor) p += `&staff_email=ilike.${enc('*' + f.actor + '*')}`;
    try { lo = await read(p, ctx.key); } catch (e) { loMissing = true; }
  }

  const ids = [...new Set(admin.map((x) => x.actor).filter((a) => A.UUID.test(String(a))))];
  const names = {};
  if (ids.length) {
    try { for (const x of await read(`estate_people?select=id,email&id=in.(${ids.join(',')})`, ctx.key)) names[x.id] = x.email; } catch (e) { /* ids still show */ }
  }
  const all = A.mergeTimeline(admin, lo, names).filter((r) => A.matches(r, { setting: f.setting }));   // the rest is filtered in the database; the setting key lives inside the row
  const rows = all.slice(0, PAGE);
  return res.status(200).json({
    count: rows.length, rows,
    next: all.length > PAGE ? rows[rows.length - 1].at : null,
    sources: { admin: f.source === 'league_office' ? null : admin.length, league_office: f.source === 'admin' || f.setting ? null : loMissing ? 'unavailable' : lo.length }
  });
}

/** The current state a revert is checked against, read fresh. */
async function stateFor(row, key) {
  const k = A.revertKind(row).kind;
  const e = enc(String(row.subject_email || '').toLowerCase());
  if (k === 'access') {
    const who = await read(`estate_people?select=id,email,product_access(product,role,status,expires_at,note)&email_normalised=eq.${e}&limit=1`, key);
    const a = who.length ? (who[0].product_access || []).find((x) => x.product === row.product) : null;
    return { access: a || null };
  }
  if (k === 'gate') { const g = await read(`audience_gate?select=product,lifted&product=eq.${enc(row.product)}&limit=1`, key); return { gate: g[0] || null }; }
  if (k === 'setting') {
    const s = A.settingOf(row);
    const v = await read(`app_setting_value?select=value&app_code=eq.${enc(s.code)}&key=eq.${enc(s.key)}&limit=1`, key);
    if (v.length) return { value: v[0].value };
    const d = await read(`app_setting_def?select=default_value&app_code=eq.${enc(s.code)}&key=eq.${enc(s.key)}&limit=1`, key);
    return { value: d.length ? d[0].default_value : undefined };
  }
  const p = await read(`estate_people?select=id,email,persona_preset&email_normalised=eq.${e}&limit=1`, key);
  return { persona: p.length ? p[0].persona_preset : undefined };
}

async function revert(req, res, ctx) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const id = String((body && body.id) || '');
  const m = /^([al]):([a-z0-9-]{1,40})$/i.exec(id);
  if (!m) return res.status(400).json({ error: 'id must look like a:<number>.' });
  if (m[1].toLowerCase() === 'l') return res.status(409).json({ error: 'League Office changes are reverted in League Office (Audit Log).' });
  let row;
  try { row = (await read(`admin_audit?select=${COLS}&id=eq.${enc(m[2])}&limit=1`, ctx.key))[0]; }
  catch (e) { return res.status(502).json({ error: 'The audit row could not be read.' }); }
  if (!row) return res.status(404).json({ error: 'There is no audit row with that id.' });

  const kind = A.revertKind(row);
  if (!kind.ok) return res.status(409).json({ error: kind.why });
  let st;
  try { st = await stateFor(row, ctx.key); } catch (e) { return res.status(502).json({ error: 'The current state could not be read. Nothing was changed.' }); }
  const plan = A.planRevert(row, st);
  if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
  if (plan.stepUp && !requireFresh(ctx.actor, res)) return;   // restoring a console role is a console-role grant

  try {
    const out = await auditedWrite(ctx.actor, { rpc: plan.rpc, args: plan.args, reason: A.revertReason(row.id, body.reason), linearIssue: body.linearIssue }, { key: ctx.key });
    const changed = !!(out && out.changed);
    return res.status(200).json({ ok: true, changed, now: plan.now, then: plan.then,
      message: changed ? `Reverted audit #${row.id}. A new audit row records it.` : `Nothing to change: it was already in that state.` });
  } catch (e) {
    if (e instanceof AuditError) return res.status(e.status >= 500 ? 502 : 400).json({ error: 'The revert could not be saved. Nothing was changed.' });
    throw e;
  }
}

module.exports = async function audit(req, res, ctx) {
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return revert(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
