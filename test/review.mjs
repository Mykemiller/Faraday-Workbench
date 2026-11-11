// FDY-290 (ADM-1.3): the Predicts review queue. Pure logic + the Owner-only route over the mocked
// client (test/_fakedb.mjs). No network, and nothing here can send an email.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const router = require('../api/admin/[route].js');
const shell = require('../api/admin/shell.js');
const R = require('../api/_admin/review-logic.js');
const fs = await import('node:fs');
const path = await import('node:path'); const { fileURLToPath } = await import('node:url');
const HERE = path.dirname(fileURLToPath(import.meta.url));

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const get = () => call({ method: 'GET', headers: H(), query: { route: 'review' } });
const post = (body) => call({ method: 'POST', headers: H(), query: { route: 'review' }, body });
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');

// A queue shaped like production: two approved owners, pending people, five @example.com seeds, one .con typo.
db.addRecipient('mykemiller@gmail.com', { source: 'owner', review_status: 'approved', optin_status: 'confirmed', reviewed_by: 'myke' });
db.addRecipient('mykemiller@deloitte.com', { source: 'owner', review_status: 'approved', optin_status: 'confirmed', reviewed_by: 'myke' });
for (const e of ['alex', 'jordan', 'lee', 'priya', 'sam']) db.addRecipient(e + '@example.com', { source: 'seed', dc_active: false });
db.addRecipient('mykemiller@gmail.con', { source: 'dailychallenge-leaderboard' });
db.addRecipient('real.person@deloitte.com');

// ---- pure logic ----
{
  assert.deepEqual(R.parseDecision({ email: ' A@B.IO ', decision: 'approve', confirm: true }), { email: 'a@b.io', decision: 'approve', reason: undefined, linearIssue: undefined });
  assert.match(R.parseDecision({ email: 'a@b.io', decision: 'approve' }).error, /confirmed/, 'no confirm, no decision');
  assert.match(R.parseDecision({ email: 'a@b.io', decision: 'approve', confirm: 'yes' }).error, /confirmed/, 'confirm must be literally true');
  assert.match(R.parseDecision({ email: 'a@b.io', decision: 'delete', confirm: true }).error, /approve or reject/);
  assert.match(R.parseDecision({ email: 'nope', decision: 'reject', confirm: true }).error, /email/);
  assert.match(R.decisionMessage('approve', 'a@b.io'), /No email was sent/);
  assert.match(R.decisionMessage('reject', 'a@b.io'), /No email was sent/);
  const rows = R.pendingFirst([
    { email: 'z', createdAt: '2026-01-01', reviewStatus: 'approved' }, { email: 'b', createdAt: '2026-03-01', reviewStatus: 'pending_review' },
    { email: 'a', createdAt: '2026-02-01', reviewStatus: 'pending_review' }, { email: 'c', createdAt: '2026-01-01', reviewStatus: 'rejected' }]);
  assert.deepEqual(rows.map((r) => r.email), ['a', 'b', 'c', 'z'], 'pending first (oldest first), then the rest by created date, then email');
  console.log('PASS  logic: confirm is required; the message says no email was sent; pending-first sort');
}

// ---- the queue: pending first ----
{
  const r = await get();
  assert.equal(r.code, 200); assert.equal(r.body.waiting, false);
  assert.equal(r.body.count, 9); assert.equal(r.body.pending, 7);
  assert.deepEqual(r.body.rows.slice(0, 7).map((x) => x.reviewStatus), Array(7).fill('pending_review'), 'every pending row comes before any decided row');
  assert.deepEqual(r.body.rows.slice(7).map((x) => x.reviewStatus), ['approved', 'approved']);
  const first = r.body.rows[0];
  for (const k of ['email', 'source', 'createdAt', 'lastSeenAt', 'optinStatus', 'reviewStatus']) assert.ok(k in first, 'row carries ' + k);
  assert.equal(JSON.stringify(r.body).includes('token'), false, 'the consent token is never in the response');
  const q = db.calls.filter((c) => c.path === '/rest/v1/v_predicts_recipient_review').pop();
  assert.ok(q, 'reads v_predicts_recipient_review');
  console.log('PASS  the queue reads v_predicts_recipient_review, pending first, with source, created, last seen, opt-in');
}

// ---- decisions: confirm step, one audit row each, actor = the Owner ----
{
  const n0 = db.audit.length;
  let r = await post({ email: 'real.person@deloitte.com', decision: 'approve' });
  assert.equal(r.code, 400, 'without the confirm step nothing is written'); assert.equal(db.audit.length, n0);
  assert.equal(db.recipients.find((x) => x.email === 'real.person@deloitte.com').review_status, 'pending_review');
  r = await post({ email: 'Real.Person@Deloitte.com', decision: 'approve', confirm: true, reason: 'known colleague' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.match(r.body.message, /No email was sent/);
  assert.equal(db.audit.length, n0 + 1, 'exactly one audit row per decision');
  const a = db.audit[db.audit.length - 1];
  assert.equal(a.action, 'consent.approve'); assert.equal(a.actor, OWNER_ID); assert.equal(a.reason, 'known colleague'); assert.equal(a.old_value.review_status, 'pending_review'); assert.equal(a.new_value.review_status, 'approved');
  assert.equal(db.recipients.find((x) => x.email === 'real.person@deloitte.com').optin_status, 'not_invited', 'approving does not invite');
  r = await post({ email: 'alex@example.com', decision: 'reject', confirm: true });
  assert.equal(r.code, 200); assert.equal(db.audit.length, n0 + 2);
  assert.equal(db.audit[db.audit.length - 1].action, 'consent.reject'); assert.equal(db.audit[db.audit.length - 1].reason, null, 'a reason is optional');
  console.log('PASS  decisions need the confirm step; each writes one admin_audit row with the Owner as actor; approving does not invite');
}

// ---- refusals ----
{
  const n0 = db.audit.length;
  let r = await post({ email: 'real.person@deloitte.com', decision: 'reject', confirm: true });
  assert.equal(r.code, 409, 'an already-decided person is not decided again'); assert.match(r.body.error, /already approved/);
  r = await post({ email: 'mykemiller@gmail.com', decision: 'reject', confirm: true });
  assert.equal(r.code, 409, 'an approved owner cannot be rejected from here');
  r = await post({ email: 'ghost@example.com', decision: 'approve', confirm: true });
  assert.equal(r.code, 404);
  assert.equal(db.audit.length, n0, 'refusals write nothing');
  db.failRpc = 'predicts_review_recipient';
  r = await post({ email: 'lee@example.com', decision: 'reject', confirm: true });
  assert.equal(r.code, 502); assert.equal(JSON.stringify(r.body).includes('boom'), false, 'no database text leaks'); db.failRpc = null;
  assert.equal(db.recipients.find((x) => x.email === 'lee@example.com').review_status, 'pending_review');
  console.log('PASS  a decided person, an unknown address and a database failure all change nothing and leak nothing');
}

// ---- waiting state: the view or the function is missing ----
{
  db.noView = true;
  let r = await get();
  assert.equal(r.code, 200); assert.equal(r.body.waiting, true); assert.equal(r.body.message, 'Waiting on FDY-252 migration'); assert.deepEqual(r.body.rows, []);
  r = await post({ email: 'lee@example.com', decision: 'reject', confirm: true });
  assert.equal(r.code, 503); assert.equal(r.body.waiting, true);
  db.noView = false; db.noFunctions.add('predicts_review_recipient');
  const n0 = db.audit.length;
  r = await post({ email: 'lee@example.com', decision: 'reject', confirm: true });
  assert.equal(r.code, 503); assert.equal(r.body.error, 'Waiting on FDY-252 migration'); assert.equal(db.audit.length, n0);
  db.noFunctions.clear();
  assert.equal(db.calls.some((c) => /create|alter|ddl/i.test(c.path)), false, 'the console creates neither the view nor the function');
  console.log('PASS  a missing view or function shows "Waiting on FDY-252 migration"; nothing is created');
}

// ---- Owner only; no email path ----
{
  for (const headers of [{}, { cookie: 'wb_session=forged' }]) {
    const r = await call({ method: 'GET', headers, query: { route: 'review' } });
    assert.equal(r.code, 404, 'no session or a forged one gets the bare 404'); assert.deepEqual(r.body, { error: 'Not found' });
    const w = await call({ method: 'POST', headers, query: { route: 'review' }, body: { email: 'lee@example.com', decision: 'approve', confirm: true } });
    assert.equal(w.code, 404);
  }
  const bad = await call({ method: 'DELETE', headers: H(), query: { route: 'review' } });
  assert.equal(bad.code, 405);
  assert.equal(db.calls.some((c) => /resend|\/functions\/|\/send|mail|invite/i.test(c.path) || /resend/.test(c.search)), false, 'no send endpoint was ever called');
  const src = fs.readFileSync(path.join(HERE, '../api/_admin/review.js'), 'utf8') + fs.readFileSync(path.join(HERE, '../api/_admin/review-logic.js'), 'utf8');
  assert.equal(/resend|sendgrid|nodemailer|\/functions\/v1|fetch\(/i.test(src), false, 'review code has no send path and no raw fetch');
  console.log('PASS  Owner only (bare 404 otherwise); no send endpoint is called and none exists in the route');
}

// ---- the page is served at /admin/people/review by rewrite ----
{
  const v = JSON.parse(fs.readFileSync(path.join(HERE, '../vercel.json'), 'utf8'));
  const i = v.rewrites.findIndex((x) => x.source === '/admin/people/review');
  const g = v.rewrites.findIndex((x) => x.source === '/admin/:area/:id');
  assert.ok(i >= 0 && i < g, 'the review rewrite exists and comes before the generic /admin/:area/:id');
  assert.equal(v.rewrites[i].destination, '/api/admin/shell?area=people');
  const pr = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'people' } }, pr);
  assert.equal(pr.code, 200); assert.match(pr.body, /id="rev-panel"/); assert.match(pr.body, /Approving sends no email/); assert.match(pr.body, /href="\/admin\/people\/review"/);
  const anon = mkRes(); await shell({ method: 'GET', headers: {}, query: { area: 'people' } }, anon); assert.equal(anon.code, 404);
  const other = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'people', id: 'review' } }, other); assert.equal(other.code, 404, '/admin/people/review is NOT a page id; the page handler is unchanged');
  console.log('PASS  /admin/people/review is a rewrite to the people page; the page handler is unchanged');
}
console.log('ALL PASS  review');
