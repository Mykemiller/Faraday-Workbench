// FDY-291 (ADM-1.4): the audience gate, in the console. Pure logic + the Owner-only route over the mocked
// client (test/_fakedb.mjs). No network, and nothing here can send an email.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const router = require('../api/admin/[route].js');
const shell = require('../api/admin/shell.js');
const G = require('../api/_admin/gate-logic.js');
const A = require('../api/_audit.js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const STALE = () => ownerHeaders(OWNER_ID, OWNER, Math.floor(Date.now() / 1000) - 11 * 60);   // signed in 11 min ago: not fresh
const get = () => call({ method: 'GET', headers: H(), query: { route: 'gate' } });
const post = (body, headers = H()) => call({ method: 'POST', headers, query: { route: 'gate' }, body });
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
const PIN = ['mykemiller@gmail.com', 'mykemiller@deloitte.com'];
db.addGate('predicts', false, PIN);
db.addRecipient('mykemiller@gmail.com', { review_status: 'approved', optin_status: 'confirmed' });
db.addRecipient('mykemiller@deloitte.com', { review_status: 'approved', optin_status: 'confirmed' });
db.addRecipient('third@example.org', { review_status: 'approved', optin_status: 'confirmed' });
db.addRecipient('fourth@example.org', { review_status: 'approved', optin_status: 'invited' });
db.addRecipient('fifth@example.org');

// ---- pure logic ----
{
  assert.deepEqual(G.liftImpact([{ email: 'A@x.io', review_status: 'approved', optin_status: 'confirmed' }, { email: 'b@x.io', review_status: 'approved', optin_status: 'invited' }, { email: 'c@x.io', review_status: 'pending_review', optin_status: 'not_invited' }], ['a@x.io']), { eligible: 1, newlyMailed: 0 });
  assert.match(G.parseChange({ product: 'predicts', lifted: true, confirm: 'lift' }, null).error, /reason is required/);
  assert.match(G.parseChange({ product: 'predicts', lifted: true }, 'because').error, /type lift/);
  assert.match(G.parseChange({ product: 'predicts', lifted: true, confirm: 'LIFT' }, 'because').error, /type lift/, 'the word must be exactly lift');
  assert.deepEqual(G.parseChange({ product: 'predicts', lifted: false }, 'because'), { product: 'predicts', lifted: false, confirm: null }, 'arming needs no confirmation word');
  assert.match(G.parseChange({ product: 'Bad Name', lifted: false }, 'x').error, /product/);
  assert.match(G.parseChange({ product: 'predicts', lifted: 'true', confirm: 'lift' }, 'x').error, /true or false/, 'lifted must be a real boolean');
  assert.match(G.changeMessage('predicts', true, true), /within 60 seconds/);
  assert.match(G.changeMessage('predicts', true, false), /already lifted/);
  console.log('PASS  logic: a reason is required, lifting needs the exact word lift, arming does not, lifted must be a boolean');
}

// ---- the screen's data ----
{
  const r = await get();
  assert.equal(r.code, 200); assert.equal(r.body.waiting, false);
  const g = r.body.gates.find((x) => x.product === 'predicts');
  assert.equal(g.lifted, false); assert.deepEqual(g.pinned, PIN);
  assert.deepEqual(g.impact, { eligible: 3, newlyMailed: 1 }, '3 approved+confirmed, 1 of them not pinned');
  assert.match(r.body.propagation, /60 seconds/);
  assert.deepEqual(r.body.history, [], 'no gate changes yet');
  assert.equal(JSON.stringify(r.body).includes('token'), false);
  console.log('PASS  GET shows the gate, the pinned list and who would start receiving mail if it were lifted');
}

// ---- lift: reason, confirm word, step-up, audit ----
{
  const n0 = db.audit.length;
  let r = await post({ product: 'predicts', lifted: true, confirm: 'lift' });
  assert.equal(r.code, 400); assert.match(r.body.error, /reason is required/);
  r = await post({ product: 'predicts', lifted: true, reason: 'pilot ready' });
  assert.equal(r.code, 400); assert.match(r.body.error, /type lift/);
  r = await post({ product: 'predicts', lifted: true, confirm: 'lift', reason: 'pilot ready' }, STALE());
  assert.equal(r.code, 403); assert.equal(r.body.error, 'step_up_required', 'lifting needs a fresh sign-in');
  assert.equal(db.gates[0].lifted, false); assert.equal(db.audit.length, n0, 'every refusal writes nothing');
  r = await post({ product: 'predicts', lifted: true, confirm: 'lift', reason: 'pilot ready', pinned: ['x@y.io'] });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true); assert.match(r.body.message, /within 60 seconds/);
  assert.equal(db.gates[0].lifted, true); assert.deepEqual(db.gates[0].pinned, PIN, 'the pinned list is not editable here');
  assert.equal(db.audit.length, n0 + 1, 'exactly one audit row');
  const a = db.audit[db.audit.length - 1];
  assert.equal(a.action, 'gate.lift'); assert.equal(a.actor, OWNER_ID); assert.equal(a.actor_verified, true); assert.equal(a.via, 'workbench:console'); assert.equal(a.reason, 'pilot ready'); assert.equal(a.old_value.lifted, false); assert.equal(a.new_value.lifted, true);
  const rpc = db.calls.filter((c) => c.path === '/rest/v1/rpc/estate_audience_gate_set').pop().body;
  assert.equal(rpc.p_confirm, 'lift'); assert.equal('pinned' in rpc || 'p_pinned' in rpc, false);
  r = await post({ product: 'predicts', lifted: true, confirm: 'lift', reason: 'again' });
  assert.equal(r.code, 200); assert.equal(r.body.changed, false); assert.match(r.body.message, /already lifted/); assert.equal(db.audit.length, n0 + 1, 'a no-op writes no audit row');
  console.log('PASS  lift: reason + typed word + fresh sign-in required; one audit row (actor = Owner, via workbench:console); pinned untouched; a repeat is a no-op');
}

// ---- arm, and the history ----
{
  const n0 = db.audit.length;
  let r = await post({ product: 'predicts', lifted: false });
  assert.equal(r.code, 400); assert.match(r.body.error, /reason is required/);
  r = await post({ product: 'predicts', lifted: false, reason: 'pause the pilot' });
  assert.equal(r.code, 200); assert.equal(db.gates[0].lifted, false);
  assert.equal(db.audit.length, n0 + 1); assert.equal(db.audit[db.audit.length - 1].action, 'gate.arm');
  r = await post({ product: 'predicts', lifted: false, reason: '  ', linearIssue: 'fdy-291' });
  assert.equal(r.code, 200, 'a Linear issue key stands in for a blank reason, like every other console write'); assert.equal(r.body.changed, false);
  const h = (await get()).body.history;
  assert.deepEqual(h.map((x) => x.action), ['gate.arm', 'gate.lift'], 'history is the gate rows only, newest first');
  assert.equal(h[1].reason, 'pilot ready');
  console.log('PASS  arm needs a reason but no typed word; history lists gate.lift and gate.arm newest first');
}

// ---- refusals, waiting state, Owner only, no email ----
{
  let r = await post({ product: 'nope', lifted: false, reason: 'x' });
  assert.equal(r.code, 404);
  db.failRpc = 'estate_audience_gate_set';
  r = await post({ product: 'predicts', lifted: true, confirm: 'lift', reason: 'x' });
  assert.equal(r.code, 502); assert.equal(JSON.stringify(r.body).includes('boom'), false, 'no database text leaks'); db.failRpc = null;
  db.noGate = true;
  r = await get(); assert.equal(r.code, 200); assert.equal(r.body.waiting, true); assert.equal(r.body.message, 'Waiting on FDY-252 migration');
  r = await post({ product: 'predicts', lifted: false, reason: 'x' }); assert.equal(r.code, 503); assert.equal(r.body.waiting, true);
  db.noGate = false; db.noFunctions.add('estate_audience_gate_set');
  const n0 = db.audit.length;
  r = await post({ product: 'predicts', lifted: true, confirm: 'lift', reason: 'x' }); assert.equal(r.code, 503); assert.equal(db.audit.length, n0);
  db.noFunctions.clear();
  for (const headers of [{}, { cookie: 'wb_session=forged' }]) {
    const g = await call({ method: 'GET', headers, query: { route: 'gate' } });
    assert.equal(g.code, 404); assert.deepEqual(g.body, { error: 'Not found' });
    const w = await call({ method: 'POST', headers, query: { route: 'gate' }, body: { product: 'predicts', lifted: true, confirm: 'lift', reason: 'x' } });
    assert.equal(w.code, 404);
  }
  assert.equal((await call({ method: 'DELETE', headers: H(), query: { route: 'gate' } })).code, 405);
  assert.equal(db.calls.some((c) => /resend|\/functions\/|\/send|mail|invite/i.test(c.path)), false, 'no send endpoint was ever called');
  const src = fs.readFileSync(path.join(HERE, '../api/_admin/gate.js'), 'utf8') + fs.readFileSync(path.join(HERE, '../api/_admin/gate-logic.js'), 'utf8');
  assert.equal(/resend|sendgrid|nodemailer|\/functions\/v1|fetch\(/i.test(src), false, 'no send path and no raw fetch');
  assert.ok(Object.prototype.hasOwnProperty.call(A.AUDITED_RPCS, 'estate_audience_gate_set'), 'the gate function is on the audited list');
  console.log('PASS  unknown product, a failing or missing function and a missing table change nothing and leak nothing; Owner only; no email path');
}

// ---- page: a tab on the people page; the page handler is unchanged ----
{
  const pr = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'people' } }, pr);
  assert.equal(pr.code, 200); assert.match(pr.body, /id="gate-panel"/); assert.match(pr.body, /href="\/admin\/people\?tab=gate"/); assert.match(pr.body, /type lift to confirm/);
  const odd = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'people', id: 'gate' } }, odd); assert.equal(odd.code, 404, '/admin/people/gate is not a page id; the page handler is unchanged');
  const anon = mkRes(); await shell({ method: 'GET', headers: {}, query: { area: 'people' } }, anon); assert.equal(anon.code, 404);
  assert.equal(/service_role|SERVICE_ROLE/.test(pr.body), false);
  console.log('PASS  the gate is a tab on the people page (?tab=gate); /admin/people/<anything else> stays a bare 404');
}
console.log('ALL PASS  gate');
