// FDY-298 (ADM-7a): the rights decision. Every allowed and every refused action, every scope, every grant state.
// Pure: api/_rights.js has no I/O and no clock of its own.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const R = require('../api/_rights.js');
const NOW = Date.parse('2026-11-12T12:00:00Z');

const OPERATOR_MAY = ['people.review', 'access.grant', 'access.expire', 'setting.draft', 'setting.promote', 'broadcast.send'];
const OPERATOR_MAY_NOT = ['price.change', 'config.lock', 'console_role.grant', 'operator.manage', 'secrets.view', 'registry.promote', 'registry.set_state', 'gate.set', 'audit.revert', 'person.persona'];
const owner = { kind: 'owner' };
const op = (scope) => ({ kind: 'operator', grants: [{ scope }] });

// the table in the brief, and nothing else, is what an operator may do
assert.deepEqual(Object.keys(R.ACTIONS).filter((a) => R.ACTIONS[a].operator).sort(), OPERATOR_MAY.slice().sort());
assert.deepEqual(Object.keys(R.ACTIONS).filter((a) => !R.ACTIONS[a].operator).sort(), OPERATOR_MAY_NOT.slice().sort());
console.log('PASS  the operator table is exactly: review people, grant and expire access, draft and promote settings, send broadcasts');

// ---- Owner: every known action ----
for (const a of [...OPERATOR_MAY, ...OPERATOR_MAY_NOT]) assert.equal(R.decide(owner, a, { product: 'ispyadc' }, NOW).ok, true, 'owner may ' + a);
assert.equal(R.decide(owner, 'people.review', {}, NOW).ok, true, 'the Owner needs no app named');
console.log('PASS  the Owner may do every action');

// ---- Operator, all apps: the six allowed, the ten refused ----
for (const a of OPERATOR_MAY) for (const product of ['ispyadc', 'jw', 'predicts', 'dailychallenge', 'workbench', 'other']) {
  assert.equal(R.decide(op(null), a, { product }, NOW).ok, true, `all-apps operator may ${a} on ${product}`);
}
for (const a of OPERATOR_MAY_NOT) for (const product of ['ispyadc', 'predicts', 'workbench', undefined]) {
  const d = R.decide(op(null), a, { product }, NOW);
  assert.deepEqual(d, { ok: false, why: 'owner_only' }, `all-apps operator may NOT ${a}`);
}
console.log('PASS  an all-apps operator may do the six actions on any app and none of the ten owner-only actions');

// ---- Operator scoped to one app ----
for (const a of OPERATOR_MAY) {
  assert.equal(R.decide(op('ispyadc'), a, { product: 'ispyadc' }, NOW).ok, true, `${a} in scope`);
  for (const product of ['jw', 'predicts', 'dailychallenge', 'workbench', 'other']) assert.deepEqual(R.decide(op('ispyadc'), a, { product }, NOW), { ok: false, why: 'out_of_scope' }, `${a} out of scope on ${product}`);
  assert.deepEqual(R.decide(op('ispyadc'), a, {}, NOW), { ok: false, why: 'app_required' }, `${a} needs an app named`);
  assert.deepEqual(R.decide(op(null), a, {}, NOW), { ok: false, why: 'app_required' }, `${a} needs an app named, even for all apps`);
  assert.deepEqual(R.decide(op('ispyadc'), a, undefined, NOW), { ok: false, why: 'app_required' }, 'no context at all');
}
for (const a of OPERATOR_MAY_NOT) assert.equal(R.decide(op('ispyadc'), a, { product: 'ispyadc' }, NOW).ok, false, `a scoped operator still may NOT ${a} even in scope`);
// two scopes: the union
const two = { kind: 'operator', grants: [{ scope: 'ispyadc' }, { scope: 'jw' }] };
assert.equal(R.decide(two, 'access.grant', { product: 'jw' }, NOW).ok, true);
assert.equal(R.decide(two, 'access.grant', { product: 'predicts' }, NOW).ok, false);
console.log('PASS  a scoped operator is limited to its app; two grants cover the union; owner-only actions stay refused in scope');

// ---- grants: only an active, unexpired operator row counts ----
const row = (extra) => ({ role: 'operator', status: 'active', expires_at: null, scope_product: null, ...extra });
assert.deepEqual(R.operatorGrants([row({})], NOW), [{ scope: null }]);
assert.deepEqual(R.operatorGrants([row({ scope_product: 'jw' })], NOW), [{ scope: 'jw' }]);
assert.deepEqual(R.operatorGrants([row({ status: 'paused' }), row({ status: 'revoked' })], NOW), [], 'paused and revoked grants decide nothing');
assert.deepEqual(R.operatorGrants([row({ expires_at: '2026-11-12T11:59:59Z' })], NOW), [], 'an expired grant decides nothing');
assert.deepEqual(R.operatorGrants([row({ expires_at: '2026-11-13T00:00:00Z' })], NOW), [{ scope: null }], 'a future expiry still counts');
assert.deepEqual(R.operatorGrants([{ role: 'owner', status: 'active', expires_at: null }], NOW), [], 'a non-operator row grants no operator rights');
assert.deepEqual(R.operatorGrants(undefined, NOW), []);
assert.deepEqual(R.decide({ kind: 'operator', grants: R.operatorGrants([row({ status: 'paused' })], NOW) }, 'access.grant', { product: 'jw' }, NOW), { ok: false, why: 'no_grant' });
assert.deepEqual(R.decide({ kind: 'operator' }, 'access.grant', { product: 'jw' }, NOW), { ok: false, why: 'no_grant' });
console.log('PASS  only an active, unexpired operator grant counts; paused, revoked, expired and non-operator rows decide nothing');

// ---- fail closed ----
for (const bad of ['', 'access.granted', 'ACCESS.GRANT', 'people', undefined, null, '__proto__', 'constructor', 'toString']) {
  assert.deepEqual(R.decide(owner, bad, { product: 'jw' }, NOW), { ok: false, why: 'unknown_action' }, 'an unknown action is refused even for the Owner: ' + bad);
  assert.equal(R.decide(op(null), bad, { product: 'jw' }, NOW).ok, false);
}
assert.deepEqual(R.decide(null, 'access.grant', { product: 'jw' }, NOW), { ok: false, why: 'no_actor' });
assert.deepEqual(R.decide('owner', 'access.grant', { product: 'jw' }, NOW), { ok: false, why: 'no_actor' });
assert.deepEqual(R.decide({ kind: 'viewer' }, 'access.grant', { product: 'jw' }, NOW), { ok: false, why: 'unknown_actor' });
assert.deepEqual(R.decide({ kind: 'Owner' }, 'access.grant', { product: 'jw' }, NOW), { ok: false, why: 'unknown_actor' }, 'kind is matched exactly');
assert.equal(R.decide(op(null), 'access.grant', { product: 5 }, NOW).ok, false, 'a non-string app is refused');
console.log('PASS  fail closed: unknown action (even for the Owner), no actor, unknown kind, no app named');

// ---- mapping helpers ----
assert.equal(R.accessAction('access.grant', 'workbench'), 'console_role.grant', 'any access write on the console is a console-role grant');
assert.equal(R.accessAction('access.expire', 'workbench'), 'console_role.grant');
assert.equal(R.accessAction('access.grant', 'ispyadc'), 'access.grant');
assert.equal(R.decide(op(null), R.accessAction('access.grant', 'workbench'), { product: 'workbench' }, NOW).ok, false, 'an operator cannot grant a console role');
assert.deepEqual(['IS', 'jw', 'FP', 'DC', 'WB', 'TF', '', undefined].map(R.productForApp), ['ispyadc', 'jw', 'predicts', 'dailychallenge', 'workbench', 'other', 'other', 'other']);
assert.equal(R.decide(op('ispyadc'), 'setting.promote', { product: R.productForApp('TF') }, NOW).ok, false, 'a scoped operator cannot run an app that has no scope key');
assert.equal(R.decide(op(null), 'setting.promote', { product: R.productForApp('TF') }, NOW).ok, true, 'an all-apps operator can');
console.log('PASS  console writes are console-role grants; app codes map to scope keys; unscoped apps need an all-apps grant');

// ---- the route helper ----
const mkRes = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
let r = mkRes(); assert.equal(R.guard(op('jw'), 'gate.set', {}, r, NOW), false); assert.equal(r.code, 403); assert.equal(r.body.error, 'not_permitted'); assert.match(r.body.message, /Only the Owner/);
r = mkRes(); assert.equal(R.guard(owner, 'gate.set', {}, r, NOW), true); assert.equal(r.code, 200);
r = mkRes(); assert.equal(R.guard(op('jw'), 'access.grant', { product: 'predicts' }, r, NOW), false); assert.match(r.body.message, /does not cover this app/);
for (const m of Object.values(R.MESSAGES)) assert.equal(/[$€£]\s?\d|secret|key|token/i.test(m), false, 'no sensitive wording in a refusal');
console.log('PASS  guard answers 403 not_permitted with a plain reason and lets allowed actions through');
console.log('ALL PASS  rights');
