/* CC-TF-NOTES-OUTBOX-1.0 · retry worker for ThoughtForge Panel notes → Linear (TH).
 *
 *   GET  (Vercel cron, every 15 min)  Authorization: Bearer $CRON_SECRET
 *        retries notes in pending_sync / linear_pending last touched more than 2 minutes ago
 *   POST (the panel, when it opens)   Owner or break-glass session cookie
 *        same, with a 30-second age so it never races the save request's own inline attempt
 *
 * After 10 attempts a note becomes `failed` and its last_error shows in the panel. A failed
 * note is not retried until someone sets it back to linear_pending.
 * Never logs note bodies. Errors are redacted before they are stored or returned.
 */
'use strict';

const { secretMatches } = require('./_wb.js');
const { requireOperator } = require('./_auth.js');
const TF = require('./_tfnotes.js');
const { syncNote, depsFromEnv } = require('./_tfsync.js');

const BATCH = 10;

async function run(ageSeconds) {
  const env = depsFromEnv(process.env);
  if (!env.deps) return { code: 503, body: { error: env.error } };
  const rows = await env.deps.db.pending(ageSeconds, BATCH);
  const results = [];
  for (const row of rows) {
    let r;
    try { r = await syncNote(row, env.deps); } catch (e) { r = { status: 'error', error: TF.redact(e) }; }
    results.push({ id: row.id, client_id: row.client_id, status: r.status,
      linear_identifier: r.note && r.note.linear_identifier || null, error: r.error || null });
  }
  return { code: 200, body: { ok: true, dry_run: env.deps.dryRun, considered: rows.length, results } };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const secret = process.env.CRON_SECRET;
      if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set on this deployment.' });
      const auth = String(req.headers.authorization || '');
      if (!secretMatches(auth.replace(/^Bearer\s+/i, ''), secret)) return res.status(401).json({ error: 'Unauthorized' });
      const out = await run(120);
      return res.status(out.code).json(out.body);
    }
    if (req.method === 'POST') {
      if (!(await requireOperator(req, res))) return;
      const out = await run(30);
      return res.status(out.code).json(out.body);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: TF.redact(e) });
  }
};
