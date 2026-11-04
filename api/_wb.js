/* Shared helpers for the Workbench API routes (CC-WORKBENCH-NOTES-LINEAR-1.0).
 * Same gating model as workbench-recompute: a shared secret in
 * WORKBENCH_REFRESH_SECRET, compared in constant time, fail-closed when unset. */
'use strict';

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ycadmmngkdhvpcsrcuaq.supabase.co';

function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Returns null when the request is authorised, otherwise sends the refusal and returns true. */
function refuseUnlessKeyed(req, res) {
  const secret = process.env.WORKBENCH_REFRESH_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'WORKBENCH_REFRESH_SECRET is not set on this deployment.' });
    return true;
  }
  if (!secretMatches(req.headers['x-workbench-key'], secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return true;
  }
  return null;
}

function sb(path, serviceKey, init) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init && init.headers)
    }
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

module.exports = { SUPABASE_URL, secretMatches, refuseUnlessKeyed, sb, readJson };
