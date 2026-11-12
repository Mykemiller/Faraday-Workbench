// FDY-292: the audit timeline in headless Chromium, through the real handlers over an in-memory database.
// Both logs in one list, filters, before/after/reason, revert through the reason panel, refusals shown.
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
const rpcAs = (rpc, args) => db.fetch('https://x.supabase.co/rest/v1/rpc/' + rpc, { method: 'POST', body: JSON.stringify({ p_actor: OWNER_ID, p_actor_verified: true, p_via: 'workbench:console', ...args }) });
await rpcAs('estate_access_set', { p_email: 'kim@example.org', p_product: 'ispyadc', p_role: 'tester', p_status: 'active', p_expires_at: null, p_note: null, p_reason: 'pilot' });
await rpcAs('estate_access_set', { p_email: 'kim@example.org', p_product: 'ispyadc', p_role: 'tester', p_status: 'revoked', p_expires_at: null, p_note: null, p_reason: 'left the pilot' });
db.addRecipient('r@example.org');
await rpcAs('predicts_review_recipient', { p_email: 'r@example.org', p_decision: 'approve', p_actor: OWNER_ID });
db.audit.forEach((r, i) => { r.at = new Date(Date.parse('2026-11-11T12:00:00Z') + i * 60000).toISOString(); });
db.addLo('staff@x.io', 'seasons', 'season.save', { at: '2026-11-11T12:02:30Z', target_type: 'season', target_id: 'S-2026', before: { n: 1 }, after: { n: 2 }, reason: 'tune', reversible: true });

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
const rows = () => page.locator('#audit-table tbody tr');
const loaded = () => page.waitForSelector('#audit-table:not([hidden]) tbody tr');

await page.goto(ORIGIN + '/admin/audit'); await loaded();
assert.equal(await rows().count(), 5, 'person.create, add, revoke, consent.approve, and the League Office row');
const texts = await rows().allTextContents();
assert.match(texts[0], /consent\.approve/, 'newest first');
assert.ok(texts.some((t) => /season\.save/.test(t) && /seasons/.test(t) && /season:S-2026/.test(t) && /"n":1/.test(t) && /"n":2/.test(t) && /tune/.test(t)), 'League Office row: app, subject, before, after, reason');
assert.ok(texts.some((t) => /access\.revoke/.test(t) && /"status":"active"/.test(t) && /"status":"revoked"/.test(t) && /left the pilot/.test(t)), 'console row: before, after, reason');
assert.equal(await page.locator('#audit-table button[data-revert]').count(), 2, 'Revert only on rows that can be reverted (add + revoke)');
assert.match(await page.textContent('#audit-table'), /No revert/);
console.log('PASS  Audit shows both logs newest first, with before, after and reason, and Revert only where it is possible');

await page.fill('#audit-q', 'kim@'); await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 3);
await page.fill('#audit-q', ''); await page.selectOption('#audit-source', 'league_office'); await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 1);
await page.selectOption('#audit-source', ''); await page.fill('#audit-app', 'seasons'); await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 1);
await page.fill('#audit-app', ''); await page.fill('#audit-actor', 'staff@'); await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 1);
await page.fill('#audit-actor', 'nobody@example.org'); await page.waitForFunction(() => /No audit rows match/.test(document.getElementById('audit-msg').textContent));
await page.fill('#audit-actor', ''); await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 5);
console.log('PASS  filters: person, which log, app, who did it, and an empty result says so');

// revert through the reason panel
const n0 = db.audit.length;
await page.locator('#audit-table tbody tr', { hasText: 'access.revoke' }).locator('button[data-revert]').click();
await page.waitForSelector('#reason-panel:not([hidden])');
assert.match(await page.textContent('#reason-title'), /Revert: access\.revoke \(kim@example\.org\)/);
assert.match(await page.textContent('#reason-diff'), /revoked/); assert.match(await page.textContent('#reason-diff'), /active/);
await page.fill('#reason-text', 'came back'); await page.click('#reason-save');
await page.waitForFunction(() => /Reverted audit/.test(document.getElementById('audit-msg').textContent));
assert.equal(db.audit.length, n0 + 1); assert.equal(db.audit.at(-1).action, 'access.restore'); assert.match(db.audit.at(-1).reason, /^Revert of audit #.*: came back$/);
await page.waitForFunction(() => document.querySelectorAll('#audit-table tbody tr').length === 6);
assert.match(await page.locator('#audit-table tbody tr', { hasText: 'left the pilot' }).textContent(), /Reverted/, 'the reverted row now says so and has no button');
console.log('PASS  Revert: reason panel shows the change, Save makes one new row, the old row is marked Reverted');

// cancel writes nothing; a refusal is shown, nothing written
const n1 = db.audit.length;
await page.locator('#audit-table tbody tr', { hasText: 'access.add' }).locator('button[data-revert]').click();
await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-cancel');
assert.equal(db.audit.length, n1, 'Cancel writes nothing');
await rpcAs('estate_access_set', { p_email: 'kim@example.org', p_product: 'ispyadc', p_role: 'viewer', p_status: 'active', p_expires_at: null, p_note: null, p_reason: 'role changed' });
const n2 = db.audit.length;
await page.locator('#audit-table tbody tr', { hasText: 'access.add' }).locator('button[data-revert]').click();
await page.waitForSelector('#reason-panel:not([hidden])'); await page.click('#reason-save');
await page.waitForFunction(() => /changed since/.test(document.getElementById('audit-msg').textContent));
assert.equal(await page.getAttribute('#audit-msg', 'class'), 'msg err'); assert.equal(db.audit.length, n2, 'a refused revert writes nothing');
console.log('PASS  Cancel writes nothing; a refused revert shows why and writes nothing');

assert.deepEqual(errs, [], 'no script errors');
await browser.close();
console.log('ALL PASS  audit-page');
