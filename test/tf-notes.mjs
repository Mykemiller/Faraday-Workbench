// CC-TF-NOTES-OUTBOX-1.0 · ThoughtForge notes outbox. No network: Supabase and Linear are faked.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const T = require('../api/_tfnotes.js');
const { syncNote } = require('../api/_tfsync.js');
const O = require('../tf-outbox.js');

const ACCEPT = 'Web site Bios need to be LinkedIn or CV style, not voice or script prompts';
const CID = '7d3f5c2a-4b1e-4c8a-9f60-2a1b3c4d5e6f';
const baseRow = (over = {}) => ({ id: 1, slug: 'thought-forge', kind: 'note', body: ACCEPT, source: 'voice', client_id: CID,
  created_at: '2026-11-08T17:30:00Z', updated_at: '2026-11-08T17:30:00Z', attempts: 0, sync_status: 'pending_sync', linear_issue_id: null, ...over });

// ---------- payload builder ----------
assert.equal(T.buildTitle(ACCEPT), ACCEPT); // 75 chars, no sentence end: kept whole
assert.equal(T.buildTitle('Fix the bios. Then the headshots.'), 'Fix the bios.');
const long = 'word '.repeat(40);
assert.ok(T.buildTitle(long).length <= 80 && T.buildTitle(long).endsWith('…'));
assert.equal(T.priorityFor('note', ACCEPT), 0);
assert.equal(T.priorityFor('action', 'tidy'), 3);
assert.equal(T.priorityFor('note', 'this is URGENT'), 2);
assert.equal(T.priorityFor('action', 'high priority: x'), 2);
assert.equal(T.stateNameFor('note', false), 'Backlog');
assert.equal(T.stateNameFor('note', true), 'Triage');
assert.equal(T.stateNameFor('action', true), 'Todo');
assert.deepEqual(T.labelNamesFor('voice', 'model'), ['ThoughtForge Panel', 'thoughtforge-note', 'voice']);
assert.deepEqual(T.labelNamesFor('typed', 'template'), ['ThoughtForge Panel', 'thoughtforge-note', 'typed', 'prompt-regenerate']);
const desc = T.buildDescription(baseRow(), 'x ```sql\nselect 1\n``` y', 'model');
assert.ok(desc.includes(ACCEPT) && desc.includes('Source: voice') && desc.includes('Note ID: ' + CID));
assert.match(desc, /Saved: 11\/08\/2026, 11:30 CST/); // America/Chicago
assert.ok(!/```sql/.test(desc) && desc.includes('~~~sql')); // inner fences cannot break the block
const input = T.buildIssueInput({ teamId: 'team', stateId: 'st', labelIds: ['l1'] }, baseRow(), T.templatePrompt(baseRow()), 'template');
assert.deepEqual(Object.keys(input).sort(), ['description', 'labelIds', 'priority', 'stateId', 'teamId', 'title']);
const FixPrompt = require('../fix-prompt.js');
assert.ok(FixPrompt.issueHasPrompt(input.description, []), 'tile CC badge detects the prompt');
console.log('PASS  Linear payload builder');

// ---------- template fallback + 7-part check ----------
const tpl = T.templatePrompt(baseRow());
assert.ok(T.validatePrompt(tpl), 'template passes its own 7-part check');
assert.equal(T.validatePrompt('## Goal\nx'), false);
const outOfOrder = tpl.replace('## Goal', '## Goalx').concat('\n## Goal\nlate');
assert.equal(T.validatePrompt(outOfOrder), false, 'headings must be in order');
assert.ok(!tpl.includes('@'), 'no email address in the template');
const req = T.buildAnthropicRequest(baseRow());
assert.equal(req.model, 'claude-haiku-5-5'); assert.equal(req.max_tokens, 2000);
assert.ok(req.messages[0].content.includes(ACCEPT));
console.log('PASS  template fallback and 7-part validator');

// ---------- redaction ----------
const r = T.redact(new Error('bad lin_api_ABC123 sk-ant-api03-xyz Bearer abc.def me@example.com eyJa.eyJb.sig'));
assert.ok(!/ABC123|xyz|abc\.def|example\.com|eyJa/.test(r), r);
assert.ok(T.redact('x'.repeat(900)).length === 300);
console.log('PASS  redaction');

// ---------- state machine ----------
assert.equal(T.initialSyncStatus('thought-forge'), 'pending_sync');
assert.equal(T.initialSyncStatus('boundstone'), null);
assert.equal(T.failureStatus(1), 'linear_pending');
assert.equal(T.failureStatus(9), 'linear_pending');
assert.equal(T.failureStatus(10), 'failed');
assert.equal(T.isRetryable(baseRow()), true);
assert.equal(T.isRetryable(baseRow({ sync_status: 'failed' })), false);
assert.equal(T.isRetryable(baseRow({ linear_issue_id: 'x' })), false);
assert.equal(T.isRetryable(baseRow({ attempts: 10 })), false);
console.log('PASS  outbox state machine');

// ---------- syncNote with fakes: idempotency on retry ----------
function world() {
  const db = new Map(); const issues = []; let clock = 0; const calls = { create: 0, find: 0, generate: 0 };
  const put = (row) => { db.set(row.id, { ...row }); return db.get(row.id); };
  const deps = {
    dryRun: false,
    db: {
      async claim(row) { const cur = db.get(row.id);
        if (!cur || cur.updated_at !== row.updated_at || cur.linear_issue_id || !T.RETRYABLE.includes(cur.sync_status)) return null;
        return put({ ...cur, attempts: cur.attempts + 1, updated_at: 't' + (++clock) }); },
      async update(id, patch) { return put({ ...db.get(id), ...patch, updated_at: 't' + (++clock) }); }
    },
    async linear(q, v) {
      if (q.includes('TfTeam')) return { teams: { nodes: [{ id: 'team', states: { nodes: [{ id: 's-todo', name: 'Todo', type: 'unstarted' }, { id: 's-back', name: 'Backlog', type: 'backlog' }] } }] },
        issueLabels: { nodes: [{ id: 'l-tf', name: 'ThoughtForge Panel', team: null }, { id: 'l-voice', name: 'voice', team: { id: 'team' } }, { id: 'l-other', name: 'typed', team: { id: 'other-team' } }] } };
      if (q.includes('TfFind')) { calls.find++; return { issues: { nodes: issues.filter((i) => i.description.includes(v.marker)) } }; }
      if (q.includes('TfCreate')) { calls.create++; if (deps.failCreate) throw new Error('Linear 500 lin_api_SECRET'); const i = { id: 'i' + issues.length, identifier: 'TH-' + (100 + issues.length), url: 'u', description: v.input.description, input: v.input }; issues.push(i); return { issueCreate: { success: true, issue: i } }; }
      throw new Error('unexpected query');
    },
    async generate() { calls.generate++; if (deps.failGenerate) throw new Error('529 overloaded'); return T.templatePrompt(baseRow()).replace('Act on this', 'Model: act on this'); }
  };
  return { db, issues, calls, deps, put };
}

{ // happy path, model prompt, then a retry of the same row creates nothing
  const w = world(); const row = w.put(baseRow());
  const a = await syncNote(row, w.deps);
  assert.equal(a.status, 'synced'); assert.equal(w.issues.length, 1);
  assert.equal(a.note.linear_identifier, 'TH-100'); assert.equal(a.note.prompt_source, 'model');
  assert.equal(w.issues[0].input.stateId, 's-back'); assert.equal(w.issues[0].input.priority, 0);
  assert.deepEqual(w.issues[0].input.labelIds, ['l-tf', 'l-voice']); // label from another team skipped
  assert.deepEqual(a.missing_labels, ['thoughtforge-note']);
  const again = await syncNote(a.note, w.deps); // double-tap / reload
  assert.equal(again.status, 'synced'); assert.equal(w.issues.length, 1);
  const stale = await syncNote(row, w.deps); // a second worker holding the old row
  assert.equal(w.issues.length, 1, `stale worker must not create (${stale.status})`);
  console.log('PASS  one note → one issue; retries and stale workers create nothing');
}
{ // crash between Linear create and DB update: the Note ID search adopts the issue
  const w = world(); const row = w.put(baseRow());
  w.issues.push({ id: 'i-orphan', identifier: 'TH-77', url: 'u', description: 'x\n' + T.noteMarker(CID) });
  const a = await syncNote(row, w.deps);
  assert.equal(a.status, 'synced'); assert.equal(a.note.linear_identifier, 'TH-77'); assert.equal(w.calls.create, 0);
  console.log('PASS  crash recovery by Note ID search');
}
{ // Anthropic down: template prompt + prompt-regenerate label, still exactly one issue
  const w = world(); w.deps.failGenerate = true; const row = w.put(baseRow({ source: 'typed', kind: 'action' }));
  const a = await syncNote(row, w.deps);
  assert.equal(a.status, 'synced'); assert.equal(a.note.prompt_source, 'template');
  assert.equal(w.issues[0].input.stateId, 's-todo'); assert.equal(w.issues[0].input.priority, 3);
  assert.ok(a.missing_labels.includes('prompt-regenerate'));
  assert.match(w.issues[0].input.description, /prompt-regenerate/);
  console.log('PASS  Anthropic failure falls back to the template');
}
{ // Linear down: note stays saved, retries count up, failed after 10, error redacted
  const w = world(); w.deps.failCreate = true; let row = w.put(baseRow());
  for (let i = 1; i <= 10; i++) {
    const out = await syncNote(row, w.deps); row = out.note;
    assert.equal(row.attempts, i);
    assert.equal(out.status, i < 10 ? 'linear_pending' : 'failed');
    assert.ok(!row.last_error.includes('SECRET'));
  }
  const after = await syncNote(row, w.deps); assert.equal(after.status, 'failed'); assert.equal(w.issues.length, 0);
  assert.equal(w.db.get(1).body, ACCEPT, 'note body never lost');
  console.log('PASS  Linear failure keeps the note, retries 10 times, then failed');
}
{ // dry run: no Linear, no Anthropic, exact payloads returned
  const w = world(); w.deps.dryRun = true; w.deps.linear = () => { throw new Error('no linear in dry run'); }; w.deps.generate = () => { throw new Error('no anthropic in dry run'); };
  const a = await syncNote(w.put(baseRow()), w.deps);
  assert.equal(a.status, 'dry_run'); assert.equal(a.note.sync_status, 'dry_run');
  const vars = a.payloads.linear_issue_create.variables.input;
  assert.equal(vars.teamId, T.KNOWN.teamId); assert.equal(vars.stateId, T.KNOWN.states.Backlog); assert.equal(vars.title, ACCEPT);
  assert.equal(a.payloads.anthropic_messages_request.model, 'claude-haiku-5-5');
  console.log('PASS  dry run returns payloads and calls nothing');
}
{ // other tiles never sync
  const w = world(); const a = await syncNote(w.put(baseRow({ slug: 'boundstone', sync_status: null })), w.deps);
  assert.equal(a.status, 'not_synced_tile'); assert.equal(w.calls.create, 0);
}

// ---------- the save route: idempotent insert against a fake PostgREST ----------
{
  process.env.WORKBENCH_REFRESH_SECRET = 'k1'; process.env.FARADAY_SERVICE_ROLE_KEY = 'svc';
  delete process.env.LINEAR_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.TF_NOTES_DRY_RUN;
  const rows = []; let seq = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const m = init.method || 'GET';
    const json = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (!u.pathname.endsWith('/workbench_product_notes')) throw new Error('unexpected fetch ' + u);
    if (m === 'POST') { const b = JSON.parse(init.body);
      if (b.client_id && rows.some((r) => r.client_id === b.client_id)) return json([], 201);
      const row = { id: ++seq, status: 'open', attempts: 0, created_at: '2026-11-08T17:30:00Z', updated_at: 'u0', linear_issue_id: null, ...b }; rows.push(row); return json([row], 201); }
    if (m === 'GET') { const c = u.searchParams.get('client_id'); return json(rows.filter((r) => 'eq.' + r.client_id === c)); }
    throw new Error('unexpected ' + m);
  };
  const handler = require('../api/workbench-notes.js');
  const mkRes = () => { const r = { code: 0, body: null, setHeader() {}, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const reqBody = { slug: 'thought-forge', kind: 'note', body: ACCEPT, source: 'voice', client_id: CID };
  let res = mkRes(); await handler({ method: 'POST', headers: { 'x-workbench-key': 'wrong' }, body: reqBody }, res);
  assert.equal(res.code, 401); assert.equal(rows.length, 0);
  res = mkRes(); await handler({ method: 'POST', headers: { 'x-workbench-key': 'k1' }, body: reqBody }, res);
  assert.equal(res.code, 200); assert.equal(rows.length, 1); assert.equal(rows[0].sync_status, 'pending_sync'); assert.equal(rows[0].source, 'voice');
  assert.match(res.body.sync.error, /LINEAR_API_KEY/); // saved even though Linear is not configured
  res = mkRes(); await handler({ method: 'POST', headers: { 'x-workbench-key': 'k1' }, body: reqBody }, res);
  assert.equal(res.code, 200); assert.equal(res.body.duplicate, true); assert.equal(rows.length, 1); assert.equal(res.body.note.id, 1);
  res = mkRes(); await handler({ method: 'POST', headers: { 'x-workbench-key': 'k1' }, body: { ...reqBody, client_id: 'nope' } }, res);
  assert.equal(res.code, 400);
  res = mkRes(); await handler({ method: 'POST', headers: { 'x-workbench-key': 'k1' }, body: { slug: 'boundstone', kind: 'note', body: 'x' } }, res);
  assert.equal(res.code, 200); assert.equal(rows[1].sync_status, null); assert.equal(res.body.sync, null);
  console.log('PASS  save route: 401 writes nothing, 200 after commit, same client_id never duplicates');
}

// ---------- browser outbox: the key-rejection path keeps the draft ----------
{
  const mem = {}; const ls = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const d1 = O.saveDraft(ls, 'thought-forge', { body: ACCEPT, source: 'voice' });
  assert.ok(T.isUuid(d1.client_id));
  const out401 = O.interpretSave(401, { error: 'Unauthorized' });
  assert.equal(out401.clear, false); assert.equal(out401.needKey, true);
  if (!out401.clear) { /* panel keeps the draft */ }
  assert.equal(O.loadDraft(ls, 'thought-forge').body, ACCEPT);
  const d2 = O.saveDraft(ls, 'thought-forge', { body: ACCEPT + '!' });
  assert.equal(d2.client_id, d1.client_id, 'retry after re-key is the same note');
  assert.equal(O.interpretSave(502, { error: 'down' }).clear, false);
  assert.equal(O.interpretSave(200, { ok: true, note: { linear_identifier: 'TH-70' }, sync: { status: 'synced' } }).message, 'Saved · TH-70 created.');
  O.clearDraft(ls, 'thought-forge'); assert.equal(O.loadDraft(ls, 'thought-forge'), null);
  assert.notEqual(O.saveDraft(ls, 'thought-forge', { body: 'next' }).client_id, d1.client_id, 'a new note gets a new id');
  assert.equal(O.appendDictation('Web site', ' bios '), 'Web site bios');
  assert.equal(O.speechCtor({}), null);
  assert.equal(O.syncChip({ sync_status: 'failed', last_error: 'x' }).cls, 'bad');
  console.log('PASS  key rejection keeps the draft; client_id survives until a 200');
}
console.log('tf-notes: ok');
