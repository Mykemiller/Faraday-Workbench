/* Shared helpers for the Workbench API routes (CC-WORKBENCH-NOTES-LINEAR-1.0).
 * Gating lives in api/_auth.js (FDY-285): an Owner session or a break-glass session. */
'use strict';

const crypto = require('crypto');

/* Secrets are product-prefixed (FDY-252 Phase 0, decision D-09): FARADAY_* names the Supabase
 * project the Workbench writes people/scoring data to. The unprefixed names stay as aliases
 * until the Vercel project is renamed — read the prefixed name first, never both. */
const SUPABASE_URL = process.env.FARADAY_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ycadmmngkdhvpcsrcuaq.supabase.co';

/** The Faraday-project service key: FARADAY_SERVICE_ROLE_KEY, else the legacy SUPABASE_SERVICE_ROLE_KEY alias. */
function faradayServiceKey() {
  return process.env.FARADAY_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

module.exports = { SUPABASE_URL, secretMatches, sb, readJson, faradayServiceKey };
