// Test helper (FDY-285, revised): session cookies for route tests, and a fake of the two
// services sign-in talks to (Supabase REST and Resend). No network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../api/_auth.js');

export const SHARED_KEY = 's3cret-workbench-key';
export const OWNER = 'owner@example.com';
export const OWNER_ID = '11111111-1111-4111-8111-111111111111';

export function configure() {
  process.env.WORKBENCH_REFRESH_SECRET = SHARED_KEY;
  process.env.WORKBENCH_OWNER_EMAIL = OWNER;
  delete process.env.WORKBENCH_SESSION_SECRET;
}
export const sessionSecret = () => A.sessionSecret();
export const cookieOf = (payload) => `${A.COOKIE}=${A.sign(payload, A.sessionSecret())}`;
/** A signed-in Owner's cookie header. Route tests use this instead of a stub fetch. */
export const signedInHeaders = () => ({ cookie: cookieOf(A.ownerPayload(OWNER_ID, OWNER)) });
export const ownerHeaders = (personId, email, now) => ({ cookie: cookieOf(A.ownerPayload(personId, email, now)) });

export function mkRes() {
  const r = { code: 0, body: null, headers: {}, setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, send(b) { r.body = b; return r; } };
  return r;
}
/** The cookie a response set, as a request header value ('' when cleared or absent). */
export function cookieFrom(res) {
  const sc = String(res.headers['set-cookie'] || '');
  const v = sc.split(';')[0];
  return v && !v.endsWith('=') ? v : '';
}

/** Fake Supabase REST and Resend. `world.access[email] = { role, status, expires_at, person_id }`. */
export function fakeWorld() {
  const w = { access: {}, audit: [], mail: [], failAudit: false, failAccess: false, failMail: false, calls: [] };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : {};
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    w.calls.push(u.pathname);
    if (u.hostname === 'api.resend.com') {
      if (w.failMail) return json({ message: 'down' }, 500);
      w.mail.push(body); return json({ id: 'm1' });
    }
    if (u.pathname === '/rest/v1/rpc/estate_access_for') {
      if (w.failAccess) return json({ message: 'boom' }, 500);
      const a = w.access[String(body.p_email).trim().toLowerCase()];
      if (!a || body.p_product !== 'workbench') return json({ product: body.p_product, usable: false, status: 'none' });
      const usable = a.status === 'active' && (!a.expires_at || Date.parse(a.expires_at) > Date.now());
      return json({ person_id: a.person_id, product: 'workbench', role: a.role, status: a.status, expires_at: a.expires_at || null, usable });
    }
    if (u.pathname === '/rest/v1/admin_audit') {
      if (w.failAudit) return json({ message: 'boom' }, 500);
      w.audit.push(body); return json(null, 201);
    }
    throw new Error('unexpected fetch ' + u);
  };
  return w;
}
