/* Pure logic for the Operators screen (FDY-298, ADM-7a). No I/O. An operator row is product_access with
 * product = 'workbench', role = 'operator' and a scope_product (null = all apps). */
'use strict';

const L = require('./people-logic.js');

/* Scope choices: all apps (empty) or one product_access key. */
const SCOPES = Object.freeze([{ value: '', label: 'All apps' }]
  .concat(Object.entries(L.PRODUCTS).map(([id, p]) => ({ value: id, label: p.label }))));
const SCOPE_KEYS = Object.freeze(SCOPES.map((s) => s.value));
const ACTIONS = Object.freeze(['add', 'pause', 'resume', 'revoke', 'restore', 'set_expiry']);
const scopeLabel = (s) => (s ? (L.PRODUCTS[s] ? L.PRODUCTS[s].label : s) : 'All apps');

function shapeRow(a, now) {
  const p = a.estate_people || {};
  return {
    personId: p.id || null, email: p.email || null, scope: a.scope_product || '', scopeLabel: scopeLabel(a.scope_product),
    status: a.status, state: L.accessState(a, now), expiresAt: a.expires_at || null, note: a.note || null,
    addedBy: a.added_by || null, updatedAt: a.updated_at || null
  };
}

/** Validate a write. Returns { error } or { email, scope, action, expiresAt, note, reason?... }. */
function parseWrite(body, now) {
  const b = body && typeof body === 'object' ? body : {};
  if (!ACTIONS.includes(b.action)) return { error: 'action must be one of ' + ACTIONS.join(', ') };
  const email = L.normalizeEmail(b.email);
  if (!L.isEmail(email)) return { error: 'That does not look like an email address.' };
  const scope = b.scope === undefined || b.scope === null ? '' : String(b.scope);
  if (!SCOPE_KEYS.includes(scope)) return { error: 'scope must be empty (all apps) or one of ' + SCOPE_KEYS.filter(Boolean).join(', ') };
  let expiresAt = null;
  if (b.action === 'add' || b.action === 'set_expiry') {
    const raw = b.expiresAt === undefined || b.expiresAt === null ? '' : String(b.expiresAt).trim();
    if (raw === 'now') expiresAt = new Date(now).toISOString();
    else if (raw) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw + 'T23:59:59Z'))) return { error: 'expiresAt must be a date (YYYY-MM-DD).' };
      expiresAt = raw + 'T23:59:59Z';
      if (Date.parse(expiresAt) <= now) return { error: 'The expiry must be in the future.' };
    }
  }
  return { email, scope, action: b.action, expiresAt, note: b.note ? String(b.note).trim().slice(0, 500) || null : null };
}

module.exports = { SCOPES, SCOPE_KEYS, ACTIONS, scopeLabel, shapeRow, parseWrite };
