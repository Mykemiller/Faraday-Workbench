/* Pure logic for the audience gate screen (FDY-291, ADM-1.4). No I/O, unit-tested directly.
 * audience_gate (FDY-252 Phase 1): product, lifted, pinned[], lifted_by, lifted_at, reason, updated_at.
 * Armed (lifted=false): only the pinned addresses are mailed. Lifted: the recipient rows govern.
 */
'use strict';

const PRODUCT = /^[a-z][a-z0-9_]{0,31}$/;

/** A gate row as the console shows it. */
function shapeGate(r) {
  return {
    product: r.product, lifted: r.lifted === true, pinned: Array.isArray(r.pinned) ? r.pinned.map(String) : [],
    changedBy: r.lifted_by || null, changedAt: r.lifted_at || null, reason: r.reason || null, updatedAt: r.updated_at || null
  };
}

/** How many approved + confirmed people are NOT pinned: who would start receiving mail if the gate were lifted. */
function liftImpact(recipients, pinned) {
  const pin = new Set((pinned || []).map((e) => String(e).trim().toLowerCase()));
  const eligible = (recipients || []).filter((r) => r.review_status === 'approved' && r.optin_status === 'confirmed');
  const newly = eligible.filter((r) => !pin.has(String(r.email).trim().toLowerCase()));
  return { eligible: eligible.length, newlyMailed: newly.length };
}

/** Validate a change request. A reason is REQUIRED here (the database function refuses a blank one), and a
 *  lift needs the literal typed word `lift`. Arming needs no confirmation: it can only narrow the audience. */
function parseChange(body, resolvedReason) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.product !== 'string' || !PRODUCT.test(b.product)) return { error: 'product is not a valid name.' };
  if (typeof b.lifted !== 'boolean') return { error: 'lifted must be true or false.' };
  if (!resolvedReason) return { error: 'A reason is required to change the audience gate.' };
  if (b.lifted === true && b.confirm !== 'lift') return { error: 'Lifting the gate needs the confirmation word: type lift.' };
  return { product: b.product, lifted: b.lifted, confirm: b.lifted ? 'lift' : null };
}

/** Gate rows of the audit trail, newest first. */
function gateHistory(rows) {
  return (rows || []).filter((r) => /^gate\./.test(String(r.action))).map((r) => ({
    at: r.at, actor: r.actor, actorVerified: r.actor_verified === true, action: r.action, reason: r.reason || null,
    before: r.old_value, after: r.new_value
  }));
}

function changeMessage(product, lifted, changed) {
  if (!changed) return `The ${product} gate was already ${lifted ? 'lifted' : 'armed'}. Nothing changed.`;
  return lifted
    ? `Lifted the ${product} gate. Senders pick this up within 60 seconds.`
    : `Armed the ${product} gate. Senders pick this up within 60 seconds.`;
}

module.exports = { PRODUCT, shapeGate, liftImpact, parseChange, gateHistory, changeMessage };
