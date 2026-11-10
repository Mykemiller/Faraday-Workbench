// Admin tab: subscriber list, filters, detail, gated writes. No network: the API is intercepted.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { teamCounts, parseAction } = require('../api/workbench-subscribers.js');

// ---- pure logic ----
assert.deepEqual(teamCounts([
  { subscriber_id: 'a', team_id: 't1' }, { subscriber_id: 'a', team_id: 't1' }, // same team, two seasons
  { subscriber_id: 'a', team_id: 't2' }, { subscriber_id: 'b', team_id: 't1' }
]), { a: 2, b: 1 });
const plans = [{ tier: 'free' }, { tier: 'pro' }];
const id = '11111111-1111-1111-1111-111111111111';
assert.match(parseAction({ action: 'pause', subscriberId: id, reason: '' }, plans).error, /reason/i);
assert.match(parseAction({ action: 'nuke', subscriberId: id, reason: 'x' }, plans).error, /action/);
assert.match(parseAction({ action: 'pause', subscriberId: 'nope', reason: 'x' }, plans).error, /uuid/);
assert.match(parseAction({ action: 'set_tier', subscriberId: id, reason: 'x', tier: 'gold' }, plans).error, /tier/i);
assert.equal(parseAction({ action: 'set_tier', subscriberId: id, reason: 'x', tier: 'pro' }, plans).ok, true);
console.log('PASS  pure logic');

// ---- gating ----
const handler = require('../api/workbench-subscribers.js');
const mkRes = () => { const r = { code: 0, body: null, setHeader() {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
// FDY-285: the gate is a signed-in Owner session cookie, not the x-workbench-key header.
delete process.env.WORKBENCH_REFRESH_SECRET;
let r = mkRes(); await handler({ method: 'GET', headers: {} }, r); assert.equal(r.code, 503);
const S = await import('./_session.mjs'); S.configure();
r = mkRes(); await handler({ method: 'GET', headers: {} }, r); assert.equal(r.code, 401);
r = mkRes(); await handler({ method: 'GET', headers: { 'x-workbench-key': S.SHARED_KEY } }, r); assert.equal(r.code, 401);
r = mkRes(); await handler({ method: 'DELETE', headers: {} }, r); assert.equal(r.code, 405);
console.log('PASS  gating (503 unset, 401 no session, 401 raw shared key, 405 method)');

// ---- page ----
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.WB_PAGE || 'file://' + path.join(HERE, '..', 'index.html');
const CHROME = process.env.WB_CHROME;
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e)));
const other = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'workbench-payloads.json'), 'utf8'));
const scoring = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'scoring-panels.payload.json'), 'utf8'));
const serve = (n, b) => page.route(`**/rpc/${n}`, x => x.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }));
await serve('workbench_scoring_panels', scoring); await serve('workbench_health', other.health);
await serve('workbench_idf', other.idf); await serve('workbench_forecast_model', other.forecast); await serve('workbench_storefront', other.storefront);
const subs = [
  { id, email: 'a@x.com', handle: 'alpha', active: true, play_streak: 3, last_seen_at: '2026-08-04T12:00:00Z', created_at: '2026-08-01T12:00:00Z', teams: 2, tier: 'pro' },
  { id: '22222222-2222-2222-2222-222222222222', email: 'b@x.com', handle: null, active: false, play_streak: 0, last_seen_at: null, created_at: '2026-07-01T12:00:00Z', teams: 0, tier: 'free' }
];
const calls = []; let posted = null;
await page.route('**/api/workbench-subscribers**', route => {
  const req = route.request(); calls.push(req.method() + ' ' + new URL(req.url()).search + ' key=' + (req.headers()['x-workbench-key'] || 'none'));
  if (req.method() === 'POST') { posted = JSON.parse(req.postData()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'Account paused.' }) }); }
  const u = new URL(req.url());
  const body = u.searchParams.get('id')
    ? { subscriber: subs[0], teams: [{ name: 'Cloud', captain: true, pending: false }], access: { liveAgent: { tier: 'pro', balance: 40, cycle: '2026-11-01' } }, plans: [{ tier: 'free', entitled: false, monthly_tokens: 0 }, { tier: 'pro', entitled: true, monthly_tokens: 200 }], audit: [] }
    : { subscribers: subs, plans: [] };
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
await page.addInitScript(() => localStorage.setItem('wb.refresh.key', 'k1')); // a leftover key from before FDY-285
await page.addInitScript(() => { window.__wbAuthProbe = true; }); await page.route('**/api/auth', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedIn: true, kind: 'owner', email: 'owner@example.com', personId: '11111111-1111-4111-8111-111111111111', fresh: true }) }));
await page.goto(PAGE);
await page.waitForTimeout(400);
assert.equal(calls.length, 0); console.log('PASS  Admin does not call the API until opened');
await page.click('#tab-admin');
await page.waitForSelector('.adm-row[data-id]');
assert.equal(await page.locator('.adm-row[data-id]').count(), 2);
assert.match(calls[0], /GET\s+key=none/);
assert.equal(await page.evaluate(() => localStorage.getItem('wb.refresh.key')), null);
assert.equal(await page.getAttribute('#isp-moved', 'href'), '/admin/people/access', 'ISpyaDC access now lives in the console (FDY-289)');
assert.equal(await page.locator('#isp-actor, #isp-add, #isp-list').count(), 0, 'the old ISpyaDC screen is gone');
assert.match(await page.textContent('#wb-auth'), /owner@example\.com · Sign out/);
console.log('PASS  list loads with the session; the shared key is neither sent nor kept in the browser; actor is the signed-in owner');
await page.click('#adm-filters [data-f="paused"]');
assert.equal(await page.locator('.adm-row[data-id]').count(), 1);
await page.click('#adm-filters [data-f="all"]');
await page.fill('#adm-q', 'alpha'); assert.equal(await page.locator('.adm-row[data-id]').count(), 1);
await page.fill('#adm-q', ''); console.log('PASS  status filter and search');
await page.click(`.adm-row[data-id="${id}"]`); await page.waitForSelector('#adm-tier');
assert.match(await page.textContent('#adm-detail'), /40.*tokens/); console.log('PASS  detail shows Live Agent access');
await page.click('[data-adm="pause"]');
assert.match(await page.textContent('#adm-msg'), /reason is required/i); assert.equal(posted, null);
console.log('PASS  write refused client-side without a reason');
await page.fill('#adm-reason-acct', 'testing'); await page.click('[data-adm="pause"]');
await page.waitForFunction(() => document.getElementById('adm-msg').textContent.includes('paused'));
assert.deepEqual(posted, { action: 'pause', subscriberId: id, reason: 'testing' }); console.log('PASS  pause posts action, id and reason');
// keyboard path also lazy-loads (reload, land on Admin via hash)
calls.length = 0; await page.goto(PAGE + '#admin'); await page.waitForSelector('.adm-row[data-id]');
console.log('PASS  deep link #admin loads the list');
assert.deepEqual(errs, [], 'no JS exceptions: ' + errs.join(' | '));
await browser.close(); console.log('admin-tab: ok');
