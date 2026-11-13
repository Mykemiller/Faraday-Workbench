// FDY-287 (ADM-0.4): the /admin console shell, its Owner-only gate, the read-only People and
// Audit routes, and the audit helper (unit-tested against a mocked client). No network.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, mkRes, fakeWorld, ownerHeaders } from './_session.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = require('../api/_auth.js');
const shell = require('../api/admin/shell.js');
const router = require('../api/admin/[route].js');
const { AREAS, areaFor, renderShell } = require('../api/_admin/shell.js');
const { auditedWrite, resolveReason, linearKey, AuditError, AUDITED_RPCS, VIA } = require('../api/_audit.js');

const OWNER = 'owner@example.com', OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'admin@example.com', ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const call = async (h, req) => { const r = mkRes(); await h(req, r); return r; };
configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';

const PEOPLE = [
  { id: OWNER_ID, email: OWNER, display_name: 'Owner', source: 'predicts-approved', created_at: '2026-11-06T22:00:00Z',
    product_access: [{ product: 'workbench', role: 'owner', status: 'active', expires_at: null }, { product: 'ispyadc', role: 'admin', status: 'revoked', expires_at: null }] },
  { id: ADMIN_ID, email: ADMIN, display_name: null, source: 'dailychallenge', created_at: '2026-11-07T10:00:00Z',
    product_access: [{ product: 'ispyadc', role: 'tester', status: 'active', expires_at: '2020-01-01T00:00:00Z' }] }
];
const AUDIT = [
  { id: 'a1', at: '2026-11-09T19:40:00Z', actor: OWNER_ID, actor_verified: true, product: 'workbench', subject_email: OWNER, action: 'workbench.sign_in', reason: null, old_value: null, new_value: { ip: '203.0.113.9' }, via: 'workbench:email-code' },
  { id: 'a2', at: '2026-11-09T19:30:00Z', actor: 'break-glass:shared-key', actor_verified: false, product: 'workbench', subject_email: '*', action: 'workbench.break_glass', reason: 'email down', old_value: null, new_value: {}, via: 'workbench:break-glass' }
];
const seen = [];
function world() {
  const w = fakeWorld();
  w.access[OWNER] = { role: 'owner', status: 'active', person_id: OWNER_ID };
  w.access[ADMIN] = { role: 'admin', status: 'active', person_id: ADMIN_ID };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.pathname === '/rest/v1/estate_people') { seen.push(u.pathname + u.search); return json(u.searchParams.get('id') ? PEOPLE.map((p) => ({ id: p.id, email: p.email })) : PEOPLE); }
    if (u.pathname === '/rest/v1/admin_audit' && (init.method || 'GET') === 'GET') { seen.push(u.pathname + u.search); return json(AUDIT); }
    return w.fetch(url, init);
  };
  return w;
}

// ---- the gate: an Owner session renders; everyone else gets 404 ----
{
  const w = world();
  const expired = ownerHeaders(OWNER_ID, OWNER, Math.floor(Date.now() / 1000) - A.OWNER_TTL_S - 5);
  const others = { 'no session': {}, 'expired session': expired, 'non-owner (role admin)': ownerHeaders(ADMIN_ID, ADMIN), 'forged cookie': { cookie: 'wb_session=x.y' } };
  for (const [who, headers] of Object.entries(others)) {
    for (const area of [undefined, 'people', 'audit', 'console']) {
      const r = await call(shell, { method: 'GET', headers, query: { area } });
      assert.equal(r.code, 404, `${who} /admin/${area || ''}`); assert.deepEqual(r.body, { error: 'Not found' });
    }
    for (const route of ['people', 'audit', 'nope']) {
      const r = await call(router, { method: 'GET', headers, query: { route } });
      assert.equal(r.code, 404, `${who} /api/admin/${route}`); assert.deepEqual(r.body, { error: 'Not found' });
    }
  }
  assert.equal(seen.length, 0, 'no data was read for anyone refused');
  const h = ownerHeaders(OWNER_ID, OWNER);
  let r = await call(shell, { method: 'GET', headers: h, query: {} });
  assert.equal(r.code, 200); assert.match(r.headers['content-type'], /text\/html/); assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.body, /<h1>Home<\/h1>/); assert.match(r.body, /owner@example\.com/);
  assert.equal((await call(shell, { method: 'GET', headers: h, query: { area: 'nope' } })).code, 404, 'unknown area');
  assert.equal((await call(shell, { method: 'POST', headers: h, query: {} })).code, 404, 'the page is GET only');
  w.access[OWNER].status = 'revoked';
  assert.equal((await call(shell, { method: 'GET', headers: h, query: {} })).code, 404, 'a revoked Owner loses the console at once');
  console.log('PASS  shell renders for an Owner session; 404 for no session, expired, non-owner, forged, revoked');
}

// ---- six areas, each with its own URL; only People, Apps and Audit have content ----
{
  world();
  assert.deepEqual(AREAS.map((a) => a.label), ['Home', 'People', 'Apps', 'Plans and billing', 'Audit', 'Console']);
  assert.deepEqual(AREAS.map((a) => a.path), ['/admin', '/admin/people', '/admin/apps', '/admin/plans', '/admin/audit', '/admin/console']);
  assert.equal(new Set(AREAS.map((a) => a.path)).size, 6);
  const h = ownerHeaders(OWNER_ID, OWNER);
  for (const a of AREAS) {
    const seg = a.path.split('/')[2];
    assert.equal(areaFor(seg).id, a.id);
    const r = await call(shell, { method: 'GET', headers: h, query: { area: seg } });
    assert.equal(r.code, 200, a.path);
    assert.ok(r.body.includes(`<a href="${a.path}" aria-current="page">`), `${a.path} marks itself current`);
    for (const b of AREAS) assert.ok(r.body.includes(`href="${b.path}"`), `${a.path} links to ${b.path}`);
    if (a.content) assert.equal(/Coming in Phase/.test(r.body), false, `${a.label} has content`);
    else assert.match(r.body, new RegExp(`Coming in Phase ${a.phase}`), `${a.label} is a placeholder`);
  }
  assert.deepEqual(AREAS.filter((a) => a.content).map((a) => a.id), ['people', 'apps', 'audit']);
  const rw = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'vercel.json'), 'utf8')).rewrites;
  assert.deepEqual(rw, [{ source: '/admin/people/review', destination: '/api/admin/shell?area=people' }, { source: '/admin', destination: '/api/admin/shell' }, { source: '/admin/:area', destination: '/api/admin/shell?area=:area' }, { source: '/admin/:area/:id', destination: '/api/admin/shell?area=:area&id=:id' }]);
  assert.equal(fs.existsSync(path.join(HERE, '..', 'admin')), false, 'no static /admin files: the page only exists behind the gate');
  console.log('PASS  six areas with their own URLs; People, Apps and Audit have content, the rest say "Coming in Phase N"');
}

// ---- no price strings, no secrets, escaped output ----
{
  for (const a of AREAS) {
    const html = renderShell(a, { email: OWNER });
    assert.equal(/[$€£]\s?\d|\d+\.\d{2}\s*\/\s*mo|per month|\/month|USD/i.test(html), false, `${a.label}: no price string`);
    assert.equal(/service_role|SERVICE_ROLE|svc\b/.test(html), false);
  }
  const x = renderShell(areaFor('people'), { email: '"><script>alert(1)</script>@x.io' });
  assert.equal(x.includes('<script>alert(1)'), false, 'the signed-in email is escaped');
  console.log('PASS  shell has no price strings, no key material, and escapes what it prints');
}

// ---- People and Audit data routes (read-only) ----
{
  world(); seen.length = 0;
  const h = ownerHeaders(OWNER_ID, OWNER);
  let r = await call(router, { method: 'GET', headers: h, query: { route: 'people' } });
  assert.equal(r.code, 200); assert.equal(r.body.count, 2);
  assert.deepEqual(r.body.people[0].access.map((a) => a.state).sort(), ['active', 'revoked']);
  assert.equal(r.body.people[1].access[0].state, 'expired');
  assert.equal((await call(router, { method: 'DELETE', headers: h, query: { route: 'people' } })).code, 405);
  r = await call(router, { method: 'GET', headers: h, query: { route: 'audit', q: 'Owner@(x)*', product: 'workbench' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.rows[0].actor, OWNER_ID); assert.equal(r.body.rows[0].actorEmail, OWNER); assert.equal(r.body.rows[0].actorVerified, true);
  assert.equal(r.body.rows[1].actorEmail, null); assert.equal(r.body.rows[1].actorVerified, false);
  const q = seen.find((s) => s.startsWith('/rest/v1/admin_audit'));
  assert.match(q, /product=eq\.workbench/); assert.match(q, /subject_email=ilike\.\*owner%40x\*$/, 'wildcards and brackets typed by the user are stripped'); assert.match(q, /limit=101/, 'a page of 100 plus one, to know whether older rows exist');
  assert.equal((await call(router, { method: 'GET', headers: h, query: { route: 'audit', product: 'x;drop' } })).code, 400);
  assert.equal((await call(router, { method: 'DELETE', headers: h, query: { route: 'audit' } })).code, 405, 'Audit is read-only');
  r = await call(router, { method: 'GET', url: '/api/admin/people?x=1', headers: h });
  assert.equal(r.code, 200, 'the route name is also read from the URL');
  console.log('PASS  People and Audit routes: Owner-only, filters validated, actor id shown with its email (People writes: test/people.mjs)');
}

// ---- audit helper: unit tests with a mocked client ----
{
  const owner = { kind: 'owner', personId: OWNER_ID, email: OWNER };
  const calls = [];
  const client = async (p, key, init) => { calls.push({ path: p, key, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ changed: true }) }; };
  const deps = { key: 'svc', client };

  assert.equal(resolveReason('  because  ', 'FDY-287'), 'because', 'typed text wins');
  assert.equal(resolveReason('', 'fdy-287'), 'FDY-287', 'blank reason defaults to the Linear issue');
  assert.equal(resolveReason(undefined, undefined), null, 'a reason is never required');
  assert.equal(resolveReason('   ', 'not an issue'), null);
  assert.equal(resolveReason('x'.repeat(600), null).length, 500);
  assert.equal(linearKey('FDY-12'), 'FDY-12'); assert.equal(linearKey('https://linear.app/x'), null);

  let out = await auditedWrite(owner, { rpc: 'estate_access_set', args: { p_email: 'x@y.io', p_product: 'ispyadc', p_role: 'tester', p_status: 'active', p_expires_at: null, p_note: null } }, deps);
  assert.deepEqual(out, { changed: true });
  assert.equal(calls[0].path, '/rest/v1/rpc/estate_access_set'); assert.equal(calls[0].key, 'svc');
  assert.equal(calls[0].body.p_actor, OWNER_ID, 'actor is the signed-in person id');
  assert.equal(calls[0].body.p_actor_verified, true); assert.equal(calls[0].body.p_via, VIA); assert.equal(VIA, 'workbench:console');
  assert.equal(calls[0].body.p_reason, null, 'no reason given: the write still goes through');
  assert.equal(calls[0].body.p_email, 'x@y.io');

  await auditedWrite(owner, { rpc: 'estate_audience_gate_set', args: { p_product: 'predicts', p_lifted: true }, linearIssue: 'FDY-289' }, deps);
  assert.equal(calls[1].body.p_reason, 'FDY-289', 'a change that names a Linear issue gets it as the reason');
  await auditedWrite(owner, { rpc: 'estate_audience_gate_set', args: { p_product: 'predicts', p_lifted: true }, linearIssue: 'FDY-289', reason: 'incident re-arm' }, deps);
  assert.equal(calls[2].body.p_reason, 'incident re-arm');

  await auditedWrite(owner, { rpc: 'predicts_review_recipient', args: { p_email: 'x@y.io', p_decision: 'approved' } }, deps);
  assert.deepEqual(Object.keys(calls[3].body).sort(), ['p_actor', 'p_decision', 'p_email', 'p_reason'], 'only the parameters that function takes');
  assert.equal(calls[3].body.p_actor, OWNER_ID);

  const n = calls.length;
  const refuse = async (actor, change, d, status, re) => { await assert.rejects(auditedWrite(actor, change, d), (e) => e instanceof AuditError && e.status === status && re.test(e.message)); };
  await refuse(owner, { rpc: 'workbench_findings_sync', args: {} }, deps, 400, /not an audited function/);
  await refuse(owner, { rpc: '__proto__', args: {} }, deps, 400, /not an audited function/);
  await refuse(owner, { rpc: 'estate_access_set', args: { p_actor: 'someone@else.io' } }, deps, 400, /p_actor is set by the helper/);
  await refuse(owner, { rpc: 'estate_access_set', args: { p_actor_verified: true } }, deps, 400, /set by the helper/);
  await refuse(owner, { rpc: 'estate_access_set', args: { p_reason: 'x' } }, deps, 400, /set by the helper/);
  await refuse({ kind: 'admin', personId: null }, { rpc: 'estate_access_set', args: {} }, deps, 403, /Owner is required/);
  await refuse(null, { rpc: 'estate_access_set', args: {} }, deps, 403, /Owner is required/);
  await refuse({ kind: 'owner', personId: 'typed@email.io' }, { rpc: 'estate_access_set', args: {} }, deps, 403, /Owner is required/);
  await refuse(owner, { rpc: 'estate_access_set', args: {} }, { client }, 503, /service key/);
  assert.equal(calls.length, n, 'a refused write calls nothing');

  const failing = { key: 'svc', client: async () => ({ ok: false, status: 400, json: async () => ({ message: 'estate_access_set: status must be active or revoked (got x)' }) }) };
  await refuse(owner, { rpc: 'estate_access_set', args: {} }, failing, 400, /status must be active or revoked/);
  await refuse(owner, { rpc: 'estate_access_set', args: {} }, { key: 'svc', client: async () => { throw new Error('ECONNRESET'); } }, 502, /nothing was saved/);
  assert.deepEqual(Object.keys(AUDITED_RPCS).sort(), ['app_registry_promote', 'app_registry_set_live_url', 'app_registry_set_state', 'app_setting_set', 'estate_access_set', 'estate_audience_gate_set', 'estate_consent_review', 'estate_operator_set', 'estate_person_set_persona', 'predicts_review_recipient']);
  assert.ok(Object.isFrozen(AUDITED_RPCS));
  console.log('PASS  audit helper: actor = person id, reason optional, Linear issue default, only audited functions, refusals write nothing');
}
console.log('ALL PASS  admin-shell');
