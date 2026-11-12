// FDY-290: People > Review in headless Chromium, through the real handlers over an in-memory database.
// Pending first, the confirm step (reason panel), one audit row per decision, the waiting state, and no send.
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
db.addRecipient('mykemiller@gmail.com', { source: 'owner', review_status: 'approved', optin_status: 'confirmed', reviewed_by: 'myke' });
db.addRecipient('alex@example.com', { source: 'seed', dc_active: false });
db.addRecipient('mykemiller@gmail.con', { source: 'dailychallenge-leaderboard' });
db.addRecipient('real.person@deloitte.com');

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const ORIGIN = 'http://wb.test';
await page.route(ORIGIN + '/**', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const res = mkRes();
  const headers = ownerHeaders(OWNER_ID, OWNER); const query = Object.fromEntries(u.searchParams); const seg = u.pathname.split('/');
  if (u.pathname === '/admin/people/review') await shell({ method: 'GET', headers, query: { area: 'people' } }, res);   // what vercel.json's rewrite does
  else if (seg[1] === 'admin' && seg.length <= 4) await shell({ method: 'GET', headers, query: { area: seg[2], id: seg[3] } }, res);
  else if (u.pathname.startsWith('/api/admin/')) await router({ method: req.method(), headers, url: u.pathname + u.search, query, body: req.postData() ? JSON.parse(req.postData()) : undefined }, res);
  else return route.fulfill({ status: 404, body: '' });
  const html = typeof res.body === 'string';
  route.fulfill({ status: res.code, contentType: html ? 'text/html; charset=utf-8' : 'application/json', body: html ? res.body : JSON.stringify(res.body) });
});
const rows = () => page.locator('#rev-table tbody tr');
const settle = (n) => page.waitForFunction((k) => document.querySelectorAll('#rev-table tbody tr').length === k, n);
const last = () => db.audit[db.audit.length - 1];
const saved = () => page.waitForFunction(() => /ok|err/.test(document.getElementById('rev-msg').className));
const confirm = async (check, reason) => {
  await page.waitForSelector('#reason-panel:not([hidden])');
  if (check) await check();
  if (reason) await page.fill('#reason-text', reason);
  await page.evaluate(() => { document.getElementById('rev-msg').className = 'msg'; });
  await page.click('#reason-save'); await saved();
};

// ---- reached from People; pending first ----
await page.goto(ORIGIN + '/admin/people');
await page.click('.tabs a:text-is("Review")'); await page.waitForURL(ORIGIN + '/admin/people/review');
await settle(4);
assert.equal(await page.isVisible('#dir-panel'), false, 'the directory is hidden on the review path');
assert.equal(await page.getAttribute('.tabs a[href="/admin/people/review"]', 'aria-current'), 'page');
assert.match(await page.textContent('#rev-panel'), /Approving sends no email/);
assert.match(await page.textContent('#rev-panel'), /FDY-112 invitation job sends the invitation later/);
const statuses = await rows().locator('td:nth-child(6)').allTextContents();
assert.deepEqual(statuses, ['Pending review', 'Pending review', 'Pending review', 'Approved'], 'pending rows come first');
assert.equal(await page.textContent('#rev-count'), '4 people · 3 pending');
const head = (await page.locator('#rev-table thead th').allTextContents()).join('|');
assert.match(head, /Email\|Source\|Created\|Last seen\|Opt-in\|Review/);
assert.equal(await page.locator('#rev-table button[data-act]').count(), 6, 'Approve + Reject only on the 3 pending rows');
console.log('PASS  Review opens from People; pending first; source, created, last seen and opt-in shown; says approving sends no email');

// ---- approve through the confirm step ----
const row = (e) => `#rev-table tr[data-email="${e}"]`;
const n0 = db.audit.length;
await page.click(`${row('real.person@deloitte.com')} button[data-act="approve"]`);
await page.waitForSelector('#reason-panel:not([hidden])');
assert.match(await page.textContent('#reason-diff'), /real\.person@deloitte\.com|Pending review\s*Approved/);
await page.click('#reason-cancel'); await page.waitForTimeout(100);
assert.equal(db.audit.length, n0, 'Cancel writes nothing');
assert.equal(db.recipients.find((r) => r.email === 'real.person@deloitte.com').review_status, 'pending_review');
await page.click(`${row('real.person@deloitte.com')} button[data-act="approve"]`);
await confirm(async () => assert.match(await page.textContent('#reason-diff'), /invitation email[\s\S]*FDY-112/), 'known colleague');
assert.equal(db.audit.length, n0 + 1, 'one audit row'); assert.equal(last().action, 'consent.approve'); assert.equal(last().actor, OWNER_ID); assert.equal(last().reason, 'known colleague');
assert.match(await page.textContent('#rev-msg'), /Approved real\.person@deloitte\.com\. No email was sent/);
assert.equal(await page.locator(`${row('real.person@deloitte.com')} button[data-act]`).count(), 0, 'a decided row loses its buttons');
console.log('PASS  Cancel writes nothing; approve goes through the confirm step; one audit row; the page says no email was sent');

// ---- reject the flagged rows from the console (what Myke does after deploy) ----
await page.click(`${row('alex@example.com')} button[data-act="reject"]`); await confirm();
assert.equal(last().action, 'consent.reject'); assert.equal(last().reason, null);
await page.click(`${row('mykemiller@gmail.con')} button[data-act="reject"]`); await confirm();
assert.equal(db.audit.length, n0 + 3, 'one audit row per decision');
assert.equal(db.recipients.filter((r) => r.review_status === 'rejected').length, 2);
assert.equal(await page.textContent('#rev-count'), '4 people · 0 pending');
console.log('PASS  reject: one audit row each; the queue counts update');

// ---- a decision that the server refuses is shown in plain English ----
db.recipients.find((r) => r.email === 'mykemiller@gmail.com').review_status = 'pending_review';
await page.reload(); await settle(4);
db.recipients.find((r) => r.email === 'mykemiller@gmail.com').review_status = 'approved';   // decided elsewhere meanwhile
await page.click(`${row('mykemiller@gmail.com')} button[data-act="reject"]`); await confirm();
assert.match(await page.textContent('#rev-msg'), /already approved/);
console.log('PASS  a decision made elsewhere meanwhile is refused with a plain message');

// ---- waiting state ----
db.noView = true; await page.reload();
await page.waitForFunction(() => /Waiting on FDY-252 migration/.test(document.getElementById('rev-msg').textContent));
assert.equal(await page.isVisible('#rev-table'), false); assert.equal(await page.locator('#rev-table button').count(), 0);
db.noView = false;
console.log('PASS  waiting state: "Waiting on FDY-252 migration", no table, no buttons');

// ---- the directory still works at /admin/people; nothing was sent; no price strings ----
await page.goto(ORIGIN + '/admin/people');
await page.waitForFunction(() => /person|people/.test(document.getElementById('people-count').textContent));
assert.equal(await page.isVisible('#rev-panel'), false); assert.equal(await page.isVisible('#dir-panel'), true);
assert.equal(db.calls.some((c) => /resend|\/functions\/|\/send|mail|invite/i.test(c.path)), false, 'no send endpoint was called');
assert.equal(/[$€£]\s?\d|per month|\/month|USD/i.test(await page.content()), false, 'no price string');
assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  review-page');
