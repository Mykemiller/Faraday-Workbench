// Admin tab · ISpyaDC access (FDY-42): pure validation, key gating, the handler
// against a recording fetch stub, and the page with the API intercepted. No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const api = require('../api/workbench-ispyadc-access.js');
const { normalizeEmail, isValidEmail, defaultExpiry, expiryToTimestamp, grantState, parseWrite, ispyConfig, TESTER_DEFAULT_DAYS } = api;

// ---- pure logic ----
assert.equal(normalizeEmail('  Tester@Example.COM '), 'tester@example.com');
assert.equal(isValidEmail('a@b.io'), true);
assert.equal(isValidEmail('not an email'), false);
assert.equal(isValidEmail('a@b'), false);
assert.equal(TESTER_DEFAULT_DAYS, 14);
assert.equal(defaultExpiry('tester', '2026-11-06'), '2026-11-20');
assert.equal(defaultExpiry('tester', '2026-12-25'), '2027-01-08'); // crosses a year boundary
assert.equal(defaultExpiry('admin', '2026-11-06'), null);
assert.equal(defaultExpiry('user', '2026-11-06'), null);
assert.equal(expiryToTimestamp('2026-11-20'), '2026-11-20T23:59:59Z');
assert.equal(expiryToTimestamp(''), null);
assert.equal(expiryToTimestamp(null), null);
assert.equal(expiryToTimestamp('soon'), undefined);
assert.equal(expiryToTimestamp('2026-13-40'), undefined);
const now = new Date('2026-11-06T19:00:00Z');
assert.equal(grantState({ status: 'active', expires_at: null }, now), 'active');
assert.equal(grantState({ status: 'active', expires_at: '2026-11-07T23:59:59Z' }, now), 'active');
assert.equal(grantState({ status: 'active', expires_at: '2026-11-01T23:59:59Z' }, now), 'expired');
assert.equal(grantState({ status: 'revoked', expires_at: null }, now), 'revoked');
console.log('PASS  pure logic (normalise, validate, default tester expiry, state)');

// ---- parseWrite: validation, lowercasing, default expiry ----
const TODAY = '2026-11-06';
const actor = 'ops@example.com';
assert.match(parseWrite({ action: 'nuke', actor }, TODAY).error, /action/);
assert.match(parseWrite({ action: 'add', email: 'x@y.io', role: 'tester' }, TODAY).error, /acting as/i);
assert.match(parseWrite({ action: 'add', actor, email: 'nope', role: 'tester' }, TODAY).error, /email/i);
assert.match(parseWrite({ action: 'add', actor, email: 'x@y.io', role: 'owner' }, TODAY).error, /role/);
assert.match(parseWrite({ action: 'add', actor, email: 'x@y.io', role: 'tester', expiresAt: 'soon' }, TODAY).error, /expiresAt/);
let p = parseWrite({ action: 'add', actor: ' OPS@Example.com ', email: '  Tester@Example.COM ', role: 'tester' }, TODAY);
assert.equal(p.ok, true);
assert.equal(p.email, 'tester@example.com', 'email is lowercased before saving');
assert.equal(p.actor, 'ops@example.com');
assert.equal(p.expiresAt, '2026-11-20T23:59:59Z', 'omitted expiry on a tester = 14 days');
p = parseWrite({ action: 'add', actor, email: 'x@y.io', role: 'tester', expiresAt: '' }, TODAY);
assert.equal(p.expiresAt, null, 'an explicit empty expiry means none, even for a tester');
p = parseWrite({ action: 'add', actor, email: 'x@y.io', role: 'admin' }, TODAY);
assert.equal(p.expiresAt, null, 'an admin gets no default expiry');
assert.match(parseWrite({ action: 'revoke', actor, id: 'nope' }, TODAY).error, /uuid/);
const id = '11111111-1111-1111-1111-111111111111';
assert.equal(parseWrite({ action: 'revoke', actor, id }, TODAY).ok, true);
assert.equal(parseWrite({ action: 'set_expiry', actor, id, expiresAt: '' }, TODAY).expiresAt, null);
assert.equal(parseWrite({ action: 'set_role', actor, id, role: 'admin' }, TODAY).role, 'admin');
console.log('PASS  parseWrite (actor required, lowercase, 14-day tester default, explicit empty = none)');

// ---- config: names only, never values ----
assert.deepEqual(ispyConfig({}), { configured: false, missing: ['ISPYADC_SUPABASE_URL', 'ISPYADC_SERVICE_ROLE_KEY'] });
assert.deepEqual(ispyConfig({ ISPYADC_SUPABASE_URL: 'https://x.supabase.co/' }), { configured: false, missing: ['ISPYADC_SERVICE_ROLE_KEY'] });
const cfg = ispyConfig({ ISPYADC_SUPABASE_URL: 'https://x.supabase.co/', ISPYADC_SERVICE_ROLE_KEY: 'sk' });
assert.equal(cfg.configured, true); assert.equal(cfg.url, 'https://x.supabase.co');
console.log('PASS  config detection (names only)');

// ---- gating ----
const mkRes = () => { const r = { code: 0, body: null, setHeader() {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
delete process.env.WORKBENCH_REFRESH_SECRET;
let r = mkRes(); await api({ method: 'GET', headers: {} }, r); assert.equal(r.code, 503);
process.env.WORKBENCH_REFRESH_SECRET = 's3cret';
r = mkRes(); await api({ method: 'GET', headers: { 'x-workbench-key': 'wrong' } }, r); assert.equal(r.code, 401);
r = mkRes(); await api({ method: 'DELETE', headers: {} }, r); assert.equal(r.code, 405);
const H = { 'x-workbench-key': 's3cret' };
delete process.env.ISPYADC_SUPABASE_URL; delete process.env.ISPYADC_SERVICE_ROLE_KEY;
r = mkRes(); await api({ method: 'GET', headers: H }, r);
assert.equal(r.code, 200); assert.equal(r.body.configured, false);
assert.deepEqual(r.body.missing, ['ISPYADC_SUPABASE_URL', 'ISPYADC_SERVICE_ROLE_KEY']);
assert.ok(!JSON.stringify(r.body).includes('s3cret'));
console.log('PASS  gating (503 unset, 401 wrong key, 405 method, 200 not-configured with names only)');

// ---- handler against a recording fetch stub (the ISpyaDC project is never reached) ----
process.env.ISPYADC_SUPABASE_URL = 'https://ispy.example.supabase.co';
process.env.ISPYADC_SERVICE_ROLE_KEY = 'service-key-value';
const calls = [];
const existing = { id, email: 'tester@example.com', role: 'tester', status: 'active', expires_at: '2026-11-20T23:59:59Z', note: null, added_by: 'ops@example.com', created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' };
let table = [existing];
globalThis.fetch = async (url, init) => {
  const u = new URL(url); const method = (init && init.method) || 'GET';
  calls.push({ method, path: u.pathname + u.search, body: init && init.body ? JSON.parse(init.body) : null, headers: init && init.headers });
  assert.equal(u.origin, 'https://ispy.example.supabase.co', 'talks to the ISpyaDC project, not the estate project');
  assert.equal(init.headers.apikey, 'service-key-value');
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (u.pathname.endsWith('/ispyadc_access_audit')) return method === 'POST' ? json(201, null) : json(200, []);
  if (u.pathname.endsWith('/ispyadc_access')) {
    const email = u.searchParams.get('email'); const byId = u.searchParams.get('id');
    if (method === 'GET' && email) return json(200, table.filter((g) => 'eq.' + g.email === email));
    if (method === 'GET' && byId) return json(200, table.filter((g) => 'eq.' + g.id === byId));
    if (method === 'GET') return json(200, table);
    if (method === 'POST') { const row = { id: '22222222-2222-2222-2222-222222222222', created_at: 'x', updated_at: 'x', ...JSON.parse(init.body) }; table = [...table, row]; return json(201, [row]); }
    if (method === 'PATCH') { const row = { ...table.find((g) => 'eq.' + g.id === byId), ...JSON.parse(init.body) }; table = table.map((g) => (g.id === row.id ? row : g)); return json(200, [row]); }
  }
  return json(404, { message: 'no route ' + u.pathname });
};
const body = (b) => ({ method: 'POST', headers: H, body: b });

// duplicate rejection
r = mkRes(); await api(body({ action: 'add', actor, email: 'Tester@Example.com', role: 'admin' }), r);
assert.equal(r.code, 409); assert.match(r.body.error, /already has a grant/);
assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'a duplicate writes nothing');
console.log('PASS  duplicate add is refused with a friendly 409 and writes nothing');

// add: insert + audit row with the actor, 14-day default expiry
calls.length = 0;
r = mkRes(); await api(body({ action: 'add', actor: 'Ops@Example.com', email: 'New@Example.com', role: 'tester', note: 'trial' }), r);
assert.equal(r.code, 200, JSON.stringify(r.body));
const ins = calls.find((c) => c.method === 'POST' && c.path.endsWith('/ispyadc_access'));
assert.equal(ins.body.email, 'new@example.com'); assert.equal(ins.body.role, 'tester'); assert.equal(ins.body.status, 'active');
assert.equal(ins.body.added_by, 'ops@example.com');
const todayUtc = new Date().toISOString().slice(0, 10);
assert.equal(ins.body.expires_at, defaultExpiry('tester', todayUtc) + 'T23:59:59Z', 'tester default expiry = today + 14');
const au = calls.find((c) => c.method === 'POST' && c.path.endsWith('/ispyadc_access_audit'));
assert.ok(au, 'an audit row is written'); assert.equal(au.body.action, 'add'); assert.equal(au.body.actor, 'ops@example.com');
assert.equal(au.body.email, 'new@example.com'); assert.equal(au.body.old_value, null); assert.equal(au.body.new_value.role, 'tester');
console.log('PASS  add writes the grant and an audit row with the operator as actor');

// revoke: PATCH + audit with before/after
calls.length = 0;
r = mkRes(); await api(body({ action: 'revoke', actor, id }), r);
assert.equal(r.code, 200, JSON.stringify(r.body));
const patch = calls.find((c) => c.method === 'PATCH'); assert.deepEqual(patch.body, { status: 'revoked' });
const au2 = calls.find((c) => c.method === 'POST' && c.path.endsWith('/ispyadc_access_audit'));
assert.equal(au2.body.action, 'revoke'); assert.equal(au2.body.old_value.status, 'active'); assert.equal(au2.body.new_value.status, 'revoked');
// restore + set_expiry + set_role each audit as well
for (const [req, action, expectPatch] of [
  [{ action: 'restore', actor, id }, 'restore', { status: 'active' }],
  [{ action: 'set_expiry', actor, id, expiresAt: '' }, 'update', { expires_at: null }],
  [{ action: 'set_role', actor, id, role: 'admin' }, 'update', { role: 'admin' }],
]) {
  calls.length = 0; r = mkRes(); await api(body(req), r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.find((c) => c.method === 'PATCH').body, expectPatch);
  assert.equal(calls.find((c) => c.method === 'POST' && c.path.endsWith('/ispyadc_access_audit')).body.action, action);
}
r = mkRes(); await api(body({ action: 'revoke', actor, id: '99999999-9999-9999-9999-999999999999' }), r); assert.equal(r.code, 404);
// GET lists with derived state
r = mkRes(); await api({ method: 'GET', headers: H }, r);
assert.equal(r.code, 200); assert.equal(r.body.configured, true); assert.ok(r.body.grants.every((g) => ['active', 'expired', 'revoked'].includes(g.state)));
console.log('PASS  revoke / restore / set_expiry / set_role each patch and audit; 404 on unknown id; GET derives state');

// ---- page ----
const { chromium } = await import(process.env.WB_PLAYWRIGHT || 'playwright');
import path from 'node:path'; import { fileURLToPath } from 'node:url'; import fs from 'node:fs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.WB_PAGE || 'file://' + path.join(HERE, '..', 'index.html');
const CHROME = process.env.WB_CHROME;
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const other = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'workbench-payloads.json'), 'utf8'));
const scoring = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'scoring-panels.payload.json'), 'utf8'));
async function openAdmin(ispyGet) {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  const serve = (n, b) => page.route(`**/rpc/${n}`, (x) => x.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }));
  await serve('workbench_scoring_panels', scoring); await serve('workbench_health', other.health);
  await serve('workbench_idf', other.idf); await serve('workbench_forecast_model', other.forecast); await serve('workbench_storefront', other.storefront);
  await page.route('**/api/workbench-subscribers**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ subscribers: [], plans: [] }) }));
  const posted = [];
  await page.route('**/api/workbench-ispyadc-access**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') { posted.push(JSON.parse(req.postData())); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'Done.' }) }); }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ispyGet()) });
  });
  await page.addInitScript(() => localStorage.setItem('wb.refresh.key', 'k1'));
  await page.goto(PAGE);
  await page.click('#tab-admin');
  await page.waitForSelector('#ispy-access');
  return { page, errs, posted };
}

// not configured
{
  const { page, errs } = await openAdmin(() => ({ configured: false, missing: ['ISPYADC_SUPABASE_URL', 'ISPYADC_SERVICE_ROLE_KEY'], grants: [], audit: [] }));
  await page.waitForSelector('#isp-config:not([hidden])');
  const txt = await page.textContent('#isp-config');
  assert.match(txt, /not configured/); assert.match(txt, /ISPYADC_SUPABASE_URL/); assert.match(txt, /ISPYADC_SERVICE_ROLE_KEY/);
  assert.equal(await page.isHidden('#isp-body'), true);
  assert.deepEqual(errs, []);
  await page.close();
  console.log('PASS  page: not-configured state names the variables and crashes nothing');
}

// configured: list, search, add default expiry, confirm-step revoke
{
  const grants = [
    { ...existing, state: 'active' },
    { id: '33333333-3333-3333-3333-333333333333', email: 'old@example.com', role: 'admin', status: 'revoked', expires_at: null, note: null, added_by: 'owner-seed', created_at: 'x', updated_at: '2026-11-01T00:00:00Z', state: 'revoked' },
  ];
  const { page, errs, posted } = await openAdmin(() => ({ configured: true, grants, audit: [{ id: 'a', email: 'old@example.com', action: 'revoke', actor: 'ops@example.com', at: '2026-11-01T00:00:00Z' }] }));
  await page.waitForSelector('#isp-body:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#isp-list .isp-row[data-id]').length === 2);
  assert.equal(await page.textContent('#isp-count'), '2 grants');
  assert.match(await page.textContent('#isp-audit'), /revoke · old@example.com — by ops@example.com/);
  await page.fill('#isp-q', 'old@'); await page.waitForFunction(() => document.querySelectorAll('#isp-list .isp-row[data-id]').length === 1);
  await page.fill('#isp-q', '');
  // default tester expiry = today + 14 (UTC), editable
  const expDefault = await page.inputValue('#isp-exp');
  const plus14 = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 14); return d.toISOString().slice(0, 10); })();
  assert.equal(expDefault, plus14, 'tester default expiry shown');
  await page.selectOption('#isp-role', 'admin'); assert.equal(await page.inputValue('#isp-exp'), '', 'admin clears the default');
  await page.selectOption('#isp-role', 'tester'); assert.equal(await page.inputValue('#isp-exp'), plus14);
  // add without an actor is refused client-side
  await page.fill('#isp-email', 'New@Example.com'); await page.click('#isp-add');
  await page.waitForFunction(() => /acting as/i.test(document.getElementById('isp-msg').textContent));
  assert.equal(posted.length, 0);
  // duplicate is refused client-side too
  await page.fill('#isp-actor', 'ops@example.com'); await page.fill('#isp-email', 'TESTER@example.com'); await page.click('#isp-add');
  await page.waitForFunction(() => /already has a grant/.test(document.getElementById('isp-msg').textContent));
  assert.equal(posted.length, 0);
  // a real add posts the lowercased email, the role and the default expiry
  await page.fill('#isp-email', 'New@Example.com'); await page.click('#isp-add');
  await page.waitForFunction(() => document.getElementById('isp-msg').textContent === 'Done.');
  assert.deepEqual(posted[0], { action: 'add', email: 'new@example.com', role: 'tester', expiresAt: plus14, actor: 'ops@example.com' });
  // revoke needs a confirm step
  await page.click(`button[data-isp="revoke"][data-id="${id}"]`);
  await page.waitForSelector(`button[data-isp="revoke-confirm"][data-id="${id}"]`);
  assert.equal(posted.length, 1, 'first click confirms nothing');
  await page.click(`button[data-isp="revoke-cancel"][data-id="${id}"]`);
  await page.waitForSelector(`button[data-isp="revoke"][data-id="${id}"]`);
  await page.click(`button[data-isp="revoke"][data-id="${id}"]`);
  await page.click(`button[data-isp="revoke-confirm"][data-id="${id}"]`);
  await page.waitForTimeout(200);
  assert.deepEqual(posted[1], { action: 'revoke', id, actor: 'ops@example.com' });
  // restore is one click
  await page.click('button[data-isp="restore"][data-id="33333333-3333-3333-3333-333333333333"]');
  await page.waitForTimeout(200);
  assert.deepEqual(posted[2], { action: 'restore', id: '33333333-3333-3333-3333-333333333333', actor: 'ops@example.com' });
  assert.deepEqual(errs, []);
  await page.close();
  console.log('PASS  page: list, search, 14-day default, actor required, duplicate refused, add payload, revoke confirm step, restore');
}
await browser.close();
console.log('ALL PASS  ispyadc-access');
