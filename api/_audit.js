/* The console's audit helper (FDY-287, ADM-0.4). Every console write goes through auditedWrite().
 *
 * "Same transaction" is done in the database, not here: a write is one call to a SECURITY DEFINER
 * function that makes the change AND appends its admin_audit row in a single transaction (the
 * FDY-252 Phase 1 pattern). This helper is the only way the console calls such a function. It:
 *
 *   - refuses any function not listed in AUDITED_RPCS (so a write can never skip the audit row),
 *   - sets the actor to the signed-in person's estate_people id, never a value from the browser,
 *   - marks the actor verified and the channel 'workbench:console' where the function takes them,
 *   - fills the reason: optional; when blank and the change names a Linear issue, the issue key.
 *
 * To add a write: write the function so it inserts its own admin_audit row, then list it here.
 */
'use strict';

const { sb } = require('./_wb.js');

const VIA = 'workbench:console';
const LINEAR_KEY = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Functions that write admin_audit in their own transaction (FDY-252 Phase 1).
 * verified / via: whether the function accepts p_actor_verified / p_via. All take p_actor, p_reason. */
const AUDITED_RPCS = Object.freeze({
  estate_access_set: { verified: true, via: true },
  estate_person_set_persona: { verified: true, via: true },
  estate_audience_gate_set: { verified: true, via: true },
  estate_consent_review: { verified: false, via: false },
  predicts_review_recipient: { verified: false, via: false },
  app_registry_promote: { verified: true, via: true },
  app_registry_set_state: { verified: true, via: true },
  app_setting_set: { verified: true, via: true }
});

/** A Linear issue key (FDY-123) from what the caller passed, or null. */
function linearKey(raw) {
  const k = String(raw || '').trim().toUpperCase();
  return LINEAR_KEY.test(k) ? k : null;
}

/** The reason to record. Never required: typed text wins, else the Linear issue key, else null. */
function resolveReason(reason, linearIssue) {
  const text = String(reason === undefined || reason === null ? '' : reason).trim().slice(0, 500);
  if (text) return text;
  return linearKey(linearIssue);
}

class AuditError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * Run one audited write.
 *   actor   the object requireOwner() returned (kind 'owner', personId)
 *   change  { rpc, args, reason?, linearIssue? }   args are the function's own p_* parameters
 *   deps    { key, client? }   client(path, key, init) defaults to the service-role fetch
 * Returns the function's JSON result. Throws AuditError; nothing is written on a refusal.
 */
async function auditedWrite(actor, change, deps) {
  if (!actor || actor.kind !== 'owner' || !UUID.test(String(actor.personId || ''))) {
    throw new AuditError('auditedWrite: a signed-in Owner is required', 403);
  }
  const rpc = String((change && change.rpc) || '');
  const spec = Object.prototype.hasOwnProperty.call(AUDITED_RPCS, rpc) ? AUDITED_RPCS[rpc] : null;
  if (!spec) throw new AuditError(`auditedWrite: ${rpc || '(none)'} is not an audited function`, 400);
  const key = deps && deps.key;
  if (!key) throw new AuditError('auditedWrite: the service key is not set', 503);
  const args = (change && change.args) || {};
  for (const name of ['p_actor', 'p_actor_verified', 'p_via', 'p_reason']) {
    if (Object.prototype.hasOwnProperty.call(args, name)) throw new AuditError(`auditedWrite: ${name} is set by the helper, not the caller`, 400);
  }
  const body = { ...args, p_actor: actor.personId, p_reason: resolveReason(change.reason, change.linearIssue) };
  if (spec.verified) body.p_actor_verified = true;
  if (spec.via) body.p_via = VIA;

  const client = (deps && deps.client) || sb;
  let r;
  try {
    r = await client(`/rest/v1/rpc/${rpc}`, key, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    throw new AuditError('auditedWrite: the database could not be reached; nothing was saved', 502);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new AuditError((j && (j.message || j.hint)) || 'HTTP ' + r.status, r.status >= 400 && r.status < 600 ? r.status : 502);
  return j;
}

module.exports = { auditedWrite, resolveReason, linearKey, AuditError, AUDITED_RPCS, VIA };
