/* Workbench sign-in and session (FDY-285, ADM-0.2).
 *
 * Decisions: D2 (email-code sign-in first; the shared key becomes owner-only break-glass, removed
 * later), D4 (Owner is the only console role through Phase 1).
 *
 * Entry rule: an active, unexpired public.product_access row with product = 'workbench' and
 * role = 'owner', read through the service-role RPC estate_access_for(email, product) on the
 * Faraday Supabase project (FDY-252 Phase 1). The rule is re-checked on EVERY request, so a
 * revoke takes effect at once, not when the cookie expires.
 *
 * Session: one httpOnly, Secure, SameSite=Strict cookie, signed with WORKBENCH_SESSION_SECRET
 * (HMAC-SHA256), valid 8 hours. It carries no secret: person id, email, kind and timestamps.
 *
 *   kind 'owner'  a person who entered an email code. The audit actor is their estate_people id.
 *   kind 'bg'     break-glass: someone presented the shared key (WORKBENCH_REFRESH_SECRET).
 *                 Valid 1 hour; every exchange writes admin_audit and emails the owner.
 *
 * Step-up: price changes and console-role grants call requireFresh(), which needs an owner
 * session whose last email code is under 10 minutes old. Break-glass never satisfies it.
 *
 * Everything fails closed: no secret, no service key, an unreadable access row or a failed audit
 * write all refuse. Service-role keys stay on the server; nothing here is sent to the browser.
 */
'use strict';

const crypto = require('crypto');
const { SUPABASE_URL, secretMatches, faradayServiceKey } = require('./_wb.js');

const COOKIE = 'wb_session';
const OWNER_TTL_S = 8 * 60 * 60;
const BREAK_GLASS_TTL_S = 60 * 60;
const FRESH_S = 10 * 60;
const PRODUCT = 'workbench';
const OWNER_ROLE = 'owner';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const nowS = () => Math.floor(Date.now() / 1000);
const normalizeEmail = (raw) => String(raw || '').trim().toLowerCase();
const isEmail = (e) => EMAIL.test(e) && e.length <= 254;

function sessionSecret() {
  const s = process.env.WORKBENCH_SESSION_SECRET || '';
  return s.length >= 32 ? s : '';
}
function breakGlassSecret() {
  return process.env.WORKBENCH_REFRESH_SECRET || '';
}
/** Short fingerprint of the shared key, so rotating the key ends every break-glass session. */
function keyFingerprint(secret) {
  return crypto.createHash('sha256').update('wb-bg:' + secret).digest('hex').slice(0, 16);
}

/* ---- cookie ------------------------------------------------------------- */

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

/** The payload when the token is authentic and unexpired, else null. */
function unsign(token, secret, now) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!secretMatches(mac, want)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p !== 'object') return null;
  if (p.k !== 'owner' && p.k !== 'bg') return null;
  if (!Number.isFinite(p.exp) || !Number.isFinite(p.iat)) return null;
  const t = now === undefined ? nowS() : now;
  if (p.exp <= t || p.iat > t + 60) return null;
  return p;
}

function readCookie(req) {
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function setSessionCookie(res, payload) {
  res.setHeader('Set-Cookie', cookieHeader(sign(payload, sessionSecret()), Math.max(0, payload.exp - nowS())));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', cookieHeader('', 0));
}

function ownerPayload(personId, email, now) {
  const t = now === undefined ? nowS() : now;
  return { k: 'owner', pid: personId, em: email, iat: t, exp: t + OWNER_TTL_S, fr: t };
}
function breakGlassPayload(now) {
  const t = now === undefined ? nowS() : now;
  return { k: 'bg', kf: keyFingerprint(breakGlassSecret()), iat: t, exp: t + BREAK_GLASS_TTL_S };
}

/* ---- Supabase (service role, server only) -------------------------------- */

function sbFetch(path, key, init) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init && init.headers) }
  });
}

/** { personId, email } when the email holds usable workbench/owner access, else null. Throws on a read failure. */
async function ownerAccess(email, key) {
  const r = await sbFetch('/rest/v1/rpc/estate_access_for', key, {
    method: 'POST', body: JSON.stringify({ p_email: email, p_product: PRODUCT })
  });
  if (!r.ok) throw new Error('estate_access_for HTTP ' + r.status);
  const a = await r.json();
  if (!a || a.usable !== true || a.product !== PRODUCT || a.role !== OWNER_ROLE) return null;
  if (!UUID.test(String(a.person_id || ''))) return null;
  return { personId: a.person_id, email };
}

/** Append one admin_audit row. Throws when the row is not written. */
async function writeAudit(key, row) {
  const r = await sbFetch('/rest/v1/admin_audit', key, {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ product: PRODUCT, reason: null, old_value: null, new_value: null, ...row })
  });
  if (!r.ok) throw new Error('admin_audit HTTP ' + r.status);
}

/* ---- who is asking ------------------------------------------------------- */

/** A state-changing request must come from this site. SameSite=Strict already blocks cross-site
 *  cookies; this refuses a mismatched Origin as well. A request with no Origin header passes. */
function sameOrigin(req) {
  const m = String(req.method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().toLowerCase();
  try { return new URL(origin).host.toLowerCase() === host; } catch (e) { return false; }
}

/** Resolve the caller. { actor } on success, { deny: [status, message] } otherwise. Never throws. */
async function resolveActor(req) {
  const secret = sessionSecret();
  if (!secret) return { deny: [503, 'WORKBENCH_SESSION_SECRET is not set on this deployment (32 characters or more).'] };
  if (!sameOrigin(req)) return { deny: [401, 'Unauthorized'] };
  const s = unsign(readCookie(req), secret);
  if (!s) return { deny: [401, 'Unauthorized'] };

  if (s.k === 'bg') {
    const bg = breakGlassSecret();
    if (!bg || !secretMatches(s.kf, keyFingerprint(bg))) return { deny: [401, 'Unauthorized'] };
    return { actor: { kind: 'break-glass', actor: 'break-glass:shared-key', verified: false, personId: null, email: null, expiresAt: s.exp, freshAt: null } };
  }

  const key = faradayServiceKey();
  if (!key) return { deny: [503, 'FARADAY_SERVICE_ROLE_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is not set on this deployment.'] };
  let acc;
  try { acc = await ownerAccess(String(s.em || ''), key); } catch (e) { return { deny: [401, 'Unauthorized'] }; }
  if (!acc || acc.personId !== s.pid) return { deny: [401, 'Unauthorized'] };
  return { actor: { kind: 'owner', actor: acc.personId, verified: true, personId: acc.personId, email: acc.email, expiresAt: s.exp, freshAt: s.fr } };
}

/** Gate for the operator routes (/api/workbench-*). Returns the actor, or sends 401/503 and returns null. */
async function requireOperator(req, res) {
  const r = await resolveActor(req);
  if (r.actor) return r.actor;
  res.status(r.deny[0]).json({ error: r.deny[1] });
  return null;
}

/** Gate for every /api/admin/* route. Anything short of a valid session is a 404, with no detail. */
async function requireAdmin(req, res) {
  const r = await resolveActor(req);
  if (r.actor) return r.actor;
  res.status(404).json({ error: 'Not found' });
  return null;
}

/** Gate for the console (/admin and its data routes): a signed-in Owner only (D4). A break-glass
 *  session is not a person, so it gets the same bare 404 as no session at all. */
async function requireOwner(req, res) {
  const r = await resolveActor(req);
  if (r.actor && r.actor.kind === 'owner') return r.actor;
  res.status(404).json({ error: 'Not found' });
  return null;
}

function isFresh(actor, now) {
  if (!actor || actor.kind !== 'owner' || !Number.isFinite(actor.freshAt)) return false;
  const t = now === undefined ? nowS() : now;
  return t - actor.freshAt <= FRESH_S;
}

/** Step-up gate: an owner whose last email code is under 10 minutes old. Sends 403 and returns false otherwise. */
function requireFresh(actor, res) {
  if (isFresh(actor)) return true;
  res.status(403).json({ error: 'step_up_required', message: 'Enter a fresh email code to do this.' });
  return false;
}

module.exports = {
  COOKIE, OWNER_TTL_S, BREAK_GLASS_TTL_S, FRESH_S, PRODUCT, OWNER_ROLE,
  normalizeEmail, isEmail, sessionSecret, breakGlassSecret, keyFingerprint,
  sign, unsign, readCookie, setSessionCookie, clearSessionCookie, ownerPayload, breakGlassPayload,
  sbFetch, ownerAccess, writeAudit, sameOrigin, resolveActor, requireOperator, requireAdmin, requireOwner, isFresh, requireFresh
};
