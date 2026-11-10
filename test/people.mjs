// FDY-288 (ADM-1.1): People directory and Person page. Search, filters, grant, pause, revoke and
// the other writes, against a mocked client (test/_fakedb.mjs). Each write must produce an
// admin_audit row whose actor is the signed-in person's id. No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const L = require('../api/_admin/people-logic.js');
const router = require('../api/admin/[route].js');
const shell = require('../api/admin/shell.js');
const A = require('../api/_auth.js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const NOW = Date.parse('2026-11-10T12:00:00Z');
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const get = (route, query = {}) => call({ method: 'GET', headers: H(), query: { route, ...query } });
const post = (route, body, headers) => call({ method: 'POST', headers: headers || H(), query: { route }, body });

function seed() {
  const db = fakeDb(); globalThis.fetch = db.fetch;
  const owner = db.addPerson(OWNER, { id: OWNER_ID, display_name: 'Olive Owner' });
  db.addAccess(owner, 'workbench', 'owner'); db.addAccess(owner, 'ispyadc', 'admin');
  db.addConsent(owner, 'predicts', 'approved', 'confirmed');
  const tess = db.addPerson('tess@example.com', { display_name: 'Tess Tester', persona_preset: 'MF-07' });
  db.addAccess(tess, 'ispyadc', 'tester', 'active', inDays(3));
  const pat = db.addPerson('pat@example.com'); db.addAccess(pat, 'jw', 'member', 'paused');
  const rex = db.addPerson('rex@example.com', { persona_preset: 'MF-21' }); db.addAccess(rex, 'predicts', 'member', 'revoked'); db.addAccess(rex, 'jw', 'member', 'active', inDays(20));
  const eve = db.addPerson('eve@example.com'); db.addAccess(eve, 'ispyadc', 'tester', 'active', inDays(-2));
  db.addConsent(eve, 'predicts', 'pending_review', 'not_invited');
  const nan = db.addPerson('nobody@example.com');
  return { db, owner, tess, pat, rex, eve, nan };
}
const emails = (r) => r.body.people.map((p) => p.email).sort();

// ---- pure logic ----
{
  assert.equal(L.accessState({ status: 'active', expires_at: null }, NOW), 'active');
  assert.equal(L.accessState({ status: 'active', expires_at: '2026-11-09T00:00:00Z' }, NOW), 'expired');
  assert.equal(L.accessState({ status: 'paused', expires_at: '2026-11-09T00:00:00Z' }, NOW), 'paused', 'paused wins over expiry');
  assert.equal(L.accessState({ status: 'revoked', expires_at: null }, NOW), 'revoked');
  assert.equal(L.normalizeEmail('  Tess@Example.COM '), 'tess@example.com');
  assert.equal(L.PERSONAS.length, 21); assert.equal(L.PERSONAS[0], 'MF-01'); assert.equal(L.PERSONAS[20], 'MF-21');
  assert.equal(L.expiryToTimestamp('2026-12-01', NOW), '2026-12-01T23:59:59Z'); assert.equal(L.expiryToTimestamp('', NOW), null);
  assert.equal(L.expiryToTimestamp('now', NOW), '2026-11-10T12:00:00.000Z'); assert.equal(L.expiryToTimestamp('soon', NOW), undefined);
  assert.equal(L.defaultExpiry('tester', NOW), '2026-11-24'); assert.equal(L.defaultExpiry('member', NOW), null);
  assert.match(L.parseFilters({ app: 'nope' }).error, /app/); assert.match(L.parseFilters({ status: 'x' }).error, /status/);
  assert.match(L.parseFilters({ expiry: 'x' }).error, /expiry/); assert.match(L.parseFilters({ persona: 'MF-22' }).error, /persona/);
  assert.equal(L.parseFilters({ persona: 'mf-07' }).persona, 'MF-07'); assert.equal(L.parseFilters({ persona: 'unset' }).persona, 'UNSET');
  assert.match(L.parseWrite({ action: 'nuke' }, NOW).error, /action/);
  assert.match(L.parseWrite({ action: 'grant', product: 'jw', role: 'owner' }, NOW).error, /role/);
  assert.match(L.parseWrite({ action: 'grant', product: 'ispyadc', role: 'virtual_team_member' }, NOW).error, /role/, 'Virtual Team Member is never a per-app role (D11)');
  assert.deepEqual(L.PRODUCTS.workbench.roles, ['owner'], 'Owner is the only console role (D4)');
  assert.equal(L.parseWrite({ action: 'grant', product: 'ispyadc', role: 'tester' }, NOW).expiresAt, '2026-11-24T23:59:59Z', 'testers default to 14 days');
  assert.equal(L.parseWrite({ action: 'grant', product: 'ispyadc', role: 'tester', expiresAt: '' }, NOW).expiresAt, null);
  assert.equal(L.parseWrite({ action: 'pause', product: 'jw' }, NOW).reason, '', 'a reason is never required');
  assert.match(L.parseWrite({ action: 'set_persona', persona: 'MF-00' }, NOW).error, /persona/);
  assert.equal(L.parseWrite({ action: 'set_persona', persona: '' }, NOW).persona, null);
  console.log('PASS  pure logic: access state, filters and write validation');
}

// ---- directory: search ----
{
  seed();
  let r = await get('people');
  assert.equal(r.code, 200); assert.equal(r.body.total, 6); assert.equal(r.body.count, 6);
  const o = r.body.people.find((p) => p.email === OWNER);
  assert.deepEqual(o.access.map((a) => a.product).sort(), ['ispyadc', 'workbench']);
  assert.equal(o.plan, null, 'plan band is "None yet" until Phase 3');
  assert.equal(o.consent[0].label, 'approved · confirmed'); assert.equal(o.persona, null);
  assert.equal(JSON.stringify(r.body).includes('SECRET-TOKEN'), false, 'the consent token never leaves the server');
  assert.equal(r.body.options.personas.length, 21);
  assert.deepEqual(emails(await get('people', { q: 'TESS' })), ['tess@example.com'], 'search by email, any case');
  assert.deepEqual(emails(await get('people', { q: 'olive' })), [OWNER], 'search by name');
  assert.deepEqual(emails(await get('people', { q: 'example.com' })).length, 6);
  assert.deepEqual(emails(await get('people', { q: 'zzz' })), []);
  console.log('PASS  directory lists apps, plan band and consent; search by name or email');
}

// ---- directory: filters ----
{
  seed();
  assert.deepEqual(emails(await get('people', { app: 'jw' })), ['pat@example.com', 'rex@example.com']);
  assert.deepEqual(emails(await get('people', { status: 'paused' })), ['pat@example.com']);
  assert.deepEqual(emails(await get('people', { status: 'revoked' })), ['rex@example.com']);
  assert.deepEqual(emails(await get('people', { status: 'expired' })), ['eve@example.com']);
  assert.deepEqual(emails(await get('people', { status: 'none' })), ['nobody@example.com']);
  assert.deepEqual(emails(await get('people', { status: 'active' })), [OWNER, 'rex@example.com', 'tess@example.com']);
  assert.deepEqual(emails(await get('people', { app: 'predicts', status: 'active' })), [], 'status is read within the chosen app');
  assert.deepEqual(emails(await get('people', { app: 'jw', status: 'active' })), ['rex@example.com']);
  assert.deepEqual(emails(await get('people', { app: 'workbench', status: 'none' })).length, 5);
  assert.deepEqual(emails(await get('people', { expiry: '7d' })), ['tess@example.com']);
  assert.deepEqual(emails(await get('people', { expiry: '30d' })), ['rex@example.com', 'tess@example.com']);
  assert.deepEqual(emails(await get('people', { expiry: 'expired' })), ['eve@example.com']);
  assert.deepEqual(emails(await get('people', { expiry: 'none' })), [OWNER]);
  assert.deepEqual(emails(await get('people', { persona: 'MF-07' })), ['tess@example.com']);
  assert.deepEqual(emails(await get('people', { persona: 'mf-21' })), ['rex@example.com']);
  assert.deepEqual(emails(await get('people', { persona: 'unset' })).length, 4);
  assert.deepEqual(emails(await get('people', { app: 'ispyadc', expiry: '7d', persona: 'MF-07', q: 'tess' })), ['tess@example.com'], 'filters combine');
  assert.equal((await get('people', { app: 'x' })).code, 400); assert.equal((await get('people', { persona: 'MF-99' })).code, 400);
  console.log('PASS  filters: app, status, expiry and persona preset (MF-01 to MF-21), alone and combined');
}

// ---- Person page read ----
{
  const { db, tess } = seed();
  db.audit.push({ id: 'x1', at: '2026-11-09T10:00:00Z', actor: OWNER_ID, actor_verified: true, product: 'ispyadc', subject_email: 'tess@example.com', action: 'access.add', reason: 'FDY-42', old_value: null, new_value: { role: 'tester' }, via: 'workbench:console' });
  db.audit.push({ id: 'x2', at: '2026-11-09T11:00:00Z', actor: OWNER_ID, actor_verified: true, product: 'jw', subject_email: 'someone-else@example.com', action: 'access.add', reason: null, old_value: null, new_value: {}, via: 'workbench:console' });
  let r = await get('person', { id: tess.id });
  assert.equal(r.code, 200); assert.equal(r.body.person.email, 'tess@example.com'); assert.equal(r.body.person.persona, 'MF-07');
  assert.equal(r.body.person.access.length, 1); assert.equal(r.body.person.plan, null);
  assert.equal(r.body.audit.length, 1, 'only audit rows about this person'); assert.equal(r.body.audit[0].actorEmail, OWNER);
  assert.equal((await get('person', { id: 'nope' })).code, 400);
  assert.equal((await get('person', { id: '99999999-9999-4999-8999-999999999999' })).code, 404);
  // reachable from the directory by URL
  const list = await get('people', { q: 'tess' });
  const page = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'people', id: list.body.people[0].id } }, page);
  assert.equal(page.code, 200); assert.ok(page.body.includes(`data-id="${tess.id}"`)); assert.match(page.body, /id="access-table"/);
  for (const bad of [{ area: 'people', id: 'not-a-uuid' }, { area: 'audit', id: tess.id }, { area: 'apps', id: tess.id }]) {
    const x = mkRes(); await shell({ method: 'GET', headers: H(), query: bad }, x); assert.equal(x.code, 404);
  }
  const anon = mkRes(); await shell({ method: 'GET', headers: {}, query: { area: 'people', id: tess.id } }, anon); assert.equal(anon.code, 404);
  console.log('PASS  Person page: every access, consent and audit row about the person; reachable by /admin/people/<id>; 404 unless Owner');
}

// ---- writes: grant, pause, resume, expire, revoke, restore, role, persona ----
{
  const { db, tess, nan } = seed();
  const last = () => db.audit[db.audit.length - 1];
  const state = async (id, product) => (await get('person', { id })).body.person.access.find((a) => a.product === product);
  let n = db.audit.length;
  const wrote = (action, extra = {}) => {
    assert.equal(db.audit.length, n + 1, action + ' writes exactly one audit row'); n = db.audit.length;
    const a = last(); assert.equal(a.action, action); assert.equal(a.actor, OWNER_ID, 'actor is the signed-in person id'); assert.equal(a.actor_verified, true); assert.equal(a.via, 'workbench:console');
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(a[k], v, action + ' ' + k);
  };

  // grant (no reason given)
  let r = await post('person', { id: nan.id, action: 'grant', product: 'jw', role: 'member' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); wrote('access.add', { reason: null, subject_email: 'nobody@example.com' });
  assert.equal((await state(nan.id, 'jw')).state, 'active');
  r = await post('person', { id: nan.id, action: 'grant', product: 'jw', role: 'editor' });
  assert.equal(r.code, 409); assert.match(r.body.error, /already has Jurisdiction Watch access/); assert.equal(db.audit.length, n, 'a refused grant writes nothing');
  r = await post('person', { id: nan.id, action: 'grant', product: 'ispyadc', role: 'tester', linearIssue: 'fdy-288' });
  wrote('access.add', { reason: 'FDY-288' });
  assert.equal((await state(nan.id, 'ispyadc')).expiresAt.slice(0, 10), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), 'tester expiry defaults to 14 days');

  // pause -> not usable -> resume
  r = await post('person', { id: nan.id, action: 'pause', product: 'jw', reason: 'on leave' });
  assert.equal(r.code, 200); wrote('access.pause', { reason: 'on leave', old_value: { role: 'member', status: 'active', expires_at: null, note: null } });
  assert.equal((await state(nan.id, 'jw')).state, 'paused');
  r = await post('person', { id: nan.id, action: 'pause', product: 'jw' });
  assert.equal(r.body.changed, false); assert.equal(db.audit.length, n, 'pausing twice changes and audits nothing');
  r = await post('person', { id: nan.id, action: 'resume', product: 'jw' }); wrote('access.resume');
  assert.equal((await post('person', { id: nan.id, action: 'resume', product: 'jw' })).code, 409);

  // expire now, set a date, clear it
  r = await post('person', { id: nan.id, action: 'set_expiry', product: 'jw', expiresAt: 'now' });
  assert.equal(r.code, 200); assert.match(r.body.message, /expired now/); wrote('access.update');
  assert.equal((await state(nan.id, 'jw')).state, 'expired');
  r = await post('person', { id: nan.id, action: 'set_expiry', product: 'jw', expiresAt: '2030-01-31' }); wrote('access.update');
  assert.equal((await state(nan.id, 'jw')).expiresAt, '2030-01-31T23:59:59Z');
  r = await post('person', { id: nan.id, action: 'set_expiry', product: 'jw', expiresAt: '' }); wrote('access.update');
  assert.equal((await post('person', { id: nan.id, action: 'set_expiry', product: 'jw', expiresAt: 'someday' })).code, 400);

  // role, revoke, restore
  r = await post('person', { id: nan.id, action: 'set_role', product: 'jw', role: 'editor' }); wrote('access.update');
  r = await post('person', { id: nan.id, action: 'revoke', product: 'jw', reason: 'left' }); wrote('access.revoke', { reason: 'left' });
  assert.equal((await state(nan.id, 'jw')).state, 'revoked');
  assert.equal((await post('person', { id: nan.id, action: 'pause', product: 'jw' })).code, 409, 'a revoked row is restored, not paused');
  r = await post('person', { id: nan.id, action: 'restore', product: 'jw' }); wrote('access.restore');
  assert.equal((await post('person', { id: nan.id, action: 'revoke', product: 'predicts' })).code, 404, 'nothing to revoke');

  // persona
  r = await post('person', { id: tess.id, action: 'set_persona', persona: 'mf-12' });
  assert.equal(r.code, 200); wrote('person.persona', { old_value: { persona_preset: 'MF-07' }, new_value: { persona_preset: 'MF-12' } });
  r = await post('person', { id: tess.id, action: 'set_persona', persona: 'MF-12' }); assert.equal(r.body.changed, false); assert.equal(db.audit.length, n);
  r = await post('person', { id: tess.id, action: 'set_persona', persona: '' }); wrote('person.persona');
  assert.equal((await post('person', { id: tess.id, action: 'set_persona', persona: 'MF-40' })).code, 400);

  // every call went through an audited function; nothing wrote a table directly
  const writes = db.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/rpc/estate_access_for'));
  assert.ok(writes.length > 10);
  assert.ok(writes.every((c) => ['/rest/v1/rpc/estate_access_set', '/rest/v1/rpc/estate_person_set_persona'].includes(c.path)), 'writes only through audited functions');
  assert.ok(writes.every((c) => c.body.p_actor === OWNER_ID && c.body.p_actor_verified === true));

  // a database failure surfaces and writes nothing
  db.failRpc = 'estate_access_set';
  r = await post('person', { id: nan.id, action: 'pause', product: 'ispyadc' });
  assert.equal(r.code, 500); assert.equal(db.audit.length, n); db.failRpc = null;
  console.log('PASS  grant, pause, resume, expire, revoke, restore, role and persona: one audit row each, actor = person id, reason optional');
}

// ---- guards: self-lockout, console-role step-up, non-owner ----
{
  const { db, nan } = seed(); const n = db.audit.length;
  for (const body of [{ action: 'pause' }, { action: 'revoke' }, { action: 'set_expiry', expiresAt: 'now' }]) {
    const r = await post('person', { id: OWNER_ID, product: 'workbench', ...body });
    assert.equal(r.code, 409); assert.match(r.body.error, /lock the console/);
  }
  assert.equal((await post('person', { id: OWNER_ID, action: 'pause', product: 'ispyadc' })).code, 200, 'the Owner can still change their other apps');
  const stale = ownerHeaders(OWNER_ID, OWNER, Math.floor(Date.now() / 1000) - A.FRESH_S - 30);
  let r = await post('person', { id: nan.id, action: 'grant', product: 'workbench', role: 'owner' }, stale);
  assert.equal(r.code, 403); assert.equal(r.body.error, 'step_up_required', 'granting a console role needs a fresh sign-in');
  r = await post('people', { email: 'new-owner@example.com', product: 'workbench', role: 'owner' }, stale);
  assert.equal(r.code, 403);
  r = await post('person', { id: nan.id, action: 'grant', product: 'jw', role: 'member' }, stale);
  assert.equal(r.code, 200, 'ordinary grants do not need step-up');
  assert.equal(db.audit.length, n + 2);
  for (const route of ['people', 'person']) {
    assert.equal((await call({ method: 'POST', headers: {}, query: { route }, body: { id: nan.id, action: 'revoke', product: 'jw' } })).code, 404);
    assert.equal((await call({ method: 'GET', headers: { cookie: 'wb_session=x.y' }, query: { route, id: nan.id } })).code, 404);
  }
  console.log('PASS  guards: no self-lockout, console-role grants need a fresh sign-in, 404 without an Owner session');
}

// ---- add a person: lowercased, duplicates refused kindly ----
{
  const { db, tess } = seed(); const n = db.audit.length;
  let r = await post('people', { email: '  New.Person@Example.COM ', product: 'predicts', role: 'member', reason: 'pilot' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const made = db.people.find((p) => p.email === 'new.person@example.com');
  assert.ok(made, 'the email is stored lowercased'); assert.equal(r.body.url, '/admin/people/' + made.id);
  const a = db.audit.filter((x) => x.action === 'access.add').pop();
  assert.equal(a.actor, OWNER_ID); assert.equal(a.reason, 'pilot'); assert.equal(a.subject_email, 'new.person@example.com');
  const m = db.audit.length;
  r = await post('people', { email: 'TESS@example.com', product: 'jw', role: 'member' });
  assert.equal(r.code, 409); assert.match(r.body.error, /tess@example\.com is already in the directory/); assert.equal(r.body.url, '/admin/people/' + tess.id);
  assert.equal(db.audit.length, m, 'a duplicate writes nothing'); assert.equal(db.people.filter((p) => p.email === 'tess@example.com').length, 1);
  assert.equal((await post('people', { email: 'not an email', product: 'jw', role: 'member' })).code, 400);
  assert.equal((await post('people', { email: 'x@y.io', product: 'jw', role: 'owner' })).code, 400);
  assert.ok(db.audit.length > n);
  console.log('PASS  add a person: email lowercased; a duplicate is refused with a friendly message and a link');
}
console.log('ALL PASS  people');
