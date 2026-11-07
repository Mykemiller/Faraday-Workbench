/* CC-WORKBENCH-NOTES-LINEAR-1.0 · per-product notes and actions.
 *
 * Writes to public.workbench_product_notes, which anon and authenticated cannot
 * touch (RLS on, grants revoked). The page reads notes through the anon RPC
 * workbench_product_notes(); it writes only through here, with the service key
 * held server-side and the shared workbench secret as the gate.
 *
 *   POST  { slug, kind: 'note'|'action', body }   -> inserts, returns the row
 *   PATCH { id, status: 'open'|'done' }           -> flips status, stamps done_at
 */
'use strict';

const { refuseUnlessKeyed, sb, readJson, faradayServiceKey } = require('./_wb.js');

const KINDS = new Set(['note', 'action']);
const STATUSES = new Set(['open', 'done']);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseUnlessKeyed(req, res)) return;

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
      const r = await sb('/rest/v1/workbench_product_notes', serviceKey, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ slug, kind, body: text })
      });
      const rows = await r.json().catch(() => null);
      if (!r.ok) return res.status(r.status).json({ error: (rows && (rows.message || rows.hint)) || `HTTP ${r.status}` });
      return res.status(201).json({ ok: true, note: Array.isArray(rows) ? rows[0] : rows });
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
