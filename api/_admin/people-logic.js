/* Pure logic for the People directory and the Person page (FDY-288, ADM-1.1). No I/O here, so it
 * is unit-tested directly. Shapes come from the FDY-252 tables: estate_people, product_access,
 * contact_consent.
 */
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERSONA = /^MF-(0[1-9]|1[0-9]|2[01])$/;

/* The apps product_access accepts (its CHECK constraint), and the roles offered for each.
 * Only Owner exists as a console role through Phase 1 (D4). Virtual Team Member is an
 * organization seat type in Phase 4 (D11), never a per-app role, so it is not offered here. */
const PRODUCTS = Object.freeze({
  ispyadc: { label: 'ISpyaDC', roles: ['user', 'tester', 'admin'] },
  jw: { label: 'Jurisdiction Watch', roles: ['member', 'editor', 'admin'] },
  predicts: { label: 'Predicts', roles: ['member', 'editor', 'admin'] },
  dailychallenge: { label: 'Daily Challenge', roles: ['member', 'editor', 'admin'] },
  workbench: { label: 'Workbench console', roles: ['owner'] }
});
const PERSONAS = Object.freeze(Array.from({ length: 21 }, (_, i) => 'MF-' + String(i + 1).padStart(2, '0')));
const STATES = Object.freeze(['active', 'paused', 'expired', 'revoked']);
const EXPIRY_FILTERS = Object.freeze(['7d', '30d', 'none', 'expired']);
const TESTER_DEFAULT_DAYS = 14;
const DAY_MS = 86400000;

const normalizeEmail = (raw) => String(raw || '').trim().toLowerCase();
const isEmail = (e) => EMAIL.test(e) && e.length <= 254;

/** What an access row is right now. Paused and revoked win over expiry. */
function accessState(a, now) {
  if (a.status === 'revoked') return 'revoked';
  if (a.status === 'paused') return 'paused';
  if (a.expires_at && Date.parse(a.expires_at) <= now) return 'expired';
  return 'active';
}

/** One consent line per (product, channel): "approved · confirmed". The token is never read. */
function consentLabel(c) {
  const review = { pending_review: 'pending review', approved: 'approved', rejected: 'rejected' }[c.review_status] || c.review_status;
  const optin = { not_invited: 'not invited', invited: 'invited', confirmed: 'confirmed', unsubscribed: 'unsubscribed' }[c.optin_status] || c.optin_status;
  return review + ' · ' + optin;
}

/** A database person row (with embedded product_access and contact_consent) as the console shows it. */
function shapePerson(p, now) {
  return {
    id: p.id, email: p.email, displayName: p.display_name || null, source: p.source, createdAt: p.created_at,
    persona: p.persona_preset || null,
    plan: null, // Plans and entitlements arrive in Phase 3 (ADM-3.1). Until then: "None yet".
    access: (p.product_access || []).map((a) => ({
      product: a.product, label: (PRODUCTS[a.product] || {}).label || a.product, role: a.role, status: a.status,
      state: accessState(a, now), expiresAt: a.expires_at || null, note: a.note || null, addedBy: a.added_by || null, updatedAt: a.updated_at || null
    })).sort((x, y) => x.label.localeCompare(y.label)),
    consent: (p.contact_consent || []).map((c) => ({
      product: c.product, channel: c.channel, reviewStatus: c.review_status, optinStatus: c.optin_status, label: consentLabel(c),
      reviewedAt: c.reviewed_at || null, confirmedAt: c.confirmed_at || null, unsubscribedAt: c.unsubscribed_at || null
    }))
  };
}

/** Validate directory filters. Returns { error } or the cleaned filter. Unknown values are refused, not ignored. */
function parseFilters(q) {
  q = q || {};
  const f = { q: String(q.q || '').trim().toLowerCase().slice(0, 100), app: '', status: '', expiry: '', persona: '' };
  if (q.app) { if (!Object.prototype.hasOwnProperty.call(PRODUCTS, q.app)) return { error: 'app is not one of ' + Object.keys(PRODUCTS).join(', ') }; f.app = q.app; }
  if (q.status) { if (!STATES.includes(q.status) && q.status !== 'none') return { error: 'status must be active, paused, expired, revoked or none' }; f.status = q.status; }
  if (q.expiry) { if (!EXPIRY_FILTERS.includes(q.expiry)) return { error: 'expiry must be 7d, 30d, none or expired' }; f.expiry = q.expiry; }
  if (q.persona) {
    const p = String(q.persona).toUpperCase();
    if (p !== 'UNSET' && !PERSONA.test(p)) return { error: 'persona must be MF-01 to MF-21 or unset' };
    f.persona = p;
  }
  return f;
}

/** Apply the filters to shaped people. App narrows which access rows the status and expiry filters look at. */
function filterPeople(people, f, now) {
  return people.filter((p) => {
    if (f.q && !(String(p.email).toLowerCase().includes(f.q) || String(p.displayName || '').toLowerCase().includes(f.q))) return false;
    if (f.persona && (f.persona === 'UNSET' ? p.persona !== null : p.persona !== f.persona)) return false;
    const rows = f.app ? p.access.filter((a) => a.product === f.app) : p.access;
    if (f.app && !rows.length && f.status !== 'none') return false;
    if (f.status === 'none') { if (rows.length) return false; } else if (f.status && !rows.some((a) => a.state === f.status)) return false;
    if (f.expiry) {
      const within = (ms) => rows.some((a) => a.state === 'active' && a.expiresAt && Date.parse(a.expiresAt) - now <= ms);
      if (f.expiry === '7d' && !within(7 * DAY_MS)) return false;
      if (f.expiry === '30d' && !within(30 * DAY_MS)) return false;
      if (f.expiry === 'none' && !rows.some((a) => a.state === 'active' && !a.expiresAt)) return false;
      if (f.expiry === 'expired' && !rows.some((a) => a.state === 'expired')) return false;
    }
    return true;
  });
}

/** 'YYYY-MM-DD' -> end of that day UTC; '' or null -> no expiry; 'now' -> this instant. undefined = invalid. */
function expiryToTimestamp(v, now) {
  if (v === null || v === undefined || v === '') return null;
  if (v === 'now') return new Date(now).toISOString();
  const s = String(v);
  if (!DATE.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) return undefined;
  return s + 'T23:59:59Z';
}
function defaultExpiry(role, now) {
  return role === 'tester' ? new Date(now + TESTER_DEFAULT_DAYS * DAY_MS).toISOString().slice(0, 10) : null;
}

const WRITE_ACTIONS = Object.freeze(['grant', 'set_role', 'pause', 'resume', 'set_expiry', 'revoke', 'restore', 'set_persona']);

/** Validate a write request body. Returns { error } or { ok, action, ... }. Reason is optional, always. */
function parseWrite(body, now) {
  body = body || {};
  const action = String(body.action || '');
  if (!WRITE_ACTIONS.includes(action)) return { error: 'action must be one of ' + WRITE_ACTIONS.join(', ') };
  const out = { ok: true, action, reason: body.reason === undefined || body.reason === null ? '' : String(body.reason), linearIssue: body.linearIssue ? String(body.linearIssue) : '' };

  if (action === 'set_persona') {
    const p = String(body.persona || '').trim().toUpperCase();
    if (p && !PERSONA.test(p)) return { error: 'persona must be MF-01 to MF-21, or empty to clear it' };
    return { ...out, persona: p || null };
  }
  const product = String(body.product || '');
  if (!Object.prototype.hasOwnProperty.call(PRODUCTS, product)) return { error: 'Choose an app: ' + Object.keys(PRODUCTS).join(', ') };
  out.product = product;
  if (action === 'grant' || action === 'set_role') {
    const role = String(body.role || '');
    if (!PRODUCTS[product].roles.includes(role)) return { error: `role for ${PRODUCTS[product].label} must be ${PRODUCTS[product].roles.join(', ')}` };
    out.role = role;
  }
  if (action === 'grant') {
    const date = body.expiresAt === undefined ? defaultExpiry(out.role, now) : body.expiresAt;
    const ts = expiryToTimestamp(date, now);
    if (ts === undefined || date === 'now') return { error: 'expiresAt must be a date (YYYY-MM-DD) or empty' };
    out.expiresAt = ts;
    const note = body.note === undefined || body.note === null ? null : String(body.note).trim().slice(0, 500) || null;
    out.note = note;
  }
  if (action === 'set_expiry') {
    const ts = expiryToTimestamp(body.expiresAt, now);
    if (ts === undefined) return { error: 'expiresAt must be a date (YYYY-MM-DD), "now", or empty to clear it' };
    out.expiresAt = ts;
  }
  return out;
}

module.exports = {
  UUID, PRODUCTS, PERSONAS, STATES, EXPIRY_FILTERS, WRITE_ACTIONS, TESTER_DEFAULT_DAYS,
  normalizeEmail, isEmail, accessState, consentLabel, shapePerson, parseFilters, filterPeople, expiryToTimestamp, defaultExpiry, parseWrite
};
