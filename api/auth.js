/* Workbench sign-in (FDY-285, revised). Deliberately NOT under /api/admin/*: a signed-out
 * browser must be able to reach it. It returns nothing about who has access.
 *
 *   GET                                -> { signedIn, kind?, email?, personId?, expiresAt?, fresh? }
 *   POST { action: 'sign_in', key }     -> the Workbench key, once. Sets the 8-hour session cookie and
 *                                          writes one admin_audit row (actor = the owner's person id).
 *                                          A repeat sign-in while signed in is the step-up (fresh).
 *   POST { action: 'sign_out' }         -> clears the cookie.
 *
 * Env (names only; values live in Vercel): WORKBENCH_REFRESH_SECRET (the key),
 * WORKBENCH_OWNER_EMAIL (the owner's address), FARADAY_SERVICE_ROLE_KEY.
 */
'use strict';

const { readJson, secretMatches, faradayServiceKey } = require('./_wb.js');
const A = require('./_auth.js');

const WRONG_KEY = 'That key did not work.';

function clientInfo(req) {
  const h = req.headers || {};
  return {
    ip: String(h['x-forwarded-for'] || '').split(',')[0].trim() || null,
    user_agent: String(h['user-agent'] || '').slice(0, 200) || null
  };
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

async function signIn(req, body, res, key) {
  const expected = A.workbenchKey();
  if (!expected) return res.status(503).json({ error: 'WORKBENCH_REFRESH_SECRET is not set on this deployment.' });
  if (!secretMatches(String(body.key || '').trim(), expected)) return res.status(401).json({ error: WRONG_KEY });

  const email = A.ownerEmail();
  if (!email) return res.status(503).json({ error: 'WORKBENCH_OWNER_EMAIL is not set on this deployment.' });
  let acc = null;
  try { acc = await A.ownerAccess(email, key); } catch (e) { return res.status(503).json({ error: 'Sign-in is unavailable right now. Try again.' }); }
  if (!acc) return res.status(401).json({ error: WRONG_KEY });

  // A sign-in by the person who is already signed in is the step-up; anything else is a sign-in.
  const prior = await A.resolveActor(req);
  const stepUp = !!(prior.actor && prior.actor.kind === 'owner' && prior.actor.personId === acc.personId);
  try {
    await A.writeAudit(key, {
      actor: acc.personId, actor_verified: true, subject_email: email,
      action: stepUp ? 'workbench.step_up' : 'workbench.sign_in',
      new_value: clientInfo(req), via: 'workbench:key'
    });
  } catch (e) {
    return res.status(503).json({ error: 'Sign-in could not be recorded, so it was refused. Try again.' });
  }
  const p = A.ownerPayload(acc.personId, email);
  A.setSessionCookie(res, p);
  return res.status(200).json({ ok: true, signedIn: true, kind: 'owner', email, personId: acc.personId, expiresAt: new Date(p.exp * 1000).toISOString(), fresh: true });
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
  if (action !== 'sign_in') return res.status(400).json({ error: 'action must be sign_in or sign_out' });
  const key = faradayServiceKey();
  if (!key) return res.status(503).json({ error: 'FARADAY_SERVICE_ROLE_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is not set on this deployment.' });
  return signIn(req, body, res, key);
}

module.exports = handler;
