/* /api/admin/people (FDY-287, FDY-288). Owner only.
 *
 *   GET  ?q=&app=&status=&expiry=&persona=   the directory: search by name or email, filter by app,
 *                                            status, expiry and persona preset. Each person carries
 *                                            their apps, plan band ("None yet" until Phase 3) and consent.
 *   POST { email, product, role, expiresAt?, note?, reason?, linearIssue? }
 *                                            add a person by granting their first access. The email is
 *                                            lowercased; an address already in the directory is refused
 *                                            with a friendly message and a link to that person.
 *
 * Reads go straight to estate_people (with product_access and contact_consent embedded; the consent
 * token is never selected). The write goes through auditedWrite(), so it writes its admin_audit row.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const { requireFresh } = require('../_auth.js');
const L = require('./people-logic.js');

const PERSON_SELECT = 'id,email,display_name,source,created_at,persona_preset,'
  + 'product_access(product,role,status,expires_at,note,added_by,updated_at),'
  + 'contact_consent(product,channel,review_status,optin_status,reviewed_at,confirmed_at,unsubscribed_at)';

async function read(path, key) {
  const r = await sb('/rest/v1/' + path, key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = 502; throw e; }
  return j;
}

async function list(req, res, ctx) {
  const f = L.parseFilters(req.query);
  if (f.error) return res.status(400).json({ error: f.error });
  const rows = await read(`estate_people?select=${PERSON_SELECT}&order=created_at.desc&limit=1000`, ctx.key);
  const now = Date.now();
  const all = rows.map((p) => L.shapePerson(p, now));
  const people = L.filterPeople(all, f, now);
  return res.status(200).json({
    total: all.length, count: people.length, people,
    options: { products: Object.entries(L.PRODUCTS).map(([id, p]) => ({ id, label: p.label, roles: p.roles })), personas: L.PERSONAS, states: L.STATES }
  });
}

async function add(req, res, ctx) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const email = L.normalizeEmail(body && body.email);
  if (!L.isEmail(email)) return res.status(400).json({ error: 'That does not look like an email address.' });
  const p = L.parseWrite({ ...body, action: 'grant' }, Date.now());
  if (p.error) return res.status(400).json({ error: p.error });
  // Granting the console itself is a console-role grant: it needs a fresh sign-in (step-up).
  if (p.product === 'workbench' && !requireFresh(ctx.actor, res)) return;

  const dup = await read(`estate_people?select=id,email&email_normalised=eq.${encodeURIComponent(email)}&limit=1`, ctx.key);
  if (dup.length) {
    return res.status(409).json({ error: `${email} is already in the directory. Open their page to change their access.`, personId: dup[0].id, url: '/admin/people/' + dup[0].id });
  }
  try {
    const out = await auditedWrite(ctx.actor, {
      rpc: 'estate_access_set', reason: p.reason, linearIssue: p.linearIssue,
      args: { p_email: email, p_product: p.product, p_role: p.role, p_status: 'active', p_expires_at: p.expiresAt, p_note: p.note }
    }, { key: ctx.key });
    const id = out && out.person_id;
    return res.status(200).json({ ok: true, personId: id || null, url: id ? '/admin/people/' + id : null, message: `Added ${email} with ${L.PRODUCTS[p.product].label} access as ${p.role}.` });
  } catch (e) {
    if (e instanceof AuditError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}

module.exports = async function people(req, res, ctx) {
  if (req.method === 'GET') return list(req, res, ctx);
  if (req.method === 'POST') return add(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
module.exports.PERSON_SELECT = PERSON_SELECT;
