// FDY-285 (revised): sign-in with the Workbench key, the Owner role, the session, and the
// /api/admin/* 404 rule. Covers: no session, expired session, non-owner, owner, step-up,
// revoke, rotation, fail-closed paths. No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, SHARED_KEY, OWNER, OWNER_ID, mkRes, cookieFrom, fakeWorld, ownerHeaders, signedInHeaders, sessionSecret } from './_session.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = require('../api/_auth.js');
const auth = require('../api/auth.js');
const adminRouter = require('../api/admin/[route].js');
const adminSession = (req, res) => adminRouter({ ...req, query: { route: 'session' } }, res);
const subscribers = require('../api/workbench-subscribers.js');

const ADMIN = 'admin@example.com', ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const post = (body, headers = {}) => ({ method: 'POST', headers, body });
const call = async (h, req) => { const r = mkRes(); await h(req, r); return r; };
const signIn = (key = SHARED_KEY, headers = {}) => call(auth, post({ action: 'sign_in', key }, headers));

function freshWorld() {
  const w = fakeWorld();
  w.access[OWNER] = { role: 'owner', status: 'active', person_id: OWNER_ID };
  w.access[ADMIN] = { role: 'admin', status: 'active', person_id: ADMIN_ID }; // not Owner (D4)
  globalThis.fetch = w.fetch;
  return w;
}
configure();
process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';

// ---- cookie: signed, expiring, tamper-proof, bound to the key ----
{
  const now = 1_800_000_000;
  const tok = A.sign(A.ownerPayload(OWNER_ID, OWNER, now), sessionSecret());
  assert.equal(A.unsign(tok, sessionSecret(), now + 60).pid, OWNER_ID);
  assert.equal(A.unsign(tok, sessionSecret(), now + A.OWNER_TTL_S - 1).pid, OWNER_ID, 'valid just under 8 hours');
  assert.equal(A.unsign(tok, sessionSecret(), now + A.OWNER_TTL_S), null, 'expired at 8 hours');
  assert.equal(A.OWNER_TTL_S, 8 * 60 * 60);
  assert.equal(A.unsign(tok, 'another-secret', now + 60), null);
  const [b, m] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), pid: ADMIN_ID })).toString('base64url') + '.' + m;
  assert.equal(A.unsign(forged, sessionSecret(), now + 60), null, 'an edited payload is rejected');
  assert.equal(A.unsign('garbage', sessionSecret()), null); assert.equal(A.unsign('', sessionSecret()), null);
  assert.notEqual(A.sessionSecret(), SHARED_KEY, 'the cookie key is derived, never the Workbench key itself');
  console.log('PASS  cookie is signed, lasts 8 hours, rejects tampering, and is keyed from the Workbench key');
}

// ---- no session ----
{
  freshWorld();
  let r = await call(adminSession, { method: 'GET', headers: {} });
  assert.equal(r.code, 404); assert.deepEqual(r.body, { error: 'Not found' });
  r = await call(subscribers, { method: 'GET', headers: {} });
  assert.equal(r.code, 401);
  r = await call(subscribers, { method: 'GET', headers: { 'x-workbench-key': SHARED_KEY } });
  assert.equal(r.code, 401, 'the key in a header does not open a route; only a session does');
  r = await call(auth, { method: 'GET', headers: {} });
  assert.equal(r.code, 200); assert.deepEqual(r.body, { signedIn: false });
  console.log('PASS  no session: /api/admin/* 404, operator routes 401, key-as-header refused');
}

// ---- sign-in: the key, once; wrong key writes nothing ----
{
  const w = freshWorld();
  let r = await signIn('wrong-key');
  assert.equal(r.code, 401); assert.equal(r.body.error, 'That key did not work.'); assert.equal(cookieFrom(r), ''); assert.equal(w.audit.length, 0);
  r = await signIn('');
  assert.equal(r.code, 401);
  r = await signIn(SHARED_KEY, { 'user-agent': 'UA', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'owner'); assert.equal(r.body.personId, OWNER_ID); assert.equal(r.body.email, OWNER); assert.equal(r.body.fresh, true);
  const sc = r.headers['set-cookie'];
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=28800/); assert.match(sc, /Path=\//);
  const cookie = cookieFrom(r);
  assert.equal(w.audit.length, 1);
  const a = w.audit[0];
  assert.equal(a.actor, OWNER_ID, 'the audit actor is the owner person id');
  assert.equal(a.actor_verified, true); assert.equal(a.action, 'workbench.sign_in'); assert.equal(a.via, 'workbench:key');
  assert.equal(a.product, 'workbench'); assert.equal(a.subject_email, OWNER); assert.equal(a.new_value.ip, '203.0.113.9');
  assert.equal(JSON.stringify(w.audit).includes(SHARED_KEY), false, 'the key is never logged');
  r = await call(adminSession, { method: 'GET', headers: { cookie } });
  assert.equal(r.code, 200); assert.equal(r.body.personId, OWNER_ID);
  r = await call(auth, { method: 'GET', headers: { cookie } });
  assert.equal(r.body.signedIn, true); assert.equal(r.body.kind, 'owner');
  assert.equal(JSON.stringify(r.body).includes('svc'), false);
  console.log('PASS  the key signs the owner in: 8-hour httpOnly cookie, audited with the person id');
}

// ---- non-owner: the owner address must hold owner; anything else is refused ----
{
  const w = freshWorld();
  w.access[OWNER].role = 'admin';
  let r = await signIn();
  assert.equal(r.code, 401); assert.equal(cookieFrom(r), ''); assert.equal(w.audit.length, 0, 'a role of admin cannot sign in with the key');
  w.access[OWNER].role = 'owner'; w.access[OWNER].status = 'revoked';
  assert.equal((await signIn()).code, 401, 'a revoked owner cannot sign in');
  w.access[OWNER].status = 'active';
  const h = ownerHeaders(ADMIN_ID, ADMIN);
  assert.equal((await call(adminSession, { method: 'GET', headers: h })).code, 404);
  assert.equal((await call(subscribers, { method: 'GET', headers: h })).code, 401);
  console.log('PASS  a role of admin, or a revoked owner, gets no session even with the right key');
}

// ---- owner email not configured: refused, never guessed ----
{
  freshWorld();
  const keep = process.env.WORKBENCH_OWNER_EMAIL; delete process.env.WORKBENCH_OWNER_EMAIL;
  const r = await signIn();
  assert.equal(r.code, 503); assert.match(r.body.error, /WORKBENCH_OWNER_EMAIL/); assert.equal(cookieFrom(r), '');
  process.env.WORKBENCH_OWNER_EMAIL = keep;
  console.log('PASS  no WORKBENCH_OWNER_EMAIL: sign-in refused with a clear message');
}

// ---- expired session ----
{
  freshWorld();
  const old = Math.floor(Date.now() / 1000) - A.OWNER_TTL_S - 5;
  const h = ownerHeaders(OWNER_ID, OWNER, old);
  assert.equal((await call(adminSession, { method: 'GET', headers: h })).code, 404);
  assert.equal((await call(subscribers, { method: 'GET', headers: h })).code, 401);
  assert.deepEqual((await call(auth, { method: 'GET', headers: h })).body, { signedIn: false });
  console.log('PASS  expired session is refused everywhere');
}

// ---- a live session ends the moment access is revoked, expires or cannot be read ----
{
  const w = freshWorld();
  const cookie = signedInHeaders().cookie;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 200);
  w.access[OWNER].status = 'revoked';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 404, 'revoke ends it on the next request');
  w.access[OWNER].status = 'active'; w.access[OWNER].expires_at = '2020-01-01T00:00:00Z';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 404, 'expiry ends it');
  delete w.access[OWNER].expires_at; w.failAccess = true;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 404, 'an unreadable access row fails closed');
  w.failAccess = false;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 200, 'restored access works again');
  console.log('PASS  revoke, expiry or an unreadable access row end the session at once');
}

// ---- a sign-in that cannot be audited is refused ----
{
  const w = freshWorld(); w.failAudit = true;
  const r = await signIn();
  assert.equal(r.code, 503); assert.equal(cookieFrom(r), '');
  console.log('PASS  sign-in is refused when the audit row cannot be written');
}

// ---- step-up: a repeat sign-in while signed in is audited as step-up and is fresh ----
{
  const w = freshWorld();
  const first = await signIn(); const cookie = cookieFrom(first);
  const r = await call(auth, post({ action: 'sign_in', key: SHARED_KEY }, { cookie }));
  assert.equal(r.code, 200); assert.equal(w.audit[1].action, 'workbench.step_up'); assert.equal(w.audit[1].actor, OWNER_ID);
  const now = Math.floor(Date.now() / 1000);
  const stale = { kind: 'owner', freshAt: now - A.FRESH_S - 5 }, fresh = { kind: 'owner', freshAt: now - 30 };
  assert.equal(A.isFresh(fresh), true); assert.equal(A.isFresh(stale), false);
  let res = mkRes(); assert.equal(A.requireFresh(stale, res), false); assert.equal(res.code, 403); assert.equal(res.body.error, 'step_up_required');
  res = mkRes(); assert.equal(A.requireFresh(fresh, res), true); assert.equal(res.code, 0);
  const old = await call(adminSession, { method: 'GET', headers: ownerHeaders(OWNER_ID, OWNER, now - 3600) });
  assert.equal(old.code, 200); assert.equal(old.body.fresh, false);
  console.log('PASS  step-up: only a sign-in under 10 minutes old is fresh');
}

// ---- rotating the Workbench key ends every session ----
{
  freshWorld();
  const cookie = signedInHeaders().cookie;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 200);
  process.env.WORKBENCH_REFRESH_SECRET = 'rotated-key-value';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 404, 'rotation ends the session');
  process.env.WORKBENCH_REFRESH_SECRET = SHARED_KEY;
  console.log('PASS  rotating WORKBENCH_REFRESH_SECRET ends every session');
}

// ---- unconfigured deployment, cross-site request, sign-out ----
{
  freshWorld();
  const cookie = signedInHeaders().cookie;
  delete process.env.WORKBENCH_REFRESH_SECRET;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 404);
  assert.equal((await call(subscribers, { method: 'GET', headers: { cookie } })).code, 503);
  assert.equal((await signIn()).code, 503, 'no key configured: sign-in refused');
  process.env.WORKBENCH_REFRESH_SECRET = SHARED_KEY;
  const h = signedInHeaders();
  let r = await call(subscribers, { method: 'POST', headers: { ...h, origin: 'https://evil.example', host: 'faraday-stuff.com' }, body: {} });
  assert.equal(r.code, 401, 'a cross-site POST is refused');
  r = await call(auth, post({ action: 'sign_out' }, h));
  assert.equal(r.code, 200); assert.match(r.headers['set-cookie'], /Max-Age=0/);
  r = await call(auth, post({ action: 'sign_up' }, {}));
  assert.equal(r.code, 400, 'only sign_in and sign_out exist');
  console.log('PASS  unset key fails closed; cross-site POST refused; sign-out clears the cookie; no other actions');
}

// ---- quality gates ----
{
  freshWorld();
  // Every function file under api/admin/, and every route name the router serves (plus an unknown one).
  const dir = path.join(HERE, '..', 'api', 'admin');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const targets = [];
  for (const f of walk(dir)) {
    const h = require(f); const rel = path.relative(dir, f);
    if (h.ROUTES) for (const name of [...Object.keys(h.ROUTES), 'no-such-route']) targets.push([`${rel} -> ${name}`, h, { route: name }]);
    else for (const area of [undefined, 'people', 'audit']) targets.push([`${rel} area=${area || 'home'}`, h, { area }]);
  }
  assert.ok(targets.length >= 2);
  for (const [label, h, query] of targets) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      for (const headers of [{}, { 'x-workbench-key': SHARED_KEY }, { cookie: 'wb_session=forged.forged' }, { authorization: 'Bearer svc' }]) {
        const r = await call(h, { method, headers, query, body: {} });
        assert.equal(r.code, 404, `${label} ${method} unauthenticated must be 404, got ${r.code}`);
      }
    }
  }
  console.log(`PASS  gate: every /api/admin/* route (${targets.length}) answers 404 without a session, on every method`);
  const html = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');
  assert.equal(/service_role/i.test(html), false, 'index.html must not contain service_role / SERVICE_ROLE');
  assert.equal(/wb\.refresh\.key["']\s*,/.test(html), false, 'the key is no longer stored in the browser');
  assert.equal(/x-workbench-key/i.test(html), false);
  assert.equal(/request_code|verify_code|break_glass/.test(html), false, 'the email-code and break-glass actions are gone');
  console.log('PASS  gate: index.html has no service_role string, stores no key, and sends no retired action');
}
console.log('ALL PASS  auth');
