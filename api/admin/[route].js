/* /api/admin/<route> (FDY-285, FDY-287). One function serves every console data route, so a new
 * route is a file in api/_admin/ plus one line here, and no route can forget its gate:
 * the gate runs HERE, before the route's code, and anything it refuses is a bare 404.
 *
 *   session   signed-in Owner session      api/_admin/session.js (does its own requireAdmin)
 *   people    Owner only                        api/_admin/people.js
 *   person    Owner only                        api/_admin/person.js
 *   audit     Owner only                        api/_admin/audit.js
 */
'use strict';

const { faradayServiceKey } = require('../_wb.js');
const { requireOwner } = require('../_auth.js');

const ROUTES = Object.freeze({
  session: { gate: 'self', run: require('../_admin/session.js') },
  people: { gate: 'owner', run: require('../_admin/people.js') },
  person: { gate: 'owner', run: require('../_admin/person.js') },
  audit: { gate: 'owner', run: require('../_admin/audit.js') }
});

function routeName(req) {
  const q = req.query && req.query.route;
  if (typeof q === 'string' && q) return q;
  const m = /\/api\/admin\/([a-z0-9-]+)(?:[/?#]|$)/i.exec(String(req.url || ''));
  return m ? m[1] : '';
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const name = routeName(req);
  const route = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
  if (!route) {
    // Unknown route: still check the session first, so the answer never depends on the name.
    if (await requireOwner(req, res)) res.status(404).json({ error: 'Not found' });
    return;
  }
  if (route.gate === 'self') return route.run(req, res);
  const actor = await requireOwner(req, res);
  if (!actor) return;
  const key = faradayServiceKey();
  if (!key) return res.status(503).json({ error: 'FARADAY_SERVICE_ROLE_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is not set on this deployment.' });
  try {
    return await route.run(req, res, { actor, key });
  } catch (e) {
    if (res.headersSent) return undefined;
    return res.status(502).json({ error: 'The request could not be completed.' });
  }
}

module.exports = handler;
module.exports.ROUTES = ROUTES;
