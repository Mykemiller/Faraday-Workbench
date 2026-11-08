// @ts-check
/* CC-TF-NOTES-OUTBOX-1.0 · the outbox worker: one saved note → exactly one TH issue.
 *
 * syncNote() is written against injected deps so the tests can drive it with fakes:
 *   deps.db.claim(row)          optimistic lock: bumps attempts + updated_at only if updated_at is unchanged
 *   deps.db.update(id, patch)   plain update, returns the row
 *   deps.linear(query, vars)    one GraphQL call, returns `data`, throws on errors
 *   deps.generate(request)      one Messages API call, returns the prompt text, throws on failure
 *   deps.dryRun                 true → no Linear and no Anthropic calls; payloads are returned
 *
 * Duplicate protection, in order:
 *   1. a row that already has linear_issue_id is never sent again
 *   2. the claim is a compare-and-swap on updated_at, so two workers cannot hold one row
 *   3. before creating, Linear is searched for "Note ID: <uuid>"; a hit is adopted, not re-created
 */
'use strict';

const T = require('./_tfnotes.js');

const Q_TEAM = `query TfTeam($key: String!, $labels: [String!]) {
  teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id name type } } } }
  issueLabels(first: 100, filter: { name: { in: $labels } }) { nodes { id name team { id } } }
}`;
const Q_FIND = `query TfFind($teamId: ID!, $marker: String!) {
  issues(first: 1, includeArchived: true, filter: { team: { id: { eq: $teamId } }, description: { contains: $marker } }) {
    nodes { id identifier url }
  }
}`;
const M_CREATE = `mutation TfCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

/** Resolve team, state and label ids by name. Labels that do not exist are skipped and reported. */
async function resolveIds(linear, note, promptSource) {
  const names = T.labelNamesFor(note.source, promptSource);
  const d = await linear(Q_TEAM, { key: T.TEAM_KEY, labels: names });
  const team = d && d.teams && d.teams.nodes && d.teams.nodes[0];
  if (!team) throw new Error(`Linear team ${T.TEAM_KEY} not found`);
  const states = team.states.nodes;
  const hasTriage = states.some((s) => s.type === 'triage');
  const wanted = T.stateNameFor(note.kind, hasTriage);
  const state = states.find((s) => s.name === wanted) || states.find((s) => s.type === (note.kind === 'action' ? 'unstarted' : 'backlog'));
  if (!state) throw new Error(`Linear state ${wanted} not found on ${T.TEAM_KEY}`);
  const usable = (d.issueLabels.nodes || []).filter((l) => !l.team || l.team.id === team.id);
  const labelIds = [];
  const missing = [];
  for (const n of names) {
    const hit = usable.find((l) => l.name === n);
    if (hit) labelIds.push(hit.id); else missing.push(n);
  }
  return { teamId: team.id, stateId: state.id, stateName: state.name, labelIds, missingLabels: missing };
}

/** Prompt from the model if it validates, else the template. Never throws. */
async function makePrompt(deps, note) {
  try {
    const text = await deps.generate(T.buildAnthropicRequest(note));
    if (T.validatePrompt(text)) return { prompt: String(text).trim(), promptSource: /** @type {'model'} */ ('model'), promptError: null };
    return { prompt: T.templatePrompt(note), promptSource: /** @type {'template'} */ ('template'), promptError: 'generated prompt failed the 7-part check' };
  } catch (e) {
    return { prompt: T.templatePrompt(note), promptSource: /** @type {'template'} */ ('template'), promptError: T.redact(e) };
  }
}

/**
 * @param {any} row  a workbench_product_notes row (needs id, client_id, kind, body, source, created_at, updated_at, attempts, sync_status)
 * @param {any} deps
 * @returns {Promise<{status:string, note?:any, error?:string, payloads?:any, missing_labels?:string[]}>}
 */
async function syncNote(row, deps) {
  if (!row || row.slug !== T.TF_SLUG) return { status: 'not_synced_tile', note: row };
  if (row.linear_issue_id) return { status: T.SYNC.SYNCED, note: row };
  if (row.sync_status === T.SYNC.FAILED) return { status: T.SYNC.FAILED, note: row };

  if (deps.dryRun) {
    const prompt = T.templatePrompt(row);
    const ids = {
      teamId: T.KNOWN.teamId,
      stateId: T.KNOWN.states[T.stateNameFor(row.kind, false)],
      labelIds: T.labelNamesFor(row.source, 'model').map((n) => T.KNOWN.labels[n] || `<label id for "${n}">`)
    };
    const note = await deps.db.update(row.id, { sync_status: T.SYNC.DRY_RUN, last_error: null });
    return {
      status: T.SYNC.DRY_RUN, note,
      payloads: {
        anthropic_messages_request: T.buildAnthropicRequest(row),
        linear_find_existing: { query: Q_FIND, variables: { teamId: ids.teamId, marker: T.noteMarker(row.client_id) } },
        linear_issue_create: { query: M_CREATE, variables: { input: T.buildIssueInput(ids, row, prompt, 'template') } },
        note_on_prompt: 'Dry run shows the template prompt; a live run uses the model prompt when it passes the 7-part check.'
      }
    };
  }

  const claimed = await deps.db.claim(row);
  if (!claimed) return { status: 'busy', note: row };

  try {
    const ids0 = await resolveIds(deps.linear, claimed, 'model');
    const found = await deps.linear(Q_FIND, { teamId: ids0.teamId, marker: T.noteMarker(claimed.client_id) });
    const existing = found && found.issues && found.issues.nodes && found.issues.nodes[0];
    if (existing) {
      const note = await deps.db.update(claimed.id, {
        sync_status: T.SYNC.SYNCED, linear_issue_id: existing.id, linear_identifier: existing.identifier,
        linear_url: existing.url, last_error: null
      });
      return { status: T.SYNC.SYNCED, note };
    }

    const { prompt, promptSource, promptError } = await makePrompt(deps, claimed);
    const ids = promptSource === 'model' ? ids0 : await resolveIds(deps.linear, claimed, promptSource);
    const input = T.buildIssueInput(ids, claimed, prompt, promptSource);
    const created = await deps.linear(M_CREATE, { input });
    const issue = created && created.issueCreate && created.issueCreate.success && created.issueCreate.issue;
    if (!issue) throw new Error('Linear issueCreate returned success=false');

    const note = await deps.db.update(claimed.id, {
      sync_status: T.SYNC.SYNCED, linear_issue_id: issue.id, linear_identifier: issue.identifier,
      linear_url: issue.url, prompt_source: promptSource, last_error: promptError ? `prompt: ${promptError}` : null
    });
    return { status: T.SYNC.SYNCED, note, missing_labels: ids.missingLabels };
  } catch (e) {
    const status = T.failureStatus(claimed.attempts);
    const error = T.redact(e);
    const note = await deps.db.update(claimed.id, { sync_status: status, last_error: error }).catch(() => claimed);
    return { status, note, error };
  }
}

/* ---------- real deps ---------- */

const { sb, faradayServiceKey } = require('./_wb.js');

const COLS = 'id,slug,kind,body,status,created_at,done_at,client_id,source,sync_status,attempts,last_error,linear_issue_id,linear_identifier,linear_url,prompt_source,updated_at';

function makeDb(serviceKey) {
  async function patch(filter, body) {
    const r = await sb(`/rest/v1/workbench_product_notes?${filter}&select=${COLS}`, serviceKey, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body)
    });
    const rows = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`notes update HTTP ${r.status}`);
    return Array.isArray(rows) ? rows : [];
  }
  return {
    async claim(row) {
      const rows = await patch(
        `id=eq.${Number(row.id)}&updated_at=eq.${encodeURIComponent(row.updated_at)}&linear_issue_id=is.null&sync_status=in.(${T.RETRYABLE.join(',')})`,
        { attempts: (row.attempts || 0) + 1 });
      return rows[0] || null;
    },
    async update(id, body) {
      const rows = await patch(`id=eq.${Number(id)}`, body);
      return rows[0] || null;
    },
    async pending(olderThanSeconds, limit) {
      const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString();
      const r = await sb(`/rest/v1/workbench_product_notes?select=${COLS}&slug=eq.${T.TF_SLUG}`
        + `&sync_status=in.(${T.RETRYABLE.join(',')})&linear_issue_id=is.null&attempts=lt.${T.MAX_ATTEMPTS}`
        + `&updated_at=lt.${encodeURIComponent(cutoff)}&order=created_at.asc&limit=${limit}`, serviceKey, { method: 'GET' });
      const rows = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`notes read HTTP ${r.status}`);
      return Array.isArray(rows) ? rows : [];
    }
  };
}

function makeLinear(apiKey) {
  return async function linear(query, variables) {
    const r = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables })
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.errors) {
      const msg = j && j.errors && j.errors[0] && j.errors[0].message;
      throw new Error(`Linear ${r.status}${msg ? ': ' + msg : ''}`);
    }
    return j.data;
  };
}

function makeGenerate(apiKey) {
  let client = null;
  return async function generate(request) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    if (!client) {
      const mod = require('@anthropic-ai/sdk');
      const Anthropic = mod.Anthropic || mod.default || mod;
      client = new Anthropic({ apiKey, maxRetries: 1, timeout: 25_000 });
    }
    const msg = await client.messages.create(request);
    if (msg.stop_reason === 'refusal') throw new Error('model refused');
    if (msg.stop_reason === 'max_tokens') throw new Error('prompt hit max_tokens');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('empty model response');
    return text;
  };
}

/** Real deps from the environment. Returns { deps } or { error } naming the missing variable. */
function depsFromEnv(env) {
  const dryRun = env.TF_NOTES_DRY_RUN === '1';
  const serviceKey = faradayServiceKey();
  if (!serviceKey) return { error: 'FARADAY_SERVICE_ROLE_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is not set on this deployment.' };
  const db = makeDb(serviceKey);
  if (dryRun) return { deps: { db, dryRun: true, linear: null, generate: null } };
  if (!env.LINEAR_API_KEY) return { deps: null, db, error: 'LINEAR_API_KEY is not set on this deployment.' };
  return { deps: { db, dryRun: false, linear: makeLinear(env.LINEAR_API_KEY), generate: makeGenerate(env.ANTHROPIC_API_KEY) } };
}

module.exports = { syncNote, resolveIds, makePrompt, depsFromEnv, makeDb, Q_TEAM, Q_FIND, M_CREATE, COLS };
