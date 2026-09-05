/* CC-WORKBENCH-FINDINGS-REMEDIATION-1.0 / D3 + D8
 *
 * The ONLY server-side component in this repo. It exists because the four
 * workbench_*_refresh RPCs are service_role-only (anon and authenticated are
 * both revoked, verified live), so the browser structurally cannot invoke
 * them. The service key never reaches the client bundle - it is read here
 * from a server-only env var and used only to POST to Supabase.
 *
 * Gating: a shared secret in WORKBENCH_REFRESH_SECRET, compared in constant
 * time. If either env var is absent the route fails CLOSED with 503 - it
 * never falls back to running unauthenticated.
 *
 * Health is deliberately NOT refreshed here. Measured over 14 days of cron
 * history it averages 28.6s and peaks at 114.4s - far and away the slowest
 * lane - and cron 33 already refreshes it every 5 minutes, so an on-demand
 * run buys nothing and would blow the function's time budget.
 */
'use strict';

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ycadmmngkdhvpcsrcuaq.supabase.co';

const LANES = [
  { lane: 'scoring',    rpc: 'workbench_scoring_panels_refresh', table: 'workbench_scoring_cache' },
  { lane: 'idf',        rpc: 'workbench_idf_refresh',            table: 'workbench_idf_cache' },
  { lane: 'storefront', rpc: 'workbench_storefront_refresh',     table: 'workbench_storefront_cache' },
  { lane: 'forecast',   rpc: 'workbench_forecast_model_refresh', table: 'workbench_forecast_model_cache' }
];

/** Constant-time compare via Node crypto, so a wrong key leaks nothing by timing. */
function secretMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function sb(path, serviceKey, init) {
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.WORKBENCH_REFRESH_SECRET;

  // Fail closed. An unconfigured deployment refuses rather than running open.
  if (!secret) {
    return res.status(503).json({
      error: 'WORKBENCH_REFRESH_SECRET is not set on this deployment. Recompute is disabled.'
    });
  }
  if (!serviceKey) {
    return res.status(503).json({
      error: 'SUPABASE_SERVICE_ROLE_KEY is not set on this deployment. Recompute is disabled.'
    });
  }
  if (!secretMatches(req.headers['x-workbench-key'], secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fired in parallel: worst measured lane is scoring at 27.4s, so the wall
  // clock is bounded by the slowest, not by their sum.
  const lanes = await Promise.all(LANES.map(async (L) => {
    const t0 = Date.now();
    try {
      const r = await sb(`/rest/v1/rpc/${L.rpc}`, serviceKey, { method: 'POST', body: '{}' });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return { lane: L.lane, ok: false, ms: Date.now() - t0, error: `HTTP ${r.status} ${body.slice(0, 200)}` };
      }
      let computed_at = null;
      const c = await sb(`/rest/v1/${L.table}?select=computed_at&limit=1`, serviceKey, { method: 'GET' });
      if (c.ok) {
        const rows = await c.json().catch(() => []);
        if (Array.isArray(rows) && rows[0]) computed_at = rows[0].computed_at || null;
      }
      return { lane: L.lane, ok: true, ms: Date.now() - t0, computed_at };
    } catch (e) {
      return { lane: L.lane, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
    }
  }));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: lanes.every((l) => l.ok),
    note: 'health excluded by design — cron 33 refreshes it every 5 minutes',
    lanes
  });
};
