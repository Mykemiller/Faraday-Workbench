/* Pure logic for the audit timeline (FDY-292, ADM-1.5). No I/O, unit-tested directly.
 *
 * Two logs, one timeline:
 *   admin_audit   the console and estate functions: actor, actor_verified, product, subject_email, action,
 *                 reason, old_value, new_value, via.
 *   lo_audit_log  League Office: staff_email, domain, action, reason, target_type/target_id, before, after,
 *                 reversible, reverts_id, reverted_by.
 * Both are append-only. A revert never edits a row: it makes a NEW change through the same audited function
 * that made the original, so it leaves a NEW audit row (reason: "Revert of audit #<id>").
 */
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT = /^[a-z][a-z0-9_]{0,31}$/;
const ROW_ID = /^[a-z0-9-]{1,40}$/i;
const REVERT_PREFIX = 'Revert of audit #';

const text = (v) => (v === undefined || v === null ? '' : String(v));
const lower = (v) => text(v).trim().toLowerCase();
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** The setting an app.setting row is about: { code, key } or null. Reads the database's own shape
 *  ({code,key,value}); an older shape that keys the value by setting name falls back to subject_email. */
function settingOf(row) {
  if (row.action !== 'app.setting') return null;
  const n = obj(row.new_value) || {}, o = obj(row.old_value) || {};
  if (n.key || o.key) return { code: text(n.code || o.code || row.subject_email).toUpperCase(), key: text(n.key || o.key) };
  const k = Object.keys(n).find((x) => x !== 'enforcement_status') || Object.keys(o)[0];
  return k ? { code: text(row.subject_email).toUpperCase(), key: k } : null;
}
const settingValue = (side, s) => { const v = obj(side); if (!v) return undefined; return v.key !== undefined ? v.value : v[s.key]; };

/** What a revert would do for an admin_audit row, decided from the row alone (no database).
 *  { ok:true, kind } | { ok:false, why }. The state check happens again at revert time. */
function revertKind(row) {
  const a = text(row.action);
  if (/^access\./.test(a)) return a === 'access.add' || a === 'access.revoke' || a === 'access.restore' || a === 'access.update' || a === 'access.pause' || a === 'access.resume'
    ? { ok: true, kind: 'access' } : { ok: false, why: 'This kind of access change cannot be reverted.' };
  if (a === 'gate.lift') return { ok: true, kind: 'gate' };
  if (a === 'gate.arm') return { ok: false, why: 'Re-lifting the gate is a deliberate act: use Audience gate, type lift.' };
  if (a === 'app.setting') return settingOf(row) ? { ok: true, kind: 'setting' } : { ok: false, why: 'The setting this row changed cannot be identified.' };
  if (a === 'person.persona') return { ok: true, kind: 'persona' };
  if (/^consent\./.test(a)) return { ok: false, why: 'A review decision is not reverted here: decide again in the review queue.' };
  if (a === 'app.promote' || a === 'app.state' || a === 'app.set_state') return { ok: false, why: 'Release and state changes are history: promote or set the state again instead.' };
  if (/^person\.(create|seed)$/.test(a) || /^gate\.seed$/.test(a)) return { ok: false, why: 'This row records a person or gate being created. There is nothing to revert.' };
  return { ok: false, why: 'This kind of change cannot be reverted.' };
}

/** One timeline row from an admin_audit row. names: { personId: email }. */
function fromAdmin(r, names) {
  const k = revertKind(r);
  const s = settingOf(r);
  return {
    key: 'a:' + r.id, source: 'admin', id: r.id, at: r.at,
    actor: text(r.actor), actorEmail: (names && names[r.actor]) || null, actorVerified: r.actor_verified === true,
    product: r.product || null, app: r.product || null, subject: r.subject_email || null,
    action: r.action, reason: r.reason || null,
    before: r.old_value === undefined ? null : r.old_value, after: r.new_value === undefined ? null : r.new_value,
    via: r.via || null, setting: s ? s.code + '.' + s.key : null,
    revert: k.ok ? { possible: true } : { possible: false, why: k.why }, revertedBy: null
  };
}

/** One timeline row from an lo_audit_log row. League Office changes are reverted in League Office. */
function fromLo(r) {
  const target = r.target_id ? (r.target_type ? r.target_type + ':' : '') + r.target_id : (r.target_type || null);
  return {
    key: 'l:' + r.id, source: 'league_office', id: r.id, at: r.at,
    actor: text(r.staff_email), actorEmail: text(r.staff_email) || null, actorVerified: null,
    product: 'league-office', app: text(r.domain) || 'league-office', subject: target,
    action: r.action, reason: r.reason || null,
    before: r.before === undefined ? null : r.before, after: r.after === undefined ? null : r.after,
    via: 'league-office', setting: null,
    revert: { possible: false, why: r.reverted_by ? 'Already reverted in League Office.'
      : r.reverts_id ? 'This row is itself a revert.' : r.reversible ? 'Revert League Office changes in League Office (Audit Log).' : 'This League Office change is marked irreversible.' },
    revertedBy: r.reverted_by || null
  };
}

const byNewest = (a, b) => (Date.parse(b.at) - Date.parse(a.at)) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);

/** Both logs, newest first. Marks admin rows whose revert has been recorded (a later row says "Revert of audit #id"). */
function mergeTimeline(adminRows, loRows, names) {
  const rows = [...(adminRows || []).map((r) => fromAdmin(r, names)), ...(loRows || []).map(fromLo)].sort(byNewest);
  const done = new Map();
  for (const r of rows) {
    const m = r.reason && r.reason.startsWith(REVERT_PREFIX) ? /^Revert of audit #([a-z0-9-]+)/i.exec(r.reason) : null;
    if (m && !done.has(m[1])) done.set(m[1], r.key);
  }
  for (const r of rows) if (r.source === 'admin' && done.has(String(r.id))) { r.revertedBy = done.get(String(r.id)); r.revert = { possible: false, why: 'Already reverted.' }; }
  return rows;
}

/** Filters: actor (email, person id or text), app, person (the subject), setting (CODE.key or the key), source. All optional. */
function parseFilters(q) {
  const out = {}; const g = (k) => (q && q[k] !== undefined && q[k] !== '' ? text(q[k]).trim() : '');
  const clean = (s, n) => s.slice(0, n).replace(/[*%(),\\]/g, '');
  q = q || {};
  // FDY-287's parameters still work: q = the person (subject), product = the app
  q = { ...q, person: q.person !== undefined && q.person !== '' ? q.person : q.q, app: q.app !== undefined && q.app !== '' ? q.app : q.product };
  if (g('actor')) out.actor = clean(g('actor'), 100).toLowerCase();
  if (g('person')) out.person = clean(g('person'), 100).toLowerCase();
  if (g('setting')) out.setting = clean(g('setting'), 100).toLowerCase();
  if (g('app')) { if (!PRODUCT.test(g('app')) && !/^[a-z][a-z0-9_-]{0,31}$/.test(g('app'))) return { error: 'app is not a valid name' }; out.app = g('app'); }
  if (g('source')) { if (!['admin', 'league_office'].includes(g('source'))) return { error: 'source must be admin or league_office' }; out.source = g('source'); }
  if (g('before')) { if (Number.isNaN(Date.parse(g('before')))) return { error: 'before is not a timestamp' }; out.before = new Date(g('before')).toISOString(); }
  return out;
}

function matches(row, f) {
  const has = (hay, n) => lower(hay).includes(n);
  if (f.source && row.source !== f.source) return false;
  if (f.app && lower(row.app) !== f.app.toLowerCase()) return false;
  if (f.actor && !(has(row.actor, f.actor) || has(row.actorEmail, f.actor))) return false;
  if (f.person && !has(row.subject, f.person)) return false;
  if (f.setting && !(row.setting && has(row.setting, f.setting))) return false;
  if (f.before && !(Date.parse(row.at) < Date.parse(f.before))) return false;
  return true;
}

/* ---- revert planning -------------------------------------------------------------------------
 * plan(row, state) decides the new change from the ORIGINAL row and the CURRENT state, both passed in.
 * The state must still equal what the row left behind; otherwise something changed since and a blind revert
 * would overwrite it. Refusals are { ok:false, status, error }. */
const NOT_NOW = (why) => ({ ok: false, status: 409, error: why });
const sameDate = (a, b) => (a || null) === (b || null) || (a && b && Date.parse(a) === Date.parse(b));

function planAccess(row, st) {
  if (!st || !st.access) return NOT_NOW('That person no longer has an access row for this app, so there is nothing to revert.');
  const cur = st.access, after = obj(row.new_value) || {}, before = obj(row.old_value);
  if (cur.role !== after.role || cur.status !== after.status || !sameDate(cur.expires_at, after.expires_at) || text(cur.note) !== text(after.note)) {
    return NOT_NOW('Access for this person has changed since this row, so it is not reverted automatically. Change it on their page.');
  }
  const target = before || { role: after.role, status: 'revoked', expires_at: after.expires_at || null, note: after.note || null };   // reverting an add = revoke, keep the history
  return { ok: true, rpc: 'estate_access_set', stepUp: row.product === 'workbench',
    args: { p_email: row.subject_email, p_product: row.product, p_role: target.role, p_status: target.status, p_expires_at: target.expires_at || null, p_note: target.note || null },
    now: { role: cur.role, status: cur.status, expires: cur.expires_at || null }, then: { role: target.role, status: target.status, expires: target.expires_at || null } };
}

function planGate(row, st) {
  if (!st || !st.gate) return NOT_NOW('The audience gate for this product could not be read.');
  const after = obj(row.new_value) || {}, before = obj(row.old_value) || {};
  if (before.lifted !== false) return NOT_NOW('Only a lift of the gate can be reverted (back to armed).');
  if (st.gate.lifted !== after.lifted) return NOT_NOW('The gate has changed since this row, so it is not reverted automatically.');
  return { ok: true, rpc: 'estate_audience_gate_set', stepUp: false,
    args: { p_product: row.product, p_lifted: false, p_confirm: null },
    now: { lifted: st.gate.lifted }, then: { lifted: false } };
}

function planSetting(row, st) {
  const s = settingOf(row);
  if (!s || !st || st.value === undefined) return NOT_NOW('That setting could not be read.');
  const newV = settingValue(row.new_value, s), oldV = settingValue(row.old_value, s);
  if (oldV === undefined) return NOT_NOW('This row does not record the earlier value, so it cannot be reverted.');
  if (!same(st.value, newV)) return NOT_NOW('The setting has changed since this row, so it is not reverted automatically.');
  return { ok: true, rpc: 'app_setting_set', stepUp: false,
    args: { p_code: s.code, p_key: s.key, p_value: oldV }, now: { value: st.value }, then: { value: oldV } };
}

function planPersona(row, st) {
  if (!st || st.persona === undefined) return NOT_NOW('That person could not be read.');
  const after = obj(row.new_value) || {}, before = obj(row.old_value) || {};
  if ((st.persona || null) !== (after.persona_preset || null)) return NOT_NOW('The persona has changed since this row, so it is not reverted automatically.');
  return { ok: true, rpc: 'estate_person_set_persona', stepUp: false,
    args: { p_email: row.subject_email, p_persona: before.persona_preset || '' }, now: { persona: st.persona || null }, then: { persona: before.persona_preset || null } };
}

/** The new change for an admin_audit row, or a refusal. row is the RAW admin_audit row. */
function planRevert(row, state) {
  const k = revertKind(row);
  if (!k.ok) return { ok: false, status: 409, error: k.why };
  return { access: planAccess, gate: planGate, setting: planSetting, persona: planPersona }[k.kind](row, state);
}

/** The reason recorded on the new row: it always says which row it reverts. */
function revertReason(id, typed) {
  const t = text(typed).trim();
  return (REVERT_PREFIX + id + (t ? ': ' + t : '')).slice(0, 500);
}

module.exports = { UUID, PRODUCT, ROW_ID, REVERT_PREFIX, settingOf, revertKind, fromAdmin, fromLo, mergeTimeline, parseFilters, matches, planRevert, revertReason };
