// FDY-289: People > Access in headless Chromium, through the real handlers over an in-memory
// database. Add, role, expiry, pause, revoke, restore, each through the reason panel. No network.
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
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner'); db.addAccess(owner, 'ispyadc', 'admin');
const tess = db.addPerson('tess@example.com'); db.addAccess(tess, 'ispyadc', 'tester', 'active', new Date(Date.now() + 5 * 86400000).toISOString());
const jane = db.addPerson('jane@example.com'); db.addAccess(jane, 'jw', 'member');

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
const settle = (n) => page.waitForFunction((k) => document.querySelectorAll('#acc-table tbody tr').length === k, n);
const last = () => db.audit[db.audit.length - 1];
const saved = () => page.waitForFunction(() => /ok|err/.test(document.getElementById('acc-msg').className));
const confirm = async (check, reason) => {
  await page.waitForSelector('#reason-panel:not([hidden])');
  if (check) await check();
  if (reason) await page.fill('#reason-text', reason);
  await page.evaluate(() => { document.getElementById('acc-msg').className = 'msg'; });
  await page.click('#reason-save'); await saved();
};

// ---- reached from People; ISpyaDC by default ----
await page.goto(ORIGIN + '/admin/people');
await page.click('.tabs a:text-is("Access")'); await page.waitForURL(ORIGIN + '/admin/people/access');
await settle(2);
assert.equal(await page.inputValue('#acc-app'), 'ispyadc');
assert.deepEqual(await page.locator('#acc-role option').allTextContents(), ['user', 'tester', 'admin']);
assert.equal(await page.inputValue('#acc-role'), 'tester');
assert.equal(await page.inputValue('#acc-exp'), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), 'tester default = today + 14');
assert.match(await page.textContent('#acc-note'), /live there within 60 seconds, with no deploy/);
assert.equal(await page.textContent('#acc-count'), '2 grants');
await page.fill('#acc-q', 'tess'); await settle(1); await page.fill('#acc-q', ''); await settle(2);
console.log('PASS  People > Access opens from People; ISpyaDC by default; roles user, tester, admin; 14-day tester default');

// ---- add ----
await page.fill('#acc-email', 'New.Tester@Example.com'); await page.click('#acc-form button');
await confirm(async () => assert.match(await page.textContent('#reason-diff'), /new\.tester@example\.com/));
await settle(3);
assert.equal(last().action, 'access.add'); assert.equal(last().actor, OWNER_ID); assert.equal(last().product, 'ispyadc'); assert.equal(last().reason, null);
assert.equal(await page.inputValue('#acc-email'), '');
await page.selectOption('#acc-role', 'admin'); assert.equal(await page.inputValue('#acc-exp'), '', 'an admin has no default expiry');
await page.fill('#acc-email', 'TESS@example.com'); await page.click('#acc-form button'); await confirm();
assert.match(await page.textContent('#acc-msg'), /already has ISpyaDC access/);
assert.equal(await page.getAttribute('#acc-msg a', 'href'), '/admin/people/' + tess.id);
console.log('PASS  add by email through the reason panel; a duplicate is refused with a link to the person');

// ---- change role, expiry, pause, revoke, restore ----
const row = `#acc-table tr[data-id="${tess.id}"]`;
await page.selectOption(`${row} select[data-f="role"]`, 'admin');
await confirm(async () => assert.match(await page.textContent('#reason-diff'), /role\s*tester\s*admin/), 'promoted');
assert.equal(last().action, 'access.update'); assert.equal(last().reason, 'promoted'); assert.equal(last().new_value.role, 'admin');
await page.fill(`${row} input[data-f="exp"]`, '2031-01-15'); await page.dispatchEvent(`${row} input[data-f="exp"]`, 'change');
await confirm(); assert.equal(last().new_value.expires_at, '2031-01-15T23:59:59Z');
await page.click(`${row} button[data-act="pause"]`); await confirm(); assert.equal(last().action, 'access.pause');
assert.match(await page.textContent(`${row} .tag`), /paused/);
await page.click(`${row} button[data-act="resume"]`); await confirm(); assert.equal(last().action, 'access.resume');
await page.click(`${row} button[data-act="revoke"]`); await confirm(); assert.equal(last().action, 'access.revoke');
assert.equal(await page.locator(`${row} button[data-act="pause"]`).count(), 0);
await page.click(`${row} button[data-act="restore"]`); await confirm(); assert.equal(last().action, 'access.restore');
const n0 = db.audit.length;
await page.selectOption(`${row} select[data-f="role"]`, 'user'); await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-cancel');
await page.waitForTimeout(100); assert.equal(db.audit.length, n0); assert.equal(await page.inputValue(`${row} select[data-f="role"]`), 'admin', 'Cancel puts the field back');
console.log('PASS  role, expiry, pause, resume, revoke, restore: one audit row each; Cancel writes nothing and resets the field');

// ---- another app ----
await page.selectOption('#acc-app', 'jw'); await settle(1);
assert.match(page.url(), /app=jw/); assert.deepEqual(await page.locator('#acc-role option').allTextContents(), ['member', 'editor', 'admin']);
assert.match(await page.textContent('#acc-table tbody'), /jane@example\.com/);
console.log('PASS  the same screen serves the other apps (?app=jw)');

assert.equal(/[$€£]\s?\d|per month|\/month|USD/i.test(await page.content()), false, 'no price string');
assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  access-page');
