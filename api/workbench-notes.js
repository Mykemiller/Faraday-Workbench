/* CC-WORKBENCH-NOTES-LINEAR-1.0 · per-product notes and actions.
 *
 * Writes to public.workbench_product_notes, which anon and authenticated cannot
 * touch (RLS on, grants revoked). The page reads notes through the anon RPC
 * workbench_product_notes(); it writes only through here, with the service key
 * held server-side. The site-level Vercel SSO protection is the gate; no key header is checked here.
 *
 *   POST  { slug, kind: 'note'|'action', body, client_id?, source? }  -> inserts, returns the row
 *   PATCH { id, status: 'open'|'done' }           -> flips status, stamps done_at
 *
 * CC-TF-NOTES-OUTBOX-1.0: client_id (a uuid made in the browser) makes POST idempotent —
 * a retry, double-tap or reload with the same id returns the row already saved, never a
 * second one. Notes on the ThoughtForge Panel tile are then sent to Linear (team TH) by
 * api/_tfsync.js. The row is committed BEFORE any Linear or Anthropic call, and the
 * response is 200 as soon as it is, so a Linear outage never loses the note.
 */
'use strict';

const { sb, readJson, faradayServiceKey } = require('./_wb.js');
const TF = require('./_tfnotes.js');
const { syncNote, depsFromEnv, COLS } = require('./_tfsync.js');

const KINDS = new Set(['note', 'action']);
const STATUSES = new Set(['open', 'done']);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // No per-request key: the whole site sits behind Vercel SSO protection (set on the project).

  const serviceKey = faradayServiceKey();
  if (!serviceKey) return res.status(503).json({ error: 'FARADAY_SERVICE_ROLE_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is not set on this deployment.' });

  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }

  try {
    if (req.method === 'POST') {
      const slug = String(body.slug || '').trim();
      const kind = KINDS.has(body.kind) ? body.kind : 'note';
      const text = String(body.body || '').trim();
      if (!slug) return res.status(400).json({ error: 'slug is required' });
      if (!text || text.length > 2000) return res.status(400).json({ error: 'body must be 1–2000 characters' });
      const clientId = body.client_id == null ? null : String(body.client_id);
      if (clientId !== null && !TF.isUuid(clientId)) return res.status(400).json({ error: 'client_id must be a uuid' });
      const source = body.source === 'voice' ? 'voice' : (body.source === 'typed' ? 'typed' : null);
      const row = { slug, kind, body: text, source, sync_status: TF.initialSyncStatus(slug) };
      if (clientId) row.client_id = clientId;
      // Idempotent insert: on a repeated client_id nothing is written and the saved row is read back.
      const r = await sb(`/rest/v1/workbench_product_notes?select=${COLS}${clientId ? '&on_conflict=client_id' : ''}`, serviceKey, {
        method: 'POST',
        headers: { Prefer: clientId ? 'return=representation,resolution=ignore-duplicates' : 'return=representation' },
        body: JSON.stringify(row)
      });
      const rows = await r.json().catch(() => null);
      if (!r.ok) return res.status(r.status).json({ error: (rows && (rows.message || rows.hint)) || `HTTP ${r.status}` });
      let note = Array.isArray(rows) ? rows[0] : rows;
      let duplicate = false;
      if (!note && clientId) {
        const g = await sb(`/rest/v1/workbench_product_notes?select=${COLS}&client_id=eq.${clientId}`, serviceKey, { method: 'GET' });
        const got = await g.json().catch(() => null);
        note = Array.isArray(got) ? got[0] : null;
        duplicate = true;
        if (!note) return res.status(502).json({ error: 'Saved row could not be read back' });
      }

      // Best-effort Linear sync. Failures leave the row pending for the panel and the cron to retry.
      let sync = null;
      if (note && note.slug === TF.TF_SLUG && !note.linear_issue_id) {
        const env = depsFromEnv(process.env);
        if (env.deps) {
          try { sync = await syncNote(note, env.deps); } catch (e) { sync = { status: note.sync_status, error: TF.redact(e) }; }
          if (sync && sync.note) note = sync.note;
        } else {
          sync = { status: note.sync_status, error: env.error };
        }
      }
      return res.status(200).json({ ok: true, duplicate, note, sync: sync && { status: sync.status, error: sync.error || null, missing_labels: sync.missing_labels || [], payloads: sync.payloads } });
    }

    const id = Number(body.id);
    const status = STATUSES.has(body.status) ? body.status : null;
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id is required' });
    if (!status) return res.status(400).json({ error: 'status must be open or done' });
    const r = await sb(`/rest/v1/workbench_product_notes?id=eq.${id}`, serviceKey, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status, done_at: status === 'done' ? new Date().toISOString() : null })
    });
    const rows = await r.json().catch(() => null);
    if (!r.ok) return res.status(r.status).json({ error: (rows && (rows.message || rows.hint)) || `HTTP ${r.status}` });
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'No note with that id' });
    return res.status(200).json({ ok: true, note: rows[0] });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
