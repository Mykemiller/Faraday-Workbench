/* /api/admin/operators (FDY-298, ADM-7a). OWNER ONLY. The Operator role: who may run which apps from the console.
 *
 *   GET   { rows[], scopes[] }   every operator row: person, scope (all apps or one app), state, expiry.
 *         { waiting: true }      while the FDY-298 migration is not applied.
 *   POST  { email, scope?, action: add|pause|resume|revoke|restore|set_expiry, expiresAt?, note?, reason?, linearIssue? }
 *         calls estate_operator_set through auditedWrite(): one admin_audit row in the same transaction, actor = the Owner.
 *
 * Granting an operator is granting a console role: it needs the fresh sign-in, and only the Owner may do it
 * (operator.manage is Owner-only in api/_rights.js). Adding an operator does NOT let them in: console entry is
 * Owner-only (api/_auth.js, unchanged). Phase 2 wires entry.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const { requireFresh } = require('../_auth.js');
const { guard } = require('../_rights.js');
const O = require('./operators-logic.js');

const SELECT = 'role,status,expires_at,note,added_by,updated_at,scope_product,estate_people(id,email)';
const WAITING = { waiting: true, message: 'Waiting on FDY-298 migration' };

async function readRows(key) {
  const r = await sb(`/rest/v1/product_access?select=${SELECT}&product=eq.workbench&role=eq.operator&order=created_at.desc&limit=1000`, key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (r.status === 400 || r.status === 404) { const e = new Error('waiting'); e.waiting = true; throw e; }   // no scope_product column yet
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = 502; throw e; }
  return j;
}

async function list(req, res, ctx) {
  try {
    const rows = await readRows(ctx.key);
    const now = Date.now();
    return res.status(200).json({ waiting: false, scopes: O.SCOPES, rows: rows.filter((a) => a.estate_people).map((a) => O.shapeRow(a, now)) });
  } catch (e) {
    if (e.waiting) return res.status(200).json({ ...WAITING, rows: [], scopes: O.SCOPES });
    return res.status(502).json({ error: 'The operators could not be read.' });
  }
}

async function change(req, res, ctx) {
  if (!guard(ctx.actor, 'operator.manage', {}, res)) return;
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const now = Date.now();
  const p = O.parseWrite(body, now);
  if (p.error) return res.status(400).json({ error: p.error });
  if (!requireFresh(ctx.actor, res)) return;   // granting an operator is granting a console role

  let rows;
  try { rows = await readRows(ctx.key); }
  catch (e) { return e.waiting ? res.status(503).json({ ...WAITING, error: WAITING.message }) : res.status(502).json({ error: 'The operators could not be read.' }); }
  const cur = rows.find((a) => a.estate_people && a.estate_people.email === p.email && (a.scope_product || '') === p.scope) || null;
  const who = `${p.email} (${O.scopeLabel(p.scope)})`;
  let args, message;
  if (p.action === 'add') {
    if (cur) return res.status(409).json({ error: `${who} is already an operator (${cur.status}). Change that row instead.` });
    args = { p_email: p.email, p_scope_product: p.scope || null, p_status: 'active', p_expires_at: p.expiresAt, p_note: p.note };
    message = `Added ${who} as an operator${p.expiresAt ? ' until ' + p.expiresAt.slice(0, 10) : ''}. They cannot sign in to the console yet: entry is Owner-only.`;
  } else {
    if (!cur) return res.status(404).json({ error: `${who} is not an operator.` });
    const keep = { p_email: p.email, p_scope_product: p.scope || null, p_status: cur.status, p_expires_at: cur.expires_at || null, p_note: cur.note || null };
    if (p.action === 'pause') { if (cur.status === 'revoked') return res.status(409).json({ error: 'That grant is revoked. Restore it first.' }); args = { ...keep, p_status: 'paused' }; message = `Paused ${who}.`; }
    else if (p.action === 'resume') { if (cur.status !== 'paused') return res.status(409).json({ error: 'That grant is not paused.' }); args = { ...keep, p_status: 'active' }; message = `Resumed ${who}.`; }
    else if (p.action === 'revoke') { args = { ...keep, p_status: 'revoked' }; message = `Revoked ${who}.`; }
    else if (p.action === 'restore') { if (cur.status !== 'revoked') return res.status(409).json({ error: 'That grant is not revoked.' }); args = { ...keep, p_status: 'active' }; message = `Restored ${who}.`; }
    else { args = { ...keep, p_expires_at: p.expiresAt }; message = p.expiresAt === null ? `${who} no longer expires.` : `${who} expires ${p.expiresAt.slice(0, 10)}.`; }
  }
  try {
    const out = await auditedWrite(ctx.actor, { rpc: 'estate_operator_set', reason: body.reason, linearIssue: body.linearIssue, args }, { key: ctx.key });
    return res.status(200).json({ ok: true, changed: !(out && out.changed === false), message: out && out.changed === false ? 'Nothing changed.' : message });
  } catch (e) {
    if (e instanceof AuditError) {
      if (e.status === 404) return res.status(503).json({ ...WAITING, error: WAITING.message });
      return res.status(e.status >= 500 ? 502 : 400).json({ error: e.status >= 500 ? 'The change could not be saved. Nothing was changed.' : e.message });
    }
    throw e;
  }
}

module.exports = async function operators(req, res, ctx) {
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return change(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
