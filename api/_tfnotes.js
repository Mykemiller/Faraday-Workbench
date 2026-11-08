// @ts-check
/* CC-TF-NOTES-OUTBOX-1.0 · pure helpers for ThoughtForge Panel notes → Linear (TH).
 *
 * No I/O here. Everything in this file is deterministic so test/tf-notes.mjs can cover it:
 * the Linear payload builder, the template prompt, the 7-part validator, redaction, and the
 * outbox state transitions. The I/O lives in api/_tfsync.js.
 */
'use strict';

/** Tile whose notes create TH issues. Other tiles keep the old save-only behaviour. */
const TF_SLUG = 'thought-forge';
const TEAM_KEY = 'TH';
const MAX_ATTEMPTS = 10;
const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 2000;
const TITLE_MAX = 80;

/* Ids read from Linear in Phase A (2026-11-08). Live runs re-resolve them by name every time;
 * these are used only to make dry-run payloads exact. Ids, not secrets. */
const KNOWN = {
  teamId: '2dbd7e1d-ec03-4f56-8125-1b10b104eddd',
  states: { Todo: 'c87a1e9a-140f-4b51-83b6-07c8723b8b5f', Backlog: 'c2f63e58-896e-4562-ade1-980f5c5ae229' },
  labels: { 'ThoughtForge Panel': '2dd4e9c3-2be9-4934-b9b7-18405eff0d00' }
};

/** The 7 parts every generated prompt must carry, in order. */
const SEVEN_PARTS = ['Goal', 'Done When', 'Context', 'Autonomy', 'Quality', 'Boundaries', 'Report'];

const SYNC = Object.freeze({
  PENDING: 'pending_sync', LINEAR_PENDING: 'linear_pending', SYNCED: 'synced', FAILED: 'failed', DRY_RUN: 'dry_run'
});
/** States a retry worker may pick up. `failed` needs a human to reset it to linear_pending. */
const RETRYABLE = [SYNC.PENDING, SYNC.LINEAR_PENDING];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** @param {unknown} v */
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** @param {Date|string|number} d */
function chicagoStamp(d) {
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short'
  });
}

/** First sentence of the note, whitespace collapsed, at most 80 characters.
 * @param {string} body */
function buildTitle(body) {
  const flat = String(body || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'ThoughtForge note';
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  let first = (m ? m[1] : flat).trim();
  if (first.length > TITLE_MAX) first = first.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '').trimEnd() + '…';
  return first.length ? first : flat.slice(0, TITLE_MAX);
}

/** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
 * @param {string} kind @param {string} body */
function priorityFor(kind, body) {
  if (/\burgent\b|\bhigh[\s-]priority\b/i.test(String(body || ''))) return 2;
  return kind === 'action' ? 3 : 0;
}

/** Workflow state name. Notes use Triage when the team has one, else Backlog.
 * @param {string} kind @param {boolean} hasTriage */
function stateNameFor(kind, hasTriage) {
  if (kind === 'action') return 'Todo';
  return hasTriage ? 'Triage' : 'Backlog';
}

/** @param {string} source @param {string} promptSource */
function labelNamesFor(source, promptSource) {
  const out = ['ThoughtForge Panel', 'thoughtforge-note', source === 'voice' ? 'voice' : 'typed'];
  if (promptSource === 'template') out.push('prompt-regenerate');
  return out;
}

/* ---------- prompt ---------- */

const SYSTEM_PROMPT = [
  'You turn a short note from the founder of Faraday into a self-contained Claude Code prompt.',
  'The prompt will be read by a coding agent that has none of this context. It is stored in a Linear issue and is never run automatically.',
  '',
  'Output only the prompt, in Markdown, with exactly these seven second-level headings in this order:',
  '## Goal',
  '## Done When',
  '## Context',
  '## Autonomy',
  '## Quality',
  '## Boundaries',
  '## Report',
  '',
  'Rules:',
  '- Goal: one or two sentences on the outcome.',
  '- Done When: a numbered list of checkable conditions.',
  '- Context: what the agent needs to know. Say plainly what you do not know (repository, file, owner) and tell the agent to find it first. Never invent file paths, table names, ticket numbers or URLs.',
  '- Autonomy: Phase A is read-only diagnosis that ends with a report and a STOP for an explicit GO. Phase B runs only after GO and never deploys to production, merges, or changes production settings.',
  '- Quality: require idempotent changes, a dry run before any live write, and a snapshot of any data the change touches before it is modified.',
  '- Boundaries: work on a branch and open a pull request; never commit to main; never write secrets, keys or personal email addresses anywhere. Pricing, taxonomy, subscriber-facing copy, production architecture and production deploys are always a human decision.',
  '- Report: a structured report that ends with a "Myke actions" section listing what Myke must decide or do.',
  '- Keep the note\'s intent exactly. Do not add scope the note does not ask for.',
  '- Plain, short sentences. No preamble, no closing remarks, no code fences around the whole prompt.'
].join('\n');

/** @param {{body:string, kind:string, source:string}} note */
function buildUserMessage(note) {
  return [
    `Kind: ${note.kind === 'action' ? 'action item' : 'note'}`,
    `Entered by: ${note.source === 'voice' ? 'voice dictation (expect transcription errors)' : 'typing'}`,
    'Product: ThoughtForge Panel (Faraday Workbench, Estate tile)',
    '',
    'Note (verbatim):',
    '<note>',
    String(note.body || ''),
    '</note>'
  ].join('\n');
}

/** Exact Messages API request body (also returned verbatim by the dry run).
 * Thinking is off: this is short, formulaic text and thinking tokens would count against max_tokens.
 * @param {{body:string, kind:string, source:string}} note */
function buildAnthropicRequest(note) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(note) }]
  };
}

/** True when the text carries all seven headings in order plus the Myke actions section.
 * @param {string} text */
function validatePrompt(text) {
  const t = String(text || '');
  if (t.length < 300) return false;
  let at = -1;
  for (const part of SEVEN_PARTS) {
    const re = new RegExp('^#{1,3}\\s*' + part.replace(/ /g, '\\s+') + '\\b', 'im');
    const m = re.exec(t.slice(at + 1));
    if (!m) return false;
    at = at + 1 + m.index;
  }
  return /myke actions/i.test(t);
}

/** Fallback prompt built from the note when the API is unavailable or returns something invalid.
 * @param {{body:string, kind:string, source:string, client_id:string}} note */
function templatePrompt(note) {
  const body = String(note.body || '').trim();
  const isAction = note.kind === 'action';
  return [
    '## Goal',
    `Act on this ThoughtForge Panel ${isAction ? 'action item' : 'note'}: "${body}"`,
    '',
    '## Done When',
    '1. The request in the note is understood and restated in one sentence in the report.',
    '2. The code, data or content that the note refers to has been located, with file paths.',
    '3. A change plan is approved by Myke, then made on a branch with a pull request.',
    '4. Nothing is deployed to production.',
    '',
    '## Context',
    '- Source: a note saved from the ThoughtForge Panel tile on the Faraday Workbench (faraday-stuff.com).',
    `- Entered by ${note.source === 'voice' ? 'voice dictation, so some words may be mis-transcribed' : 'typing'}.`,
    `- Note ID: ${note.client_id}`,
    '- This prompt was built from a template because the prompt generator was unavailable. The repository and files involved are not known yet; find them first and do not guess.',
    '',
    '## Autonomy',
    'Phase A (read-only): find what the note refers to, describe the current state with file paths, and propose a plan. Then STOP and wait for Myke to reply GO.',
    'Phase B (only after GO): make the change on a branch, add tests, open a draft pull request. Do not merge, deploy to production, or change production settings.',
    '',
    '## Quality',
    '- Every change is idempotent and covered by a test where code is involved.',
    '- Run a dry run before any live write.',
    '- Snapshot any data before it is modified and record row counts.',
    '',
    '## Boundaries',
    '- Work on a branch; never commit to main.',
    '- Never write secrets, keys or personal email addresses into code, logs, issues or prompts.',
    '- Pricing, taxonomy, subscriber-facing copy, production architecture and production deploys are Myke\'s decision.',
    '',
    '## Report',
    '1. What the note asks for, in one sentence.',
    '2. Phase A findings with file paths.',
    '3. The plan, and after Phase B the pull request URL and test results.',
    '4. Myke actions: the decisions and steps Myke must take, including an explicit request for GO.'
  ].join('\n');
}

/* ---------- Linear payload ---------- */

/** A fenced block must not contain its own fence: inner ``` becomes ~~~ so the issue renders
 * as one block and fix-prompt.js still detects a Claude Code prompt.
 * @param {string} text */
const fenceSafe = (text) => String(text || '').replace(/```/g, '~~~');

/** @param {string} text */
const verbatimBlock = (text) => '```text\n' + fenceSafe(text) + '\n```';

/**
 * @param {{body:string, kind:string, source:string, client_id:string, created_at:string}} note
 * @param {string} prompt @param {'model'|'template'} promptSource
 */
function buildDescription(note, prompt, promptSource) {
  return [
    `**${note.kind === 'action' ? 'Action item' : 'Note'} from the ThoughtForge Panel.**`,
    '',
    '### Note (verbatim)',
    verbatimBlock(note.body),
    '',
    `- Source: ${note.source === 'voice' ? 'voice' : 'typed'}`,
    `- Saved: ${chicagoStamp(note.created_at)}`,
    `- Note ID: ${note.client_id}`,
    '',
    '### Claude Code prompt',
    promptSource === 'template'
      ? '_Built from the template because the prompt generator was unavailable. Labelled `prompt-regenerate`._'
      : '_Generated from the note. Review before running; it is never run automatically._',
    '',
    '```markdown\n' + fenceSafe(prompt) + '\n```'
  ].join('\n');
}

/**
 * @param {{teamId:string, stateId:string, labelIds:string[]}} ids
 * @param {{body:string, kind:string, source:string, client_id:string, created_at:string}} note
 * @param {string} prompt @param {'model'|'template'} promptSource
 */
function buildIssueInput(ids, note, prompt, promptSource) {
  /** @type {Record<string, unknown>} */
  const input = {
    teamId: ids.teamId,
    title: buildTitle(note.body),
    description: buildDescription(note, prompt, promptSource),
    stateId: ids.stateId,
    priority: priorityFor(note.kind, note.body)
  };
  if (ids.labelIds && ids.labelIds.length) input.labelIds = ids.labelIds;
  return input;
}

/** The search marker that lets a crash between the Linear create and the DB update be recovered.
 * @param {string} clientId */
const noteMarker = (clientId) => `Note ID: ${clientId}`;

/* ---------- state machine ---------- */

/** Status after a failed attempt. `attempts` is the count INCLUDING the one that just failed.
 * @param {number} attempts */
function failureStatus(attempts) {
  return attempts >= MAX_ATTEMPTS ? SYNC.FAILED : SYNC.LINEAR_PENDING;
}

/** Status a fresh row starts in. @param {string} slug */
function initialSyncStatus(slug) {
  return slug === TF_SLUG ? SYNC.PENDING : null;
}

/** @param {{sync_status?:string|null, linear_issue_id?:string|null, attempts?:number}} row */
function isRetryable(row) {
  return !!row && RETRYABLE.includes(String(row.sync_status)) && !row.linear_issue_id && (row.attempts || 0) < MAX_ATTEMPTS;
}

/* ---------- redaction ---------- */

/** Strip anything key-shaped or address-shaped, cap the length. Used for every stored/logged error.
 * @param {unknown} err */
function redact(err) {
  const raw = err && typeof err === 'object' && 'message' in err ? String(/** @type {any} */ (err).message) : String(err);
  return raw
    .replace(/lin_(api|oauth)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/(Bearer|Basic)\s+[^\s"']+/gi, '$1 [redacted]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .slice(0, 300);
}

module.exports = {
  TF_SLUG, TEAM_KEY, MAX_ATTEMPTS, MODEL, MAX_TOKENS, KNOWN, SEVEN_PARTS, SYNC, RETRYABLE,
  isUuid, chicagoStamp, buildTitle, priorityFor, stateNameFor, labelNamesFor,
  SYSTEM_PROMPT, buildUserMessage, buildAnthropicRequest, validatePrompt, templatePrompt,
  buildDescription, buildIssueInput, noteMarker, failureStatus, initialSyncStatus, isRetryable, redact
};
