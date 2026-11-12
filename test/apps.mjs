// FDY-294 (ADM-2.1): the app registry. Pure logic (api/_admin/apps-logic.js) and the Owner-only
// route (api/_admin/apps.js) against the mocked database (test/_fakedb.mjs). No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const router = require('../api/admin/[route].js');
const shell = require('../api/admin/shell.js');
const L = require('../api/_admin/apps-logic.js');
const { AUDITED_RPCS } = require('../api/_audit.js');
const { renderShell, areaFor } = require('../api/_admin/shell.js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
delete process.env.VERCEL_API_TOKEN; delete process.env.VERCEL_TEAM_ID;
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const get = (query = {}) => call({ method: 'GET', headers: H(), query: { route: 'apps', ...query } });
const post = (body) => call({ method: 'POST', headers: H(), query: { route: 'apps' }, body });

// ---- pure logic ----
{
  for (const [v, text] of [['3.4', '03.04'], ['03.04', '03.04'], ['0.0', '00.00'], ['12.5', '12.05'], ['99.99', '99.99'], [' 2.34 ', '02.34']]) {
    const p = L.parseVersion(v); assert.ok(p, v); assert.equal(p.text, text);
  }
  assert.deepEqual(L.parseVersion('3.4'), { major: 3, minor: 4, text: '03.04' });
  for (const bad of ['3.', '.4', 'a.b', '3.4.5', '03.100', '100.1', '-1.2', '3.-4', '3,4', '', '3', ' ', '3. 4', '0x3.4', null, undefined, 3.4, {}]) {
    assert.equal(L.parseVersion(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal(L.formatVersion(2, 34), '02.34'); assert.equal(L.formatVersion(-1, 2), null); assert.equal(L.formatVersion(1.5, 2), null);
  console.log('PASS  version format: both parts are whole numbers (1-2 digits); 3. .4 a.b 3.4.5 03.100 negatives are refused');
}
{
  assert.equal(L.ruleState(0), 'Not Ready'); assert.equal(L.ruleState(1), 'Just Functioning'); assert.equal(L.ruleState(2), 'Just Functioning');
  assert.equal(L.ruleState(3), null, '03.00 and above: the promote leaves the state alone'); assert.equal(L.ruleState(12), null);
  assert.equal(L.canOwnerSetState('02.99'), false); assert.equal(L.canOwnerSetState('03.00'), true); assert.equal(L.canOwnerSetState({ major: 2 }), false); assert.equal(L.canOwnerSetState({ version_major: 5 }), true);
  assert.equal(L.canOwnerSetState('junk'), false);
  assert.deepEqual(L.STATES, ['Launch Ready', 'Needs Tuning', 'Just Functioning', 'Not Ready', 'Not Started']);
  assert.equal(L.checkPromote({ state: 'Needs Tuning' }, { version: '3.1', release: '  ' }).error.includes('release'), true);
  assert.equal(L.checkPromote({ state: 'Needs Tuning' }, { version: '3.1', release: 'x'.repeat(121) }).ok, undefined);
  assert.equal(L.checkPromote({ state: 'Needs Tuning' }, { version: '3.1', release: 'x'.repeat(120) }).ok, true);
  assert.equal(L.checkPromote({ state: 'Needs Tuning' }, { version: '0.9', release: 'r' }).expectedState, 'Not Ready');
  assert.equal(L.checkPromote({ state: 'Needs Tuning' }, { version: '4.0', release: 'r' }).expectedState, 'Needs Tuning');
  assert.match(L.checkSetState({ version_major: 2 }, 'Launch Ready').error, /Below 03\.00/);
  assert.equal(L.checkSetState({ version_major: 3 }, 'Launch Ready').ok, true);
  assert.match(L.checkSetState({ version_major: 3 }, 'Great').error, /State must be one of/);
  console.log('PASS  state rule: below 01.00 Not Ready, 01.00-02.99 Just Functioning, 03.00+ unchanged; the Owner sets state only from 03.00');
}
{
  const def = (o) => ({ key: 'k', label: 'K', ...o });
  assert.equal(L.validateSetting(def({ type: 'boolean' }), true).ok, true); assert.equal(L.validateSetting(def({ type: 'boolean' }), 'true').ok, false);
  const i = def({ type: 'integer', min_value: 500, max_value: 15000 });
  assert.equal(L.validateSetting(i, 500).ok, true); assert.equal(L.validateSetting(i, 15000).ok, true);
  for (const bad of [499, 15001, 4000.5, '4000', null, NaN]) assert.equal(L.validateSetting(i, bad).ok, false, String(bad));
  const e = def({ type: 'enum', options: ['a', 'b'] });
  assert.equal(L.validateSetting(e, 'a').ok, true); assert.equal(L.validateSetting(e, 'c').ok, false);
  assert.equal(L.validateSetting(def({ type: 'text' }), 'x').ok, true); assert.equal(L.validateSetting(def({ type: 'text' }), 3).ok, false);
  assert.equal(L.validateSetting(def({ type: 'weird' }), 1).ok, false);
  assert.equal(L.effectiveSetting({ default_value: 4000 }, null), 4000); assert.equal(L.effectiveSetting({ default_value: 4000 }, { value: 900 }), 900);
  assert.equal(L.effectiveSetting({ default_value: true }, { value: false }), false, 'a stored false wins over a true default');
  console.log('PASS  setting validation (type, min/max, options) and effective value (stored row wins, else the default)');
}
{
  const a = L.shapeApp({ code: 'WB', name: 'Workbench', version_major: 2, version_minor: 34, state: 'Just Functioning', state_source: 'rule', lifecycle_stage: 'live', tile_slug: 'wb', owner: null, supabase_project: 'p', settings_schema_version: 1, vercel_project: 'secret-project' });
  assert.equal(a.version, '02.34'); assert.equal(a.stateSourceLabel, 'set by rule'); assert.equal(a.canSetState, false); assert.equal(a.owner, null);
  assert.equal('vercelProject' in a || 'vercel_project' in a, false, 'the Vercel project name is not shown');
  assert.equal(L.shapeApp({ code: 'JW', name: 'J', version_major: 3, version_minor: 0, state: 'Launch Ready', state_source: 'owner' }).stateSourceLabel, 'set by Owner');
  assert.deepEqual(L.shapeBuild(null), { status: 'unavailable', reason: 'failed' }); assert.deepEqual(L.shapeBuild({ deployments: [] }), { status: 'unavailable', reason: 'failed' });
  assert.deepEqual(L.shapeBuild({ deployments: [{ ready: 1800000000000, meta: { githubCommitSha: 'abcdef1234567', githubCommitMessage: 'First line\n\nbody' } }] }), { status: 'ok', at: new Date(1800000000000).toISOString(), commit: 'abcdef1', message: 'First line' });
  assert.equal(L.shapeBuild({ deployments: [{ ready: 'x' }] }).status, 'unavailable');
  assert.deepEqual(L.shapeMetric({ label: null, value: null, as_of: null }), { status: 'not_measured' });
  assert.deepEqual(L.shapeMetric({ label: 'Rows', value: 12, as_of: 'x' }), { status: 'ok', label: 'Rows', value: '12', asOf: 'x' });
  assert.equal(L.shapeMetric(undefined).status, 'unavailable');
  await assert.rejects(L.withTimeout(new Promise(() => {}), 30), /timeout/); assert.equal(await L.withTimeout(Promise.resolve(7), 30), 7);
  // the browser code carries the same version pattern as the server
  const client = fs.readFileSync(path.join(HERE, '..', 'api', '_admin', 'client.js'), 'utf8');
  assert.ok(client.includes('var VERSION_RE = /' + L.VERSION_RE.source + '/;'), 'client.js and apps-logic.js use the same version pattern');
  console.log('PASS  card shaping, live-result shaping (any problem is unavailable), withTimeout, client/server version pattern parity');
}

// ---- fixture: 15 apps ----
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
const admin = db.addPerson('admin@example.com', { id: '22222222-2222-4222-8222-222222222222' }); db.addAccess(admin, 'workbench', 'admin');
const CODES = ['JW', 'FP', 'TF', 'DC', 'FA', 'BL', 'IA', 'SR', 'BS', 'IS', 'PP', 'LO', 'CH', 'LA', 'WB'];
CODES.forEach((c, n) => db.addApp(c, c + ' app', c === 'WB' ? 2 : n % 5, c === 'WB' ? 34 : n, { vercel_project: c === 'WB' ? 'faraday-workbench' : null, linear_label: c.toLowerCase(), tracker_url: 'https://example.com/' + c }));
db.apps.find((a) => a.code === 'JW').version_major = 3; db.apps.find((a) => a.code === 'JW').state = 'Launch Ready'; db.apps.find((a) => a.code === 'JW').state_source = 'owner';
db.addDef('WB', 'apps_live_read_timeout_ms', 'integer', 4000, { label: 'Live read timeout (ms)', min_value: 500, max_value: 15000, precedence_group: 'apps_live_reads' });
db.addDef('WB', 'apps_live_reads_enabled', 'boolean', true, { label: 'Live reads enabled', precedence_group: 'apps_live_reads' });
db.addDef('WB', 'audit_page_size', 'integer', 100, { label: 'Audit page size', min_value: 25, max_value: 500, enforcement_status: 'recorded_only', precedence_group: 'audit_screen' });
db.addDef('WB', 'tone', 'enum', 'plain', { options: ['plain', 'terse'] });
const last = () => db.audit[db.audit.length - 1];
const rpcCalls = (name) => db.calls.filter((c) => c.path === '/rest/v1/rpc/' + name);

// ---- the list: stored fields only ----
{
  const r = await get();
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.apps.length, 15, 'one card per app');
  assert.deepEqual(r.body.apps.map((a) => a.code), CODES.slice().sort());
  const wb = r.body.apps.find((a) => a.code === 'WB');
  assert.equal(wb.version, '02.34'); assert.equal(wb.state, 'Just Functioning'); assert.equal(wb.stateSourceLabel, 'set by rule'); assert.equal(wb.canSetState, false);
  assert.equal(r.body.apps.find((a) => a.code === 'JW').stateSourceLabel, 'set by Owner');
  assert.deepEqual(r.body.states, L.STATES);
  const s = r.body.settings.WB.find((x) => x.key === 'apps_live_read_timeout_ms');
  assert.deepEqual([s.min, s.max, s.default, s.effective, s.enforcement, s.group, s.needsRedeploy], [500, 15000, 4000, 4000, 'enforced', 'apps_live_reads', false]);
  assert.equal(r.body.settings.WB.find((x) => x.key === 'audit_page_size').enforcement, 'recorded_only');
  assert.equal(JSON.stringify(r.body).includes('faraday-workbench'), false, 'vercel project names stay on the server');
  assert.equal(db.vercel.calls.length, 0, 'the list never touches Vercel'); assert.equal(rpcCalls('app_registry_metric').length, 0, 'or a metric');
  assert.equal(db.calls.some((c) => /linear/i.test(c.path)), false);
  for (const t of ['app_registry', 'app_setting_def', 'app_setting_value']) db.failRead = t, assert.equal((await get()).code, 502, `a failed ${t} read fails the whole call, never a partial list`);
  db.failRead = null;
  console.log('PASS  list: 15 cards from stored fields only (no Vercel, metric or Linear call); a failed read fails closed');
}

// ---- promote ----
{
  const n = db.audit.length;
  const wb = () => db.apps.find((a) => a.code === 'WB');
  let r = await post({ action: 'promote', code: 'WB', version: '2.35' });
  assert.equal(r.code, 400); assert.match(r.body.error, /name the release/); assert.equal(db.audit.length, n);
  for (const bad of ['3.', '.4', 'a.b', '3.4.5', '03.100', '-1.0']) { r = await post({ action: 'promote', code: 'WB', version: bad, release: 'R' }); assert.equal(r.code, 400, bad); assert.match(r.body.error, /version must look like/); }
  assert.equal((await post({ action: 'promote', code: 'WB', version: '2.35', release: 'x'.repeat(121) })).code, 400);
  assert.equal((await post({ action: 'promote', code: 'ZZ', version: '2.35', release: 'R' })).code, 400, 'unknown app');
  assert.equal((await post({ action: 'promote', code: 'wb', version: '2.35', release: 'R' })).code, 400, 'codes are two capitals');
  assert.equal(db.audit.length, n, 'refusals write nothing');
  r = await post({ action: 'promote', code: 'WB', version: '2.35', release: 'Apps screen', reason: 'shipping' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true); assert.equal(r.body.result.version, '02.35');
  assert.equal(wb().version_minor, 35); assert.equal(wb().state, 'Just Functioning'); assert.equal(wb().state_source, 'rule');
  assert.equal(db.audit.length, n + 1, 'one audit row');
  assert.equal(last().actor, OWNER_ID); assert.equal(last().actor_verified, true); assert.equal(last().via, 'workbench:console'); assert.equal(last().reason, 'shipping'); assert.equal(last().new_value.release, 'Apps screen');
  r = await post({ action: 'promote', code: 'WB', version: '02.35', release: 'Again' });
  assert.equal(r.code, 200); assert.equal(r.body.changed, false); assert.equal(db.audit.length, n + 1, 'an unchanged promote writes no audit row');
  // below 01.00 -> Not Ready; 01.00-02.99 -> Just Functioning (rule); 03.00+ leaves the state (and its source) alone
  await post({ action: 'promote', code: 'WB', version: '0.9', release: 'Back to alpha' }); assert.equal(wb().state, 'Not Ready'); assert.equal(wb().state_source, 'rule');
  await post({ action: 'promote', code: 'WB', version: '1.0', release: 'First light' }); assert.equal(wb().state, 'Just Functioning');
  await post({ action: 'promote', code: 'WB', version: '3.0', release: 'Three' });
  assert.equal(wb().state, 'Just Functioning', '03.00 leaves the state unchanged'); assert.equal(wb().state_source, 'rule', 'and its source');
  assert.equal((await get()).body.apps.find((a) => a.code === 'WB').canSetState, true);
  const jw = db.apps.find((a) => a.code === 'JW');
  await post({ action: 'promote', code: 'JW', version: '3.9', release: 'Nine' }); assert.equal(jw.state, 'Launch Ready'); assert.equal(jw.state_source, 'owner');
  await post({ action: 'promote', code: 'WB', version: '2.0', release: 'Rollback' }); assert.equal(wb().state, 'Just Functioning');
  console.log('PASS  promote needs a release name and a valid version; state by rule below 03.00, untouched at 03.00+; one audit row, actor = Owner; unchanged = no row');
}

// ---- set state ----
{
  const n = db.audit.length;
  const wb = () => db.apps.find((a) => a.code === 'WB');
  assert.equal(wb().version_major, 2);
  let r = await post({ action: 'set_state', code: 'WB', state: 'Launch Ready' });
  assert.equal(r.code, 400); assert.match(r.body.error, /below 03\.00 the state is set by rule/i); assert.equal(wb().state, 'Just Functioning'); assert.equal(db.audit.length, n);
  assert.equal(rpcCalls('app_registry_set_state').length, 0, 'refused before the database is asked');
  r = await post({ action: 'set_state', code: 'JW', state: 'Great' }); assert.equal(r.code, 400); assert.match(r.body.error, /State must be one of/);
  r = await post({ action: 'set_state', code: 'JW', state: 'Needs Tuning', reason: 'tune' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.result.state_source, 'owner');
  const jw = db.apps.find((a) => a.code === 'JW'); assert.equal(jw.state, 'Needs Tuning'); assert.equal(jw.state_source, 'owner');
  assert.equal(db.audit.length, n + 1); assert.equal(last().action, 'app.set_state'); assert.equal(last().actor, OWNER_ID);
  r = await post({ action: 'set_state', code: 'JW', state: 'Needs Tuning' }); assert.equal(r.body.changed, false); assert.equal(db.audit.length, n + 1);
  // the database is the authority too: if the registry disagrees about the version, its refusal is plain and carries no SQL
  db.apps.find((a) => a.code === 'FP').version_major = 3; const fp = db.apps.find((a) => a.code === 'FP');
  const orig = db.fetch; db.fetch = async (u, i) => (String(u).includes('rpc/app_registry_set_state') ? { ok: false, status: 400, json: async () => ({ message: 'ERROR: relation "app_registry" syntax error at 42' }) } : orig(u, i));
  globalThis.fetch = db.fetch; r = await post({ action: 'set_state', code: 'FP', state: 'Not Started' });
  assert.equal(r.code, 400); assert.equal(/relation|syntax|ERROR/.test(JSON.stringify(r.body)), false, 'no SQL text leaks'); fp.version_major = 1;
  db.fetch = orig; globalThis.fetch = orig;
  console.log('PASS  set state: refused below 03.00 (before the database is asked), allowed at 03.00+, source becomes Owner, one audit row; DB refusals never leak SQL');
}

// ---- settings ----
{
  const n = db.audit.length;
  const row = (extra) => ({ action: 'set_setting', code: 'WB', ...extra });
  for (const [k, v, re] of [['apps_live_read_timeout_ms', 499, /at least 500/], ['apps_live_read_timeout_ms', 15001, /at most 15000/], ['apps_live_read_timeout_ms', 4000.5, /whole number/], ['apps_live_read_timeout_ms', '4000', /whole number/],
    ['apps_live_reads_enabled', 'yes', /true or false/], ['tone', 'loud', /one of/], ['nope', 1, /no setting named/], ['Bad Key', 1, /not a setting name/]]) {
    const r = await post(row({ key: k, value: v })); assert.equal(r.code, 400, k + ' ' + v); assert.match(r.body.error, re);
  }
  assert.equal((await post({ action: 'set_setting', code: 'JW', key: 'tone', value: 'plain' })).code, 400, 'defs are per app');
  assert.equal(db.audit.length, n); assert.equal(rpcCalls('app_setting_set').length, 0);
  let r = await post(row({ key: 'apps_live_read_timeout_ms', value: 2500, reason: 'slow vercel' }));
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true);
  assert.equal(db.audit.length, n + 1); assert.equal(last().actor, OWNER_ID); assert.equal(last().reason, 'slow vercel'); assert.equal(last().action, 'app.setting');
  const s = (await get()).body.settings.WB.find((x) => x.key === 'apps_live_read_timeout_ms');
  assert.equal(s.effective, 2500); assert.equal(s.default, 4000);
  r = await post(row({ key: 'apps_live_read_timeout_ms', value: 2500 })); assert.equal(r.body.changed, false); assert.equal(db.audit.length, n + 1, 'unchanged = no audit row');
  r = await post(row({ key: 'apps_live_read_timeout_ms', value: 4000 })); assert.equal(r.body.changed, true);
  assert.equal((await post(row({ key: 'apps_live_reads_enabled', value: true }))).body.changed, false, 'the default value is not a change');
  assert.equal((await post({ action: 'nope', code: 'WB' })).code, 400); assert.equal((await post('not json')).code, 400);
  console.log('PASS  settings: bad values refused with plain messages; a change writes one audit row; unchanged writes none; effective value follows');
}

// ---- live reads ----
{
  db.vercel.deployments = [{ ready: 1800000000000, meta: { githubCommitSha: '1234567890', githubCommitMessage: 'Ship it\nmore' } }];
  const live = (code, part) => get({ live: code, part });
  // not configured
  let r = await live('WB', 'build'); assert.equal(r.code, 200); assert.deepEqual([r.body.status, r.body.reason], ['unavailable', 'not configured']); assert.equal(db.vercel.calls.length, 0, 'no token: no call');
  process.env.VERCEL_API_TOKEN = 'tok-secret';
  r = await live('JW', 'build'); assert.equal(r.body.reason, 'not configured', 'no vercel_project');
  r = await live('WB', 'build'); assert.equal(r.code, 200); assert.equal(r.body.status, 'ok'); assert.equal(r.body.commit, '1234567'); assert.equal(r.body.message, 'Ship it'); assert.equal(r.body.at, new Date(1800000000000).toISOString());
  const u = new URL(db.vercel.calls[0].url); assert.equal(u.origin + u.pathname, 'https://api.vercel.com/v6/deployments');
  assert.deepEqual([u.searchParams.get('projectId'), u.searchParams.get('target'), u.searchParams.get('state'), u.searchParams.get('limit'), u.searchParams.get('teamId')], ['faraday-workbench', 'production', 'READY', '1', null]);
  assert.equal(db.vercel.calls[0].auth, 'Bearer tok-secret'); assert.equal(JSON.stringify(r.body).includes('tok-secret'), false);
  process.env.VERCEL_TEAM_ID = 'team_1'; await live('WB', 'build'); assert.equal(new URL(db.vercel.calls.pop().url).searchParams.get('teamId'), 'team_1'); delete process.env.VERCEL_TEAM_ID;
  // Vercel failing: only that field is unavailable; the other live part still works
  db.vercel.mode = 'fail'; db.metric.WB = { label: 'Audit rows', value: 120, as_of: '2026-11-10T12:00:00Z' };
  r = await live('WB', 'build'); assert.equal(r.code, 200); assert.deepEqual([r.body.status, r.body.reason], ['unavailable', 'failed']);
  r = await live('WB', 'metric'); assert.equal(r.code, 200); assert.deepEqual([r.body.status, r.body.label, r.body.value, r.body.asOf], ['ok', 'Audit rows', '120', '2026-11-10T12:00:00Z']);
  assert.equal((await get()).code, 200, 'and the cards still load'); db.vercel.mode = 'ok';
  // metric label null = not measured
  r = await live('JW', 'metric'); assert.equal(r.code, 200); assert.equal(r.body.status, 'not_measured');
  // the metric RPC failing
  db.failRpc = 'app_registry_metric'; r = await live('WB', 'metric'); assert.equal(r.code, 200); assert.equal(r.body.status, 'unavailable'); db.failRpc = null;
  // bad input
  assert.equal((await live('WB', 'nope')).code, 400); assert.equal((await live('wb', 'build')).code, 400); assert.equal((await live('ZZ', 'build')).code, 404);
  // a failed registry read is not a 5xx
  db.failRead = 'app_registry'; r = await live('WB', 'build'); assert.equal(r.code, 200); assert.equal(r.body.status, 'unavailable'); db.failRead = null;
  // settings read fails: defaults (4000 ms, enabled), live reads still run
  db.failRead = 'app_setting_def'; db.vercel.calls.length = 0; r = await live('WB', 'build'); assert.equal(r.body.status, 'ok'); assert.equal(db.vercel.calls.length, 1); db.failRead = null;
  console.log('PASS  live reads: build/metric each independent; Vercel or the metric failing is HTTP 200 unavailable for that field only; label null = not measured; settings failure falls back to defaults');
}
{
  // apps_live_reads_enabled = false: both unavailable, nothing outbound
  await post({ action: 'set_setting', code: 'WB', key: 'apps_live_reads_enabled', value: false });
  db.vercel.calls.length = 0; const before = rpcCalls('app_registry_metric').length;
  for (const part of ['build', 'metric']) { const r = await get({ live: 'WB', part }); assert.equal(r.code, 200); assert.equal(r.body.status, 'unavailable'); assert.equal(r.body.reason, 'disabled'); }
  assert.equal(db.vercel.calls.length, 0); assert.equal(rpcCalls('app_registry_metric').length, before, 'switched off: no outbound read at all');
  await post({ action: 'set_setting', code: 'WB', key: 'apps_live_reads_enabled', value: true });
  // the timeout is honoured: effective 500 ms against a service that never answers
  await post({ action: 'set_setting', code: 'WB', key: 'apps_live_read_timeout_ms', value: 500 });
  db.vercel.mode = 'hang'; db.hangRpc = 'app_registry_metric';
  for (const part of ['build', 'metric']) {
    const t0 = Date.now(); const r = await get({ live: 'WB', part }); const dt = Date.now() - t0;
    assert.equal(r.code, 200); assert.equal(r.body.status, 'unavailable'); assert.ok(dt >= 450 && dt < 3000, `${part} gave up after ~500 ms (took ${dt})`);
  }
  db.vercel.mode = 'ok'; db.hangRpc = null;
  await post({ action: 'set_setting', code: 'WB', key: 'apps_live_read_timeout_ms', value: 4000 });
  console.log('PASS  apps_live_reads_enabled=false: both parts unavailable, nothing outbound; apps_live_read_timeout_ms is honoured (500 ms against a hung service)');
}

// ---- gates ----
{
  const n = db.audit.length, calls = db.calls.length;
  const nonOwner = ownerHeaders(admin.id, 'admin@example.com');
  const cases = { 'no session': {}, 'forged cookie': { cookie: 'wb_session=x.y' }, 'non-owner (role admin)': nonOwner };
  for (const [who, headers] of Object.entries(cases)) {
    for (const [method, query, body] of [['GET', {}], ['GET', { live: 'WB', part: 'build' }], ['POST', {}, { action: 'promote', code: 'WB', version: '9.9', release: 'x' }], ['POST', {}, { action: 'set_state', code: 'JW', state: 'Not Ready' }], ['POST', {}, { action: 'set_setting', code: 'WB', key: 'audit_page_size', value: 50 }]]) {
      const r = await call({ method, headers, query: { route: 'apps', ...query }, body });
      assert.equal(r.code, 404, `${who} ${method} ${JSON.stringify(query)}`); assert.deepEqual(r.body, { error: 'Not found' }, 'the same bare 404 as the other routes');
    }
    const p = mkRes(); await shell({ method: 'GET', headers, query: { area: 'apps' } }, p); assert.equal(p.code, 404);
    const q = mkRes(); await shell({ method: 'GET', headers, query: { area: 'apps', id: 'settings' } }, q); assert.equal(q.code, 404);
    const q2 = mkRes(); await shell({ method: 'GET', headers, query: { area: 'apps', tab: 'settings' } }, q2); assert.equal(q2.code, 404, 'the tab is a query on /admin/apps, gated the same');
  }
  assert.equal(db.audit.length, n, 'nothing written for anyone refused'); assert.equal(db.calls.slice(calls).some((c) => /app_|apps/.test(c.path)), false, 'no registry data read for anyone refused');
  assert.equal((await call({ method: 'DELETE', headers: H(), query: { route: 'apps' } })).code, 405);
  // one page, both panels, Settings reached by ?tab=settings; /admin/apps/<anything> is not a page
  for (const query of [{ area: 'apps' }, { area: 'apps', tab: 'settings' }]) {
    const pr = mkRes(); await shell({ method: 'GET', headers: H(), query }, pr);
    assert.equal(pr.code, 200); assert.match(pr.body, /id="apps-grid"/); assert.match(pr.body, /id="set-groups"/); assert.equal(/Coming in Phase/.test(pr.body), false);
    assert.match(pr.body, /href="\/admin\/apps\?tab=settings"/); assert.match(pr.body, /href="\/admin\/apps" data-tab="cards"/);
  }
  for (const id of ['settings', 'other', 'access', '11111111-1111-4111-8111-111111111111']) {
    const pr = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'apps', id } }, pr); assert.equal(pr.code, 404, 'owner: /admin/apps/' + id); assert.deepEqual(pr.body, { error: 'Not found' });
  }
  const pr = mkRes(); await shell({ method: 'GET', headers: H(), query: { area: 'audit', id: 'settings' } }, pr); assert.equal(pr.code, 404);
  console.log('PASS  /api/admin/apps and /admin/apps[?tab=settings] are Owner-only: no session, forged cookie and non-owner all get the bare 404; nothing read or written');
}

// ---- wiring and hygiene ----
{
  for (const rpc of ['app_registry_promote', 'app_registry_set_state', 'app_setting_set']) assert.deepEqual(AUDITED_RPCS[rpc], { verified: true, via: true }, rpc);
  assert.equal(require('../api/admin/[route].js').ROUTES.apps.gate, 'owner');
  assert.equal(areaFor('apps').content, true);
  const html = renderShell(areaFor('apps'), { email: OWNER }) + renderShell(areaFor('apps'), { email: OWNER }, 'settings');
  assert.equal(/service_role|SERVICE_ROLE|svc\b/.test(html), false, 'no key material in the shell or its browser code');
  assert.equal(/[$€£]\s?\d|\d+\.\d{2}\s*\/\s*mo|per month|\/month|USD/i.test(html), false, 'no price string');
  const src = ['apps.js', 'apps-logic.js'].map((f) => fs.readFileSync(path.join(HERE, '..', 'api', '_admin', f), 'utf8')).join('\n');
  assert.equal(/VERCEL_API_TOKEN/.test(fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8')), false);
  assert.deepEqual(src.match(/rpc\/[a-z_]+/g), ['rpc/app_registry_metric'], 'the only direct RPC is the read-only metric; every write goes through auditedWrite');
  assert.equal(/method: '(PATCH|PUT|DELETE)'/.test(src), false);
  console.log('PASS  the three RPCs are audited, apps is an Owner route, no key material or price strings in the console markup');
}
console.log('ALL PASS  apps');
