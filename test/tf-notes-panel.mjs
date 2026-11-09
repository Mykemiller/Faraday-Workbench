// CC-TF-NOTES-OUTBOX-1.0 · panel behaviour in headless Chromium. No network: every API is intercepted.
import assert from 'node:assert/strict';
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.WB_PAGE || 'file://' + path.join(HERE, '..', 'index.html');
const CHROME = process.env.WB_CHROME;
const ACCEPT = 'Web site Bios need to be LinkedIn or CV style, not voice or script prompts';

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const other = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'workbench-payloads.json'), 'utf8'));
const scoring = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'scoring-panels.payload.json'), 'utf8'));
const serve = (n, b) => page.route(`**/rpc/${n}`, (x) => x.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(typeof b === 'function' ? b() : b) }));
await serve('workbench_scoring_panels', scoring); await serve('workbench_health', other.health);
await serve('workbench_idf', other.idf); await serve('workbench_forecast_model', other.forecast); await serve('workbench_storefront', other.storefront);
let NOTES = { 'thought-forge': [{ id: 9, kind: 'note', body: 'older note', status: 'open', created_at: '2026-11-07T12:00:00Z', sync_status: 'linear_pending', attempts: 2, last_error: 'Linear 500' }] };
await page.route('**/rpc/workbench_product_notes', (x) => x.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NOTES) }));

// FDY-285: the panel signs in with a session cookie; no key is sent or stored. The notes route
// itself checks no key (PR #31), so a save needs no sign-in; the Linear retry does.
const posts = []; let mode = 'ok'; const retries = [];
await page.addInitScript(() => { window.__wbAuthProbe = true; }); await page.route('**/api/auth', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedIn: true, kind: 'owner', email: 'owner@example.com', personId: '11111111-1111-4111-8111-111111111111', fresh: true }) }));
await page.route('**/api/workbench-notes', async (route) => {
  const req = route.request(); const body = JSON.parse(req.postData() || '{}');
  posts.push({ key: req.headers()['x-workbench-key'] || null, body });
  if (mode === 'down') return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream"}' });
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 400));
  const note = { id: 10, kind: body.kind, body: body.body, status: 'open', created_at: '2026-11-08T17:30:00Z', client_id: body.client_id, source: body.source, sync_status: 'synced', linear_identifier: 'TH-70', linear_url: 'https://linear.app/x/issue/TH-70' };
  NOTES = { 'thought-forge': [note, ...NOTES['thought-forge']] };
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, duplicate: false, note, sync: { status: 'synced' } }) });
});
await page.route('**/api/thoughtforge-sync', (route) => { retries.push(route.request().headers()['x-workbench-key'] || null); route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"considered":0,"results":[]}' }); });

await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('wb.refresh.key', 'stale-key'); sessionStorage.setItem('seeded', '1'); } });
await page.goto(PAGE);
const open = async () => {
  await page.waitForSelector('#storefronts .abtn[data-slug="thought-forge"][data-tab="notes"]', { timeout: 15000 });
  await page.click('#storefronts .abtn[data-slug="thought-forge"][data-tab="notes"]');
  await page.waitForSelector('#note-body');
};
await open();
assert.match(await page.textContent('#drawer-body'), /Linear retrying \(2\/10\)/);
await page.waitForTimeout(150);
assert.deepEqual(retries, [null]);
assert.equal(await page.evaluate(() => localStorage.getItem('wb.refresh.key')), null, 'the leftover shared key is deleted on load');
console.log('PASS  pending notes are retried when the drawer opens, by session, with no key sent or kept');

await page.fill('#note-body', ACCEPT);
await page.selectOption('#note-source', 'voice');
mode = 'down';
await page.click('#note-save');
await page.waitForFunction(() => /Not saved/.test(document.getElementById('note-msg')?.textContent || ''));
assert.equal(await page.inputValue('#note-body'), ACCEPT, 'draft kept after a failed save');
assert.match(await page.textContent('#note-msg'), /still here/i);
console.log('PASS  a failed save keeps the draft');

// the drawer is redrawn (close + reopen) before retrying: the draft must survive that too
await page.click('#drawer-close'); await open();
assert.equal(await page.inputValue('#note-body'), ACCEPT);
await page.reload(); await open();
assert.equal(await page.inputValue('#note-body'), ACCEPT); assert.equal(await page.inputValue('#note-source'), 'voice');
console.log('PASS  draft survives a redraw and a reload');

mode = 'slow';
await page.click('#note-save');
await page.click('#note-save').catch(() => {}); // double-tap while the save is in flight
await page.waitForFunction(() => /TH-70 created/.test(document.getElementById('note-msg')?.textContent || ''), null, { timeout: 5000 });
const good = posts.slice(1);
assert.equal(good.length, 1, 'double-tap sends one save');
assert.equal(good[0].body.body, ACCEPT); assert.equal(good[0].body.source, 'voice'); assert.equal(good[0].key, null);
assert.equal(new Set(posts.map((p) => p.body.client_id)).size, 1, 'every attempt carried the same client_id');
assert.equal(await page.inputValue('#note-body'), '', 'cleared only after 200');
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tf_note_draft') || '{}')['thought-forge'] || null), null);
assert.match(await page.textContent('#drawer-body'), /TH-70/);
console.log('PASS  one save, draft cleared after 200, issue chip shown');

// feature detection: no Web Speech API -> no mic button
const p2 = await ctx.newPage();
await p2.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
for (const [n, b] of Object.entries({ workbench_scoring_panels: scoring, workbench_health: other.health, workbench_idf: other.idf, workbench_forecast_model: other.forecast, workbench_storefront: other.storefront, workbench_product_notes: NOTES }))
  await p2.route(`**/rpc/${n}`, (x) => x.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }));
await p2.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
await p2.goto(PAGE);
await p2.waitForSelector('#storefronts .abtn[data-slug="thought-forge"][data-tab="notes"]', { timeout: 15000 });
await p2.click('#storefronts .abtn[data-slug="thought-forge"][data-tab="notes"]'); await p2.waitForSelector('#note-body');
assert.equal(await p2.locator('#note-mic').count(), 0);
const hasSpeech = await page.evaluate(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
assert.equal(await page.locator('#note-mic').count(), hasSpeech ? 1 : 0);
console.log('PASS  mic button hidden where the Web Speech API is missing');

assert.deepEqual(errs.filter((e) => !/Failed to fetch|NetworkError/.test(e)), []);
await browser.close();
console.log('tf-notes-panel: ok');
