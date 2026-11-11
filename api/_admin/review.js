/* /api/admin/review (FDY-290, ADM-1.3). Owner only. The Predicts review queue.
 *
 *   GET   the queue, read from v_predicts_recipient_review, pending first.
 *         { waiting: true } when the view does not exist yet (the FDY-252 migration is not applied).
 *   POST  { email, decision: 'approve'|'reject', confirm: true, reason?, linearIssue? }
 *         calls predicts_review_recipient(p_email, p_decision, p_actor, p_reason) through auditedWrite(),
 *         so each decision writes one admin_audit row with the signed-in Owner's id as the actor.
 *
 * NOTHING HERE SENDS EMAIL. Approving only changes the review state; the FDY-112 cron sends the
 * invitation later. Only a row that is still pending can be decided here (anything else is refused),
 * so an approved owner cannot be rejected by a stray click. The console never creates the view or the
 * function: when either is missing it says it is waiting on the migration.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const R = require('./review-logic.js');

const WAITING = 'Waiting on FDY-252 migration';

async function list(req, res, ctx) {
  const r = await sb('/rest/v1/v_predicts_recipient_review?select=email,source,dc_created_at,last_seen_at,dc_active,review_status,optin_status,reviewed_at,reviewed_by&limit=1000', ctx.key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (r.status === 404 || (j && !Array.isArray(j) && ['PGRST205', '42P01'].includes(j.code))) return res.status(200).json({ waiting: true, message: WAITING, rows: [] });
  if (!r.ok || !Array.isArray(j)) return res.status(502).json({ error: 'The review queue could not be read.' });
  const rows = R.pendingFirst(j.map(R.shapeRow));
  return res.status(200).json({ waiting: false, count: rows.length, pending: rows.filter((x) => x.reviewStatus === R.PENDING).length, rows });
}

async function decide(req, res, ctx) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const p = R.parseDecision(body);
  if (p.error) return res.status(400).json({ error: p.error });

  const r = await sb('/rest/v1/v_predicts_recipient_review?select=email,review_status&limit=1000', ctx.key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (r.status === 404 || (j && !Array.isArray(j) && ['PGRST205', '42P01'].includes(j.code))) return res.status(503).json({ waiting: true, error: WAITING });
  if (!r.ok || !Array.isArray(j)) return res.status(502).json({ error: 'The review queue could not be read.' });
  const row = j.filter((x) => R.normalizeEmail(x.email) === p.email)[0];
  if (!row) return res.status(404).json({ error: 'That address is not in the review queue.' });
  if (row.review_status !== R.PENDING) return res.status(409).json({ error: `${p.email} is already ${row.review_status === 'approved' ? 'approved' : 'rejected'}; only a pending person can be decided here.` });

  try {
    await auditedWrite(ctx.actor, {
      rpc: 'predicts_review_recipient', reason: p.reason, linearIssue: p.linearIssue,
      args: { p_email: row.email, p_decision: p.decision }
    }, { key: ctx.key });
  } catch (e) {
    if (e instanceof AuditError) {
      if (e.status === 404) return res.status(503).json({ waiting: true, error: WAITING });
      return res.status(e.status >= 500 ? 502 : 400).json({ error: 'The decision could not be saved. Nothing was changed.' });
    }
    throw e;
  }
  return res.status(200).json({ ok: true, message: R.decisionMessage(p.decision, p.email) });
}

module.exports = async function review(req, res, ctx) {
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return decide(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
module.exports.WAITING = WAITING;
