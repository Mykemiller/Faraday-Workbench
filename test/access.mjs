// FDY-289 (ADM-1.2): People > Access. The FDY-42 ISpyaDC access screen, repointed from
// ispyadc_access (ISpyaDC's own project) to product_access (Faraday project) with app = ispyadc.
// Mocked client (test/_fakedb.mjs). No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const router = require('../api/admin/[route].js');
const shell = require('../api/admin/shell.js');
const L = require('../api/_admin/people-logic.js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const get = (query = {}) => call({ method: 'GET', headers: H(), query: { route: 'access', ...query } });
const post = (body) => call({ method: 'POST', headers: H(), query: { route: 'access' }, body });
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner'); db.addAccess(owner, 'ispyadc', 'admin');
const tess = db.addPerson('tess@example.com'); db.addAccess(tess, 'ispyadc', 'tester', 'active', inDays(5));
const old = db.addPerson('old@example.com'); db.addAccess(old, 'ispyadc', 'tester', 'active', inDays(-1));
const jane = db.addPerson('jane@example.com'); db.addAccess(jane, 'jw', 'member');

// ---- the screen reads product_access for the app, ISpyaDC by default ----
{
  let r = await get();
  assert.equal(r.code, 200); assert.equal(r.body.app, 'ispyadc'); assert.equal(r.body.label, 'ISpyaDC');
  assert.deepEqual(r.body.roles, ['user', 'tester', 'admin'], 'ISpyaDC keeps its roles: admin, tester, user');
  assert.equal(r.body.testerDefaultDays, 14);
  assert.deepEqual(r.body.rows.map((x) => x.email).sort(), ['old@example.com', OWNER, 'tess@example.com']);
  assert.equal(r.body.rows.find((x) => x.email === 'old@example.com').state, 'expired');
  const q = db.calls.filter((c) => c.path === '/rest/v1/product_access').pop();
  assert.match(q.search, /product=eq\.ispyadc/, 'reads product_access with app = ispyadc');
  assert.equal(db.calls.some((c) => /ispyadc_access/.test(c.path)), false, 'ispyadc_access is never read');
  r = await get({ app: 'jw' });
  assert.deepEqual(r.body.rows.map((x) => x.email), ['jane@example.com']); assert.deepEqual(r.body.roles, ['member', 'editor', 'admin']);
  assert.equal((await get({ app: 'nope' })).code, 400);
  console.log('PASS  Access reads product_access for app = ispyadc (roles admin, tester, user); other apps by ?app=');
}

// ---- grant by email ----
{
  const n = db.audit.length;
  let r = await post({ email: '  New.Tester@Example.COM ', role: 'tester' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const made = db.people.find((p) => p.email === 'new.tester@example.com'); assert.ok(made, 'lowercased');
  const row = db.access.find((a) => a.person_id === made.id && a.product === 'ispyadc');
  assert.equal(row.role, 'tester'); assert.equal(row.status, 'active');
  assert.equal(row.expires_at.slice(0, 10), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), 'tester expiry defaults to 14 days');
  const a = db.audit[db.audit.length - 1];
  assert.equal(a.action, 'access.add'); assert.equal(a.actor, OWNER_ID); assert.equal(a.actor_verified, true); assert.equal(a.product, 'ispyadc'); assert.equal(a.reason, null);
  r = await post({ email: 'admin2@example.com', role: 'admin' });
  assert.equal(db.access.find((x) => x.role === 'admin' && x.person_id !== OWNER_ID).expires_at, null, 'an admin gets no default expiry');
  r = await post({ email: 'jane@example.com', role: 'user', expiresAt: '2030-06-30', reason: 'pilot' });
  assert.equal(r.code, 200, 'a person already in the directory can be granted this app');
  assert.equal(db.people.filter((p) => p.email === 'jane@example.com').length, 1);
  assert.equal(db.access.find((x) => x.person_id === jane.id && x.product === 'ispyadc').expires_at, '2030-06-30T23:59:59Z');
  assert.equal(db.audit[db.audit.length - 1].reason, 'pilot');
  const m = db.audit.length;
  r = await post({ email: 'TESS@example.com', role: 'admin' });
  assert.equal(r.code, 409); assert.match(r.body.error, /already has ISpyaDC access \(tester, active\)/); assert.equal(r.body.url, '/admin/people/' + tess.id);
  assert.equal(db.audit.length, m, 'a duplicate writes nothing');
  assert.equal((await post({ email: 'nope', role: 'tester' })).code, 400);
  assert.equal((await post({ email: 'x@y.io', role: 'owner' })).code, 400, 'ISpyaDC has no owner role');
  assert.equal((await post({ email: 'x@y.io', role: 'tester', expiresAt: 'soon' })).code, 400);
  assert.ok(db.audit.length > n);
  console.log('PASS  grant by email: lowercased, 14-day tester default, existing people reuse their record, duplicates refused with a link');
}

// ---- changing a row uses the Person route; an expired row is expired ----
{
  const person = (body) => call({ method: 'POST', headers: H(), query: { route: 'person' }, body });
  let r = await person({ id: tess.id, action: 'set_role', product: 'ispyadc', role: 'admin' }); assert.equal(r.code, 200);
  r = await person({ id: tess.id, action: 'set_expiry', product: 'ispyadc', expiresAt: 'now' }); assert.equal(r.code, 200);
  r = await get();
  const t = r.body.rows.find((x) => x.email === 'tess@example.com');
  assert.equal(t.role, 'admin'); assert.equal(t.state, 'expired');
  const usable = await (await db.fetch('https://x/rest/v1/rpc/estate_access_for', { method: 'POST', body: JSON.stringify({ p_email: 'tess@example.com', p_product: 'ispyadc' }) })).json();
  assert.equal(usable.usable, false, 'the row ISpyaDC reads says an expired grant is not usable');
  console.log('PASS  role and expiry changes show on the screen; an expired row is not usable on the read path');
}

// ---- gates and the retired route ----
{
  for (const headers of [{}, { cookie: 'wb_session=x.y' }]) {
    assert.equal((await call({ method: 'GET', headers, query: { route: 'access' } })).code, 404);
    assert.equal((await call({ method: 'POST', headers, query: { route: 'access' }, body: { email: 'x@y.io', role: 'admin' } })).code, 404);
    const p = mkRes(); await shell({ method: 'GET', headers, query: { area: 'people', id: 'access' } }, p); assert.equal(p.code, 404);
  }
  const page = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'people', id: 'access' } }, page);
  assert.equal(page.code, 200); assert.match(page.body, /id="acc-table"/); assert.match(page.body, /href="\/admin\/people\/access" aria-current="page"/);
  const bad = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'audit', id: 'access' } }, bad); assert.equal(bad.code, 404);
  assert.equal((await call({ method: 'DELETE', headers: H(), query: { route: 'access' } })).code, 405);
  assert.equal(fs.existsSync(path.join(HERE, '..', 'api', 'workbench-ispyadc-access.js')), false, 'the route that wrote ispyadc_access is gone');
  const src = ['api/_admin/access.js', 'api/_admin/person.js', 'api/_admin/people.js', 'index.html'].map((f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8')).join('\n');
  assert.equal(/ISPYADC_SUPABASE_URL|ISPYADC_SERVICE_ROLE_KEY/.test(src), false, 'the Workbench no longer needs keys to ISpyaDC’s project');
  assert.deepEqual(L.PRODUCTS.ispyadc.roles.slice().sort(), ['admin', 'tester', 'user']);
  console.log('PASS  /admin/people/access is Owner-only (404 otherwise); the old ispyadc_access route and its keys are gone');
}
console.log('ALL PASS  access');
