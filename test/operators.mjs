// FDY-298 (ADM-7a): the Operator role in the console. The Owner-only route, the audit row, coexistence with the Owner's
// own access, console entry staying Owner-only, and every write route consulting the rights decision before it touches
// the database. Over the mocked client (test/_fakedb.mjs); no network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const router = require('../api/admin/[route].js');
const O = require('../api/_admin/operators-logic.js');
const R = require('../api/_rights.js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const STALE = () => ownerHeaders(OWNER_ID, OWNER, Math.floor(Date.now() / 1000) - 11 * 60);
const get = (headers = H()) => call({ method: 'GET', headers, query: { route: 'operators' } });
const post = (body, headers = H()) => call({ method: 'POST', headers, query: { route: 'operators' }, body });
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
const last = () => db.audit[db.audit.length - 1];

// ---- pure logic ----
{
  assert.deepEqual(O.SCOPES[0], { value: '', label: 'All apps' }); assert.equal(O.SCOPES.length, 6);
  const NOW = Date.parse('2026-11-12T12:00:00Z');
  assert.match(O.parseWrite({ action: 'nope', email: 'a@x.io' }, NOW).error, /action must be/);
  assert.match(O.parseWrite({ action: 'add', email: 'not-an-email' }, NOW).error, /email/);
  assert.match(O.parseWrite({ action: 'add', email: 'a@x.io', scope: 'nonsense' }, NOW).error, /scope must be/);
  assert.match(O.parseWrite({ action: 'add', email: 'a@x.io', expiresAt: '2020-01-01' }, NOW).error, /future/);
  assert.match(O.parseWrite({ action: 'add', email: 'a@x.io', expiresAt: 'soon' }, NOW).error, /YYYY-MM-DD/);
  assert.deepEqual(O.parseWrite({ action: 'add', email: ' A@X.io ', scope: '' }, NOW), { email: 'a@x.io', scope: '', action: 'add', expiresAt: null, note: null });
  assert.equal(O.parseWrite({ action: 'add', email: 'a@x.io', scope: 'jw', expiresAt: '2027-01-01' }, NOW).expiresAt, '2027-01-01T23:59:59Z');
  assert.equal(O.scopeLabel(''), 'All apps'); assert.equal(O.scopeLabel('ispyadc'), 'ISpyaDC');
  console.log('PASS  logic: action, email, scope and expiry are validated; the scope list is all apps plus the five apps');
}

// ---- auth ----
{
  assert.equal((await call({ method: 'GET', headers: {}, query: { route: 'operators' } })).code, 404);
  assert.equal((await call({ method: 'POST', headers: {}, query: { route: 'operators' }, body: { action: 'add', email: 'x@y.io' } })).code, 404);
  assert.equal((await call({ method: 'DELETE', headers: H(), query: { route: 'operators' } })).code, 405);
  console.log('PASS  without an Owner session the operators route is a bare 404');
}

// ---- waiting on the migration ----
{
  db.noOperatorColumn = true;
  let r = await get(); assert.equal(r.code, 200); assert.equal(r.body.waiting, true); assert.match(r.body.message, /FDY-298 migration/); assert.deepEqual(r.body.rows, []);
  r = await post({ action: 'add', email: 'op@example.org', scope: '' }); assert.equal(r.code, 503); assert.equal(r.body.waiting, true);
  db.noOperatorColumn = false;
  console.log('PASS  before the migration: "Waiting on FDY-298 migration", and nothing is written');
}

// ---- add: step-up, audit, duplicate ----
{
  const n0 = db.audit.length;
  let r = await post({ action: 'add', email: 'op@example.org', scope: '' }, STALE());
  assert.equal(r.code, 403); assert.equal(r.body.error, 'step_up_required'); assert.equal(db.audit.length, n0, 'granting an operator needs the fresh sign-in');
  r = await post({ action: 'add', email: 'op@example.org', scope: '', reason: 'covers all apps' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.match(r.body.message, /cannot sign in to the console yet/);
  const adds = db.audit.filter((x) => x.action === 'operator.add');
  assert.equal(adds.length, 1); assert.equal(adds[0].actor, OWNER_ID); assert.equal(adds[0].actor_verified, true); assert.equal(adds[0].via, 'workbench:console');
  assert.equal(adds[0].reason, 'covers all apps'); assert.equal(adds[0].new_value.scope_product, null); assert.equal(adds[0].new_value.role, 'operator');
  r = await post({ action: 'add', email: 'op@example.org', scope: '' }); assert.equal(r.code, 409, 'adding the same operator twice is refused'); assert.match(r.body.error, /already an operator/);
  r = await post({ action: 'add', email: 'op@example.org', scope: 'ispyadc', expiresAt: '2099-01-01' }); assert.equal(r.code, 200, 'a second scope for the same person is a separate grant');
  r = await post({ action: 'add', email: 'op@example.org', scope: 'bad' }); assert.equal(r.code, 400);
  r = await post({ action: 'add', email: 'nope' }); assert.equal(r.code, 400);
  r = await get(); assert.equal(r.code, 200); assert.equal(r.body.rows.length, 2);
  assert.deepEqual(r.body.rows.map((x) => x.scopeLabel).sort(), ['All apps', 'ISpyaDC']); assert.ok(r.body.rows.every((x) => x.state === 'active'));
  console.log('PASS  add: step-up first, one audit row with the Owner as actor and the scope recorded, a second scope is its own grant');
}

// ---- lifecycle ----
{
  const n0 = db.audit.length;
  const step = async (action, extra, re) => { const r = await post({ action, email: 'op@example.org', scope: '', ...extra }); assert.equal(r.code, 200, action + JSON.stringify(r.body)); assert.match(r.body.message, re); return r; };
  await step('pause', {}, /Paused/); assert.equal(last().action, 'operator.pause');
  let r = await post({ action: 'pause', email: 'op@example.org', scope: '' }); assert.equal(r.code, 200); assert.equal(r.body.message, 'Nothing changed.', 'unchanged input changes nothing');
  await step('resume', {}, /Resumed/); assert.equal(last().action, 'operator.resume');
  await step('revoke', {}, /Revoked/); assert.equal(last().action, 'operator.revoke');
  r = await post({ action: 'pause', email: 'op@example.org', scope: '' }); assert.equal(r.code, 409); assert.match(r.body.error, /revoked/);
  r = await post({ action: 'resume', email: 'op@example.org', scope: '' }); assert.equal(r.code, 409);
  await step('restore', {}, /Restored/); assert.equal(last().action, 'operator.restore');
  r = await post({ action: 'restore', email: 'op@example.org', scope: '' }); assert.equal(r.code, 409);
  await step('set_expiry', { expiresAt: '2099-06-01' }, /expires 2099-06-01/); assert.equal(last().new_value.expires_at, '2099-06-01T23:59:59Z');
  r = await post({ action: 'pause', email: 'nobody@example.org', scope: '' }); assert.equal(r.code, 404);
  assert.equal(db.audit.length - n0, 5, 'one audit row per real change (pause, resume, revoke, restore, expiry), none for the no-op or the refusals');
  console.log('PASS  pause, resume, revoke, restore and expiry each write one audit row; a no-op and every refusal write none');
}

// ---- the lock-out hazard and console entry ----
{
  // the Owner now also holds operator rows for himself: sign-in still answers as owner
  let r = await post({ action: 'add', email: OWNER, scope: '', reason: 'my own operator row' }); assert.equal(r.code, 200, JSON.stringify(r.body));
  r = await post({ action: 'add', email: OWNER, scope: 'jw' }); assert.equal(r.code, 200);
  assert.equal(db.access.filter((a) => a.person_id === OWNER_ID && a.product === 'workbench').length, 3, 'one owner row and two operator rows on the same app');
  r = await call({ method: 'GET', headers: H(), query: { route: 'people' } });
  assert.equal(r.code, 200, 'the Owner still gets into the console with operator rows of his own');
  const person = await call({ method: 'GET', headers: H(), query: { route: 'person', id: OWNER_ID } });
  const wb = person.body.person.access.filter((a) => a.product === 'workbench');
  assert.equal(wb.length, 3); assert.deepEqual(wb.filter((a) => a.role === 'operator').map((a) => a.scope).sort(), ['', 'jw']);
  // a person with ONLY an operator row gets no console entry
  const opOnly = db.people.find((p) => p.email === 'op@example.org');
  r = await call({ method: 'GET', headers: ownerHeaders(opOnly.id, 'op@example.org'), query: { route: 'people' } });
  assert.equal(r.code, 404, 'an operator row gives no console entry: entry stays Owner-only');
  assert.equal(JSON.stringify(r.body).includes('rows'), false);
  console.log('PASS  the Owner holding operator rows still signs in as Owner; a person with only an operator row cannot enter');
}

// ---- operator rows are managed here, not on the person / access pages ----
{
  const opOnly = db.people.find((p) => p.email === 'op@example.org');
  let r = await call({ method: 'POST', headers: H(), query: { route: 'person' }, body: { id: opOnly.id, action: 'pause', product: 'workbench' } });
  assert.equal(r.code, 404, 'the person page cannot touch an operator row (it has no console access row to change)');
  assert.equal(db.access.find((a) => a.person_id === opOnly.id && a.role === 'operator' && !a.scope_product).status, 'active');
  r = await call({ method: 'GET', headers: H(), query: { route: 'access', app: 'workbench' } });
  assert.equal(r.code, 200); assert.ok(r.body.rows.every((x) => x.role !== 'operator'), 'the Access list shows console owners, not operators');
  r = await call({ method: 'POST', headers: H(), query: { route: 'person' }, body: { id: opOnly.id, action: 'grant', product: 'workbench', role: 'operator' } });
  assert.equal(r.code, 400, 'operator is not a role the person page can grant (it has no scope)');
  console.log('PASS  the person and access pages neither list nor change operator rows; operator is not grantable there');
}

// ---- every write route consults the rights decision BEFORE touching the database ----
{
  const person = db.people.find((p) => p.email === 'op@example.org');
  const mods = { access: require('../api/_admin/access.js'), person: require('../api/_admin/person.js'), review: require('../api/_admin/review.js'), apps: require('../api/_admin/apps.js'),
    gate: require('../api/_admin/gate.js'), audit: require('../api/_admin/audit.js'), operators: require('../api/_admin/operators.js') };
  const op = (scope) => ({ kind: 'operator', personId: person.id, email: 'op@example.org', grants: [{ scope }] });
  const run = async (name, body, actor) => {
    const n = db.calls.length; const res = mkRes();
    await mods[name]({ method: 'POST', headers: {}, body, query: {} }, res, { actor, key: 'svc' });
    return { res, calls: db.calls.length - n };
  };
  const refused = async (label, name, body, actor, re) => {
    const { res, calls } = await run(name, body, actor);
    assert.equal(res.code, 403, label); assert.equal(res.body.error, 'not_permitted', label); assert.match(res.body.message, re, label);
    assert.equal(calls, 0, label + ': refused BEFORE any database call');
  };
  const passes = async (label, name, body, actor) => {
    const { res } = await run(name, body, actor);
    assert.notEqual(res.body && res.body.error, 'not_permitted', label + ': the rights decision allowed it (a later step may still stop it)');
  };
  const all = op(null), jw = op('jw');
  // refused: everything owner-only, with no database call
  await refused('console grant by access', 'access', { app: 'workbench', email: 'x@y.io', role: 'owner' }, all, /Only the Owner/);
  await refused('console grant by person page', 'person', { id: person.id, action: 'grant', product: 'workbench', role: 'owner' }, all, /Only the Owner/);
  await refused('console pause by person page', 'person', { id: person.id, action: 'pause', product: 'workbench' }, all, /Only the Owner/);
  await refused('persona', 'person', { id: person.id, action: 'set_persona', persona: 'MF-04' }, all, /Only the Owner/);
  await refused('promote a release', 'apps', { action: 'promote', code: 'WB', version: '3.0', release: 'r' }, all, /Only the Owner/);
  await refused('set an app state', 'apps', { action: 'set_state', code: 'WB', state: 'Launch Ready' }, all, /Only the Owner/);
  await refused('the audience gate', 'gate', { product: 'predicts', lifted: true, confirm: 'lift', reason: 'x' }, all, /Only the Owner/);
  await refused('an audit revert', 'audit', { id: 'a:1' }, all, /Only the Owner/);
  await refused('managing operators', 'operators', { action: 'add', email: 'z@y.io' }, all, /Only the Owner/);
  // refused: out of scope
  await refused('grant on another app', 'access', { app: 'ispyadc', email: 'x@y.io', role: 'tester' }, jw, /does not cover this app/);
  await refused('person page on another app', 'person', { id: person.id, action: 'revoke', product: 'ispyadc' }, jw, /does not cover this app/);
  await refused('review outside Predicts scope', 'review', { email: 'a@b.io', decision: 'approve' }, jw, /does not cover this app/);
  await refused('a setting of another app', 'apps', { action: 'set_setting', code: 'IS', key: 'k', value: 1 }, jw, /does not cover this app/);
  await refused('a setting of an app with no scope key', 'apps', { action: 'set_setting', code: 'TF', key: 'k', value: 1 }, jw, /does not cover this app/);
  // allowed by the rights decision: in scope (a later step may still stop it; here the Owner-only audited write refuses a non-owner actor)
  await passes('grant in scope', 'access', { app: 'jw', email: 'x@y.io', role: 'member' }, jw);
  await passes('grant on any app (all-apps)', 'access', { app: 'ispyadc', email: 'x@y.io', role: 'tester' }, all);
  await passes('expire in scope', 'person', { id: person.id, action: 'revoke', product: 'jw' }, jw);
  await passes('restore in scope', 'person', { id: person.id, action: 'restore', product: 'jw' }, jw);
  await passes('review in Predicts scope', 'review', { email: 'a@b.io', decision: 'approve' }, op('predicts'));
  await passes('a setting in scope', 'apps', { action: 'set_setting', code: 'JW', key: 'k', value: 1 }, jw);
  await passes('a setting of an unscoped app by an all-apps operator', 'apps', { action: 'set_setting', code: 'TF', key: 'k', value: 1 }, all);
  console.log('PASS  every write route asks the rights decision first: owner-only and out-of-scope are 403 with ZERO database calls; in-scope actions pass the decision');
}

// ---- operators are visible in the audit timeline and are never reverted from there ----
{
  const r = await call({ method: 'GET', headers: H(), query: { route: 'audit', person: 'op@example.org' } });
  const row = r.body.rows.find((x) => x.action === 'operator.pause');
  assert.ok(row); assert.equal(row.revert.possible, false, 'an operator change is made on the Operators tab, not reverted from the timeline');
  console.log('PASS  operator changes appear in the audit timeline, and are not revertible from it');
}
console.log('ALL PASS  operators');
