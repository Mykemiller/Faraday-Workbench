// FDY-285 (revised): the sign-in dialog in headless Chromium. No network: /api/auth is intercepted.
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
  if (b.action === 'sign_in') { if (b.key !== 'the-key') return ok({ error: 'That key did not work.' }, 401); session = owner; return ok(owner); }
  if (b.action === 'sign_out') { session = null; return ok({ ok: true, signedIn: false }); }
  return ok({ error: 'unknown action' }, 400);
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
assert.equal(await page.getAttribute('#wb-si-key', 'type'), 'password', 'the key is masked');
assert.equal(await page.locator('#wb-si-email').count(), 0, 'no email field: no email code');
assert.equal(await page.locator('#wb-signin summary').count(), 0, 'no break-glass section');
await page.fill('#wb-si-key', 'wrong'); await page.click('#wb-si-key-form button');
await page.waitForFunction(() => /did not work/.test(document.getElementById('wb-si-msg').textContent));
assert.equal(await page.locator('#wb-signin[open]').count(), 1, 'a wrong key stays on the dialog');
await page.fill('#wb-si-key', 'the-key'); await page.click('#wb-si-key-form button');
await page.waitForFunction(() => !document.getElementById('wb-signin').open);
assert.match(await page.textContent('#wb-auth'), /owner@example\.com · Sign out/);
assert.equal(await page.isVisible('#wb-console'), true); assert.equal(await page.getAttribute('#wb-console', 'href'), '/admin');
await page.waitForFunction(() => document.getElementById('isp-actor').readOnly === true);
assert.ok(subsCalls >= 1, 'the Admin tab loads once signed in');
assert.deepEqual(posts.map((p) => p.action), ['sign_in', 'sign_in']);
console.log('PASS  one key field: wrong key stays on the dialog; right key signs in and Admin loads');

const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
assert.equal(/the-key|wb_session/.test(stored), false, 'nothing secret is readable by page script');
await page.click('#wb-auth');
await page.waitForFunction(() => document.getElementById('wb-auth').textContent.trim() === 'Sign in');
assert.equal(await page.evaluate(() => document.getElementById('isp-actor').readOnly), false);
console.log('PASS  sign out; no key or session is kept in localStorage or readable cookies');

assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  auth-page');
