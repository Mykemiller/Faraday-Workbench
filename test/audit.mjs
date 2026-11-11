// FDY-292 (ADM-1.5): the audit timeline. Pure logic + the Owner-only route over the mocked client
// (test/_fakedb.mjs). Merge order, filters, revert and refusal. No network; nothing here emails anyone.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { configure, mkRes, ownerHeaders, OWNER, OWNER_ID } from './_session.mjs';
import { fakeDb } from './_fakedb.mjs';
const require = createRequire(import.meta.url);
const router = require('../api/admin/[route].js');
const A = require('../api/_admin/audit-logic.js');

configure(); process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
const call = async (req) => { const r = mkRes(); await router(req, r); return r; };
const H = () => ownerHeaders(OWNER_ID, OWNER);
const STALE = () => ownerHeaders(OWNER_ID, OWNER, Math.floor(Date.now() / 1000) - 11 * 60);
const get = (query = {}, headers = H()) => call({ method: 'GET', headers, query: { route: 'audit', ...query } });
const post = (body, headers = H()) => call({ method: 'POST', headers, query: { route: 'audit' }, body });
const db = fakeDb(); globalThis.fetch = db.fetch;
const owner = db.addPerson(OWNER, { id: OWNER_ID }); db.addAccess(owner, 'workbench', 'owner');
const T = (min) => new Date(Date.parse('2026-11-11T12:00:00Z') + min * 60000).toISOString();
const rowOf = (key) => db.audit.find((r) => 'a:' + r.id === key);
const rpcAs = (rpc, args) => db.fetch('https://x.supabase.co/rest/v1/rpc/' + rpc, { method: 'POST', body: JSON.stringify({ p_actor: OWNER_ID, p_actor_verified: true, p_via: 'workbench:console', ...args }) });

// ---- pure logic ----
{
  const admin = [
    { id: 1, at: T(0), actor: OWNER_ID, actor_verified: true, product: 'ispyadc', subject_email: 'a@x.io', action: 'access.add', reason: null, old_value: null, new_value: { role: 'tester', status: 'active', expires_at: null, note: null }, via: 'workbench:console' },
    { id: 3, at: T(20), actor: OWNER_ID, actor_verified: true, product: 'ispyadc', subject_email: 'a@x.io', action: 'access.revoke', reason: 'left', old_value: { role: 'tester', status: 'active', expires_at: null, note: null }, new_value: { role: 'tester', status: 'revoked', expires_at: null, note: null }, via: 'workbench:console' }
  ];
  const lo = [{ id: 'bbbb', at: T(10), staff_email: 'staff@x.io', domain: 'seasons', action: 'season.save', reason: 'edit', target_type: 'season', target_id: 'S1', before: { a: 1 }, after: { a: 2 }, reversible: true, reverts_id: null, reverted_by: null }];
  const t = A.mergeTimeline(admin, lo, { [OWNER_ID]: OWNER });
  assert.deepEqual(t.map((r) => r.key), ['a:3', 'l:bbbb', 'a:1'], 'both logs, newest first');
  assert.equal(t[1].source, 'league_office'); assert.equal(t[1].app, 'seasons'); assert.equal(t[1].subject, 'season:S1'); assert.deepEqual(t[1].after, { a: 2 }); assert.equal(t[1].reason, 'edit');
  assert.equal(t[0].actorEmail, OWNER); assert.deepEqual(t[0].before.status, 'active'); assert.equal(t[0].reason, 'left');
  assert.equal(t[1].revert.possible, false); assert.match(t[1].revert.why, /League Office/);
  assert.equal(t[2].revert.possible, true);
  // a later row that says "Revert of audit #1" marks #1 as reverted
  const t2 = A.mergeTimeline([...admin, { id: 4, at: T(30), actor: OWNER_ID, actor_verified: true, product: 'ispyadc', subject_email: 'a@x.io', action: 'access.revoke', reason: 'Revert of audit #1', old_value: null, new_value: {}, via: 'x' }], [], {});
  assert.equal(t2.find((r) => r.key === 'a:1').revertedBy, 'a:4'); assert.equal(t2.find((r) => r.key === 'a:1').revert.possible, false);
  // equal timestamps keep a stable order
  assert.deepEqual(A.mergeTimeline([{ id: 5, at: T(0), action: 'x' }, { id: 6, at: T(0), action: 'x' }], [], {}).map((r) => r.key), ['a:6', 'a:5']);
  assert.equal(A.parseFilters({ source: 'nope' }).error, 'source must be admin or league_office');
  assert.match(A.parseFilters({ before: 'junk' }).error, /timestamp/);
  assert.equal(A.parseFilters({ actor: 'A(b)*%' }).actor, 'ab');
  assert.equal(A.settingOf({ action: 'app.setting', subject_email: '*', old_value: { code: 'WB', key: 'k', value: 1 }, new_value: { code: 'WB', key: 'k', value: 2 } }).key, 'k');
  assert.equal(A.revertKind({ action: 'consent.approve' }).ok, false);
  assert.equal(A.revertKind({ action: 'gate.arm' }).ok, false);
  assert.equal(A.revertKind({ action: 'something.new' }).ok, false, 'an unknown action is irreversible by default');
  assert.match(A.revertReason(7, 'oops'), /^Revert of audit #7: oops$/); assert.equal(A.revertReason(7, ''), 'Revert of audit #7');
  console.log('PASS  logic: merge order, markers, filters, an unknown action is irreversible, the revert reason names its row');
}

// ---- auth ----
{
  const r = await call({ method: 'GET', headers: {}, query: { route: 'audit' } });
  assert.equal(r.code, 404); assert.equal(JSON.stringify(r.body).includes('rows'), false);
  const p = await call({ method: 'POST', headers: {}, query: { route: 'audit' }, body: { id: 'a:1' } });
  assert.equal(p.code, 404);
  console.log('PASS  without an Owner session the timeline and the revert are a bare 404');
}

// ---- seed the history through the real functions (so every row has the real shape) ----
const jim = db.addPerson('jim@example.org'); db.addAccess(jim, 'ispyadc', 'tester', 'active');
await rpcAs('estate_access_set', { p_email: 'kim@example.org', p_product: 'ispyadc', p_role: 'tester', p_status: 'active', p_expires_at: null, p_note: null, p_reason: 'pilot' });
await rpcAs('estate_access_set', { p_email: 'kim@example.org', p_product: 'ispyadc', p_role: 'tester', p_status: 'revoked', p_expires_at: null, p_note: null, p_reason: 'left the pilot' });
db.addGate('predicts', false, ['mykemiller@gmail.com']);
await rpcAs('estate_audience_gate_set', { p_product: 'predicts', p_lifted: true, p_confirm: 'lift', p_reason: 'go' });
db.addApp('WB', 'Workbench', 2, 0); db.addDef('WB', 'cap', 'integer', 5, { min_value: 1, max_value: 50 });
await rpcAs('app_setting_set', { p_code: 'WB', p_key: 'cap', p_value: 9, p_reason: 'more' });
db.addPerson('pat@example.org');
await rpcAs('estate_person_set_persona', { p_email: 'pat@example.org', p_persona: 'MF-04', p_reason: 'fit' });
db.addRecipient('r@example.org');
await rpcAs('predicts_review_recipient', { p_email: 'r@example.org', p_decision: 'approve', p_actor: OWNER_ID });
db.audit.forEach((r, i) => { r.at = T(i); });                     // a known order
db.addLo('staff@x.io', 'seasons', 'season.save', { at: T(2.5), target_type: 'season', target_id: 'S-2026', before: { n: 1 }, after: { n: 2 }, reversible: true });
db.addLo('staff@x.io', 'comms', 'broadcast.send', { at: T(100) });

// ---- merge, shape, filters ----
{
  const r = await get();
  assert.equal(r.code, 200);
  const at = r.body.rows.map((x) => Date.parse(x.at));
  assert.deepEqual(at, at.slice().sort((a, b) => b - a), 'newest first across both logs');
  assert.ok(r.body.rows.some((x) => x.source === 'league_office') && r.body.rows.some((x) => x.source === 'admin'), 'both logs appear in one list');
  const rev = r.body.rows.find((x) => x.action === 'access.revoke');
  assert.equal(rev.reason, 'left the pilot'); assert.equal(rev.before.status, 'active'); assert.equal(rev.after.status, 'revoked');
  assert.equal(rev.actorEmail, OWNER, 'an actor id is shown with the email behind it');
  assert.equal(r.body.rows[0].action, 'broadcast.send', 'the newest row, from League Office, is first');
  console.log('PASS  one timeline: both logs, newest first, before / after / reason on every row');
}
{
  const by = async (q) => (await get(q)).body.rows;
  assert.ok((await by({ source: 'league_office' })).every((x) => x.source === 'league_office'));
  assert.ok((await by({ source: 'admin' })).every((x) => x.source === 'admin'));
  assert.deepEqual([...new Set((await by({ app: 'seasons' })).map((x) => x.app))], ['seasons']);
  assert.deepEqual([...new Set((await by({ app: 'ispyadc' })).map((x) => x.app))], ['ispyadc']);
  const kim = await by({ person: 'kim@' }); assert.equal(kim.length, 3, 'person.create + add + revoke'); assert.ok(kim.every((x) => x.subject === 'kim@example.org'));
  assert.equal((await by({ actor: OWNER })).filter((x) => x.source === 'admin').length > 0, true, 'by actor email, resolved to the person id');
  assert.ok((await by({ actor: OWNER_ID })).every((x) => x.actor === OWNER_ID));
  assert.deepEqual((await by({ actor: 'staff@' })).map((x) => x.source), ['league_office', 'league_office'], 'a League Office actor is the staff email');
  assert.deepEqual((await by({ actor: 'nobody@example.org' })), [], 'an address that is no one gives no rows, not all of them');
  const s = await by({ setting: 'cap' }); assert.equal(s.length, 1); assert.equal(s[0].setting, 'WB.cap'); assert.equal(s[0].after.value ?? s[0].after.cap, 9);
  assert.equal((await by({ setting: 'WB.cap' })).length, 1); assert.equal((await by({ setting: 'nope' })).length, 0);
  assert.equal((await get({ source: 'x' })).code, 400);
  console.log('PASS  filters: actor (email, id, staff), app, person, setting, source; an unknown actor matches nothing');
}
{
  const bulk = fakeDb(); globalThis.fetch = bulk.fetch;
  const o = bulk.addPerson(OWNER, { id: OWNER_ID }); bulk.addAccess(o, 'workbench', 'owner');
  for (let i = 0; i < 130; i++) bulk.audit.push({ id: 'r' + String(i).padStart(3, '0'), at: T(i), actor: 'system:x', actor_verified: true, product: 'estate', subject_email: 'p@x.io', action: 'person.seed', reason: null, old_value: null, new_value: null, via: 'x' });
  let r = await get(); assert.equal(r.body.rows.length, 100); assert.ok(r.body.next);
  const r2 = await get({ before: r.body.next }); assert.equal(r2.body.rows.length, 30); assert.equal(r2.body.next, null);
  assert.equal(new Set([...r.body.rows, ...r2.body.rows].map((x) => x.key)).size, 130, 'paging shows every row once');
  globalThis.fetch = db.fetch;
  console.log('PASS  paging: 100 per page, older rows by cursor, none repeated or skipped');
}
{
  db.noLo = true; const r = await get(); db.noLo = false;
  assert.equal(r.code, 200); assert.equal(r.body.sources.league_office, 'unavailable'); assert.ok(r.body.rows.length > 0);
  console.log('PASS  if League Office rows cannot be read, the console history still shows');
}

// ---- revert ----
const find = async (q) => (await get(q)).body.rows;
{
  const n0 = db.audit.length; const snapshot = JSON.stringify(db.audit);
  const revoke = (await find({ person: 'kim@' })).find((x) => x.action === 'access.revoke');
  const r = await post({ id: revoke.key, reason: 'came back' });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.changed, true);
  assert.equal(db.access.find((a) => a.product === 'ispyadc' && db.people.find((p) => p.id === a.person_id).email === 'kim@example.org').status, 'active', 'the access is back');
  assert.equal(db.audit.length, n0 + 1, 'exactly one new audit row');
  assert.equal(JSON.stringify(db.audit.slice(0, n0)), snapshot, 'history is never edited');
  const row = db.audit[db.audit.length - 1];
  assert.equal(row.action, 'access.restore'); assert.equal(row.actor, OWNER_ID); assert.equal(row.actor_verified, true);
  assert.equal(row.reason, `Revert of audit #${revoke.id}: came back`); assert.equal(row.via, 'workbench:console');
  const again = await post({ id: revoke.key });
  assert.equal(again.code, 409, 'the second revert of the same row is refused'); assert.match(again.body.error, /changed since/);
  assert.equal(db.audit.length, n0 + 1, 'a refusal writes nothing');
  assert.equal((await find({ person: 'kim@' })).find((x) => x.key === revoke.key).revertedBy !== null, true, 'the timeline marks the row reverted');
  console.log('PASS  revert of a revoke restores access with ONE new row; the second attempt and a refusal write nothing');
}
{
  const add = (await find({ person: 'kim@' })).find((x) => x.action === 'access.add');
  assert.equal(add.revert.possible, true);
  // kim was revoked then restored, so the state equals what the add left: reverting the add ends the access, the row stays
  const n1 = db.audit.length; const r1 = await post({ id: add.key });
  assert.equal(r1.code, 200); assert.equal(db.audit.length, n1 + 1); assert.equal(db.audit.at(-1).action, 'access.revoke'); assert.equal(db.audit.at(-1).new_value.status, 'revoked');
  // an add that something later changed is refused, not overwritten
  await rpcAs('estate_access_set', { p_email: 'lee@example.org', p_product: 'ispyadc', p_role: 'tester', p_status: 'active', p_expires_at: null, p_note: null, p_reason: 'new' });
  const addLee = (await find({ person: 'lee@' })).find((x) => x.action === 'access.add');
  await rpcAs('estate_access_set', { p_email: 'lee@example.org', p_product: 'ispyadc', p_role: 'viewer', p_status: 'active', p_expires_at: null, p_note: null, p_reason: 'changed role' });
  const n0 = db.audit.length; const r2 = await post({ id: addLee.key });
  assert.equal(r2.code, 409); assert.match(r2.body.error, /changed since/); assert.equal(db.audit.length, n0);
  console.log('PASS  revert of an add ends the access (the row stays); an add that something later changed is refused');
}
{
  const lift = (await find({ app: 'predicts' })).find((x) => x.action === 'gate.lift');
  const n0 = db.audit.length;
  const r = await post({ id: lift.key, reason: 'too soon' }, STALE());
  assert.equal(r.code, 200, 'arming narrows who is mailed: no step-up needed');
  assert.equal(db.gates[0].lifted, false); assert.equal(db.audit.length, n0 + 1); assert.equal(db.audit.at(-1).action, 'gate.arm');
  const arm = (await find({ app: 'predicts' })).find((x) => x.action === 'gate.arm');
  const r2 = await post({ id: arm.key });
  assert.equal(r2.code, 409); assert.match(r2.body.error, /deliberate|type lift/i, 'reverting an arm would lift the gate: refused');
  assert.equal(db.gates[0].lifted, false);
  console.log('PASS  revert of a lift arms the gate; reverting an arm (a lift) is refused, so a revert can never widen who is emailed');
}
{
  const s = (await find({ setting: 'cap' }))[0]; const n0 = db.audit.length;
  const r = await post({ id: s.key });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(db.vals.find((v) => v.key === 'cap').value, 5);
  assert.equal(db.audit.length, n0 + 1); assert.match(db.audit.at(-1).reason, /^Revert of audit #/);
  await rpcAs('app_setting_set', { p_code: 'WB', p_key: 'cap', p_value: 12, p_reason: 'again' });
  const stale = await post({ id: s.key });
  assert.equal(stale.code, 409); assert.equal(db.vals.find((v) => v.key === 'cap').value, 12, 'a later change is never overwritten by an older revert');
  console.log('PASS  revert of a setting restores the earlier value; a setting changed since is left alone');
}
{
  const p = (await find({ person: 'pat@' })).find((x) => x.action === 'person.persona');
  const r = await post({ id: p.key });
  assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(db.people.find((x) => x.email === 'pat@example.org').persona_preset, null);
  console.log('PASS  revert of a persona clears it');
}
{
  const n0 = db.audit.length; const refuse = async (key, re) => { const r = await post({ id: key }); assert.equal(r.code, 409, key); if (re) assert.match(r.body.error, re); };
  await refuse((await find({ app: 'predicts' })).find((x) => x.action === 'consent.approve').key, /decide again|review/i);
  await refuse((await find({ person: 'kim@' })).find((x) => x.action === 'person.create').key, /nothing to revert/i);
  const lo = (await find({ source: 'league_office' }))[0];
  const rl = await post({ id: lo.key }); assert.equal(rl.code, 409); assert.match(rl.body.error, /League Office/);
  assert.equal((await post({ id: 'a:does-not-exist' })).code, 404);
  assert.equal((await post({ id: 'junk' })).code, 400); assert.equal((await post({})).code, 400);
  assert.equal(db.audit.length, n0, 'every refusal leaves the history exactly as it was');
  console.log('PASS  refusals: review decisions, League Office rows, unknown and malformed ids, with nothing written');
}
{
  // restoring a console role is a console-role grant: it needs the fresh sign-in
  const w = db.addPerson('ops@example.org'); db.addAccess(w, 'workbench', 'owner', 'active');
  await rpcAs('estate_access_set', { p_email: 'ops@example.org', p_product: 'workbench', p_role: 'owner', p_status: 'revoked', p_expires_at: null, p_note: null, p_reason: 'rotate' });
  const rv = (await find({ person: 'ops@' })).find((x) => x.action === 'access.revoke'); const n0 = db.audit.length;
  const stale = await post({ id: rv.key }, STALE());
  assert.equal(stale.code, 403); assert.equal(stale.body.error, 'step_up_required'); assert.equal(db.audit.length, n0);
  const ok = await post({ id: rv.key }, H()); assert.equal(ok.code, 200); assert.equal(db.audit.length, n0 + 1);
  console.log('PASS  restoring a console role by revert needs the fresh sign-in, like a grant');
}
{
  db.failRpc = 'app_setting_set'; const cur = (await find({ setting: 'cap' })).find((x) => x.reason === 'again'); const n0 = db.audit.length;
  const r = await post({ id: cur.key }); db.failRpc = null;
  assert.equal(r.code, 502); assert.match(r.body.error, /Nothing was changed/); assert.equal(db.audit.length, n0);
  console.log('PASS  a failing write reports "nothing was changed" and writes no audit row');
}
console.log('ALL PASS  audit');
