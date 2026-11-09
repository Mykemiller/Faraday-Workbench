// Test helper (FDY-285): session cookies for route tests, and a fake of the three
// services sign-in talks to (Supabase REST, Supabase Auth, Resend). No network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../api/_auth.js');

export const SESSION_SECRET = 'test-session-secret-0123456789abcdef-xyz';
export const SHARED_KEY = 's3cret-break-glass-key';

export function configure() {
  process.env.WORKBENCH_SESSION_SECRET = SESSION_SECRET;
  process.env.WORKBENCH_REFRESH_SECRET = SHARED_KEY;
}
export const cookieOf = (payload) => `${A.COOKIE}=${A.sign(payload, SESSION_SECRET)}`;
/** A break-glass session cookie: needs no database read, so route tests can keep their own fetch stubs. */
export const breakGlassHeaders = () => ({ cookie: cookieOf(A.breakGlassPayload()) });
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

/** Fake Supabase + Resend. `world.access[email] = { role, status, expires_at, person_id }`. */
export function fakeWorld() {
  const w = { access: {}, audit: [], otp: [], codes: {}, mail: [], failAudit: false, failAccess: false, failMail: false, calls: [] };
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
    if (u.pathname === '/auth/v1/otp') { w.otp.push(body); w.codes[body.email] = '123456'; return json({}); }
    if (u.pathname === '/auth/v1/verify') {
      if (w.codes[body.email] && w.codes[body.email] === body.token) { delete w.codes[body.email]; return json({ access_token: 'at', user: { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: body.email } }); }
      return json({ error_code: 'otp_expired' }, 403);
    }
    throw new Error('unexpected fetch ' + u);
  };
  return w;
}
