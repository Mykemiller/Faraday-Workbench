// Test helper (FDY-288): an in-memory stand-in for the Supabase REST calls the console makes.
// The three functions behave like their SQL (FDY-252 Phase 1 + FDY-288): a change and its
// admin_audit row happen together, an unchanged input changes nothing and audits nothing.
import { randomUUID } from 'node:crypto';

export function fakeDb() {
  const db = { people: [], access: [], consent: [], audit: [], calls: [], failRpc: null, recipients: [], noView: false, noFunctions: new Set(), gates: [], noGate: false, lo: [], noLo: false,
    // ADM-2.1 (FDY-294): the app registry. Mirrors the database contract: deny-all tables read with the service key.
    apps: [], defs: [], vals: [], metric: {}, failRead: null, hangRpc: null,
    vercel: { mode: 'ok', deployments: [], calls: [] } };
  const norm = (e) => String(e || '').trim().toLowerCase();
  db.addPerson = (email, extra = {}) => {
    const p = { id: extra.id || randomUUID(), email: norm(email), display_name: null, source: 'test', created_at: new Date(Date.now() - db.people.length * 1000).toISOString(), persona_preset: null, ...extra };
    db.people.push(p); return p;
  };
  db.addAccess = (person, product, role, status = 'active', expires_at = null) => {
    const a = { person_id: person.id, product, role, status, expires_at, note: null, added_by: 'test', updated_at: new Date().toISOString() };
    db.access.push(a); return a;
  };
  db.addConsent = (person, product, review_status, optin_status) => {
    db.consent.push({ person_id: person.id, product, channel: 'email', review_status, optin_status, reviewed_at: null, confirmed_at: optin_status === 'confirmed' ? '2026-11-06T12:00:00Z' : null, unsubscribed_at: null, token: 'SECRET-TOKEN' });
  };
  // FDY-291: audience_gate rows (product, lifted, pinned) as FDY-252 Phase 1 defines them.
  db.addGate = (product, lifted, pinned, extra = {}) => { const g = { product, lifted, pinned, lifted_by: null, lifted_at: null, reason: null, updated_at: new Date().toISOString(), ...extra }; db.gates.push(g); return g; };
  // FDY-290: predicts_recipients as v_predicts_recipient_review shows it (the consent token is never in the view).
  db.addRecipient = (email, extra = {}) => {
    const r = { email, source: null, dc_created_at: new Date(Date.now() - db.recipients.length * 86400000).toISOString(), last_seen_at: null, dc_active: true, review_status: 'pending_review', optin_status: 'not_invited', reviewed_at: null, reviewed_by: null, ...extra };
    db.recipients.push(r); return r;
  };
  // FDY-292: lo_audit_log (League Office) rows.
  db.addLo = (staff_email, domain, action, extra = {}) => {
    const r = { id: randomUUID(), at: new Date().toISOString(), staff_email, domain, action, reason: 'test', target_type: null, target_id: null, before: null, after: null, reversible: false, reverts_id: null, reverted_by: null, ...extra };
    db.lo.push(r); return r;
  };
  const STATES = ['Launch Ready', 'Needs Tuning', 'Just Functioning', 'Not Ready', 'Not Started'];
  db.addApp = (code, name, major, minor, extra = {}) => {
    const rule = major < 1 ? 'Not Ready' : major < 3 ? 'Just Functioning' : 'Needs Tuning';
    const a = { code, name, version_major: major, version_minor: minor, state: rule, state_source: major < 3 ? 'rule' : 'owner', lifecycle_stage: 'build', tile_slug: code.toLowerCase(),
      supabase_project: null, owner: null, settings_schema_version: 1, console_url: null, tracker_url: null, linear_label: null, vercel_project: null, ...extra };
    db.apps.push(a); return a;
  };
  db.addDef = (app_code, key, type, default_value, extra = {}) => {
    const d = { app_code, key, label: key, description: null, type, min_value: null, max_value: null, options: null, default_value, enforcement_status: 'enforced', precedence_group: 'g', needs_redeploy: false, ...extra };
    db.defs.push(d); return d;
  };
  const effective = (d) => { const v = db.vals.find((x) => x.app_code === d.app_code && x.key === d.key); return v ? v.value : d.default_value; };
  const embed = (p) => ({
    ...p,
    product_access: db.access.filter((a) => a.person_id === p.id).map(({ person_id, ...a }) => a),
    contact_consent: db.consent.filter((c) => c.person_id === p.id).map(({ person_id, token, ...c }) => c)
  });
  const audit = (row) => db.audit.push({ id: randomUUID(), at: new Date().toISOString(), reason: null, old_value: null, new_value: null, ...row });

  const rpc = {
    estate_access_for(b) {
      const p = db.people.find((x) => x.email === norm(b.p_email));
      const a = p && db.access.find((x) => x.person_id === p.id && x.product === b.p_product);
      if (!a) return { product: b.p_product, usable: false, status: 'none' };
      return { person_id: p.id, product: a.product, role: a.role, status: a.status, expires_at: a.expires_at, usable: a.status === 'active' && (!a.expires_at || Date.parse(a.expires_at) > Date.now()) };
    },
    estate_access_set(b) {
      if (!b.p_actor || !String(b.p_actor).trim()) throw new Error('estate_access_set: actor is required');
      if (!['active', 'paused', 'revoked'].includes(b.p_status)) throw new Error(`estate_access_set: status must be active, paused or revoked (got ${b.p_status})`);
      const email = norm(b.p_email);
      let p = db.people.find((x) => x.email === email);
      if (!p) { p = db.addPerson(email, { source: 'access:' + b.p_product }); audit({ actor: 'system:estate_person_ensure', actor_verified: true, product: 'estate', subject_email: email, action: 'person.create', via: 'rpc:estate_person_ensure' }); }
      const old = db.access.find((x) => x.person_id === p.id && x.product === b.p_product);
      const exp = b.p_expires_at || null, note = b.p_note || null;
      if (old && old.role === b.p_role && old.status === b.p_status && (old.expires_at || null) === exp && (old.note || null) === note) return { changed: false, person_id: p.id, product: b.p_product, role: old.role, status: old.status, expires_at: old.expires_at };
      const before = old ? { role: old.role, status: old.status, expires_at: old.expires_at, note: old.note } : null;
      const action = !old ? 'access.add' : old.status !== 'paused' && b.p_status === 'paused' ? 'access.pause' : old.status === 'paused' && b.p_status === 'active' ? 'access.resume'
        : old.status !== 'revoked' && b.p_status === 'revoked' ? 'access.revoke' : old.status === 'revoked' && b.p_status === 'active' ? 'access.restore' : 'access.update';
      if (old) Object.assign(old, { role: b.p_role, status: b.p_status, expires_at: exp, note }); else db.access.push({ person_id: p.id, product: b.p_product, role: b.p_role, status: b.p_status, expires_at: exp, note, added_by: b.p_actor, updated_at: new Date().toISOString() });
      audit({ actor: b.p_actor, actor_verified: b.p_actor_verified === true, product: b.p_product, subject_email: email, action, reason: b.p_reason ?? null, old_value: before, new_value: { role: b.p_role, status: b.p_status, expires_at: exp, note }, via: b.p_via || 'sql' });
      return { changed: true, action, person_id: p.id, product: b.p_product, role: b.p_role, status: b.p_status, expires_at: exp };
    },
    app_registry_promote(b) {
      const a = db.apps.find((x) => x.code === b.p_code); if (!a) throw new Error('app_registry_promote: unknown app');
      const rel = String(b.p_release || '').trim();
      if (!rel || rel.length > 120) throw new Error('app_registry_promote: a release name is required (120 characters at most)');
      const m = /^([0-9]{1,2})\.([0-9]{1,2})$/.exec(String(b.p_version || '').trim());
      if (!m) throw new Error('app_registry_promote: version must be XX.YY');
      const major = Number(m[1]), minor = Number(m[2]); const prev = String(a.version_major).padStart(2, '0') + '.' + String(a.version_minor).padStart(2, '0');
      const text = String(major).padStart(2, '0') + '.' + String(minor).padStart(2, '0');
      const rule = major < 1 ? 'Not Ready' : major < 3 ? 'Just Functioning' : null;
      const nextState = rule || a.state, nextSource = rule ? 'rule' : a.state_source;
      if (text === prev && nextState === a.state && nextSource === a.state_source) return { changed: false, code: a.code, version: text, state: a.state, state_source: a.state_source, previous_version: prev };
      const before = { version: prev, state: a.state, state_source: a.state_source };
      Object.assign(a, { version_major: major, version_minor: minor, state: nextState, state_source: nextSource });
      audit({ actor: b.p_actor, actor_verified: b.p_actor_verified === true, product: 'apps', subject_email: a.code, action: 'app.promote', reason: b.p_reason ?? null, old_value: before, new_value: { version: text, state: nextState, state_source: nextSource, release: rel }, via: b.p_via || 'sql' });
      return { changed: true, code: a.code, version: text, state: nextState, state_source: nextSource, previous_version: prev };
    },
    app_registry_set_state(b) {
      const a = db.apps.find((x) => x.code === b.p_code); if (!a) throw new Error('app_registry_set_state: unknown app');
      if (a.version_major < 3) throw new Error('app_registry_set_state: below 03.00 the state is set by rule');
      if (!STATES.includes(b.p_state)) throw new Error('app_registry_set_state: unknown state');
      if (a.state === b.p_state && a.state_source === 'owner') return { changed: false, code: a.code, state: a.state, state_source: 'owner' };
      const before = { state: a.state, state_source: a.state_source };
      Object.assign(a, { state: b.p_state, state_source: 'owner' });
      audit({ actor: b.p_actor, actor_verified: b.p_actor_verified === true, product: 'apps', subject_email: a.code, action: 'app.set_state', reason: b.p_reason ?? null, old_value: before, new_value: { state: a.state, state_source: 'owner' }, via: b.p_via || 'sql' });
      return { changed: true, code: a.code, state: a.state, state_source: 'owner' };
    },
    app_setting_set(b) {
      const d = db.defs.find((x) => x.app_code === b.p_code && x.key === b.p_key); if (!d) throw new Error('app_setting_set: unknown setting');
      const v = b.p_value;
      const bad = (d.type === 'boolean' && typeof v !== 'boolean') || (d.type === 'text' && typeof v !== 'string') || (d.type === 'enum' && !(d.options || []).includes(v))
        || (d.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v) || (d.min_value !== null && v < d.min_value) || (d.max_value !== null && v > d.max_value)));
      if (bad) throw new Error('app_setting_set: value does not fit the setting');
      const prev = effective(d);
      if (JSON.stringify(prev) === JSON.stringify(v)) return { changed: false, code: d.app_code, key: d.key, value: prev, previous: prev };
      const row = db.vals.find((x) => x.app_code === d.app_code && x.key === d.key);
      if (row) Object.assign(row, { value: v, updated_at: new Date().toISOString(), updated_by: b.p_actor }); else db.vals.push({ app_code: d.app_code, key: d.key, value: v, updated_at: new Date().toISOString(), updated_by: b.p_actor });
      audit({ actor: b.p_actor, actor_verified: b.p_actor_verified === true, product: 'apps', subject_email: d.app_code, action: 'app.setting', reason: b.p_reason ?? null, old_value: { [d.key]: prev }, new_value: { [d.key]: v }, via: b.p_via || 'sql' });
      return { changed: true, code: d.app_code, key: d.key, value: v, previous: prev };
    },
    app_registry_metric(b) {
      const m = db.metric[b.p_code];
      return m ? { label: m.label, value: m.value, as_of: m.as_of || null } : { label: null, value: null, as_of: null };
    },
    estate_audience_gate_set(b) {   // FDY-252 Phase 1: the ONLY writer of audience_gate; audits in the same step
      if (!b.p_actor || !String(b.p_actor).trim()) throw new Error('estate_audience_gate_set: actor is required');
      if (!b.p_reason || !String(b.p_reason).trim()) throw new Error('estate_audience_gate_set: reason is required');
      if (typeof b.p_lifted !== 'boolean') throw new Error('estate_audience_gate_set: p_lifted must be true or false');
      if (b.p_lifted && (b.p_confirm || '') !== 'lift') throw new Error("estate_audience_gate_set: lifting requires p_confirm = 'lift'");
      const g = db.gates.find((x) => x.product === b.p_product);
      if (!g) throw new Error('no audience_gate row for product ' + b.p_product);
      if (g.lifted === b.p_lifted) return { changed: false, product: g.product, lifted: g.lifted };
      const old = { lifted: g.lifted };
      Object.assign(g, { lifted: b.p_lifted, lifted_by: b.p_actor, lifted_at: new Date().toISOString(), reason: b.p_reason });
      audit({ actor: b.p_actor, actor_verified: b.p_actor_verified === true, product: g.product, subject_email: '*', action: b.p_lifted ? 'gate.lift' : 'gate.arm', reason: b.p_reason, old_value: old, new_value: { lifted: g.lifted }, via: b.p_via || 'sql' });
      return { changed: true, product: g.product, lifted: g.lifted };
    },
    predicts_review_recipient(b) {   // the 4-argument FDY-252 form: review + admin_audit in one step
      if (!['approve', 'reject'].includes(b.p_decision)) throw new Error('p_decision must be approve or reject');
      if (!b.p_actor || !String(b.p_actor).trim()) throw new Error('predicts_review_recipient: p_actor is required (who decided)');
      const r = db.recipients.find((x) => norm(x.email) === norm(b.p_email));
      if (!r) throw new Error('no predicts recipient with email ' + b.p_email);
      const old = { review_status: r.review_status, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at };
      r.review_status = b.p_decision === 'approve' ? 'approved' : 'rejected'; r.reviewed_by = b.p_actor; r.reviewed_at = new Date().toISOString();
      audit({ actor: b.p_actor, actor_verified: false, product: 'predicts', subject_email: r.email, action: 'consent.' + b.p_decision, reason: b.p_reason ?? null, old_value: old, new_value: { review_status: r.review_status, reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at }, via: 'rpc:predicts_review_recipient' });
      return { email: r.email, review_status: r.review_status, optin_status: r.optin_status, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by };
    },
    estate_person_set_persona(b) {
      const p = db.people.find((x) => x.email === norm(b.p_email));
      if (!p) throw new Error('estate_person_set_persona: no person with that email');
      const v = b.p_persona ? String(b.p_persona).toUpperCase() : null;
      if (v && !/^MF-(0[1-9]|1[0-9]|2[01])$/.test(v)) throw new Error('estate_person_set_persona: persona must be MF-01 to MF-21 or empty');
      if ((p.persona_preset || null) === v) return { changed: false, person_id: p.id, persona_preset: v };
      audit({ actor: b.p_actor, actor_verified: b.p_actor_verified === true, product: 'estate', subject_email: p.email, action: 'person.persona', reason: b.p_reason ?? null, old_value: { persona_preset: p.persona_preset }, new_value: { persona_preset: v }, via: b.p_via || 'sql' });
      p.persona_preset = v;
      return { changed: true, person_id: p.id, persona_preset: v };
    }
  };

  const hang = (init) => new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
  db.fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : {};
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (u.hostname === 'api.vercel.com') {
      db.vercel.calls.push({ url: String(url), auth: (init.headers || {}).Authorization });
      if (db.vercel.mode === 'hang') return hang(init);
      if (db.vercel.mode === 'fail') return json({ error: { message: 'nope' } }, 500);
      return json({ deployments: db.vercel.deployments });
    }
    db.calls.push({ method, path: u.pathname, search: u.search, body });
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
    if (m) {
      if (!rpc[m[1]] || db.noFunctions.has(m[1])) return json({ code: 'PGRST202', message: 'no function ' + m[1] }, 404);
      if (db.failRpc === m[1]) return json({ message: 'boom' }, 500);
      if (db.hangRpc === m[1]) return hang(init);
      try { return json(rpc[m[1]](body)); } catch (e) { return json({ message: e.message }, 400); }
    }
    const sp = u.searchParams;
    const tbl = /^\/rest\/v1\/(app_registry|app_setting_def|app_setting_value)$/.exec(u.pathname);
    if (tbl && method === 'GET') {
      if (db.failRead === tbl[1]) return json({ message: 'boom' }, 500);
      const eq = (k) => { const v = sp.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
      const inList = (k) => { const v = sp.get(k); return v && v.startsWith('in.(') ? v.slice(4, -1).split(',') : null; };
      const keep = (row, codeCol) => (!eq(codeCol) || row[codeCol] === eq(codeCol)) && (!eq('key') || row.key === eq('key')) && (!inList('key') || inList('key').includes(row.key));
      const rows = tbl[1] === 'app_registry' ? db.apps.filter((r) => keep(r, 'code')).slice().sort((a, b) => (a.code < b.code ? -1 : 1))
        : tbl[1] === 'app_setting_def' ? db.defs.filter((r) => keep(r, 'app_code')) : db.vals.filter((r) => keep(r, 'app_code'));
      return json(rows);
    }
    if (u.pathname === '/rest/v1/audience_gate' && method === 'GET') {
      if (db.noGate) return json({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }, 404);
      const pr = sp.get('product');
      return json(db.gates.filter((g) => !pr || !pr.startsWith('eq.') || g.product === pr.slice(3)).map((g) => ({ ...g })));
    }
    if (u.pathname === '/rest/v1/v_predicts_recipient_review' && method === 'GET') {
      if (db.noView) return json({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }, 404);
      const rows = db.recipients.slice().sort((a, b) => (b.review_status === 'pending_review') - (a.review_status === 'pending_review') || String(a.dc_created_at).localeCompare(String(b.dc_created_at)));
      return json(rows.map((r) => ({ ...r })));
    }
    if (u.pathname === '/rest/v1/estate_people' && method === 'GET') {
      let rows = db.people.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      if (sp.get('id')) { const v = sp.get('id'); rows = v.startsWith('eq.') ? rows.filter((p) => p.id === v.slice(3)) : rows.filter((p) => v.slice(4, -1).split(',').includes(p.id)); }
      if (sp.get('email_normalised')) rows = rows.filter((p) => p.email === sp.get('email_normalised').slice(3));
      return json((sp.get('select') || '').includes('product_access') ? rows.map(embed) : rows.map((p) => ((sp.get('select') || '').includes('persona_preset') ? { id: p.id, email: p.email, persona_preset: p.persona_preset } : { id: p.id, email: p.email })));
    }
    if (u.pathname === '/rest/v1/product_access' && method === 'GET') {
      const product = (sp.get('product') || '').slice(3);
      return json(db.access.filter((a) => !product || a.product === product).map(({ person_id, ...a }) => {
        const p = db.people.find((x) => x.id === person_id);
        return { ...a, created_at: a.updated_at, estate_people: p ? { id: p.id, email: p.email, display_name: p.display_name } : null };
      }));
    }
    if (u.pathname === '/rest/v1/admin_audit' && method === 'GET') {
      let rows = db.audit.slice().reverse();
      const f = (k) => { const v = sp.get(k); const i = v ? v.indexOf('.') : -1; return i < 0 ? null : { op: v.slice(0, i), val: v.slice(i + 1) }; };
      const se = f('subject_email'), ac = f('actor'), at = f('at'), id = f('id'), act = f('action');
      if (se && se.op === 'eq') rows = rows.filter((r) => r.subject_email === se.val);
      if (se && se.op === 'ilike') rows = rows.filter((r) => String(r.subject_email || '').toLowerCase().includes(se.val.replace(/\*/g, '').toLowerCase()));
      if (sp.get('product')) rows = rows.filter((r) => r.product === sp.get('product').slice(3));
      if (act && act.op === 'eq') rows = rows.filter((r) => r.action === act.val);
      if (id && id.op === 'eq') rows = rows.filter((r) => String(r.id) === id.val);
      if (ac && ac.op === 'eq') rows = rows.filter((r) => r.actor === ac.val);
      if (ac && ac.op === 'in') rows = rows.filter((r) => ac.val.slice(1, -1).split(',').includes(r.actor));
      if (ac && ac.op === 'ilike') rows = rows.filter((r) => String(r.actor || '').toLowerCase().includes(ac.val.replace(/\*/g, '').toLowerCase()));
      if (at && at.op === 'lt') rows = rows.filter((r) => Date.parse(r.at) < Date.parse(at.val));
      return json(rows.slice(0, Number(sp.get('limit')) || 100));
    }
    if (u.pathname === '/rest/v1/lo_audit_log' && method === 'GET') {
      if (db.noLo) return json({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }, 404);
      let rows = db.lo.slice().reverse();
      const f = (k) => { const v = sp.get(k); const i = v ? v.indexOf('.') : -1; return i < 0 ? null : { op: v.slice(0, i), val: v.slice(i + 1) }; };
      const dom = f('domain'), st = f('staff_email'), ti = f('target_id'), at = f('at');
      if (dom) rows = rows.filter((r) => r.domain === dom.val);
      if (st) rows = rows.filter((r) => r.staff_email.toLowerCase().includes(st.val.replace(/\*/g, '').toLowerCase()));
      if (ti) rows = rows.filter((r) => String(r.target_id || '').toLowerCase().includes(ti.val.replace(/\*/g, '').toLowerCase()));
      if (at && at.op === 'lt') rows = rows.filter((r) => Date.parse(r.at) < Date.parse(at.val));
      return json(rows.slice(0, Number(sp.get('limit')) || 100));
    }
    if (u.pathname === '/rest/v1/admin_audit' && method === 'POST') { audit(body); return json(null, 201); }
    throw new Error('unexpected fetch ' + method + ' ' + u);
  };
  return db;
}
