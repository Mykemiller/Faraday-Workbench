/* GET /api/admin/people (FDY-287). Read-only list for the console's People screen: each
 * estate_people row with its product_access rows. Owner only; adapters over the existing
 * FDY-252 tables (D5). No write lives here.
 */
'use strict';

const { sb } = require('../_wb.js');

module.exports = async function people(req, res, ctx) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const r = await sb('/rest/v1/estate_people?select=id,email,display_name,source,created_at,product_access(product,role,status,expires_at)&order=created_at.desc&limit=500', ctx.key, { method: 'GET' });
  const rows = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(rows)) return res.status(502).json({ error: 'People could not be read.' });
  const now = Date.now();
  return res.status(200).json({
    count: rows.length,
    people: rows.map((p) => ({
      id: p.id, email: p.email, displayName: p.display_name || null, source: p.source, createdAt: p.created_at,
      access: (p.product_access || []).map((a) => ({
        product: a.product, role: a.role, expiresAt: a.expires_at || null,
        state: a.status === 'revoked' ? 'revoked' : (a.expires_at && Date.parse(a.expires_at) <= now ? 'expired' : 'active')
      }))
    }))
  });
};
