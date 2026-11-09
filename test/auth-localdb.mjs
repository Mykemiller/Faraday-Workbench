// FDY-285 (revised): sign-in against a real Postgres holding the FDY-252 Phase 1 objects (the access
// RPCs, product_access, the append-only admin_audit), run as service_role. Only Supabase REST is
// faked, and Resend is not used any more. LOCAL, THROWAWAY DATABASE ONLY.
//
//   createdb wb_fdy285 && WB_PG_URL='dbname=wb_fdy285' node test/auth-localdb.mjs
//
// Without WB_PG_URL the test is skipped (and says so). It refuses anything that looks hosted.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { configure, SHARED_KEY, OWNER, mkRes, cookieFrom } from './_session.mjs';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const URL_ = process.env.WB_PG_URL || '';
if (!URL_) { console.log('SKIP  auth-localdb: set WB_PG_URL to an empty local database to run it'); process.exit(0); }
if (/supabase|pooler|amazonaws|\.co\b|\.com\b/i.test(URL_)) { console.error('REFUSED: WB_PG_URL must be a local throwaway database, never a hosted project.'); process.exit(1); }

const psql = (sql, vars = {}) => execFileSync('psql', [URL_, '-qAtX', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`])], { input: sql, encoding: 'utf8' }).trim();
execFileSync('psql', [URL_, '-qX', '-v', 'ON_ERROR_STOP=1', '-f', path.join(HERE, 'fixtures', 'estate-phase1-subset.sql')], { stdio: ['ignore', 'ignore', 'inherit'] });
const asService = (sql, vars) => psql('set role service_role;\n' + sql, vars);
const accessSet = (email, role, status) => asService("select public.estate_access_set(:'e', 'workbench', :'r', :'s', null, 'test', 'test:auth-localdb', 'test', true, 'test');", { e: email, r: role, s: status });

// A fake PostgREST in front of the real database.
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const body = init.body ? JSON.parse(init.body) : {};
  const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
  try {
    if (u.pathname === '/rest/v1/rpc/estate_access_for') return json(JSON.parse(asService("select public.estate_access_for(:'e', :'p');", { e: body.p_email, p: body.p_product })));
    if (u.pathname === '/rest/v1/admin_audit') {
      asService(`insert into public.admin_audit (actor, actor_verified, product, subject_email, action, reason, old_value, new_value, via)
        select actor, actor_verified, product, subject_email, action, reason, old_value, new_value, via
          from jsonb_to_record(:'j'::jsonb) as x(actor text, actor_verified boolean, product text, subject_email text, action text, reason text, old_value jsonb, new_value jsonb, via text);`, { j: JSON.stringify(body) });
      return json(null, 201);
    }
  } catch (e) { return json({ message: String(e.message).slice(0, 200) }, 500); }
  throw new Error('unexpected fetch ' + u);
};

configure();
process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const auth = require('../api/auth.js');
const adminRouter = require('../api/admin/[route].js');
const adminSession = (req, res) => adminRouter({ ...req, query: { route: 'session' } }, res);
const call = async (h, req) => { const r = mkRes(); await h(req, r); return r; };
const post = (body, headers = {}) => ({ method: 'POST', headers, body });
const auditCount = () => Number(asService("select count(*) from public.admin_audit where via like 'workbench:%';"));
const base = auditCount();

// 1. The row as FDY-252 Phase 1 seeded it: workbench / admin. Not Owner, so no session (D4).
accessSet(OWNER, 'admin', 'active');
let r = await call(auth, post({ action: 'sign_in', key: SHARED_KEY }));
assert.equal(r.code, 401); assert.equal(cookieFrom(r), ''); assert.equal(auditCount(), base);
console.log('PASS  seeded role "admin" does not sign in, even with the right key');

// 2. Role -> owner. The right key signs in; the audit row names the person id, verified.
accessSet(OWNER, 'owner', 'active');
r = await call(auth, post({ action: 'sign_in', key: 'wrong' }));
assert.equal(r.code, 401);
r = await call(auth, post({ action: 'sign_in', key: SHARED_KEY }));
assert.equal(r.code, 200, JSON.stringify(r.body));
const cookie = cookieFrom(r);
const personId = asService("select id from public.estate_people where email_normalised = :'e';", { e: OWNER });
const row = JSON.parse(asService("select to_jsonb(a) from public.admin_audit a where via = 'workbench:key' order by at desc limit 1;"));
assert.equal(row.actor, personId, 'admin_audit.actor is the estate_people id of the owner');
assert.equal(row.actor_verified, true); assert.equal(row.action, 'workbench.sign_in'); assert.equal(row.subject_email, OWNER); assert.equal(row.product, 'workbench');
r = await call(adminSession, { method: 'GET', headers: { cookie } });
assert.equal(r.code, 200); assert.equal(r.body.personId, personId);
console.log('PASS  after role -> owner: the key signs in; the database audit row names the person id, verified');

// 3. Revoke through the RPC: the live session stops working at once.
accessSet(OWNER, 'owner', 'revoked');
assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 404);
accessSet(OWNER, 'owner', 'active');
assert.equal((await call(adminSession, { method: 'GET', headers: { cookie } })).code, 200);
console.log('PASS  revoke in product_access ends the session on the next request; restore brings it back');

// 4. admin_audit stays append-only for the role the Workbench uses.
assert.throws(() => asService("update public.admin_audit set actor = 'x' where via like 'workbench:%';"));
assert.throws(() => asService("delete from public.admin_audit where via like 'workbench:%';"));
assert.throws(() => psql("set role anon; select count(*) from public.admin_audit;"));
console.log('PASS  admin_audit: service_role cannot update or delete; anon cannot read');
console.log('ALL PASS  auth-localdb');
