/* The /admin pages (FDY-287). vercel.json rewrites /admin and /admin/<area> here. The Owner gate
 * runs first: no session, an expired session, a non-owner or a break-glass session all get a bare
 * 404, the same answer an unknown area gets. Nothing about the console is served to anyone else.
 */
'use strict';

const { requireOwner } = require('../_auth.js');
const { areaFor, renderShell } = require('../_admin/shell.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOwner(req, res);
  if (!actor) return;
  const area = req.method === 'GET' ? areaFor(req.query && req.query.area) : null;
  if (!area) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.status(200);
  return res.send ? res.send(renderShell(area, actor)) : res.end(renderShell(area, actor));
};
