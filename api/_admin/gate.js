/* /api/admin/gate (FDY-291, ADM-1.4). Owner only. The Predicts audience gate.
 *
 *   GET   the gate rows, who would start receiving mail if lifted, and the gate's audit history.
 *   POST  { product, lifted: boolean, confirm?: 'lift', reason, linearIssue? }
 *         calls estate_audience_gate_set(p_product, p_lifted, p_actor, p_reason, p_confirm, p_actor_verified, p_via)
 *         through auditedWrite(): one admin_audit row in the same transaction, actor = the signed-in Owner.
 *
 * Senders (predicts-optin-invite, faraday-predicts-digest) read audience_gate at the start of a run and cache
 * it for under 60 seconds; if they cannot read it they fall back to the code constant: not lifted, the two
 * pinned owner addresses. Nothing here sends email. A reason is required (the database function refuses a
 * blank one); lifting needs the typed word `lift` and a fresh sign-in (the same step-up the console uses
 * for console-role grants). The pinned list is not editable here.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError, resolveReason } = require('../_audit.js');
const { requireFresh } = require('../_auth.js');
const { guard } = require('../_rights.js');
const G = require('./gate-logic.js');

async function read(path, key) {
  const r = await sb('/rest/v1/' + path, key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = r.status === 404 ? 404 : 502; throw e; }
  return j;
}

async function list(req, res, ctx) {
  let gates;
  try { gates = await read('audience_gate?select=product,lifted,pinned,lifted_by,lifted_at,reason,updated_at&order=product.asc', ctx.key); }
  catch (e) { return res.status(e.status === 404 ? 200 : 502).json(e.status === 404 ? { waiting: true, message: 'Waiting on FDY-252 migration', gates: [] } : { error: 'The audience gate could not be read.' }); }
  let impact = null;
  try { impact = await read('v_predicts_recipient_review?select=email,review_status,optin_status&limit=1000', ctx.key); } catch (e) { impact = null; }
  let history = [];
  try { history = G.gateHistory(await read('admin_audit?select=at,actor,actor_verified,product,subject_email,action,reason,old_value,new_value,via&subject_email=eq.%2A&order=at.desc&limit=100', ctx.key)); }
  catch (e) { history = []; }
  return res.status(200).json({
    waiting: false,
    gates: gates.map((g) => ({ ...G.shapeGate(g), impact: g.product === 'predicts' && impact ? G.liftImpact(impact, g.pinned) : null })),
    history, propagation: 'A change reaches the senders within 60 seconds.'
  });
}

async function change(req, res, ctx) {
  if (!guard(ctx.actor, 'gate.set', {}, res)) return;   // rights: after the session check, before any read or write
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const p = G.parseChange(body, resolveReason(body && body.reason, body && body.linearIssue));
  if (p.error) return res.status(400).json({ error: p.error });
  if (p.lifted && !requireFresh(ctx.actor, res)) return;   // lifting widens who is emailed: step-up, like a console-role grant

  let rows;
  try { rows = await read(`audience_gate?select=product,lifted&product=eq.${encodeURIComponent(p.product)}&limit=1`, ctx.key); }
  catch (e) { return e.status === 404 ? res.status(503).json({ waiting: true, error: 'Waiting on FDY-252 migration' }) : res.status(502).json({ error: 'The audience gate could not be read.' }); }
  if (!rows.length) return res.status(404).json({ error: 'There is no audience gate for that product.' });
  try {
    const out = await auditedWrite(ctx.actor, {
      rpc: 'estate_audience_gate_set', reason: body.reason, linearIssue: body.linearIssue,
      args: { p_product: p.product, p_lifted: p.lifted, p_confirm: p.confirm }
    }, { key: ctx.key });
    return res.status(200).json({ ok: true, changed: !!(out && out.changed), lifted: p.lifted, message: G.changeMessage(p.product, p.lifted, !!(out && out.changed)) });
  } catch (e) {
    if (e instanceof AuditError) {
      if (e.status === 404) return res.status(503).json({ waiting: true, error: 'Waiting on FDY-252 migration' });
      return res.status(e.status >= 500 ? 502 : 400).json({ error: 'The change could not be saved. Nothing was changed.' });
    }
    throw e;
  }
}

module.exports = async function gate(req, res, ctx) {
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return change(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
