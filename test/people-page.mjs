// FDY-288: the People directory and Person page in headless Chromium, served through the real
// handlers over an in-memory database. Every write goes through the reason side panel. No network.
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
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const owner = db.addPerson(OWNER, { id: OWNER_ID, display_name: 'Olive Owner' }); db.addAccess(owner, 'workbench', 'owner');
db.addConsent(owner, 'predicts', 'approved', 'confirmed');
const tess = db.addPerson('tess@example.com', { display_name: 'Tess Tester', persona_preset: 'MF-07' }); db.addAccess(tess, 'ispyadc', 'tester', 'active', inDays(3));
const pat = db.addPerson('pat@example.com'); db.addAccess(pat, 'jw', 'member', 'paused');

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const ORIGIN = 'http://wb.test';
await page.route(ORIGIN + '/**', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const res = mkRes();
  const headers = ownerHeaders(OWNER_ID, OWNER); const query = Object.fromEntries(u.searchParams);
  const seg = u.pathname.split('/');
  if (seg[1] === 'admin' && seg.length <= 4) await shell({ method: 'GET', headers, query: { area: seg[2], id: seg[3] } }, res); // the three vercel.json rewrites
  else if (u.pathname.startsWith('/api/admin/')) await router({ method: req.method(), headers, url: u.pathname + u.search, query, body: req.postData() ? JSON.parse(req.postData()) : undefined }, res);
  else return route.fulfill({ status: 404, body: '' });
  const html = typeof res.body === 'string';
  route.fulfill({ status: res.code, contentType: html ? 'text/html; charset=utf-8' : 'application/json', body: html ? res.body : JSON.stringify(res.body) });
});
const rows = () => page.locator('#people-table tbody tr').count();
const settle = (n) => page.waitForFunction((k) => document.querySelectorAll('#people-table tbody tr').length === k, n);
const lastAudit = () => db.audit[db.audit.length - 1];

// ---- directory ----
await page.goto(ORIGIN + '/admin/people');
await settle(3);
assert.equal(await page.textContent('#people-count'), '3 of 3 people');
const head = await page.locator('#people-table thead th').allTextContents();
assert.deepEqual(head, ['Email', 'Name', 'Apps', 'Plan', 'Consent', 'Persona']);
const tessRow = await page.textContent(`#people-table tr[data-id="${tess.id}"]`);
assert.match(tessRow, /tess@example\.com/); assert.match(tessRow, /ISpyaDC · tester/); assert.match(tessRow, /None yet/); assert.match(tessRow, /MF-07/);
assert.match(await page.textContent(`#people-table tr[data-id="${OWNER_ID}"]`), /predicts email: approved · confirmed/);
assert.equal(await page.locator('#f-persona option').count(), 23, 'Any persona + Not set + MF-01 to MF-21');
await page.fill('#f-q', 'olive'); await settle(1);
await page.fill('#f-q', ''); await settle(3);
await page.selectOption('#f-status', 'paused'); await settle(1);
assert.match(await page.textContent('#people-table tbody'), /pat@example\.com/);
assert.match(page.url(), /status=paused/, 'filters live in the URL');
await page.selectOption('#f-status', ''); await page.selectOption('#f-app', 'ispyadc'); await settle(1);
await page.selectOption('#f-app', ''); await page.selectOption('#f-expiry', '7d'); await settle(1);
await page.selectOption('#f-expiry', ''); await page.selectOption('#f-persona', 'MF-07'); await settle(1);
await page.selectOption('#f-persona', 'unset'); await settle(2);
await page.goto(ORIGIN + '/admin/people?status=paused&app=jw'); await settle(1);
assert.equal(await page.inputValue('#f-status'), 'paused'); assert.equal(await page.inputValue('#f-app'), 'jw');
console.log('PASS  directory: columns, search, filters by app, status, expiry and persona; a filtered list has its own URL');

// ---- add a person: duplicate, then a new one ----
await page.goto(ORIGIN + '/admin/people'); await settle(3);
await page.fill('#add-email', 'TESS@Example.com'); await page.selectOption('#add-app', 'jw');
await page.click('#add-form button'); await page.waitForSelector('#reason-panel:not([hidden])');
assert.match(await page.textContent('#reason-diff'), /tess@example\.com/, 'the panel shows the lowercased email');
await page.click('#reason-save');
await page.waitForFunction(() => /already in the directory/.test(document.getElementById('add-msg').textContent));
assert.equal(await page.getAttribute('#add-msg a', 'href'), '/admin/people/' + tess.id);
await page.fill('#add-email', 'New.Person@Example.com'); await page.selectOption('#add-app', 'ispyadc'); await page.selectOption('#add-role', 'tester');
assert.equal(await page.inputValue('#add-exp'), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), 'a tester defaults to 14 days');
await page.click('#add-form button'); await page.waitForSelector('#reason-panel:not([hidden])');
assert.equal(await page.inputValue('#reason-text'), ''); await page.click('#reason-save');
const made = () => db.people.find((p) => p.email === 'new.person@example.com');
await page.waitForURL((u) => /\/admin\/people\/[0-9a-f-]{36}$/.test(u.pathname));
assert.equal(new URL(page.url()).pathname, '/admin/people/' + made().id);
assert.equal(lastAudit().action, 'access.add'); assert.equal(lastAudit().actor, OWNER_ID); assert.equal(lastAudit().reason, null);
console.log('PASS  add a person: duplicate refused with a link; a new person is created lowercased and opens their page');

// ---- Person page, reached from the directory ----
await page.goto(ORIGIN + '/admin/people'); await settle(4);
await page.click(`#people-table tr[data-id="${tess.id}"] a`);
await page.waitForURL(ORIGIN + '/admin/people/' + tess.id);
await page.waitForSelector('#person-body:not([hidden])');
assert.equal(await page.textContent('#person-email'), 'tess@example.com');
assert.match(await page.textContent('#person-meta'), /Tess Tester/);
assert.equal(await page.locator('#access-table tbody tr').count(), 1);
assert.equal(await page.textContent('#person-plan'), 'None yet');
assert.equal(await page.inputValue('#persona'), 'MF-07');
assert.match(await page.textContent('#consent-table tbody'), /No consent on record/);
console.log('PASS  Person page opens from the directory at /admin/people/<id> and shows access, persona, plan, consent, history');

const row = '#access-table tr[data-product="ispyadc"]';
const act = async (name, check, reason) => {
  await page.click(`${row} button[data-act="${name}"]`); await page.waitForSelector('#reason-panel:not([hidden])');
  if (check) await check();
  if (reason) await page.fill('#reason-text', reason);
  const n = db.audit.length; await page.click('#reason-save');
  await page.waitForFunction((k) => document.getElementById('person-msg').className.includes('ok') || document.getElementById('person-msg').className.includes('err'));
  assert.equal(db.audit.length, n + 1, name + ' wrote one audit row'); assert.equal(lastAudit().actor, OWNER_ID);
};
await act('pause', async () => { assert.match(await page.textContent('#reason-diff'), /status\s*active\s*paused/); assert.match(await page.textContent('#reason-hint'), /Optional/); });
assert.equal(lastAudit().action, 'access.pause'); assert.equal(lastAudit().reason, null, 'saved with no reason');
assert.match(await page.textContent(`${row} .tag`), /paused/);
assert.equal(await page.locator(`${row} button[data-act="resume"]`).count(), 1);
await act('resume', null, 'back from leave'); assert.equal(lastAudit().action, 'access.resume'); assert.equal(lastAudit().reason, 'back from leave');
await act('expire'); assert.match(await page.textContent(`${row} .tag`), /expired/);
await act('revoke'); assert.equal(lastAudit().action, 'access.revoke'); assert.match(await page.textContent(`${row} .tag`), /revoked/);
assert.equal(await page.locator(`${row} button[data-act="pause"]`).count(), 0, 'a revoked row offers only Restore');
await act('restore'); assert.equal(lastAudit().action, 'access.restore');
assert.match(await page.textContent('#history-table tbody'), /access\.pause/); assert.match(await page.textContent('#history-table tbody'), /back from leave/);
console.log('PASS  pause, resume, expire now, revoke, restore: each through the reason panel, each one audit row, history updates');

// cancel writes nothing
let n0 = db.audit.length;
await page.click(`${row} button[data-act="pause"]`); await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-cancel');
await page.waitForTimeout(100); assert.equal(db.audit.length, n0, 'Cancel writes nothing');

// grant another app, change a role, set the persona
await page.selectOption('#grant-app', 'jw'); await page.selectOption('#grant-role', 'editor');
await page.click('#grant-form button'); await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-save');
await page.waitForFunction(() => document.querySelectorAll('#access-table tbody tr').length === 2);
assert.equal(lastAudit().action, 'access.add'); assert.equal(lastAudit().new_value.role, 'editor');
await page.selectOption('#access-table tr[data-product="jw"] select[data-f="role"]', 'admin');
await page.waitForSelector('#reason-panel:not([hidden])'); assert.match(await page.textContent('#reason-diff'), /role\s*editor\s*admin/); await page.click('#reason-save');
await page.waitForFunction(() => /role is now admin/.test(document.getElementById('person-msg').textContent));
assert.equal(lastAudit().action, 'access.update');
await page.selectOption('#persona', 'MF-12'); await page.click('#persona-save');
await page.waitForSelector('#reason-panel:not([hidden])'); assert.match(await page.textContent('#reason-diff'), /persona\s*MF-07\s*MF-12/); await page.click('#reason-save');
await page.waitForFunction(() => /Persona set to MF-12/.test(document.getElementById('person-msg').textContent));
assert.equal(lastAudit().action, 'person.persona'); assert.equal(tess.persona_preset, 'MF-12');
console.log('PASS  grant another app, change a role, set a persona: all audited; Cancel writes nothing');

// a link that names a Linear issue: the reason starts as that issue
await page.goto(ORIGIN + '/admin/people/' + tess.id + '?issue=FDY-288'); await page.waitForSelector('#person-body:not([hidden])');
await page.click(`${row} button[data-act="pause"]`); await page.waitForSelector('#reason-panel:not([hidden])');
assert.equal(await page.inputValue('#reason-text'), 'FDY-288'); await page.click('#reason-save');
await page.waitForFunction(() => document.getElementById('person-msg').className.includes('ok'));
assert.equal(lastAudit().reason, 'FDY-288');
console.log('PASS  a change that names a Linear issue (?issue=FDY-288) records it as the reason');

// the Owner cannot lock themselves out
await page.goto(ORIGIN + '/admin/people/' + OWNER_ID); await page.waitForSelector('#person-body:not([hidden])');
n0 = db.audit.length;
await page.click('#access-table tr[data-product="workbench"] button[data-act="revoke"]'); await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-save');
await page.waitForFunction(() => /lock the console/.test(document.getElementById('person-msg').textContent));
assert.equal(db.audit.length, n0);
const html = await page.content();
assert.equal(/[$€£]\s?\d|per month|\/month/i.test(html), false, 'no price string on the Person page');
assert.equal(html.includes('SECRET-TOKEN'), false);
console.log('PASS  the Owner cannot revoke their own console access; no price string; no consent token');

assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  people-page');
