/* /api/admin/apps (FDY-294, ADM-2.1). Owner only. The app registry: one card per app, the pilot
 * settings, and the three Owner writes. The tables are deny-all and read here with the service key.
 *
 *   GET                       { apps[], states[], settings: { WB: [...] } }   STORED FIELDS ONLY
 *   GET ?live=WB&part=build   latest production build from Vercel            always HTTP 200
 *   GET ?live=WB&part=metric  the app's key metric (app_registry_metric)     always HTTP 200
 *   POST { action:'promote', code, version, release, reason?, linearIssue? }
 *   POST { action:'set_state', code, state, ... }
 *   POST { action:'set_setting', code, key, value, ... }
 *
 * The list never touches Vercel, Linear or a metric, so a slow outside service cannot hold the
 * cards back. A live read that fails answers { status: 'unavailable' }, never an error. Open
 * tickets are not read here at all: the browser asks /api/workbench-linear per card.
 * Every write is auditedWrite(): the database function writes the admin_audit row itself.
 */
'use strict';

const { sb, readJson } = require('../_wb.js');
const { auditedWrite, AuditError } = require('../_audit.js');
const L = require('./apps-logic.js');

const REGISTRY_COLS = 'code,name,version_major,version_minor,state,state_source,lifecycle_stage,tile_slug,supabase_project,owner,settings_schema_version,console_url,tracker_url,linear_label';
const DEF_COLS = 'app_code,key,label,description,type,min_value,max_value,options,default_value,enforcement_status,precedence_group,needs_redeploy';
const VAL_COLS = 'app_code,key,value,updated_at,updated_by';
const LIVE_APP = 'WB';            // the pilot settings below belong to the Workbench itself
const TIMEOUT_KEY = 'apps_live_read_timeout_ms';
const ENABLED_KEY = 'apps_live_reads_enabled';
const DEFAULT_TIMEOUT_MS = 4000;
const PARTS = ['build', 'metric'];

async function read(path, key, init) {
  const r = await sb('/rest/v1/' + path, key, { method: 'GET', ...init });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) { const e = new Error('read failed'); e.status = 502; throw e; }
  return j;
}

/* ---------------------------------------------------------------------------- list */

async function list(res, ctx) {
  // Fail closed: if any of the three reads fails the whole call fails; never a partial list.
  const [rows, defs, vals] = await Promise.all([
    read(`app_registry?select=${REGISTRY_COLS}&order=code.asc&limit=200`, ctx.key),
    read(`app_setting_def?select=${DEF_COLS}&order=app_code.asc,key.asc&limit=1000`, ctx.key),
    read(`app_setting_value?select=${VAL_COLS}&limit=1000`, ctx.key)
  ]);
  const settings = {};
  for (const d of defs) {
    const v = vals.find((x) => x.app_code === d.app_code && x.key === d.key);
    (settings[d.app_code] = settings[d.app_code] || []).push(L.shapeSetting(d, v));
  }
  return res.status(200).json({ apps: rows.map(L.shapeApp), states: L.STATES, settings });
}

/* ---------------------------------------------------------------------------- live reads */

/** The two pilot settings in force. Any problem reading them falls back to 4000 ms and enabled. */
async function liveSettings(key) {
  const out = { timeoutMs: DEFAULT_TIMEOUT_MS, enabled: true };
  try {
    const keys = `(${TIMEOUT_KEY},${ENABLED_KEY})`;
    const [defs, vals] = await L.withTimeout(Promise.all([
      read(`app_setting_def?select=${DEF_COLS}&app_code=eq.${LIVE_APP}&key=in.${keys}`, key),
      read(`app_setting_value?select=${VAL_COLS}&app_code=eq.${LIVE_APP}&key=in.${keys}`, key)
    ]), DEFAULT_TIMEOUT_MS);
    const eff = (k) => {
      const d = defs.find((x) => x.key === k); if (!d) return undefined;
      return L.effectiveSetting(d, vals.find((x) => x.key === k));
    };
    const t = eff(TIMEOUT_KEY), e = eff(ENABLED_KEY);
    if (Number.isInteger(t) && t >= 500 && t <= 15000) out.timeoutMs = t;
    if (typeof e === 'boolean') out.enabled = e;
  } catch (err) { /* defaults */ }
  return out;
}

async function liveBuild(app, ms) {
  const token = process.env.VERCEL_API_TOKEN;
  const project = app && app.vercel_project;
  if (!token || !project || !/^[A-Za-z0-9._-]{1,100}$/.test(String(project))) return { status: 'unavailable', reason: 'not configured' };
  const team = process.env.VERCEL_TEAM_ID;
  let url = 'https://api.vercel.com/v6/deployments?projectId=' + encodeURIComponent(project) + '&target=production&state=READY&limit=1';
  if (team) url += '&teamId=' + encodeURIComponent(team);
  const ac = new AbortController();
  try {
    const r = await L.withTimeout(fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, signal: ac.signal }), ms);
    if (!r.ok) return { status: 'unavailable', reason: 'failed' };
    const j = await L.withTimeout(r.json(), ms);
    return L.shapeBuild(j);
  } catch (e) {
    ac.abort();
    return { status: 'unavailable', reason: 'failed' };
  }
}

async function liveMetric(code, key, ms) {
  const ac = new AbortController();
  try {
    const r = await L.withTimeout(sb('/rest/v1/rpc/app_registry_metric', key, { method: 'POST', body: JSON.stringify({ p_code: code }), signal: ac.signal }), ms);
    if (!r.ok) return { status: 'unavailable' };
    const j = await L.withTimeout(r.json(), ms);
    return L.shapeMetric(j);
  } catch (e) {
    ac.abort();
    return { status: 'unavailable' };
  }
}

async function live(req, res, ctx) {
  const q = req.query || {};
  const code = L.validateCode(q.live);
  const part = String(q.part || '');
  if (!code) return res.status(400).json({ error: 'live must be an app code such as WB.' });
  if (!PARTS.includes(part)) return res.status(400).json({ error: 'part must be build or metric.' });
  let app = null;
  try {
    const rows = await read(`app_registry?select=code,vercel_project&code=eq.${code}&limit=1`, ctx.key);
    app = rows[0] || null;
  } catch (e) {
    return res.status(200).json({ code, part, status: 'unavailable' }); // a failed read is never a 5xx
  }
  if (!app) return res.status(404).json({ error: 'Not found' });
  const s = await liveSettings(ctx.key);
  let out;
  if (!s.enabled) out = { status: 'unavailable', reason: 'disabled' };
  else out = part === 'build' ? await liveBuild(app, s.timeoutMs) : await liveMetric(code, ctx.key, s.timeoutMs);
  return res.status(200).json({ code, part, ...out });
}

/* ---------------------------------------------------------------------------- writes */

function refuse(res, e) {
  if (e instanceof AuditError) {
    if (e.status === 403 || e.status === 503) return res.status(e.status).json({ error: e.message });
    if (e.status === 409) return res.status(409).json({ error: 'The registry changed since this page loaded. Reload and try again.' });
    if (e.status >= 400 && e.status < 500) return res.status(400).json({ error: 'The registry refused that change. Nothing was saved.' });
    return res.status(502).json({ error: 'The change could not be saved. Nothing was recorded.' });
  }
  throw e;
}

async function appRow(code, key) {
  const rows = await read(`app_registry?select=${REGISTRY_COLS}&code=eq.${code}&limit=1`, key);
  return rows[0] || null;
}

async function write(req, res, ctx) {
  let body;
  try { body = await readJson(req); } catch (e) { return res.status(400).json({ error: 'Body is not JSON' }); }
  body = body && typeof body === 'object' ? body : {};
  const action = String(body.action || '');
  if (!['promote', 'set_state', 'set_setting'].includes(action)) return res.status(400).json({ error: 'action must be promote, set_state or set_setting.' });
  const code = L.validateCode(body.code);
  if (!code) return res.status(400).json({ error: 'code must be an app code such as WB.' });
  const common = { reason: body.reason, linearIssue: body.linearIssue };
  const key = ctx.key;

  const row = await appRow(code, key);
  if (!row) return res.status(400).json({ error: 'No app has the code ' + code + '.' });

  if (action === 'promote') {
    const p = L.checkPromote(row, body);
    if (p.error) return res.status(400).json({ error: p.error });
    try {
      const out = await auditedWrite(ctx.actor, { rpc: 'app_registry_promote', ...common, args: { p_code: code, p_version: p.version.text, p_release: p.release } }, { key });
      const changed = !out || out.changed !== false;
      return res.status(200).json({
        ok: true, changed, result: out || null,
        message: changed ? `${row.name} is now at ${p.version.text} (${p.release}).` : `${row.name} is already at ${p.version.text}. Nothing changed.`
      });
    } catch (e) { return refuse(res, e); }
  }

  if (action === 'set_state') {
    const state = String(body.state === undefined ? '' : body.state);
    const p = L.checkSetState(row, state);
    if (p.error) return res.status(400).json({ error: p.error });
    try {
      const out = await auditedWrite(ctx.actor, { rpc: 'app_registry_set_state', ...common, args: { p_code: code, p_state: state } }, { key });
      const changed = !out || out.changed !== false;
      return res.status(200).json({ ok: true, changed, result: out || null, message: changed ? `${row.name} is now ${state}, set by Owner.` : `${row.name} is already ${state}. Nothing changed.` });
    } catch (e) { return refuse(res, e); }
  }

  // set_setting
  const skey = String(body.key || '');
  if (!L.KEY_RE.test(skey)) return res.status(400).json({ error: 'That is not a setting name.' });
  const defs = await read(`app_setting_def?select=${DEF_COLS}&app_code=eq.${code}&key=eq.${skey}&limit=1`, key);
  if (!defs.length) return res.status(400).json({ error: `${code} has no setting named ${skey}.` });
  const v = L.validateSetting({ ...defs[0], key: skey }, body.value);
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const out = await auditedWrite(ctx.actor, { rpc: 'app_setting_set', ...common, args: { p_code: code, p_key: skey, p_value: v.value } }, { key });
    const changed = !out || out.changed !== false;
    return res.status(200).json({ ok: true, changed, result: out || null, message: changed ? `${defs[0].label} set to ${JSON.stringify(v.value)}.` : `${defs[0].label} already has that value. Nothing changed.` });
  } catch (e) { return refuse(res, e); }
}

module.exports = async function apps(req, res, ctx) {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.live !== undefined || q.part !== undefined) return live(req, res, ctx);
    return list(res, ctx);
  }
  if (req.method === 'POST') return write(req, res, ctx);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
