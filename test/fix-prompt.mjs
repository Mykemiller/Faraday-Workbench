// CC-WORKBENCH-FIX-THESE-1.0 · prompt detection, orchestrator text, and API paging (no network).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const F = require('../fix-prompt.js');
const big = 'step '.repeat(80);
const withPrompt = 'Claude Code prompt (copy/paste)\n\n```\n' + big + '\n```';

// detection
assert.equal(F.hasClaudePrompt(withPrompt), true);
assert.equal(F.hasClaudePrompt('Claude Code will do this.'), false);
assert.equal(F.hasClaudePrompt('Claude Code\n```\nshort\n```'), false);
assert.equal(F.hasClaudePrompt('```\n' + big + '\n```'), false); // fenced but no Claude Code marker
assert.equal(F.issueHasPrompt('plain', ['x', withPrompt]), true);
assert.equal(F.issueHasPrompt('plain', ['x']), false);

// orchestrator prompt: priority order, prompt-less issues omitted, hard rules present
const txt = F.buildFixPrompt({ name: 'Estate Security', linear_label: 'Estate Security' }, [
  { identifier: 'FDY-211', title: 'c', priority: 4, state: 'Backlog', has_prompt: true },
  { identifier: 'FDY-205', title: 'a', priority: 1, state: 'Backlog', has_prompt: true },
  { identifier: 'FDY-68', title: 'n', priority: 3, state: 'In Progress', has_prompt: false },
  { identifier: 'FDY-210', title: 'b', priority: 2, state: 'Backlog', has_prompt: true }
], '11/05/26 20:50 CT');
const order = [...txt.matchAll(/^\d+\. (FDY-\d+)/gm)].map((m) => m[1]).join(',');
assert.equal(order, 'FDY-205,FDY-210,FDY-211');
assert.ok(!txt.includes('FDY-68 ·'));
for (const must of ['NEVER merge', 'decoy xgbpmlkanxewtfizloay', 'RECOMMENDED', 'US Central Time', 'ORCHESTRATOR']) assert.ok(txt.includes(must), must);

// API: pages through results and flags has_prompt without returning the text
process.env.LINEAR_API_KEY = 'k'; process.env.WORKBENCH_REFRESH_SECRET = 's';
const handler = require('../api/workbench-linear.js');
const node = (id, pr, desc, comments = []) => ({ identifier: id, title: id, url: 'u', priority: pr, priorityLabel: 'x', updatedAt: '2026-11-05', description: desc,
  state: { name: 'Backlog', type: 'backlog' }, assignee: null, labels: { nodes: [{ name: 'L' }] }, comments: { nodes: comments.map((body) => ({ body })) } });
const pages = [
  { nodes: [node('A-1', 3, 'no'), node('A-2', 1, withPrompt)], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
  { nodes: [node('A-3', 2, 'no', [withPrompt])], pageInfo: { hasNextPage: false, endCursor: null } }
];
let call = 0;
global.fetch = async (_u, init) => { const v = JSON.parse(init.body).variables; assert.equal(v.after, call ? 'c1' : null); return { ok: true, status: 200, json: async () => ({ data: { issues: pages[call++] } }) }; };
let out;
const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { out = b; return this; } };
await handler({ method: 'GET', url: '/api/workbench-linear?label=Estate%20Security', headers: { 'x-workbench-key': 's' } }, res);
assert.equal(res.code, 200); assert.equal(call, 2);
assert.deepEqual(out.issues.map((i) => i.identifier), ['A-2', 'A-3', 'A-1']);
assert.deepEqual(out.issues.map((i) => i.has_prompt), [true, true, false]);
assert.equal(out.prompt_count, 2);
assert.ok(!JSON.stringify(out).includes('step step'));
console.log('fix-prompt: ok');
