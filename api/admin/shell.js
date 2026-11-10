/* The /admin pages (FDY-287). vercel.json rewrites /admin and /admin/<area> here. The Owner gate
 * runs first: no session, an expired session, a non-owner all get a bare
 * 404, the same answer an unknown area gets. Nothing about the console is served to anyone else.
 */
'use strict';

const { requireOwner } = require('../_auth.js');
const { areaFor, renderShell } = require('../_admin/shell.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOwner(req, res);
  if (!actor) return;
  const q = req.query || {};
  const area = req.method === 'GET' ? areaFor(q.area) : null;
  // /admin/people/<person id> is the only two-level page. Anything else with an id is not a page.
  const id = q.id === undefined || q.id === '' ? '' : String(q.id);
  if (!area || (id && (area.id !== 'people' || !UUID.test(id)))) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.status(200);
  return res.send ? res.send(renderShell(area, actor, id)) : res.end(renderShell(area, actor, id));
};
