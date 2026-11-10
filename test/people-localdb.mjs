// FDY-288: the Person page's writes against a real Postgres holding the FDY-252 Phase 1 objects
// plus the FDY-288 migration (paused status, persona preset), run as service_role. Proves that
// each console write lands one admin_audit row, written by the database function in the same
// transaction, with the signed-in person's id as actor. LOCAL, THROWAWAY DATABASE ONLY.
//
//   createdb wb_fdy285 && WB_PG_URL='dbname=wb_fdy285' node test/people-localdb.mjs
//
// Without WB_PG_URL the test is skipped (and says so). It refuses anything that looks hosted.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, OWNER, mkRes, ownerHeaders } from './_session.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const URL_ = process.env.WB_PG_URL || '';
if (!URL_) { console.log('SKIP  people-localdb: set WB_PG_URL to an empty local database to run it'); process.exit(0); }
if (/supabase|pooler|amazonaws|\.co\b|\.com\b/i.test(URL_)) { console.error('REFUSED: WB_PG_URL must be a local throwaway database, never a hosted project.'); process.exit(1); }

const psql = (sql, vars = {}) => execFileSync('psql', [URL_, '-qAtX', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
for (const f of ['estate-phase1-subset.sql', 'estate-fdy288.sql']) execFileSync('psql', [URL_, '-qX', '-v', 'ON_ERROR_STOP=1', '-c', 'set client_min_messages = warning', '-f', path.join(HERE, 'fixtures', f)], { stdio: ['ignore', 'ignore', 'inherit'] });
const svc = (sql, vars) => psql('set role service_role;\n' + sql, vars);
const eq = (v) => (v && v.startsWith('eq.') ? decodeURIComponent(v.slice(3)) : '');

// A fake PostgREST in front of the real database: the reads the console makes, and the two
// audited functions called exactly as PostgREST would call them (named arguments from JSON).
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const body = init.body ? JSON.parse(init.body) : {}; const sp = u.searchParams;
  const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
  try {
    if (u.pathname === '/rest/v1/rpc/estate_access_for') return json(JSON.parse(svc("select public.estate_access_for(:'e', :'p');", { e: body.p_email, p: body.p_product })));
    if (u.pathname === '/rest/v1/rpc/estate_access_set') return json(JSON.parse(svc(`select public.estate_access_set(j->>'p_email', j->>'p_product', j->>'p_role', j->>'p_status', (j->>'p_expires_at')::timestamptz, j->>'p_note', j->>'p_actor', j->>'p_reason', (j->>'p_actor_verified')::boolean, j->>'p_via') from (select :'j'::jsonb j) x;`, { j: JSON.stringify(body) })));
    if (u.pathname === '/rest/v1/rpc/estate_person_set_persona') return json(JSON.parse(svc(`select public.estate_person_set_persona(j->>'p_email', j->>'p_persona', j->>'p_actor', j->>'p_reason', (j->>'p_actor_verified')::boolean, j->>'p_via') from (select :'j'::jsonb j) x;`, { j: JSON.stringify(body) })));
    if (u.pathname === '/rest/v1/estate_people') {
      const inList = (sp.get('id') || '').startsWith('in.(') ? sp.get('id').slice(4, -1) : '';
      return json(JSON.parse(svc(`select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select p.id, p.email, p.display_name, p.source, p.created_at, p.persona_preset,
               (select coalesce(jsonb_agg(to_jsonb(a) - 'id' - 'person_id' - 'created_at'), '[]') from public.product_access a where a.person_id = p.id) as product_access,
               '[]'::jsonb as contact_consent
          from public.estate_people p
         where (:'id' = '' or p.id::text = :'id') and (:'em' = '' or p.email_normalised = :'em')
           and (:'ids' = '' or p.id::text = any (string_to_array(:'ids', ',')))) x;`, { id: eq(sp.get('id')), em: eq(sp.get('email_normalised')), ids: inList })));
    }
    if (u.pathname === '/rest/v1/admin_audit') {
      return json(JSON.parse(svc(`select coalesce(jsonb_agg(to_jsonb(a) order by a.at desc), '[]') from public.admin_audit a where a.subject_email = :'em';`, { em: eq(sp.get('subject_email')) })));
    }
  } catch (e) { return json({ message: String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 300) }, 400); }
  throw new Error('unexpected fetch ' + u);
};

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const router = require('../api/admin/[route].js');
svc("select public.estate_access_set(:'e', 'workbench', 'owner', 'active', null, 'test', 'test:people-localdb', 'test', true, 'test');", { e: OWNER });
const ownerId = svc("select id from public.estate_people where email_normalised = :'e';", { e: OWNER });
const H = () => ownerHeaders(ownerId, OWNER);
const call = async (method, route, x) => { const r = mkRes(); await router({ method, headers: H(), query: { route, ...(method === 'GET' ? x : {}) }, body: method === 'POST' ? x : undefined }, r); return r; };
const SUBJECT = `localdb.${Date.now()}@Example.com`, subject = SUBJECT.toLowerCase();
const audits = () => JSON.parse(svc("select coalesce(jsonb_agg(to_jsonb(a) order by a.at), '[]') from public.admin_audit a where a.subject_email = :'e' and a.via = 'workbench:console';", { e: subject }));
const expectAudit = (n, action) => {
  const rows = audits(); assert.equal(rows.length, n, `${action}: ${n} console audit rows so far`);
  const a = rows[n - 1]; assert.equal(a.action, action); assert.equal(a.actor, ownerId, 'actor is the signed-in person id'); assert.equal(a.actor_verified, true);
  return a;
};

// add a person (mixed case in, lowercase stored), then a duplicate
let r = await call('POST', 'people', { email: SUBJECT, product: 'jw', role: 'member' });
assert.equal(r.code, 200, JSON.stringify(r.body));
const id = r.body.personId;
assert.equal(svc("select email from public.estate_people where id = :'i';", { i: id }), subject, 'stored lowercased');
assert.equal(expectAudit(1, 'access.add').reason, null);
r = await call('POST', 'people', { email: SUBJECT.toUpperCase(), product: 'predicts', role: 'member' });
assert.equal(r.code, 409); assert.match(r.body.error, /already in the directory/);
assert.equal(svc("select count(*) from public.estate_people where email_normalised = :'e';", { e: subject }), '1');
console.log('PASS  add: stored lowercased, audited; a duplicate is refused and creates nothing');

// pause -> the real read path says not usable -> resume
r = await call('POST', 'person', { id, action: 'pause', product: 'jw', linearIssue: 'FDY-288' });
assert.equal(r.code, 200, JSON.stringify(r.body));
assert.equal(expectAudit(2, 'access.pause').reason, 'FDY-288');
const paused = JSON.parse(svc("select public.estate_access_for(:'e', 'jw');", { e: subject }));
assert.equal(paused.status, 'paused'); assert.equal(paused.usable, false, 'a paused person cannot use the app');
r = await call('POST', 'person', { id, action: 'pause', product: 'jw' });
assert.equal(r.body.changed, false); assert.equal(audits().length, 2, 'a no-op writes no audit row');
r = await call('POST', 'person', { id, action: 'resume', product: 'jw', reason: 'back' });
assert.equal(expectAudit(3, 'access.resume').reason, 'back');
assert.equal(JSON.parse(svc("select public.estate_access_for(:'e', 'jw');", { e: subject })).usable, true);
console.log('PASS  pause and resume: audited by the database function; paused is not usable on the real read path');

// expire now, revoke, restore, persona
r = await call('POST', 'person', { id, action: 'set_expiry', product: 'jw', expiresAt: 'now' }); expectAudit(4, 'access.update');
assert.equal(JSON.parse(svc("select public.estate_access_for(:'e', 'jw');", { e: subject })).usable, false, 'expired is not usable');
r = await call('POST', 'person', { id, action: 'set_expiry', product: 'jw', expiresAt: '' }); expectAudit(5, 'access.update');
r = await call('POST', 'person', { id, action: 'revoke', product: 'jw' }); expectAudit(6, 'access.revoke');
r = await call('POST', 'person', { id, action: 'restore', product: 'jw' }); expectAudit(7, 'access.restore');
r = await call('POST', 'person', { id, action: 'set_persona', persona: 'mf-09' });
assert.equal(r.code, 200, JSON.stringify(r.body));
const pa = expectAudit(8, 'person.persona'); assert.equal(pa.new_value.persona_preset, 'MF-09');
assert.equal(svc("select persona_preset from public.estate_people where id = :'i';", { i: id }), 'MF-09');
console.log('PASS  expire, revoke, restore and persona: one audit row each, actor = person id');

// the Person page read and the persona filter see the same rows
r = await call('GET', 'person', { id });
assert.equal(r.code, 200); assert.equal(r.body.person.persona, 'MF-09'); assert.equal(r.body.person.access[0].state, 'active');
assert.ok(r.body.audit.length >= 8); assert.equal(r.body.audit[0].actorEmail, OWNER);
r = await call('GET', 'people', { persona: 'MF-09', q: subject });
assert.equal(r.body.count, 1); assert.equal(r.body.people[0].id, id);
console.log('PASS  Person page and directory read the same data back');
console.log('ALL PASS  people-localdb');
