/* Workbench sign-in (FDY-285, ADM-0.2). Deliberately NOT under /api/admin/*: a signed-out
 * browser must be able to reach it. It returns nothing about who has access.
 *
 *   GET                                   -> { signedIn, kind?, email?, personId?, expiresAt?, fresh? }
 *   POST { action: 'request_code', email } -> always the same 200. A code is mailed (by Supabase
 *                                             Auth) only when the address holds workbench/owner access.
 *   POST { action: 'verify_code', email, code } -> sets the session cookie, writes admin_audit
 *                                             with the person's id as actor. A second verify while
 *                                             signed in is the step-up ("fresh code").
 *   POST { action: 'break_glass', key }    -> shared key. Emails the owner, writes admin_audit,
 *                                             sets a 1-hour break-glass session.
 *   POST { action: 'sign_out' }            -> clears the cookie.
 *
 * Env (names only; values live in Vercel): WORKBENCH_SESSION_SECRET, WORKBENCH_REFRESH_SECRET
 * (the break-glass key), FARADAY_SERVICE_ROLE_KEY, WORKBENCH_RESEND_API_KEY,
 * WORKBENCH_ALERT_FROM, WORKBENCH_ALERT_TO.
 */
'use strict';

const { readJson, secretMatches, faradayServiceKey } = require('./_wb.js');
const A = require('./_auth.js');

const CODE = /^[0-9]{6,10}$/;
const GENERIC = 'If that address has Workbench access, a code is on its way.';
const BAD_CODE = 'That code did not work. Request a new one and try again.';

function clientInfo(req) {
  const h = req.headers || {};
  return {
    ip: String(h['x-forwarded-for'] || '').split(',')[0].trim() || null,
    user_agent: String(h['user-agent'] || '').slice(0, 200) || null
  };
}

function alertConfig(env) {
  const missing = ['WORKBENCH_RESEND_API_KEY', 'WORKBENCH_ALERT_FROM', 'WORKBENCH_ALERT_TO'].filter((n) => !env[n]);
  if (missing.length) return { missing };
  return { key: env.WORKBENCH_RESEND_API_KEY, from: env.WORKBENCH_ALERT_FROM, to: env.WORKBENCH_ALERT_TO };
}

/** Mail the owner that the shared key was used. Returns true when the provider accepted it. */
async function sendBreakGlassAlert(cfg, info, at) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cfg.from, to: [cfg.to],
        subject: 'Faraday Workbench: break-glass key used',
        text: `The shared Workbench key was used to open a break-glass session.\n\nWhen: ${at}\nIP: ${info.ip || 'unknown'}\nBrowser: ${info.user_agent || 'unknown'}\n\nThe session lasts 1 hour. If this was not you, rotate WORKBENCH_REFRESH_SECRET in Vercel now; that ends the session.`
      })
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function status(req, res) {
  const r = await A.resolveActor(req);
  if (!r.actor) return res.status(200).json({ signedIn: false });
  const a = r.actor;
  return res.status(200).json({
    signedIn: true, kind: a.kind, email: a.email, personId: a.personId,
    expiresAt: new Date(a.expiresAt * 1000).toISOString(), fresh: A.isFresh(a)
  });
}

async function requestCode(body, res, key) {
  const email = A.normalizeEmail(body.email);
  if (!A.isEmail(email)) return res.status(400).json({ error: 'That does not look like an email address.' });
  let acc = null;
  try { acc = await A.ownerAccess(email, key); } catch (e) { acc = null; }
  if (acc) {
    // Supabase Auth mails the code. create_user: the owner has no auth.users row until first sign-in.
    try {
      await A.sbFetch('/auth/v1/otp', key, { method: 'POST', body: JSON.stringify({ email, create_user: true }) });
    } catch (e) { /* same answer either way */ }
  }
  return res.status(200).json({ ok: true, message: GENERIC });
}

async function verifyCode(req, body, res, key) {
  const email = A.normalizeEmail(body.email);
  const code = String(body.code || '').replace(/\s+/g, '');
  if (!A.isEmail(email) || !CODE.test(code)) return res.status(401).json({ error: BAD_CODE });

  // Access first: an address without workbench/owner never reaches Supabase Auth.
  let acc;
  try { acc = await A.ownerAccess(email, key); } catch (e) { return res.status(401).json({ error: BAD_CODE }); }
  if (!acc) return res.status(401).json({ error: BAD_CODE });

  let v;
  try {
    const r = await A.sbFetch('/auth/v1/verify', key, { method: 'POST', body: JSON.stringify({ type: 'email', email, token: code }) });
    if (!r.ok) return res.status(401).json({ error: BAD_CODE });
    v = await r.json();
  } catch (e) {
    return res.status(401).json({ error: BAD_CODE });
  }
  const verified = A.normalizeEmail(v && v.user && v.user.email);
  if (!v || !v.access_token || verified !== email) return res.status(401).json({ error: BAD_CODE });

  // A verify by the person who is already signed in is the step-up; anything else is a sign-in.
  const prior = await A.resolveActor(req);
  const stepUp = !!(prior.actor && prior.actor.kind === 'owner' && prior.actor.personId === acc.personId);
  try {
    await A.writeAudit(key, {
      actor: acc.personId, actor_verified: true, subject_email: email,
      action: stepUp ? 'workbench.step_up' : 'workbench.sign_in',
      new_value: { auth_user_id: (v.user && v.user.id) || null, ...clientInfo(req) },
      via: 'workbench:email-code'
    });
  } catch (e) {
    return res.status(503).json({ error: 'Sign-in could not be recorded, so it was refused. Try again.' });
  }
  const p = A.ownerPayload(acc.personId, email);
  A.setSessionCookie(res, p);
  return res.status(200).json({ ok: true, signedIn: true, kind: 'owner', email, personId: acc.personId, expiresAt: new Date(p.exp * 1000).toISOString(), fresh: true });
}

async function breakGlass(req, body, res, key) {
  const secret = A.breakGlassSecret();
  if (!secret) return res.status(503).json({ error: 'WORKBENCH_REFRESH_SECRET is not set on this deployment.' });
  if (!secretMatches(String(body.key || '').trim(), secret)) return res.status(401).json({ error: 'Unauthorized' });
  const cfg = alertConfig(process.env);
  if (cfg.missing) return res.status(503).json({ error: 'Break-glass is not configured: its alert email needs ' + cfg.missing.join(', ') + '.' });

  const info = clientInfo(req);
  const at = new Date().toISOString();
  const emailSent = await sendBreakGlassAlert(cfg, info, at);
  try {
    await A.writeAudit(key, {
      actor: 'break-glass:shared-key', actor_verified: false, subject_email: '*',
      action: 'workbench.break_glass', reason: String(body.reason || '').trim().slice(0, 500) || null,
      new_value: { alert_email_sent: emailSent, ...info }, via: 'workbench:break-glass'
    });
  } catch (e) {
    return res.status(503).json({ error: 'Break-glass use could not be recorded, so it was refused.' });
  }
  const p = A.breakGlassPayload();
  A.setSessionCookie(res, p);
  return res.status(200).json({ ok: true, signedIn: true, kind: 'break-glass', email: null, personId: null, expiresAt: new Date(p.exp * 1000).toISOString(), fresh: false, alertEmailSent: emailSent });
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return status(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!A.sameOrigin(req)) return res.status(401).json({ error: 'Unauthorized' });
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const action = String((body && body.action) || '');
  if (action === 'sign_out') {
    A.clearSessionCookie(res);
    return res.status(200).json({ ok: true, signedIn: false });
  }
  if (!A.sessionSecret()) return res.status(503).json({ error: 'WORKBENCH_SESSION_SECRET is not set on this deployment (32 characters or more).' });
  const key = faradayServiceKey();
  if (!key) return res.status(503).json({ error: 'FARADAY_SERVICE_ROLE_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is not set on this deployment.' });
  if (action === 'request_code') return requestCode(body, res, key);
  if (action === 'verify_code') return verifyCode(req, body, res, key);
  if (action === 'break_glass') return breakGlass(req, body, res, key);
  return res.status(400).json({ error: 'action must be request_code, verify_code, break_glass or sign_out' });
}

module.exports = handler;
module.exports.alertConfig = alertConfig;
