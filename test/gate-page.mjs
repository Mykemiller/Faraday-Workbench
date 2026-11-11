// FDY-291: People > Audience gate in headless Chromium, through the real handlers over an in-memory database.
// The state, the typed confirmation to lift, the required reason, arming, history, and the waiting state.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const CHROME = process.env.WB_CHROME;
const shell = require('../api/admin/shell.js');
const router = require('../api/admin/[route].js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
db.addGate('predicts', false, ['mykemiller@gmail.com', 'mykemiller@deloitte.com']);
db.addRecipient('mykemiller@gmail.com', { review_status: 'approved', optin_status: 'confirmed' });
db.addRecipient('mykemiller@deloitte.com', { review_status: 'approved', optin_status: 'confirmed' });
db.addRecipient('third@example.org', { review_status: 'approved', optin_status: 'confirmed' });

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const ORIGIN = 'http://wb.test';
await page.route(ORIGIN + '/**', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const res = mkRes();
  const headers = ownerHeaders(OWNER_ID, OWNER); const query = Object.fromEntries(u.searchParams); const seg = u.pathname.split('/');
  if (seg[1] === 'admin' && seg.length <= 4) await shell({ method: 'GET', headers, query: { area: seg[2], id: seg[3] } }, res);
  else if (u.pathname.startsWith('/api/admin/')) await router({ method: req.method(), headers, url: u.pathname + u.search, query, body: req.postData() ? JSON.parse(req.postData()) : undefined }, res);
  else return route.fulfill({ status: 404, body: '' });
  const html = typeof res.body === 'string';
  route.fulfill({ status: res.code, contentType: html ? 'text/html; charset=utf-8' : 'application/json', body: html ? res.body : JSON.stringify(res.body) });
});
const last = () => db.audit[db.audit.length - 1];
const saved = () => page.waitForFunction(() => /ok|err/.test(document.getElementById('gate-msg').className));
const settle = () => page.waitForFunction(() => !document.getElementById('gate-card').hidden);
const confirm = async (reason, check) => {
  await page.waitForSelector('#reason-panel:not([hidden])');
  if (check) await check();
  await page.fill('#reason-text', reason || '');
  await page.evaluate(() => { document.getElementById('gate-msg').className = 'msg'; });
  await page.click('#reason-save'); await saved();
};

// ---- reached from People; the state, the pinned list and the impact ----
await page.goto(ORIGIN + '/admin/people');
await page.click('.tabs a:text-is("Audience gate")'); await page.waitForURL(/tab=gate/); await settle();
assert.equal(await page.isVisible('#dir-panel'), false);
assert.equal(await page.getAttribute('.tabs a[href="/admin/people?tab=gate"]', 'aria-current'), 'page');
assert.match(await page.textContent('#gate-state'), /ARMED/);
assert.match(await page.textContent('#gate-pinned'), /mykemiller@gmail\.com, mykemiller@deloitte\.com/);
assert.match(await page.textContent('#gate-impact'), /3 people are approved and confirmed; 1 of them is not pinned and would start receiving mail/);
assert.match(await page.textContent('#gate-panel'), /within 60 seconds/);
assert.match(await page.textContent('#gate-panel'), /falls back to the two pinned owner addresses, closed/);
assert.equal(await page.isDisabled('#gate-lift'), true, 'Lift is off until the word is typed');
assert.equal(await page.isDisabled('#gate-arm'), true, 'Arm is off while it is already armed');
console.log('PASS  Audience gate opens from People: ARMED, the pinned list, who would be mailed if lifted, the 60-second note');

// ---- lift: typed word, then reason (required), then one audit row ----
const n0 = db.audit.length;
await page.fill('#gate-confirm', 'LIFT'); assert.equal(await page.isDisabled('#gate-lift'), true, 'the word must be exactly lift');
await page.fill('#gate-confirm', 'lift'); assert.equal(await page.isDisabled('#gate-lift'), false);
await page.click('#gate-lift');
await confirm('', async () => assert.match(await page.textContent('#reason-diff'), /armed: only the pinned[\s\S]*lifted: every approved and confirmed/));
assert.match(await page.textContent('#gate-msg'), /reason is required/);
assert.equal(db.audit.length, n0, 'no reason, no call, no audit row'); assert.equal(db.gates[0].lifted, false);
await page.click('#gate-lift');
await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-cancel'); await page.waitForTimeout(100);
assert.equal(db.audit.length, n0, 'Cancel writes nothing');
await page.click('#gate-lift'); await confirm('pilot ready');
assert.equal(db.gates[0].lifted, true); assert.equal(db.audit.length, n0 + 1);
assert.equal(last().action, 'gate.lift'); assert.equal(last().actor, OWNER_ID); assert.equal(last().reason, 'pilot ready');
assert.match(await page.textContent('#gate-msg'), /Lifted the predicts gate\. Senders pick this up within 60 seconds/);
assert.match(await page.textContent('#gate-state'), /LIFTED/);
assert.equal(await page.inputValue('#gate-confirm'), '', 'the typed word is cleared after a change');
assert.equal(await page.isDisabled('#gate-arm'), false); assert.equal(await page.isDisabled('#gate-lift'), true);
assert.match(await page.textContent('#gate-history tbody'), /gate\.lift[\s\S]*pilot ready/);
console.log('PASS  lift: the typed word, a required reason, Cancel writes nothing, one audit row, history updates');

// ---- arm again ----
await page.click('#gate-arm'); await confirm('pause');
assert.equal(db.gates[0].lifted, false); assert.equal(last().action, 'gate.arm'); assert.equal(db.audit.length, n0 + 2);
assert.match(await page.textContent('#gate-state'), /ARMED/);
assert.equal((await page.locator('#gate-history tbody tr').allTextContents()).length, 2);
console.log('PASS  arm: a reason, one audit row; history lists both changes');

// ---- waiting state ----
db.noGate = true; await page.reload();
await page.waitForFunction(() => /Waiting on FDY-252 migration/.test(document.getElementById('gate-msg').textContent));
assert.equal(await page.isVisible('#gate-card'), false);
db.noGate = false;
console.log('PASS  waiting state: "Waiting on FDY-252 migration", no controls');

// ---- the directory and review still work; nothing was sent; no price strings ----
await page.goto(ORIGIN + '/admin/people');
await page.waitForFunction(() => /person|people/.test(document.getElementById('people-count').textContent));
assert.equal(await page.isVisible('#gate-panel'), false); assert.equal(await page.isVisible('#dir-panel'), true);
assert.equal(db.calls.some((c) => /resend|\/functions\/|\/send|mail|invite/i.test(c.path)), false, 'no send endpoint was called');
assert.equal(/[$€£]\s?\d|per month|\/month|USD/i.test(await page.content()), false, 'no price string');
assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  gate-page');
