/* GET /api/admin/audit (FDY-287). Read-only: the newest admin_audit rows for the console's Audit
 * screen. Owner only. Optional filters: ?product=<name>  ?q=<part of the subject email>.
 * An actor that is a person id is shown with that person's email beside it.
 */
'use strict';

const { sb } = require('../_wb.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT = /^[a-z][a-z0-9_]{0,31}$/;
const COLS = 'id,at,actor,actor_verified,product,subject_email,action,reason,old_value,new_value,via';

module.exports = async function audit(req, res, ctx) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const q = req.query || {};
  let path = `/rest/v1/admin_audit?select=${COLS}&order=at.desc&limit=100`;
  if (q.product !== undefined && q.product !== '') {
    if (!PRODUCT.test(String(q.product))) return res.status(400).json({ error: 'product is not a valid name' });
    path += `&product=eq.${q.product}`;
  }
  if (q.q !== undefined && q.q !== '') {
    const needle = String(q.q).trim().toLowerCase().slice(0, 100).replace(/[*%(),\\]/g, '');
    if (needle) path += `&subject_email=ilike.${encodeURIComponent('*' + needle + '*')}`;
  }
  const r = await sb(path, ctx.key, { method: 'GET' });
  const rows = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(rows)) return res.status(502).json({ error: 'The audit trail could not be read.' });

  const ids = [...new Set(rows.map((x) => x.actor).filter((a) => UUID.test(String(a))))];
  const names = {};
  if (ids.length) {
    const pr = await sb(`/rest/v1/estate_people?select=id,email&id=in.(${ids.join(',')})`, ctx.key, { method: 'GET' });
    const ppl = await pr.json().catch(() => null);
    if (pr.ok && Array.isArray(ppl)) for (const p of ppl) names[p.id] = p.email;
  }
  return res.status(200).json({
    count: rows.length,
    rows: rows.map((x) => ({
      id: x.id, at: x.at, actor: x.actor, actorEmail: names[x.actor] || null, actorVerified: x.actor_verified === true,
      product: x.product, subject: x.subject_email, action: x.action, reason: x.reason || null,
      before: x.old_value === undefined ? null : x.old_value, after: x.new_value === undefined ? null : x.new_value, via: x.via
    }))
  });
};
