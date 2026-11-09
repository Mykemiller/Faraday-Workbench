/* GET /api/admin/session (FDY-285). Served through api/admin/[route].js. requireAdmin() first,
 * so anything short of a valid session (Owner or break-glass) is a bare 404.
 *
 *   GET -> { kind, email, personId, expiresAt, fresh }
 */
'use strict';

const { requireAdmin, isFresh } = require('../_auth.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireAdmin(req, res);
  if (!actor) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return res.status(200).json({
    kind: actor.kind, email: actor.email, personId: actor.personId,
    expiresAt: new Date(actor.expiresAt * 1000).toISOString(), fresh: isFresh(actor)
  });
};
