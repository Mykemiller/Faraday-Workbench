/* Pure logic for the Apps screen (FDY-294, ADM-2.1). No I/O: api/_admin/apps.js does the reads and
 * writes, this file decides what is valid and how a stored row is shown. It mirrors the database
 * functions (app_registry_promote, app_registry_set_state, app_setting_set); the database is the
 * authority, this is the early, plain-English refusal.
 *
 * The state rule: below 01.00 the state is "Not Ready"; 01.00 to 02.99 it is "Just Functioning";
 * both are set by rule. From 03.00 the Owner sets the state. A version changes only through a
 * promote that names the release.
 */
'use strict';

const STATES = Object.freeze(['Launch Ready', 'Needs Tuning', 'Just Functioning', 'Not Ready', 'Not Started']);
const SETTING_TYPES = Object.freeze(['boolean', 'integer', 'text', 'enum']);
const OWNER_STATE_FROM = 3; // major version at which the Owner may set the state
const RELEASE_MAX = 120;
const CODE_RE = /^[A-Z]{2}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
/* One or two digits, a dot, one or two digits. The browser code in client.js carries the same
 * pattern; test/apps.mjs fails if the two drift apart. */
const VERSION_RE = /^([0-9]{1,2})\.([0-9]{1,2})$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** '3.4' or '03.04' -> { major, minor, text: '03.04' }; anything else -> null. */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  const major = Number(m[1]), minor = Number(m[2]);
  return { major, minor, text: formatVersion(major, minor) };
}

function formatVersion(major, minor) {
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0 || major > 99 || minor > 99) return null;
  return pad2(major) + '.' + pad2(minor);
}

/** The state a promote sets by rule, or null when the promote leaves the state alone (03.00 and above). */
function ruleState(major) {
  if (!Number.isInteger(major) || major < 0) return null;
  if (major < 1) return 'Not Ready';
  if (major < OWNER_STATE_FROM) return 'Just Functioning';
  return null;
}

/** The Owner may set the state only from 03.00. Takes a parsed version, a version string, or a stored row. */
function canOwnerSetState(version) {
  let major = null;
  if (version && typeof version === 'object') major = version.major !== undefined ? version.major : version.version_major;
  else if (typeof version === 'string') { const p = parseVersion(version); major = p && p.major; }
  return Number.isInteger(major) && major >= OWNER_STATE_FROM;
}

function validateCode(code) { return CODE_RE.test(String(code || '')) ? String(code) : null; }

/** A release name: non-empty after trimming, at most 120 characters. Returns the trimmed name or null. */
function cleanRelease(release) {
  const r = String(release === undefined || release === null ? '' : release).trim();
  return r && r.length <= RELEASE_MAX ? r : null;
}

/** Check a promote request against a stored row. { ok, version, release, expectedState } or { error }. */
function checkPromote(row, input) {
  const v = parseVersion(input && input.version);
  if (!v) return { error: 'The version must look like 03.04: two whole numbers (one or two digits each) with a dot between them.' };
  const release = cleanRelease(input && input.release);
  if (!release) return { error: 'A promote must name the release (up to ' + RELEASE_MAX + ' characters).' };
  return { ok: true, version: v, release, expectedState: ruleState(v.major) || (row ? row.state : null) };
}

/** Check a set-state request against a stored row. { ok } or { error }. */
function checkSetState(row, state) {
  if (!STATES.includes(state)) return { error: 'State must be one of: ' + STATES.join(', ') + '.' };
  if (!row || !canOwnerSetState(row)) return { error: 'Below 03.00 the state is set by rule; promote the version instead.' };
  return { ok: true };
}

/** Validate a value against a setting definition. { ok: true, value } or { ok: false, error }. */
function validateSetting(def, value) {
  if (!def || !SETTING_TYPES.includes(def.type)) return { ok: false, error: 'Unknown setting.' };
  const label = def.label || def.key;
  if (def.type === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: label + ' must be true or false.' };
  }
  if (def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: label + ' must be a whole number.' };
    const lo = def.min_value === null || def.min_value === undefined ? null : Number(def.min_value);
    const hi = def.max_value === null || def.max_value === undefined ? null : Number(def.max_value);
    if (lo !== null && value < lo) return { ok: false, error: label + ' must be at least ' + lo + '.' };
    if (hi !== null && value > hi) return { ok: false, error: label + ' must be at most ' + hi + '.' };
    return { ok: true, value };
  }
  if (def.type === 'enum') {
    const opts = Array.isArray(def.options) ? def.options : [];
    return typeof value === 'string' && opts.includes(value) ? { ok: true, value } : { ok: false, error: label + ' must be one of: ' + opts.join(', ') + '.' };
  }
  return typeof value === 'string' ? { ok: true, value } : { ok: false, error: label + ' must be text.' };
}

/** The value in force: the stored value when a row exists, else the definition's default. */
function effectiveSetting(def, valueRow) {
  return valueRow && Object.prototype.hasOwnProperty.call(valueRow, 'value') && valueRow.value !== undefined ? valueRow.value : def.default_value;
}

/** A registry row as the cards show it. */
function shapeApp(row) {
  const major = Number(row.version_major), minor = Number(row.version_minor);
  const byOwner = row.state_source === 'owner';
  return {
    code: row.code, name: row.name,
    version: formatVersion(major, minor), versionMajor: major, versionMinor: minor,
    state: row.state, stateSource: byOwner ? 'owner' : 'rule', stateSourceLabel: byOwner ? 'set by Owner' : 'set by rule',
    canSetState: canOwnerSetState({ major }),
    lifecycle: row.lifecycle_stage || null, tileSlug: row.tile_slug || null,
    supabaseProject: row.supabase_project || null, owner: row.owner || null,
    settingsSchemaVersion: row.settings_schema_version === undefined ? null : row.settings_schema_version,
    consoleUrl: row.console_url || null, trackerUrl: row.tracker_url || null, linearLabel: row.linear_label || null
  };
}

/** One setting definition with its effective value, as the Settings tab shows it. */
function shapeSetting(def, valueRow) {
  return {
    key: def.key, label: def.label, description: def.description || null, type: def.type,
    min: def.min_value === undefined || def.min_value === null ? null : Number(def.min_value),
    max: def.max_value === undefined || def.max_value === null ? null : Number(def.max_value),
    options: Array.isArray(def.options) ? def.options : null,
    default: def.default_value, effective: effectiveSetting(def, valueRow),
    enforcement: def.enforcement_status, group: def.precedence_group, needsRedeploy: def.needs_redeploy === true,
    updatedAt: valueRow ? valueRow.updated_at || null : null, updatedBy: valueRow ? valueRow.updated_by || null : null
  };
}

/** Reject after `ms` milliseconds. The timer is always cleared. */
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeout(t));
}

const UNAVAILABLE = (reason) => (reason ? { status: 'unavailable', reason } : { status: 'unavailable' });

/** A Vercel deployments response -> the Last build field. Any problem is 'unavailable'. */
function shapeBuild(payload) {
  try {
    const d = payload && Array.isArray(payload.deployments) ? payload.deployments[0] : null;
    if (!d) return UNAVAILABLE('failed');
    const ms = Number(d.ready || d.created);
    if (!Number.isFinite(ms)) return UNAVAILABLE('failed');
    const meta = d.meta || {};
    const sha = String(meta.githubCommitSha || '').slice(0, 7);
    const first = String(meta.githubCommitMessage || '').split(/\r?\n/)[0].trim().slice(0, 200);
    const out = { status: 'ok', at: new Date(ms).toISOString(), commit: sha || null };
    if (first) out.message = first;
    return out;
  } catch (e) { return UNAVAILABLE('failed'); }
}

/** The app_registry_metric result -> the Key metric field. label null means "not measured". */
function shapeMetric(payload) {
  try {
    const p = Array.isArray(payload) ? payload[0] : payload;
    if (!p || typeof p !== 'object') return UNAVAILABLE();
    if (p.label === null || p.label === undefined || p.label === '') return { status: 'not_measured' };
    return { status: 'ok', label: String(p.label), value: p.value === null || p.value === undefined ? null : String(p.value), asOf: p.as_of || null };
  } catch (e) { return UNAVAILABLE(); }
}

module.exports = {
  STATES, SETTING_TYPES, OWNER_STATE_FROM, RELEASE_MAX, VERSION_RE, CODE_RE, KEY_RE,
  parseVersion, formatVersion, ruleState, canOwnerSetState, validateCode, cleanRelease,
  checkPromote, checkSetState, validateSetting, effectiveSetting,
  shapeApp, shapeSetting, withTimeout, shapeBuild, shapeMetric
};
