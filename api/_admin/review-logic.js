/* Pure logic for the Predicts review queue (FDY-290, ADM-1.3). No I/O, unit-tested directly.
 * The view is v_predicts_recipient_review (FDY-112): email, source, dc_created_at, last_seen_at,
 * dc_active, review_status, optin_status, reviewed_at, reviewed_by. The consent token is never in it.
 */
'use strict';

const PENDING = 'pending_review';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DECISIONS = Object.freeze({ approve: 'approved', reject: 'rejected' });

const normalizeEmail = (raw) => String(raw || '').trim().toLowerCase();

/** A view row as the console shows it. */
function shapeRow(r) {
  return {
    email: String(r.email || ''), source: r.source || null,
    createdAt: r.dc_created_at || null, lastSeenAt: r.last_seen_at || null, active: r.dc_active === null || r.dc_active === undefined ? null : r.dc_active === true,
    reviewStatus: r.review_status, optinStatus: r.optin_status, reviewedAt: r.reviewed_at || null, reviewedBy: r.reviewed_by || null
  };
}

/** Pending first, then by created date (oldest first), then email. Never mutates its input. */
function pendingFirst(rows) {
  const t = (x) => (x.createdAt ? Date.parse(x.createdAt) || 0 : 0);
  return rows.slice().sort((a, b) =>
    (b.reviewStatus === PENDING) - (a.reviewStatus === PENDING) || t(a) - t(b) || a.email.localeCompare(b.email));
}

/** Validate a decision request. The confirm step is part of the request: no confirm, no write. */
function parseDecision(body) {
  const b = body && typeof body === 'object' ? body : {};
  const email = normalizeEmail(b.email);
  if (!EMAIL.test(email)) return { error: 'That does not look like an email address.' };
  if (!Object.prototype.hasOwnProperty.call(DECISIONS, b.decision)) return { error: 'decision must be approve or reject.' };
  if (b.confirm !== true) return { error: 'This decision needs to be confirmed.' };
  return { email, decision: b.decision, reason: b.reason, linearIssue: b.linearIssue };
}

/** The sentence shown after a decision. Approving never sends mail; say so every time. */
function decisionMessage(decision, email) {
  return decision === 'approve'
    ? `Approved ${email}. No email was sent; the FDY-112 invitation job sends the invitation later.`
    : `Rejected ${email}. No email was sent.`;
}

module.exports = { PENDING, DECISIONS, normalizeEmail, shapeRow, pendingFirst, parseDecision, decisionMessage };
