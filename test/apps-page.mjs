// FDY-294 (ADM-2.1): Apps > Cards and Settings in headless Chromium, through the real handlers over
// an in-memory database. Live fields settle independently; promote, set state and settings edits
// go through the reason panel; Cancel writes nothing. No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
const CHROME = process.env.WB_CHROME;
const shell = require('../api/admin/shell.js');
const router = require('../api/admin/[route].js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc'; process.env.VERCEL_API_TOKEN = 'tok';
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
const CODES = ['JW', 'FP', 'TF', 'DC', 'FA', 'BL', 'IA', 'SR', 'BS', 'IS', 'PP', 'LO', 'CH', 'LA', 'WB'];
CODES.forEach((c) => db.addApp(c, c + ' app', c === 'WB' ? 2 : c === 'JW' ? 3 : 1, c === 'WB' ? 34 : c === 'JW' ? 4 : 2, { linear_label: c === 'IA' ? null : c.toLowerCase(), vercel_project: c === 'WB' ? 'faraday-workbench' : null, tracker_url: 'https://example.com/' + c, console_url: c === 'WB' ? '/admin' : null, owner: c === 'JW' ? 'Myke' : null, supabase_project: c === 'JW' ? 'ycadmm' : null }));
db.apps.find((a) => a.code === 'JW').state = 'Launch Ready'; db.apps.find((a) => a.code === 'JW').state_source = 'owner';
db.addDef('WB', 'apps_live_read_timeout_ms', 'integer', 4000, { label: 'Live read timeout (ms)', min_value: 500, max_value: 15000, precedence_group: 'apps_live_reads' });
db.addDef('WB', 'apps_live_reads_enabled', 'boolean', true, { label: 'Live reads enabled', precedence_group: 'apps_live_reads' });
db.addDef('WB', 'audit_page_size', 'integer', 100, { label: 'Audit page size', min_value: 25, max_value: 500, enforcement_status: 'recorded_only', precedence_group: 'audit_screen', needs_redeploy: true });
db.metric.WB = { label: 'Audit rows', value: 120, as_of: '2026-11-10T12:00:00Z' };
db.vercel.deployments = [{ ready: 1800000000000, meta: { githubCommitSha: 'abcdef1234', githubCommitMessage: 'Ship the apps screen\nbody' } }];
db.vercel.mode = 'fail'; // first load: Vercel is down

const linear = { delayMs: { ch: 1500 }, fail: new Set(['tf']), hits: [] };
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
const ORIGIN = 'http://wb.test';
await page.route(ORIGIN + '/**', async (route) => {
  const req = route.request(); const u = new URL(req.url()); const res = mkRes();
  const headers = ownerHeaders(OWNER_ID, OWNER); const query = Object.fromEntries(u.searchParams); const seg = u.pathname.split('/');
  if (u.pathname === '/api/workbench-linear') { // the existing, session-gated route; mocked here
    const label = query.label; linear.hits.push(label);
    if (linear.delayMs[label]) await new Promise((r) => setTimeout(r, linear.delayMs[label]));
    if (linear.fail.has(label)) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Linear: down' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, count: label.length + 3, issues: [] }) });
  }
  if (seg[1] === 'admin' && seg.length <= 4) await shell({ method: 'GET', headers, query: { area: seg[2], id: seg[3] } }, res);
  else if (u.pathname.startsWith('/api/admin/')) await router({ method: req.method(), headers, url: u.pathname + u.search, query, body: req.postData() ? JSON.parse(req.postData()) : undefined }, res);
  else return route.fulfill({ status: 404, body: '' });
  const html = typeof res.body === 'string';
  route.fulfill({ status: res.code, contentType: html ? 'text/html; charset=utf-8' : 'application/json', body: html ? res.body : JSON.stringify(res.body) });
});
const card = (c) => `#apps-grid .card[data-code="${c}"]`;
const live = (c, f) => `${card(c)} [data-live="${f}"]`;
const loaded = (sel) => page.waitForFunction((s) => { const e = document.querySelector(s); return e && !/Loading/.test(e.textContent); }, sel);
const last = () => db.audit[db.audit.length - 1];
const msgOk = (c) => page.waitForFunction((s) => /ok|err/.test(document.querySelector(s).className), `${card(c)} [data-msg]`);
const confirm = async (check, reason) => {
  await page.waitForSelector('#reason-panel:not([hidden])');
  if (check) await check();
  if (reason) await page.fill('#reason-text', reason);
  await page.click('#reason-save');
};

// ---- the cards render from stored fields; live fields settle on their own ----
await page.goto(ORIGIN + '/admin/apps');
await page.waitForSelector('#apps-grid .card');
assert.equal(await page.locator('#apps-grid .card').count(), 15);
assert.equal((await page.textContent('#apps-count')).trim(), '15 apps');
assert.equal((await page.textContent('h1')).trim(), 'Apps'); assert.equal(await page.getAttribute('.tabs a[aria-current="page"]', 'href'), '/admin/apps');
assert.equal(await page.locator('main .soon').count(), 0, 'the Phase 2 placeholder is gone');
assert.equal((await page.textContent(`${card('WB')} [data-f="version"]`)).trim(), '02.34');
assert.match(await page.textContent(card('WB')), /Just Functioning/); assert.match(await page.textContent(card('WB')), /set by rule/);
assert.match(await page.textContent(card('JW')), /Launch Ready/); assert.match(await page.textContent(card('JW')), /set by Owner/);
assert.match(await page.textContent(card('WB')), /Owner not set/); assert.match(await page.textContent(card('JW')), /Myke/); assert.match(await page.textContent(card('JW')), /ycadmm/);
assert.equal(await page.getAttribute(`${card('JW')} a:text-is("Tracker")`, 'href'), 'https://example.com/JW');
assert.equal(await page.getAttribute(`${card('WB')} a:text-is("Console")`, 'href'), '/admin');
console.log('PASS  15 cards: code, name, version XX.YY, state chip with its source, owner (Owner not set), Supabase project, links');

// CH's tickets are slow (1.5 s); its build and metric must not wait for them, and other cards must not either
await loaded(live('CH', 'metric')); await loaded(live('BL', 'tickets'));
assert.match(await page.textContent(live('CH', 'tickets')), /Loading/, 'a slow ticket count holds back nothing else');
assert.match(await page.textContent(live('CH', 'build')), /unavailable|Loading/);
await page.waitForFunction(() => !/Loading/.test(document.getElementById('apps-grid').textContent), null, { timeout: 15000 });
assert.match(await page.textContent(live('CH', 'tickets')), /5 open/);
assert.equal((await page.textContent(live('WB', 'build'))).trim(), 'unavailable', 'Vercel is down: that field says unavailable');
assert.match(await page.textContent(live('WB', 'metric')), /Audit rows: 120 \(as of /, 'the metric beside it still shows');
assert.match(await page.textContent(live('WB', 'tickets')), /5 open/);
assert.equal((await page.textContent(live('TF', 'tickets'))).trim(), 'unavailable', 'a failing Linear read: unavailable for that field');
assert.match(await page.textContent(live('TF', 'metric')), /Not measured/, 'label null is Not measured');
assert.equal((await page.textContent(live('IA', 'tickets'))).trim(), 'unavailable', 'no Linear label: unavailable');
assert.equal((await page.textContent(live('JW', 'build'))).trim(), 'unavailable');
assert.equal(await page.locator('#apps-grid .card').count(), 15, 'every card is still there');
assert.equal(linear.hits.includes('ia'), false); assert.equal(linear.hits.filter((l) => l === 'wb').length, 1);
console.log('PASS  live fields settle independently: a slow or failing Linear/Vercel/metric read shows unavailable or Not measured for that field only');

// ---- Set state: disabled below 03.00, a control at 03.00+ ----
assert.equal(await page.isDisabled(`${card('WB')} select[data-f="state"]`), true);
assert.match(await page.textContent(card('WB')), /Below 03\.00 the state is set by rule/);
assert.equal(await page.isDisabled(`${card('JW')} select[data-f="state"]`), false);
let n = db.audit.length;
await page.selectOption(`${card('JW')} select[data-f="state"]`, 'Needs Tuning');
await page.waitForSelector('#reason-panel:not([hidden])'); assert.match(await page.textContent('#reason-diff'), /state\s*Launch Ready\s*Needs Tuning/);
await page.click('#reason-cancel'); await page.waitForTimeout(100);
assert.equal(db.audit.length, n, 'Cancel writes nothing'); assert.equal(await page.inputValue(`${card('JW')} select[data-f="state"]`), 'Launch Ready', 'and puts the control back');
await page.selectOption(`${card('JW')} select[data-f="state"]`, 'Needs Tuning'); await confirm(null, 'tune it'); await msgOk('JW');
assert.equal(db.audit.length, n + 1); assert.equal(last().action, 'app.set_state'); assert.equal(last().actor, OWNER_ID); assert.equal(last().reason, 'tune it');
assert.match(await page.textContent(`${card('JW')} [data-f="state-chip"]`), /Needs Tuning/); assert.match(await page.textContent(card('JW')), /set by Owner/);
console.log('PASS  Set state is disabled below 03.00 and works at 03.00+ through the reason panel (one audit row; Cancel writes nothing)');

// ---- Promote ----
n = db.audit.length; const rpcs = () => db.calls.filter((c) => /rpc\/app_registry_promote/.test(c.path)).length;
assert.equal(await page.isHidden(`${card('FA')} form.promote`), true);
await page.click(`${card('FA')} button[data-act="promote-toggle"]`); assert.equal(await page.isVisible(`${card('FA')} form.promote`), true);
const f = `${card('FA')} form.promote`;
await page.fill(`${f} input[name="version"]`, '3.'); await page.fill(`${f} input[name="release"]`, 'R1'); await page.click(`${f} button`);
assert.match(await page.textContent(`${card('FA')} [data-msg]`), /version must look like 03\.04/); assert.equal(await page.isHidden('#reason-panel'), true);
await page.fill(`${f} input[name="version"]`, '2.0'); await page.fill(`${f} input[name="release"]`, '   '); await page.click(`${f} button`);
assert.match(await page.textContent(`${card('FA')} [data-msg]`), /name the release/);
assert.equal(rpcs(), 0); assert.equal(db.audit.length, n, 'refused in the browser: the server is never asked');
await page.fill(`${f} input[name="version"]`, '0.5'); await page.fill(`${f} input[name="release"]`, 'Back to alpha'); await page.click(`${f} button`);
await page.waitForSelector('#reason-panel:not([hidden])');
const diff = await page.textContent('#reason-diff'); assert.match(diff, /version\s*01\.02\s*00\.05/); assert.match(diff, /release\s*—?\s*Back to alpha/); assert.match(diff, /state\s*Just Functioning\s*Not Ready/, 'the rule-set state is in the diff');
await page.click('#reason-cancel'); await page.waitForTimeout(100); assert.equal(db.audit.length, n, 'Cancel writes nothing');
await page.click(`${f} button`); await confirm(null, 'reset'); await msgOk('FA');
assert.equal(db.audit.length, n + 1); assert.equal(last().action, 'app.promote'); assert.equal(last().actor, OWNER_ID); assert.equal(last().new_value.release, 'Back to alpha'); assert.equal(last().reason, 'reset');
assert.equal((await page.textContent(`${card('FA')} [data-f="version"]`)).trim(), '00.05'); assert.match(await page.textContent(`${card('FA')} [data-f="state-chip"]`), /Not Ready/);
assert.match(await page.textContent(live('FA', 'tickets')), /open|Loading/, 'the redrawn card reloads its live fields');
// WB crosses 03.00: the state is left alone and Set state turns on
await page.click(`${card('WB')} button[data-act="promote-toggle"]`);
const g = `${card('WB')} form.promote`;
await page.fill(`${g} input[name="version"]`, '03.00'); await page.fill(`${g} input[name="release"]`, 'Apps registry'); await page.click(`${g} button`);
await page.waitForSelector('#reason-panel:not([hidden])'); assert.doesNotMatch(await page.textContent('#reason-diff'), /Just Functioning/, 'at 03.00 the promote leaves the state alone');
await confirm(); await msgOk('WB');
assert.equal((await page.textContent(`${card('WB')} [data-f="version"]`)).trim(), '03.00');
assert.equal(await page.isDisabled(`${card('WB')} select[data-f="state"]`), false, 'Set state turns on at 03.00');
assert.match(await page.textContent(`${card('WB')} [data-f="state-chip"]`), /Just Functioning/);
console.log('PASS  Promote: refused in the browser for a bad version or no release name; the diff shows the rule-set state; one audit row; crossing 03.00 leaves the state and enables Set state');

// ---- Settings (pilot: the Workbench) ----
await page.click('.tabs a:text-is("Settings")'); await page.waitForURL(ORIGIN + '/admin/apps/settings');
await page.waitForSelector('.setrow');
assert.equal(await page.locator('.setrow').count(), 3); assert.match(await page.textContent('#set-note'), /other 14 apps follow/);
const row = (k) => `.setrow[data-key="${k}"]`;
assert.match(await page.textContent(row('apps_live_read_timeout_ms')), /whole number 500 to 15000/); assert.match(await page.textContent(row('apps_live_read_timeout_ms')), /Default: 4000/);
assert.match(await page.textContent(row('apps_live_read_timeout_ms')), /Enforced/); assert.match(await page.textContent(row('apps_live_read_timeout_ms')), /Group: apps_live_reads/); assert.match(await page.textContent(row('apps_live_read_timeout_ms')), /No redeploy needed/);
assert.match(await page.textContent(row('audit_page_size')), /Recorded only/); assert.match(await page.textContent(row('audit_page_size')), /Needs a redeploy/);
assert.equal(await page.inputValue(`${row('apps_live_read_timeout_ms')} [data-f="value"]`), '4000');
n = db.audit.length; const setSay = (k) => `${row(k)} [data-msg]`;
await page.fill(`${row('apps_live_read_timeout_ms')} input`, '100'); await page.click(`${row('apps_live_read_timeout_ms')} button`);
assert.match(await page.textContent(setSay('apps_live_read_timeout_ms')), /at least 500/); assert.equal(await page.isHidden('#reason-panel'), true);
await page.fill(`${row('apps_live_read_timeout_ms')} input`, '4000'); await page.click(`${row('apps_live_read_timeout_ms')} button`);
assert.match(await page.textContent(setSay('apps_live_read_timeout_ms')), /No change/);
await page.fill(`${row('apps_live_read_timeout_ms')} input`, '2500'); await page.click(`${row('apps_live_read_timeout_ms')} button`);
await page.waitForSelector('#reason-panel:not([hidden])'); assert.match(await page.textContent('#reason-diff'), /value\s*4000\s*2500/);
await page.click('#reason-cancel'); await page.waitForTimeout(100);
assert.equal(db.audit.length, n, 'Cancel writes nothing'); assert.equal(await page.inputValue(`${row('apps_live_read_timeout_ms')} input`), '4000', 'and puts the field back');
await page.fill(`${row('apps_live_read_timeout_ms')} input`, '2500'); await page.click(`${row('apps_live_read_timeout_ms')} button`); await confirm(null, 'vercel is slow');
await page.waitForFunction(() => /2500/.test(document.querySelector('.setrow[data-key="apps_live_read_timeout_ms"] [data-f="effective"]').textContent));
assert.equal(db.audit.length, n + 1); assert.equal(last().action, 'app.setting'); assert.equal(last().actor, OWNER_ID); assert.equal(last().reason, 'vercel is slow'); assert.deepEqual(last().new_value, { apps_live_read_timeout_ms: 2500 });
assert.match(await page.textContent(`${row('apps_live_read_timeout_ms')} [data-f="default"]`), /4000/);
await page.selectOption(`${row('apps_live_reads_enabled')} select`, 'false'); await page.click(`${row('apps_live_reads_enabled')} button`); await confirm();
await page.waitForFunction(() => /false/.test(document.querySelector('.setrow[data-key="apps_live_reads_enabled"] [data-f="effective"]').textContent));
assert.equal(db.audit.length, n + 2); assert.equal(db.vals.find((v) => v.key === 'apps_live_reads_enabled').value, false);
console.log('PASS  Settings: type, range, default, effective, enforcement, group and redeploy flag shown; a bad value is refused in the browser; edits go through the reason panel (one audit row; Cancel writes nothing)');

// ---- with live reads switched off, the cards say unavailable and make no outbound read ----
db.vercel.mode = 'ok'; db.vercel.calls.length = 0; const m0 = db.calls.filter((c) => /app_registry_metric/.test(c.path)).length;
await page.goto(ORIGIN + '/admin/apps'); await page.waitForSelector('#apps-grid .card');
await page.waitForFunction(() => !/Loading/.test(document.getElementById('apps-grid').textContent), null, { timeout: 15000 });
assert.equal((await page.textContent(live('WB', 'build'))).trim(), 'unavailable'); assert.equal((await page.textContent(live('WB', 'metric'))).trim(), 'unavailable');
assert.equal(db.vercel.calls.length, 0); assert.equal(db.calls.filter((c) => /app_registry_metric/.test(c.path)).length, m0);
assert.match(await page.textContent(live('WB', 'tickets')), /open/, 'Linear is read by the browser through the existing route, not switched by this setting');
console.log('PASS  apps_live_reads_enabled=false: build and metric read unavailable with no outbound call; the cards still load');

assert.equal(/[$€£]\s?\d|per month|\/month|USD/i.test(await page.content()), false, 'no price string');
assert.deepEqual(errs, []);
await browser.close();
console.log('ALL PASS  apps-page');
