// FDY-360: live-site links. One column (app_registry.live_url), one helper (live-link.js), two surfaces.
//  1. the shared LiveSiteLink with and without a URL; 2. the board pill; 3. the Admin card link + Owner edit
//  through the real handlers over the in-memory database, in headless Chromium; 4. migration file checks.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import vm from 'node:vm';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const LL = require('../live-link.js');
const L = require('../api/_admin/apps-logic.js');
const shell = require('../api/admin/shell.js');
const shellLib = require('../api/_admin/shell.js');
const router = require('../api/admin/[route].js');
const { AUDITED_RPCS } = require('../api/_audit.js');
const { decide } = require('../api/_rights.js');

// ---- 1. the helper ----
{
  const pill = LL.html({ url: 'https://www.jurisdiction-watch.com', name: 'Jurisdiction Watch' });
  assert.match(pill, /^<a class="olink" href="https:\/\/www\.jurisdiction-watch\.com" target="_blank" rel="noopener noreferrer"/);
  assert.match(pill, /aria-label="Open Jurisdiction Watch live site"/); assert.match(pill, />LIVE SITE ↗<\/a>$/);
  for (const bad of [null, undefined, '', '  ', 'http://x.com', 'javascript:alert(1)', 'jurisdiction-watch.com', 'https://', 'https:// x.com', 'https://x.com/"onmouseover=1', 'ftp://x.com', 42]) {
    assert.equal(LL.safeUrl(bad), null, `rejects ${JSON.stringify(bad)}`);
    const h = LL.html({ url: bad, name: 'X' });
    assert.match(h, /<span class="olink none"[^>]*>NO LIVE URL<\/span>/); assert.doesNotMatch(h, /<a /);
    assert.equal(LL.html({ url: bad, name: 'X', variant: 'inline' }), '', 'inline draws nothing when there is no URL');
  }
  const inline = LL.html({ url: 'https://ispyadc.com', name: 'ISpyaDC', variant: 'inline' });
  assert.match(inline, /^<a class="livesite" href="https:\/\/ispyadc\.com" target="_blank" rel="noopener noreferrer" aria-label="Open ISpyaDC live site"[^>]*>Live site ↗<\/a>$/);
  assert.match(LL.html({ url: 'https://a.com/?q=1&r="2"', name: '<b>' }), /href="https:\/\/a\.com\/\?q=1&amp;r=&quot;2&quot;"|NO LIVE URL/, 'attributes are escaped');
  assert.match(LL.html({ url: 'https://a.com', name: '<b>' }), /aria-label="Open &lt;b&gt; live site"/);
  console.log('PASS  LiveSiteLink: https only, new tab + noopener noreferrer + aria-label, muted NO LIVE URL pill without a URL, inline variant empty without a URL');
}

// ---- 2. the board and the Admin page draw it with the SAME file ----
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="live-link\.js"><\/script>/, 'the board loads the shared helper');
  assert.doesNotMatch(html, /NO LIVE URL<\/span>`/, 'the board has no private NO LIVE URL markup of its own');
  const i = html.indexOf('function openLinkHtml('); const body = html.slice(i, html.indexOf('\n}', i) + 2);
  const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(new URL('../live-link.js', import.meta.url), 'utf8'), ctx); vm.runInContext(body, ctx);
  assert.match(vm.runInContext('openLinkHtml({name:"Daily Challenge",live_url:"https://www.faradaydailychallenge.com"})', ctx), /LIVE SITE ↗/);
  assert.match(vm.runInContext('openLinkHtml({name:"Boundstone",live_url:null})', ctx), /NO LIVE URL/);
  const page = shellLib.renderShell(shellLib.areaFor('apps'), { kind: 'owner', personId: OWNER_ID });
  assert.ok(page.includes('root.LiveSiteLink = api'), 'the Admin page prints the shared helper');
  assert.ok(page.indexOf('root.LiveSiteLink = api') < page.indexOf('function adminClient'), 'ahead of the client code');
  console.log('PASS  board and Admin Panel both draw the link with live-link.js (no duplicated URL logic)');
}

// ---- 3. server: validation, rights, audit ----
configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc'; delete process.env.VERCEL_API_TOKEN;
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
const CODES = ['JW', 'BS', 'WB'];
CODES.forEach((c) => db.addApp(c, c + ' app', 1, 2, { tracker_url: 'https://example.com/' + c, live_url: c === 'JW' ? 'https://www.jurisdiction-watch.com' : null }));
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const post = (body) => call({ method: 'POST', headers: ownerHeaders(OWNER_ID, OWNER), query: { route: 'apps' }, body });
{
  assert.deepEqual(AUDITED_RPCS.app_registry_set_live_url, { verified: true, via: true });
  assert.equal(decide({ kind: 'operator', grants: [{ scope: null }] }, 'registry.set_live_url', {}, 0).ok, false, 'an operator may not set it: Owner only');
  for (const bad of ['http://x.com', 'javascript:alert(1)', 'x.com', 'https://', 'https://x .com', 'https://' + 'a'.repeat(300) + '.com', 42, {}]) {
    const r = await post({ action: 'set_live_url', code: 'BS', live_url: bad }); assert.equal(r.code, 400, JSON.stringify(bad)); assert.match(r.body.error, /https/);
  }
  assert.equal(db.audit.length, 0, 'nothing written on a refusal');
  assert.equal(L.shapeApp(db.apps.find((a) => a.code === 'JW')).liveUrl, 'https://www.jurisdiction-watch.com');
  assert.equal(L.shapeApp(db.apps.find((a) => a.code === 'BS')).liveUrl, null);
  const list = await call({ method: 'GET', headers: ownerHeaders(OWNER_ID, OWNER), query: { route: 'apps' } });
  assert.equal(list.body.apps.find((a) => a.code === 'JW').liveUrl, 'https://www.jurisdiction-watch.com');
  let r = await post({ action: 'set_live_url', code: 'BS', live_url: ' https://www.boundstone.org ', reason: 'verified' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true);
  assert.equal(db.apps.find((a) => a.code === 'BS').live_url, 'https://www.boundstone.org');
  const a = db.audit[db.audit.length - 1]; assert.equal(a.action, 'app.live_url'); assert.equal(a.actor, OWNER_ID); assert.equal(a.old_value.live_url, null);
  r = await post({ action: 'set_live_url', code: 'BS', live_url: 'https://www.boundstone.org' }); assert.equal(r.body.changed, false); assert.equal(db.audit.length, 1, 'idempotent: no second audit row');
  r = await post({ action: 'set_live_url', code: 'BS', live_url: '' }); assert.equal(r.code, 200); assert.equal(db.apps.find((a2) => a2.code === 'BS').live_url, null, 'blank removes the link');
  r = await post({ action: 'set_live_url', code: 'ZZ', live_url: 'https://x.com' }); assert.equal(r.code, 400);
  console.log('PASS  set_live_url: Owner only, https only, audited with before/after, unchanged = no row, blank removes');
}

// ---- 4. migration file ----
{
  const sql = fs.readFileSync(new URL('../sql/add_live_url_to_app_registry.sql', import.meta.url), 'utf8');
  assert.ok(!fs.existsSync(new URL('../sql/wb_storefront_tiles_add_live_url.sql', import.meta.url)), 'the superseded FDY-324 file is gone');
  assert.match(sql, /add column if not exists live_url text/); assert.match(sql, /check \(live_url is null or live_url ~ '\^https:\/\/'\)/);
  assert.match(sql, /_snapshot_app_registry_20261113/); assert.ok(sql.indexOf('_snapshot_app_registry_20261113') < sql.indexOf('add column'), 'snapshot first');
  assert.match(sql, /r\.live_url is distinct from v\.u/);
  assert.doesNotMatch(sql, /drop\s+(function|table)\s/i); assert.doesNotMatch(sql, /workbench_storefront_tiles\s+add column/i);
  assert.doesNotMatch(sql, /\b(jpas_|jds_|jts_)\w*\s*(set|=)/i);
  for (const code of ['BL', 'CH', 'DC', 'FA', 'FP', 'IA', 'IS', 'JW', 'LA', 'LO', 'SR', 'TF', 'WB']) assert.match(sql, new RegExp(`\\('${code}','https://`), code);
  for (const code of ['BS', 'PP']) assert.doesNotMatch(sql, new RegExp(`\\('${code}','https://`), code + ' stays NULL');
  assert.doesNotMatch(sql, /'http:\/\//);
  console.log('PASS  migration: snapshot first, https check, idempotent backfill of 13 apps (BS and PP stay NULL), no DROP, no scoring writes');
}

// ---- 5. Admin cards in Chromium ----
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const CHROME = process.env.WB_CHROME;
const db2 = fakeDb(); globalThis.fetch = db2.fetch;
const o2 = db2.addPerson(OWNER, { id: OWNER_ID }); db2.addAccess(o2, 'workbench', 'owner');
for (const c of ['JW', 'BS', 'WB']) db2.addApp(c, c === 'JW' ? 'Jurisdiction Watch' : c + ' app', c === 'WB' ? 2 : 3, 1, { tracker_url: 'https://example.com/' + c, live_url: c === 'JW' ? 'https://www.jurisdiction-watch.com' : null, linear_label: null });
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const ORIGIN = 'http://wb.test';
await page.route(ORIGIN + '/**', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const res = mkRes();
  const headers = ownerHeaders(OWNER_ID, OWNER); const query = Object.fromEntries(u.searchParams); const seg = u.pathname.split('/');
  if (u.pathname === '/api/workbench-linear') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, count: 0, issues: [] }) });
  if (seg[1] === 'admin' && seg.length <= 4) await shell({ method: 'GET', headers, query: { area: seg[2], id: seg[3] } }, res);
  else if (u.pathname.startsWith('/api/admin/')) await router({ method: req.method(), headers, url: u.pathname + u.search, query, body: req.postData() ? JSON.parse(req.postData()) : undefined }, res);
  else return route.fulfill({ status: 404, body: '' });
  const html = typeof res.body === 'string';
  route.fulfill({ status: res.code, contentType: html ? 'text/html; charset=utf-8' : 'application/json', body: html ? res.body : JSON.stringify(res.body) });
});
const card = (c) => `#apps-grid .card[data-code="${c}"]`;
await page.goto(ORIGIN + '/admin/apps'); await page.waitForSelector('#apps-grid .card');
const link = `${card('JW')} a.livesite`;
assert.equal(await page.getAttribute(link, 'href'), 'https://www.jurisdiction-watch.com');
assert.equal(await page.getAttribute(link, 'target'), '_blank'); assert.equal(await page.getAttribute(link, 'rel'), 'noopener noreferrer');
assert.equal(await page.getAttribute(link, 'aria-label'), 'Open Jurisdiction Watch live site');
const order = await page.$$eval(`${card('JW')} dd a`, (as) => as.map((a) => a.textContent.trim()));
assert.deepEqual(order, ['Live site ↗', 'Tracker'], 'Live site comes before Tracker');
assert.equal(await page.locator(`${card('BS')} a.livesite`).count(), 0, 'no link drawn without a URL');
// Owner edit
await page.click(`${card('BS')} button[data-act="livesite-toggle"]`);
await page.fill(`${card('BS')} form.livesite input[name="live_url"]`, 'http://insecure.example'); await page.click(`${card('BS')} form.livesite button`);
assert.match(await page.textContent(`${card('BS')} [data-msg]`), /https:\/\//); assert.equal(db2.audit.length, 0);
await page.fill(`${card('BS')} form.livesite input[name="live_url"]`, 'https://www.boundstone.org'); await page.click(`${card('BS')} form.livesite button`);
await page.waitForSelector('#reason-panel:not([hidden])'); assert.match(await page.textContent('#reason-diff'), /live_url/);
await page.click('#reason-cancel'); await page.waitForTimeout(100); assert.equal(db2.audit.length, 0, 'Cancel writes nothing');
await page.click(`${card('BS')} form.livesite button`); await page.waitForSelector('#reason-panel:not([hidden])'); await page.fill('#reason-text', 'checked'); await page.click('#reason-save');
await page.waitForSelector(`${card('BS')} a.livesite`);
assert.equal(await page.getAttribute(`${card('BS')} a.livesite`, 'href'), 'https://www.boundstone.org');
assert.equal(db2.audit.length, 1); assert.equal(db2.audit[0].action, 'app.live_url'); assert.equal(db2.audit[0].reason, 'checked');
assert.deepEqual(errs, [], 'no page errors');
await browser.close();
console.log('PASS  Admin card: Live site link before Tracker (new tab, noopener, aria-label); Owner edit validates https, Cancel writes nothing, Save audits');
console.log('ALL PASS  live-site-link');
