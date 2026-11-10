/* /api/admin/access (FDY-289, ADM-1.2). Owner only. People > Access: who holds access to ONE app.
 * This replaces the FDY-42 ISpyaDC screen, which wrote ispyadc_access in ISpyaDC's own project.
 * The table of record is now product_access in the Faraday project, and ISpyaDC reads it.
 *
 *   GET  ?app=ispyadc     { app, label, roles, rows[] }   one row per person with access to the app
 *   POST { app, email, role, expiresAt?, note?, reason?, linearIssue? }
 *        grant by email. A new address becomes a person; a person who already has a row for this
 *        app is refused (change that row instead). Emails are lowercased.
 *
 * Changing an existing row (role, expiry, pause, revoke, restore) goes through /api/admin/person.
 * The grant goes through auditedWrite(): one admin_audit row, actor = the signed-in person's id.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const { requireFresh } = require('../_auth.js');
const L = require('./people-logic.js');

const DEFAULT_APP = 'ispyadc';

async function read(path, key) {
  const r = await sb('/rest/v1/' + path, key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = 502; throw e; }
  return j;
}

function appOf(v) {
  const app = v === undefined || v === '' ? DEFAULT_APP : String(v);
  return Object.prototype.hasOwnProperty.call(L.PRODUCTS, app) ? app : null;
}

async function list(req, res, ctx) {
  const app = appOf(req.query && req.query.app);
  if (!app) return res.status(400).json({ error: 'app is not one of ' + Object.keys(L.PRODUCTS).join(', ') });
  const rows = await read(`product_access?select=role,status,expires_at,note,added_by,created_at,updated_at,estate_people(id,email,display_name)&product=eq.${app}&order=created_at.desc&limit=1000`, ctx.key);
  const now = Date.now();
  return res.status(200).json({
    app, label: L.PRODUCTS[app].label, roles: L.PRODUCTS[app].roles, testerDefaultDays: L.TESTER_DEFAULT_DAYS,
    apps: Object.entries(L.PRODUCTS).map(([id, p]) => ({ id, label: p.label })),
    rows: rows.filter((a) => a.estate_people).map((a) => ({
      personId: a.estate_people.id, email: a.estate_people.email, displayName: a.estate_people.display_name || null,
      role: a.role, status: a.status, state: L.accessState(a, now), expiresAt: a.expires_at || null,
      note: a.note || null, addedBy: a.added_by || null, updatedAt: a.updated_at || null
    }))
  });
}

async function grant(req, res, ctx) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const app = appOf(body && body.app);
  if (!app) return res.status(400).json({ error: 'app is not one of ' + Object.keys(L.PRODUCTS).join(', ') });
  const email = L.normalizeEmail(body.email);
  if (!L.isEmail(email)) return res.status(400).json({ error: 'That does not look like an email address.' });
  const now = Date.now();
  const p = L.parseWrite({ ...body, action: 'grant', product: app }, now);
  if (p.error) return res.status(400).json({ error: p.error });
  if (app === 'workbench' && !requireFresh(ctx.actor, res)) return;

  const who = await read(`estate_people?select=id,email,product_access(product,role,status,expires_at)&email_normalised=eq.${encodeURIComponent(email)}&limit=1`, ctx.key);
  const cur = who.length ? (who[0].product_access || []).find((a) => a.product === app) : null;
  if (cur) {
    return res.status(409).json({
      error: `${email} already has ${L.PRODUCTS[app].label} access (${cur.role}, ${L.accessState(cur, now)}). Change, restore or revoke that row instead.`,
      personId: who[0].id, url: '/admin/people/' + who[0].id
    });
  }
  try {
    const out = await auditedWrite(ctx.actor, {
      rpc: 'estate_access_set', reason: p.reason, linearIssue: p.linearIssue,
      args: { p_email: email, p_product: app, p_role: p.role, p_status: 'active', p_expires_at: p.expiresAt, p_note: p.note }
    }, { key: ctx.key });
    return res.status(200).json({ ok: true, personId: (out && out.person_id) || null, message: `Added ${email} as ${p.role}${p.expiresAt ? ' until ' + p.expiresAt.slice(0, 10) : ''}.` });
  } catch (e) {
    if (e instanceof AuditError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}

module.exports = async function access(req, res, ctx) {
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return grant(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
module.exports.DEFAULT_APP = DEFAULT_APP;
