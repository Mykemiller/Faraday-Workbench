// FDY-298: People > Operators in headless Chromium, through the real handlers over an in-memory database.
// The tab, the add form, the reason panel, per-row changes, the waiting state, and the person page showing an operator row read-only.
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
const pat = db.addPerson('pat@example.org');
db.access.push({ person_id: pat.id, product: 'workbench', role: 'operator', scope_product: 'ispyadc', status: 'active', expires_at: null, note: null, added_by: 'test', updated_at: new Date().toISOString() });

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
const rows = () => page.locator('#ops-table tbody tr');
const settled = () => page.waitForFunction(() => /ok|err/.test(document.getElementById('ops-msg').className));
const confirmPanel = async (reason) => {
  await page.waitForSelector('#reason-panel:not([hidden])');
  await page.fill('#reason-text', reason || '');
  await page.evaluate(() => { document.getElementById('ops-msg').className = 'msg'; });
  await page.click('#reason-save'); await settled();
};

// reached from People
await page.goto(ORIGIN + '/admin/people');
await page.click('.tabs a:text-is("Operators")'); await page.waitForURL(/tab=operators/);
await page.waitForSelector('#ops-table:not([hidden]) tbody tr');
assert.equal(await page.isVisible('#dir-panel'), false); assert.equal(await page.isVisible('#ops-panel'), true);
assert.equal(await page.getAttribute('.tabs a[href="/admin/people?tab=operators"]', 'aria-current'), 'page');
assert.match(await page.textContent('#ops-panel'), /Adding an operator does not let them in yet/);
assert.match(await page.textContent('#ops-panel'), /cannot change prices, lock config, grant console roles or see secrets/);
assert.equal(await rows().count(), 1); assert.match(await rows().first().textContent(), /pat@example\.org.*ISpyaDC.*active/);
console.log('PASS  Operators opens from People: the rows, the scope, and what an operator can and cannot do');

// add the Owner's own operator row, scope all apps
const n0 = db.audit.length;
await page.fill('#ops-email', OWNER); await page.selectOption('#ops-scope', ''); await page.click('#ops-form button[type=submit]');
await page.waitForSelector('#reason-panel:not([hidden])');
assert.match(await page.textContent('#reason-title'), /Add operator owner@example\.com/); assert.match(await page.textContent('#reason-diff'), /All apps/);
await page.evaluate(() => { document.getElementById('ops-msg').className = 'msg'; });
await page.fill('#reason-text', 'my own row'); await page.click('#reason-save'); await settled();
assert.match(await page.textContent('#ops-msg'), /cannot sign in to the console yet/);
assert.equal(db.audit.length, n0 + 1); assert.equal(db.audit.at(-1).action, 'operator.add'); assert.equal(db.audit.at(-1).reason, 'my own row');
assert.equal(await rows().count(), 2);
console.log('PASS  Add operator: reason panel, one audit row, the new row appears, entry stays Owner-only');

// pause then revoke a row
await rows().filter({ hasText: 'pat@example.org' }).locator('button[data-act="pause"]').click(); await confirmPanel('away');
assert.equal(db.audit.at(-1).action, 'operator.pause'); assert.match(await rows().filter({ hasText: 'pat@example.org' }).textContent(), /paused/);
await rows().filter({ hasText: 'pat@example.org' }).locator('button[data-act="revoke"]').click(); await confirmPanel('');
assert.equal(db.audit.at(-1).action, 'operator.revoke'); assert.match(await rows().filter({ hasText: 'pat@example.org' }).textContent(), /revoked/);
assert.equal(await rows().filter({ hasText: 'pat@example.org' }).locator('button[data-act="restore"]').count(), 1);
console.log('PASS  pause and revoke from the row, each one audit row; a revoked row offers Restore');

// the person page shows the operator row read-only
await page.goto(ORIGIN + '/admin/people/' + pat.id);
await page.waitForSelector('#access-table tbody tr[data-operator]');
const orow = page.locator('#access-table tbody tr[data-operator]');
assert.match(await orow.textContent(), /operator · ISpyaDC/); assert.equal(await orow.locator('button, select, input').count(), 0, 'no controls on an operator row'); assert.match(await orow.textContent(), /Manage in Operators/);
console.log('PASS  the person page lists an operator row read-only and points to Operators');

// waiting state
db.noOperatorColumn = true; await page.goto(ORIGIN + '/admin/people?tab=operators');
await page.waitForFunction(() => /Waiting on FDY-298 migration/.test(document.getElementById('ops-msg').textContent));
assert.equal(await page.isVisible('#ops-add'), false);
db.noOperatorColumn = false;
console.log('PASS  waiting state: "Waiting on FDY-298 migration", no add form');

// the directory still works
await page.goto(ORIGIN + '/admin/people');
await page.waitForFunction(() => /person|people/.test(document.getElementById('people-count').textContent));
assert.equal(await page.isVisible('#ops-panel'), false); assert.equal(await page.isVisible('#dir-panel'), true);
assert.deepEqual(errs, [], 'no script errors');
await browser.close();
console.log('ALL PASS  operators-page');
