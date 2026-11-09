// FDY-285: the sign-in dialog in headless Chromium. No network: /api/auth is intercepted.
import assert from 'node:assert/strict';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.WB_PAGE || 'file://' + path.join(HERE, '..', 'index.html');
const CHROME = process.env.WB_CHROME;
const other = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'workbench-payloads.json'), 'utf8'));
const scoring = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'scoring-panels.payload.json'), 'utf8'));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const serve = (n, b) => page.route(`**/rpc/${n}`, (x) => x.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }));
await serve('workbench_scoring_panels', scoring); await serve('workbench_health', other.health);
await serve('workbench_idf', other.idf); await serve('workbench_forecast_model', other.forecast); await serve('workbench_storefront', other.storefront);

let session = null; const posts = []; let subsCalls = 0;
const owner = { signedIn: true, kind: 'owner', email: 'owner@example.com', personId: '11111111-1111-4111-8111-111111111111', fresh: true };
await page.addInitScript(() => { window.__wbAuthProbe = true; });
await page.route('**/api/auth', (route) => {
  const req = route.request(); const ok = (b, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
  if (req.method() === 'GET') return ok(session || { signedIn: false });
  const b = JSON.parse(req.postData()); posts.push(b);
  if (b.action === 'request_code') return ok({ ok: true, message: 'If that address has Workbench access, a code is on its way.' });
  if (b.action === 'verify_code') { if (b.code !== '123456') return ok({ error: 'That code did not work. Request a new one and try again.' }, 401); session = owner; return ok(owner); }
  if (b.action === 'break_glass') { if (b.key !== 'the-key') return ok({ error: 'Unauthorized' }, 401); session = { signedIn: true, kind: 'break-glass', email: null, personId: null, fresh: false }; return ok(session); }
  if (b.action === 'sign_out') { session = null; return ok({ ok: true, signedIn: false }); }
});
await page.route('**/api/workbench-subscribers**', (route) => { subsCalls++; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscribers: [], plans: [] }) }); });
await page.route('**/api/workbench-ispyadc-access**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: false, missing: [], grants: [], audit: [] }) }));

await page.goto(PAGE);
await page.waitForTimeout(300);
assert.equal((await page.textContent('#wb-auth')).trim(), 'Sign in');
assert.equal(await page.locator('#wb-signin[open]').count(), 0, 'no dialog until asked');
await page.click('#tab-admin');
await page.waitForFunction(() => /Sign in/.test(document.getElementById('adm-msg')?.textContent || ''));
assert.equal(subsCalls, 0, 'signed out: the Admin tab calls nothing');
assert.equal(await page.locator('#wb-signin[open]').count(), 0, 'visiting Admin does not pop the dialog');
console.log('PASS  signed out: Admin tab asks for sign-in and calls no API');

await page.click('#wb-auth');
await page.waitForSelector('#wb-signin[open]');
assert.equal(await page.isHidden('#wb-si-code-form'), true);
await page.fill('#wb-si-email', 'owner@example.com'); await page.click('#wb-si-email-form button');
await page.waitForSelector('#wb-si-code-form:not([hidden])');
assert.match(await page.textContent('#wb-si-msg'), /If that address has Workbench access/);
assert.equal(await page.getAttribute('#wb-si-code', 'autocomplete'), 'one-time-code');
await page.fill('#wb-si-code', '000000'); await page.click('#wb-si-code-form button');
await page.waitForFunction(() => /did not work/.test(document.getElementById('wb-si-msg').textContent));
assert.equal(await page.locator('#wb-signin[open]').count(), 1);
await page.fill('#wb-si-code', '123456'); await page.click('#wb-si-code-form button');
await page.waitForFunction(() => !document.getElementById('wb-signin').open);
assert.match(await page.textContent('#wb-auth'), /owner@example\.com · Sign out/);
await page.waitForFunction(() => document.getElementById('isp-actor').readOnly === true);
assert.ok(subsCalls >= 1, 'the Admin tab loads once signed in');
assert.deepEqual(posts.map((p) => p.action), ['request_code', 'verify_code', 'verify_code']);
console.log('PASS  email -> code -> signed in; wrong code stays on the dialog; Admin loads after sign-in');

const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
assert.equal(/123456|the-key|wb_session/.test(stored), false, 'nothing secret is readable by page script');
await page.click('#wb-auth');
await page.waitForFunction(() => document.getElementById('wb-auth').textContent.trim() === 'Sign in');
assert.equal(await page.evaluate(() => document.getElementById('isp-actor').readOnly), false);
console.log('PASS  sign out; no code, key or session is kept in localStorage or readable cookies');

await page.click('#wb-auth'); await page.waitForSelector('#wb-signin[open]');
await page.click('#wb-signin summary');
assert.equal(await page.getAttribute('#wb-si-bg', 'type'), 'password');
await page.fill('#wb-si-bg', 'nope'); await page.click('#wb-si-bg-form button');
await page.waitForFunction(() => /Unauthorized/.test(document.getElementById('wb-si-msg').textContent));
await page.fill('#wb-si-bg', 'the-key'); await page.click('#wb-si-bg-form button');
await page.waitForFunction(() => !document.getElementById('wb-signin').open);
assert.match(await page.textContent('#wb-auth'), /Break-glass · Sign out/);
assert.equal(await page.inputValue('#wb-si-bg'), '', 'the key is cleared from the field');
console.log('PASS  break-glass key path: wrong key refused, right key gives a labelled break-glass session');

assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  auth-page');
