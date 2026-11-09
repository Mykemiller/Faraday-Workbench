// FDY-285 (ADM-0.2): email-code sign-in, Owner role, break-glass, and the /api/admin/* 404 rule.
// Covers: no session, expired session, non-owner, owner, break-glass use. No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, SESSION_SECRET, SHARED_KEY, cookieOf, mkRes, cookieFrom, fakeWorld, ownerHeaders, breakGlassHeaders } from './_session.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = require('../api/_auth.js');
const auth = require('../api/auth.js');
const adminSession = require('../api/admin/session.js');
const subscribers = require('../api/workbench-subscribers.js');

const OWNER = 'owner@example.com', OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'admin@example.com', ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const post = (body, headers = {}) => ({ method: 'POST', headers, body });
const call = async (h, req) => { const r = mkRes(); await h(req, r); return r; };

function freshWorld() {
  const w = fakeWorld();
  w.access[OWNER] = { role: 'owner', status: 'active', person_id: OWNER_ID };
  w.access[ADMIN] = { role: 'admin', status: 'active', person_id: ADMIN_ID }; // not Owner (D4)
  globalThis.fetch = w.fetch;
  return w;
}
configure();
process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
process.env.WORKBENCH_RESEND_API_KEY = 're_test'; process.env.WORKBENCH_ALERT_FROM = 'wb@example.com'; process.env.WORKBENCH_ALERT_TO = 'owner@example.com';

// ---- cookie: signed, expiring, tamper-proof ----
{
  const now = 1_800_000_000;
  const tok = A.sign(A.ownerPayload(OWNER_ID, OWNER, now), SESSION_SECRET);
  assert.equal(A.unsign(tok, SESSION_SECRET, now + 60).pid, OWNER_ID);
  assert.equal(A.unsign(tok, SESSION_SECRET, now + A.OWNER_TTL_S - 1).pid, OWNER_ID, 'valid just under 8 hours');
  assert.equal(A.unsign(tok, SESSION_SECRET, now + A.OWNER_TTL_S), null, 'expired at 8 hours');
  assert.equal(A.OWNER_TTL_S, 8 * 60 * 60);
  assert.equal(A.unsign(tok, 'another-secret-another-secret-another!!', now + 60), null);
  const [b, m] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url')), pid: ADMIN_ID })).toString('base64url') + '.' + m;
  assert.equal(A.unsign(forged, SESSION_SECRET, now + 60), null, 'an edited payload is rejected');
  assert.equal(A.unsign('garbage', SESSION_SECRET), null); assert.equal(A.unsign('', SESSION_SECRET), null);
  console.log('PASS  cookie is signed, lasts 8 hours, rejects tampering and other secrets');
}

// ---- no session ----
{
  freshWorld();
  let r = await call(adminSession, { method: 'GET', headers: {} });
  assert.equal(r.code, 404); assert.deepEqual(r.body, { error: 'Not found' });
  r = await call(subscribers, { method: 'GET', headers: {} });
  assert.equal(r.code, 401);
  r = await call(subscribers, { method: 'GET', headers: { 'x-workbench-key': SHARED_KEY } });
  assert.equal(r.code, 401, 'the shared key no longer opens a route by itself');
  r = await call(auth, { method: 'GET', headers: {} });
  assert.equal(r.code, 200); assert.deepEqual(r.body, { signedIn: false });
  console.log('PASS  no session: /api/admin/* 404, operator routes 401, raw shared key refused');
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

// ---- non-owner: gets no code, cannot verify, a forged cookie for them is refused ----
{
  const w = freshWorld();
  let r = await call(auth, post({ action: 'request_code', email: ADMIN }));
  const generic = r.body;
  assert.equal(r.code, 200); assert.equal(w.otp.length, 0, 'no code is mailed to a non-owner');
  r = await call(auth, post({ action: 'request_code', email: 'stranger@example.com' }));
  assert.deepEqual(r.body, generic); assert.equal(w.otp.length, 0);
  r = await call(auth, post({ action: 'request_code', email: OWNER }));
  assert.deepEqual(r.body, generic, 'the answer is identical whether or not the address has access');
  assert.equal(w.otp.length, 1);
  w.codes[ADMIN] = '123456'; // even holding a valid Supabase code, a non-owner is refused
  r = await call(auth, post({ action: 'verify_code', email: ADMIN, code: '123456' }));
  assert.equal(r.code, 401); assert.equal(cookieFrom(r), ''); assert.equal(w.audit.length, 0);
  const h = ownerHeaders(ADMIN_ID, ADMIN);
  assert.equal((await call(adminSession, { method: 'GET', headers: h })).code, 404);
  assert.equal((await call(subscribers, { method: 'GET', headers: h })).code, 401);
  console.log('PASS  non-owner (role admin, or unknown): no code sent, no session, same reply as an owner');
}

// ---- owner: code -> session; audit names the person id ----
let ownerCookie;
{
  const w = freshWorld();
  await call(auth, post({ action: 'request_code', email: '  Owner@Example.com ' }));
  assert.deepEqual(w.otp, [{ email: OWNER, create_user: true }]);
  let r = await call(auth, post({ action: 'verify_code', email: OWNER, code: '000000' }));
  assert.equal(r.code, 401); assert.equal(cookieFrom(r), ''); assert.equal(w.audit.length, 0, 'a wrong code writes nothing');
  r = await call(auth, post({ action: 'verify_code', email: OWNER, code: '123 456' }, { 'user-agent': 'UA', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));
  assert.equal(r.code, 200); assert.equal(r.body.kind, 'owner'); assert.equal(r.body.personId, OWNER_ID);
  const sc = r.headers['set-cookie'];
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=28800/); assert.match(sc, /Path=\//);
  ownerCookie = cookieFrom(r);
  assert.equal(w.audit.length, 1);
  const a = w.audit[0];
  assert.equal(a.actor, OWNER_ID, 'the audit actor is the signed-in person id');
  assert.notEqual(a.actor, OWNER); assert.equal(a.actor_verified, true);
  assert.equal(a.action, 'workbench.sign_in'); assert.equal(a.product, 'workbench'); assert.equal(a.subject_email, OWNER);
  assert.equal(a.via, 'workbench:email-code'); assert.equal(a.new_value.ip, '203.0.113.9');
  r = await call(adminSession, { method: 'GET', headers: { cookie: ownerCookie } });
  assert.equal(r.code, 200); assert.equal(r.body.personId, OWNER_ID); assert.equal(r.body.fresh, true);
  r = await call(auth, { method: 'GET', headers: { cookie: ownerCookie } });
  assert.equal(r.body.signedIn, true); assert.equal(r.body.email, OWNER);
  assert.equal(JSON.stringify(r.body).includes('svc'), false);
  console.log('PASS  owner: email code sets an 8-hour httpOnly cookie; audit actor = person id, verified');

  // a second code while signed in is the step-up
  await call(auth, post({ action: 'request_code', email: OWNER }));
  r = await call(auth, post({ action: 'verify_code', email: OWNER, code: '123456' }, { cookie: ownerCookie }));
  assert.equal(r.code, 200); assert.equal(w.audit[1].action, 'workbench.step_up'); assert.equal(w.audit[1].actor, OWNER_ID);

  // revoked mid-session: the cookie is still valid but access is re-read on every request
  w.access[OWNER].status = 'revoked';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie: ownerCookie } })).code, 404);
  w.access[OWNER].status = 'active'; w.access[OWNER].expires_at = '2020-01-01T00:00:00Z';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie: ownerCookie } })).code, 404);
  delete w.access[OWNER].expires_at; w.failAccess = true;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie: ownerCookie } })).code, 404, 'unreadable access fails closed');
  console.log('PASS  revoke, expiry or an unreadable access row end the session at once');

  // a sign-in that cannot be audited is refused
  w.failAccess = false; w.failAudit = true;
  await call(auth, post({ action: 'request_code', email: OWNER }));
  r = await call(auth, post({ action: 'verify_code', email: OWNER, code: '123456' }));
  assert.equal(r.code, 503); assert.equal(cookieFrom(r), '');
  console.log('PASS  sign-in is refused when the audit row cannot be written');
}

// ---- step-up (fresh code) ----
{
  freshWorld();
  const now = Math.floor(Date.now() / 1000);
  const stale = { kind: 'owner', freshAt: now - A.FRESH_S - 5 }, fresh = { kind: 'owner', freshAt: now - 30 };
  assert.equal(A.isFresh(fresh), true); assert.equal(A.isFresh(stale), false);
  assert.equal(A.isFresh({ kind: 'break-glass', freshAt: null }), false, 'break-glass never satisfies step-up');
  let r = mkRes(); assert.equal(A.requireFresh(stale, r), false); assert.equal(r.code, 403); assert.equal(r.body.error, 'step_up_required');
  r = mkRes(); assert.equal(A.requireFresh(fresh, r), true); assert.equal(r.code, 0);
  r = await call(adminSession, { method: 'GET', headers: ownerHeaders(OWNER_ID, OWNER, now - 3600) });
  assert.equal(r.code, 200); assert.equal(r.body.fresh, false);
  console.log('PASS  step-up: only an owner code under 10 minutes old is fresh');
}

// ---- break-glass ----
{
  const w = freshWorld();
  let r = await call(auth, post({ action: 'break_glass', key: 'wrong' }));
  assert.equal(r.code, 401); assert.equal(w.audit.length, 0); assert.equal(w.mail.length, 0);
  r = await call(auth, post({ action: 'break_glass', key: SHARED_KEY, reason: 'email down' }, { 'user-agent': 'UA' }));
  assert.equal(r.code, 200); assert.equal(r.body.kind, 'break-glass'); assert.equal(r.body.alertEmailSent, true);
  assert.equal(w.mail.length, 1); assert.deepEqual(w.mail[0].to, ['owner@example.com']); assert.match(w.mail[0].subject, /break-glass/i);
  assert.equal(JSON.stringify(w.mail[0]).includes(SHARED_KEY), false, 'the key is never mailed');
  assert.equal(w.audit.length, 1);
  assert.equal(w.audit[0].action, 'workbench.break_glass'); assert.equal(w.audit[0].actor, 'break-glass:shared-key');
  assert.equal(w.audit[0].actor_verified, false); assert.equal(w.audit[0].via, 'workbench:break-glass');
  assert.equal(w.audit[0].reason, 'email down'); assert.equal(w.audit[0].new_value.alert_email_sent, true);
  assert.equal(JSON.stringify(w.audit[0]).includes(SHARED_KEY), false, 'the key is never logged');
  assert.match(r.headers['set-cookie'], /Max-Age=3600/);
  const bg = cookieFrom(r);
  r = await call(adminSession, { method: 'GET', headers: { cookie: bg } });
  assert.equal(r.code, 200); assert.equal(r.body.kind, 'break-glass'); assert.equal(r.body.fresh, false);
  console.log('PASS  break-glass: wrong key refused; a use writes admin_audit, emails the owner, 1-hour session');

  // rotating the shared key ends break-glass sessions
  process.env.WORKBENCH_REFRESH_SECRET = 'rotated-key';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie: bg } })).code, 404);
  process.env.WORKBENCH_REFRESH_SECRET = SHARED_KEY;

  // fail closed: no audit -> no session; no alert config -> refused; a provider failure is recorded
  w.failAudit = true;
  r = await call(auth, post({ action: 'break_glass', key: SHARED_KEY }));
  assert.equal(r.code, 503); assert.equal(cookieFrom(r), '');
  w.failAudit = false; const keep = process.env.WORKBENCH_RESEND_API_KEY; delete process.env.WORKBENCH_RESEND_API_KEY;
  r = await call(auth, post({ action: 'break_glass', key: SHARED_KEY }));
  assert.equal(r.code, 503); assert.match(r.body.error, /WORKBENCH_RESEND_API_KEY/); assert.equal(cookieFrom(r), '');
  process.env.WORKBENCH_RESEND_API_KEY = keep; w.failMail = true; const n = w.audit.length;
  r = await call(auth, post({ action: 'break_glass', key: SHARED_KEY }));
  assert.equal(r.code, 200); assert.equal(r.body.alertEmailSent, false); assert.equal(w.audit[n].new_value.alert_email_sent, false);
  console.log('PASS  break-glass fails closed without an audit row or alert config; rotation ends its sessions');
}

// ---- unconfigured deployment, cross-site request, sign-out ----
{
  freshWorld();
  delete process.env.WORKBENCH_SESSION_SECRET;
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie: ownerCookie } })).code, 404);
  assert.equal((await call(subscribers, { method: 'GET', headers: { cookie: ownerCookie } })).code, 503);
  assert.equal((await call(auth, post({ action: 'request_code', email: OWNER }))).code, 503);
  process.env.WORKBENCH_SESSION_SECRET = 'short';
  assert.equal((await call(adminSession, { method: 'GET', headers: { cookie: ownerCookie } })).code, 404, 'a short secret counts as unset');
  process.env.WORKBENCH_SESSION_SECRET = SESSION_SECRET;
  const h = ownerHeaders(OWNER_ID, OWNER);
  let r = await call(subscribers, { method: 'POST', headers: { ...h, origin: 'https://evil.example', host: 'faraday-stuff.com' }, body: {} });
  assert.equal(r.code, 401, 'a cross-site POST is refused');
  r = await call(auth, post({ action: 'sign_out' }, h));
  assert.equal(r.code, 200); assert.match(r.headers['set-cookie'], /Max-Age=0/);
  console.log('PASS  unset or short session secret fails closed; cross-site POST refused; sign-out clears the cookie');
}

// ---- quality gates ----
{
  freshWorld();
  const dir = path.join(HERE, '..', 'api', 'admin');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const routes = walk(dir);
  assert.ok(routes.length >= 1);
  for (const f of routes) {
    const h = require(f);
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      for (const headers of [{}, { 'x-workbench-key': SHARED_KEY }, { cookie: 'wb_session=forged.forged' }, { authorization: 'Bearer svc' }]) {
        const r = await call(h, { method, headers, body: {} });
        assert.equal(r.code, 404, `${path.relative(dir, f)} ${method} unauthenticated must be 404, got ${r.code}`);
      }
    }
  }
  console.log(`PASS  gate: every /api/admin/* route (${routes.length}) answers 404 without a session, on every method`);
  const html = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8');
  assert.equal(/service_role/i.test(html), false, 'index.html must not contain service_role / SERVICE_ROLE');
  assert.equal(/wb\.refresh\.key["']\s*,/.test(html), false, 'the shared key is no longer stored in the browser');
  assert.equal(/x-workbench-key/i.test(html), false);
  console.log('PASS  gate: index.html has no service_role string and no longer stores or sends the shared key');
}
console.log('ALL PASS  auth');
