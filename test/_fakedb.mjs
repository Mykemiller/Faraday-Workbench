// Test helper (FDY-288): an in-memory stand-in for the Supabase REST calls the console makes.
// The three functions behave like their SQL (FDY-252 Phase 1 + FDY-288): a change and its
// admin_audit row happen together, an unchanged input changes nothing and audits nothing.
import { randomUUID } from 'node:crypto';

export function fakeDb() {
  const db = { people: [], access: [], consent: [], audit: [], calls: [], failRpc: null };
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

  db.fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : {};
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    db.calls.push({ method, path: u.pathname, search: u.search, body });
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(u.pathname);
    if (m) {
      if (!rpc[m[1]]) return json({ message: 'no function ' + m[1] }, 404);
      if (db.failRpc === m[1]) return json({ message: 'boom' }, 500);
      try { return json(rpc[m[1]](body)); } catch (e) { return json({ message: e.message }, 400); }
    }
    const sp = u.searchParams;
    if (u.pathname === '/rest/v1/estate_people' && method === 'GET') {
      let rows = db.people.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      if (sp.get('id')) { const v = sp.get('id'); rows = v.startsWith('eq.') ? rows.filter((p) => p.id === v.slice(3)) : rows.filter((p) => v.slice(4, -1).split(',').includes(p.id)); }
      if (sp.get('email_normalised')) rows = rows.filter((p) => p.email === sp.get('email_normalised').slice(3));
      return json((sp.get('select') || '').includes('product_access') ? rows.map(embed) : rows.map((p) => ({ id: p.id, email: p.email })));
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
      const se = sp.get('subject_email');
      if (se && se.startsWith('eq.')) rows = rows.filter((r) => r.subject_email === se.slice(3));
      if (se && se.startsWith('ilike.')) rows = rows.filter((r) => r.subject_email.includes(se.slice(6).replace(/\*/g, '')));
      if (sp.get('product')) rows = rows.filter((r) => r.product === sp.get('product').slice(3));
      return json(rows.slice(0, 100));
    }
    if (u.pathname === '/rest/v1/admin_audit' && method === 'POST') { audit(body); return json(null, 201); }
    throw new Error('unexpected fetch ' + method + ' ' + u);
  };
  return db;
}
