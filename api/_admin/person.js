/* /api/admin/person (FDY-288). Owner only. The Person page: everything the console holds about one
 * person, and the writes on their access.
 *
 *   GET  ?id=<uuid>   { person, audit[] }  person = profile, every product_access row, every
 *                     contact_consent row, plan ("None yet" until Phase 3); audit = the newest 100
 *                     admin_audit rows about them.
 *   POST { id, action, product?, role?, expiresAt?, persona?, reason?, linearIssue? }
 *        grant · set_role · pause · resume · set_expiry (a date, "now", or empty) · revoke · restore · set_persona
 *
 * Every write goes through auditedWrite(): the database function changes the row and appends
 * admin_audit in one transaction, with the signed-in person's id as the actor. A reason is optional.
 * Two guards: a console-role grant needs a fresh sign-in, and the Owner cannot pause, expire or
 * revoke their own console access (that would lock the console with nobody able to undo it).
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const { requireFresh } = require('../_auth.js');
const { guard, accessAction } = require('../_rights.js');
const L = require('./people-logic.js');
const { PERSON_SELECT } = require('./people.js');

const AUDIT_COLS = 'id,at,actor,actor_verified,product,action,reason,old_value,new_value,via';

async function read(path, key) {
  const r = await sb('/rest/v1/' + path, key, { method: 'GET' });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = 502; throw e; }
  return j;
}

async function loadPerson(id, key) {
  const rows = await read(`estate_people?select=${PERSON_SELECT}&id=eq.${id}&limit=1`, key);
  return rows[0] || null;
}

async function show(req, res, ctx) {
  const id = String((req.query && req.query.id) || '');
  if (!L.UUID.test(id)) return res.status(400).json({ error: 'id must be a person id' });
  const row = await loadPerson(id, ctx.key);
  if (!row) return res.status(404).json({ error: 'No person with that id' });
  const person = L.shapePerson(row, Date.now());
  const audit = await read(`admin_audit?select=${AUDIT_COLS}&subject_email=eq.${encodeURIComponent(L.normalizeEmail(row.email))}&order=at.desc&limit=100`, ctx.key);
  const ids = [...new Set(audit.map((a) => a.actor).filter((a) => L.UUID.test(String(a))))];
  const names = {};
  if (ids.length) for (const p of await read(`estate_people?select=id,email&id=in.(${ids.join(',')})`, ctx.key)) names[p.id] = p.email;
  return res.status(200).json({
    person,
    audit: audit.map((a) => ({
      id: a.id, at: a.at, actor: a.actor, actorEmail: names[a.actor] || null, actorVerified: a.actor_verified === true,
      product: a.product, action: a.action, reason: a.reason || null, before: a.old_value === undefined ? null : a.old_value, after: a.new_value === undefined ? null : a.new_value, via: a.via
    })),
    options: { products: Object.entries(L.PRODUCTS).map(([pid, p]) => ({ id: pid, label: p.label, roles: p.roles })), personas: L.PERSONAS }
  });
}

async function write(req, res, ctx) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  const id = String((body && body.id) || '');
  if (!L.UUID.test(id)) return res.status(400).json({ error: 'id must be a person id' });
  const now = Date.now();
  const p = L.parseWrite(body, now);
  if (p.error) return res.status(400).json({ error: p.error });
  // rights: after the session check, before any read or write. A change on the console itself is a console-role grant.
  const right = p.action === 'set_persona' ? 'person.persona'
    : accessAction(['grant', 'restore', 'resume', 'set_role'].includes(p.action) ? 'access.grant' : 'access.expire', p.product);
  if (!guard(ctx.actor, right, { product: p.product }, res)) return;
  const row = await loadPerson(id, ctx.key);
  if (!row) return res.status(404).json({ error: 'No person with that id' });
  const email = L.normalizeEmail(row.email);
  const run = async (rpc, args) => {
    try { return await auditedWrite(ctx.actor, { rpc, args, reason: p.reason, linearIssue: p.linearIssue }, { key: ctx.key }); }
    catch (e) { if (e instanceof AuditError) { res.status(e.status).json({ error: e.message }); return undefined; } throw e; }
  };
  const done = (out, message) => res.status(200).json({ ok: true, changed: !(out && out.changed === false), message: out && out.changed === false ? 'Nothing changed.' : message });

  if (p.action === 'set_persona') {
    const out = await run('estate_person_set_persona', { p_email: email, p_persona: p.persona });
    if (out === undefined) return;
    return done(out, p.persona ? `Persona set to ${p.persona}.` : 'Persona cleared.');
  }

  const label = L.PRODUCTS[p.product].label;
  const cur = (row.product_access || []).find((a) => a.product === p.product && a.role !== 'operator') || null;
  const self = id === ctx.actor.personId && p.product === 'workbench';

  if (p.action === 'grant') {
    if (cur) return res.status(409).json({ error: `${email} already has ${label} access (${cur.role}, ${L.accessState(cur, now)}). Change that row instead of adding another.` });
    if (p.product === 'workbench' && !requireFresh(ctx.actor, res)) return;
    const out = await run('estate_access_set', { p_email: email, p_product: p.product, p_role: p.role, p_status: 'active', p_expires_at: p.expiresAt, p_note: p.note });
    if (out === undefined) return;
    return done(out, `Granted ${label} access as ${p.role}${p.expiresAt ? ' until ' + p.expiresAt.slice(0, 10) : ''}.`);
  }
  if (!cur) return res.status(404).json({ error: `${email} has no ${label} access to change.` });
  const keep = { p_email: email, p_product: p.product, p_role: cur.role, p_status: cur.status, p_expires_at: cur.expires_at || null, p_note: cur.note || null };
  let args, message;
  if (p.action === 'set_role') {
    if (p.product === 'workbench' && !requireFresh(ctx.actor, res)) return;
    args = { ...keep, p_role: p.role }; message = `${label} role is now ${p.role}.`;
  } else if (p.action === 'pause') {
    if (self) return res.status(409).json({ error: 'You cannot pause your own console access. It would lock the console.' });
    if (cur.status === 'revoked') return res.status(409).json({ error: `${label} access is revoked. Restore it first.` });
    args = { ...keep, p_status: 'paused' }; message = `${label} access paused.`;
  } else if (p.action === 'resume') {
    if (cur.status !== 'paused') return res.status(409).json({ error: `${label} access is not paused.` });
    args = { ...keep, p_status: 'active' }; message = `${label} access resumed.`;
  } else if (p.action === 'revoke') {
    if (self) return res.status(409).json({ error: 'You cannot revoke your own console access. It would lock the console.' });
    args = { ...keep, p_status: 'revoked' }; message = `${label} access revoked.`;
  } else if (p.action === 'restore') {
    if (cur.status !== 'revoked') return res.status(409).json({ error: `${label} access is not revoked.` });
    if (p.product === 'workbench' && !requireFresh(ctx.actor, res)) return;
    args = { ...keep, p_status: 'active' }; message = `${label} access restored.`;
  } else { // set_expiry
    if (self && p.expiresAt) return res.status(409).json({ error: 'You cannot put an expiry on your own console access. It would lock the console.' });
    args = { ...keep, p_expires_at: p.expiresAt };
    message = p.expiresAt === null ? `${label} access no longer expires.` : (Date.parse(p.expiresAt) <= now + 1000 ? `${label} access expired now.` : `${label} access expires ${p.expiresAt.slice(0, 10)}.`);
  }
  const out = await run('estate_access_set', args);
  if (out === undefined) return;
  return done(out, message);
}

module.exports = async function person(req, res, ctx) {
  if (req.method === 'GET') return show(req, res, ctx);
  if (req.method === 'POST') return write(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
