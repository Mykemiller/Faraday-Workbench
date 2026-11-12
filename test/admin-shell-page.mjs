// FDY-287: the /admin shell in headless Chromium, served the way production serves it (the real
// handler behind a faked session and data). Covers navigation by URL, People, Audit and the
// reason side panel. No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, fakeWorld, ownerHeaders } from './_session.mjs';
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const CHROME = process.env.WB_CHROME;
const shell = require('../api/admin/shell.js');
const router = require('../api/admin/[route].js');

const OWNER = 'owner@example.com', OWNER_ID = '11111111-1111-4111-8111-111111111111';
configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const w = fakeWorld(); w.access[OWNER] = { role: 'owner', status: 'active', person_id: OWNER_ID };
const PEOPLE = [
  { id: OWNER_ID, email: OWNER, display_name: 'Owner', source: 'predicts-approved', created_at: '2026-11-06T22:00:00Z', product_access: [{ product: 'workbench', role: 'owner', status: 'active', expires_at: null }] },
  { id: '22222222-2222-4222-8222-222222222222', email: 'tester@example.com', display_name: null, source: 'dailychallenge', created_at: '2026-11-07T10:00:00Z', product_access: [{ product: 'ispyadc', role: 'tester', status: 'revoked', expires_at: null }] }
];
const AUDIT = [
  { id: 'a1', at: '2026-11-09T19:40:00Z', actor: OWNER_ID, actor_verified: true, product: 'workbench', subject_email: OWNER, action: 'workbench.sign_in', reason: null, old_value: null, new_value: {}, via: 'workbench:email-code' },
  { id: 'a2', at: '2026-11-09T19:30:00Z', actor: 'break-glass:shared-key', actor_verified: false, product: 'workbench', subject_email: '*', action: 'workbench.break_glass', reason: 'email <b>down</b>', old_value: null, new_value: {}, via: 'workbench:break-glass' }
];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const json = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.pathname === '/rest/v1/estate_people') return json(u.searchParams.get('id') ? [{ id: OWNER_ID, email: OWNER }] : PEOPLE);
  if (u.pathname === '/rest/v1/admin_audit') { const f = u.searchParams.get('subject_email'); return json(f ? AUDIT.filter((r) => r.subject_email.includes(f.replace(/^ilike\.\*|\*$/g, ''))) : AUDIT); }
  return w.fetch(url, init);
};

let signedIn = true;
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const ORIGIN = 'http://wb.test';
await page.route(ORIGIN + '/**', async (route) => {
  const u = new URL(route.request().url());
  const headers = signedIn ? ownerHeaders(OWNER_ID, OWNER) : {};
  const res = mkRes();
  const query = Object.fromEntries(u.searchParams);
  if (u.pathname === '/admin' || /^\/admin\/[^/]+$/.test(u.pathname)) await shell({ method: 'GET', headers, query: { area: u.pathname.split('/')[2] } }, res); // what the vercel.json rewrites do
  else if (u.pathname.startsWith('/api/admin/')) await router({ method: route.request().method(), headers, url: u.pathname + u.search, query }, res);
  else return route.fulfill({ status: 404, body: '' });
  const html = typeof res.body === 'string';
  route.fulfill({ status: res.code, contentType: html ? 'text/html; charset=utf-8' : 'application/json', body: html ? res.body : JSON.stringify(res.body) });
});

// ---- each screen has its own URL ----
let resp = await page.goto(ORIGIN + '/admin');
assert.equal(resp.status(), 200);
assert.equal(await page.textContent('h1'), 'Home'); assert.match(await page.textContent('main'), /Coming in Phase 1/);
assert.equal(await page.locator('nav.areas a').count(), 6);
assert.equal((await page.textContent('#who')).trim(), OWNER);
for (const [label, url, re] of [['Plans and billing', '/admin/plans', /Coming in Phase 3/], ['Console', '/admin/console', /Coming in Phase 2/]]) {
  await page.click(`nav.areas a:text-is("${label}")`); await page.waitForURL(ORIGIN + url);
  assert.equal(await page.textContent('h1'), label); assert.match(await page.textContent('main'), re);
  assert.equal(await page.getAttribute('nav.areas a[aria-current="page"]', 'href'), url);
}
console.log('PASS  six areas in the navigation; each opens at its own /admin URL; placeholders name their phase');

// ---- Apps has content now (its own tests: test/apps.mjs, test/apps-page.mjs) ----
await page.click('nav.areas a:text-is("Apps")'); await page.waitForURL(ORIGIN + '/admin/apps');
assert.equal(await page.textContent('h1'), 'Apps'); assert.equal(await page.locator('main .soon').count(), 0); assert.equal(await page.locator('.tabs a').count(), 2);
console.log('PASS  Apps opens with content (Cards and Settings tabs), not a placeholder');

// ---- People (the directory and Person page have their own test: test/people-page.mjs) ----
await page.click('nav.areas a:text-is("People")'); await page.waitForURL(ORIGIN + '/admin/people');
await page.waitForSelector('#people-table:not([hidden]) tbody tr');
assert.equal(await page.locator('#people-table tbody tr').count(), 2);
console.log('PASS  People opens from the navigation and lists people');

// ---- Audit ----
await page.goto(ORIGIN + '/admin/audit');
await page.waitForSelector('#audit-table:not([hidden]) tbody tr');
assert.equal(await page.locator('#audit-table tbody tr').count(), 2);
const first = await page.textContent('#audit-table tbody tr:nth-child(1)');
assert.match(first, /owner@example\.com/); assert.match(first, /workbench\.sign_in/); assert.match(first, /11\/09\/2026, 13:40/, 'shown in Central Time');
const second = await page.textContent('#audit-table tbody tr:nth-child(2)');
assert.match(second, /break-glass:shared-key \(unverified\)/); assert.match(second, /email <b>down<\/b>/, 'a reason is shown as text, not markup');
assert.equal(await page.locator('#audit-table tbody b').count(), 0);
await page.fill('#audit-q', 'owner@');
await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 1);
console.log('PASS  Audit lists rows newest first, names the person behind an actor id, flags unverified actors, filters');

// ---- reason side panel: before and after, optional reason, Save ----
assert.equal(await page.isHidden('#reason-panel'), true);
const openPanel = (opts) => page.evaluate((o) => { window.__r = undefined; window.AdminConsole.reasonPanel(o).then((v) => { window.__r = v; }); }, opts);
const result = () => page.evaluate(() => window.__r);
const change = { title: 'Change access for tester@example.com', before: { role: 'tester', status: 'active', note: null }, after: { role: 'admin', status: 'active', note: null } };
await openPanel(change);
await page.waitForSelector('#reason-panel:not([hidden])');
assert.equal(await page.textContent('#reason-title'), change.title);
assert.equal(await page.locator('#reason-diff tr').count(), 1, 'only the fields that change are listed');
assert.match(await page.textContent('#reason-diff'), /role\s*tester\s*admin/);
assert.equal(await page.inputValue('#reason-text'), '');
assert.equal(await page.getAttribute('#reason-text', 'required'), null);
assert.match(await page.textContent('#reason-hint'), /Optional/);
await page.click('#reason-save');
assert.deepEqual(await result(), { reason: '', linearIssue: null });
assert.equal(await page.isHidden('#reason-panel'), true);
console.log('PASS  reason panel shows before and after; Save works with no reason');

await openPanel({ ...change, linearIssue: 'fdy-289' });
assert.equal(await page.inputValue('#reason-text'), 'FDY-289', 'the reason starts as the Linear issue the change names');
await page.click('#reason-save');
assert.deepEqual(await result(), { reason: 'FDY-289', linearIssue: 'FDY-289' });
await openPanel({ ...change, linearIssue: 'FDY-289' });
await page.fill('#reason-text', 'Promoted for the pilot');
await page.click('#reason-save');
assert.deepEqual(await result(), { reason: 'Promoted for the pilot', linearIssue: 'FDY-289' });
await openPanel(change); await page.keyboard.press('Escape');
assert.equal(await result(), null, 'Escape cancels');
await openPanel(change); await page.click('#reason-cancel');
assert.equal(await result(), null);
await openPanel({ title: 'No-op', before: { role: 'admin' }, after: { role: 'admin' } });
assert.match(await page.textContent('#reason-diff'), /Nothing changes/); assert.equal(await page.isDisabled('#reason-save'), true);
await page.click('#reason-cancel');
await openPanel({ title: 'x', before: { note: '<img src=x onerror=alert(1)>' }, after: { note: 'ok' } });
assert.equal(await page.locator('#reason-diff img').count(), 0, 'values are shown as text');
await page.click('#reason-cancel');
console.log('PASS  reason panel: Linear issue default, typed reason wins, Cancel and Escape, no-op and markup handled');

// ---- signed out: the pages are gone ----
signedIn = false;
resp = await page.goto(ORIGIN + '/admin/people');
assert.equal(resp.status(), 404);
assert.equal(/Faraday Admin|People/.test(await page.content()), false, 'no console markup is served');
console.log('PASS  without an Owner session /admin answers 404 and serves no console markup');

assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  admin-shell-page');
