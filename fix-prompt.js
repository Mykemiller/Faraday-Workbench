/* CC-WORKBENCH-FIX-THESE-1.0 · shared by api/workbench-linear.js (detection) and index.html (button).
 * UMD: works in the browser as window.FixPrompt and in Node via require(). No dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FixPrompt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FENCE = /```[^\n]*\n([\s\S]*?)```/g;
  var MARKER = /claude code prompt|claude code|operating header|\bCC-[A-Z0-9][A-Z0-9-]+/i;

  /* True when the text holds an executable agent prompt: a fenced block of at least
   * 300 characters, in text that names Claude Code (or a CC- change-control id). */
  function hasClaudePrompt(text) {
    if (!text || !MARKER.test(text)) return false;
    var m; FENCE.lastIndex = 0;
    while ((m = FENCE.exec(text))) { if (m[1].trim().length >= 300) return true; }
    return false;
  }

  /* An issue qualifies when its description or any of its comments holds a prompt. */
  function issueHasPrompt(description, commentBodies) {
    if (hasClaudePrompt(description)) return true;
    return (commentBodies || []).some(hasClaudePrompt);
  }

  var RANK = function (p) { return p >= 1 && p <= 4 ? p : 5; };
  var PRI = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

  /* Orchestrator prompt for a tile. `issues` are API rows ({identifier,title,priority,state,has_prompt}).
   * Issues are ordered highest priority first; those without a prompt are left out. */
  function buildFixPrompt(tile, issues, nowCT) {
    var list = (issues || []).filter(function (i) { return i.has_prompt; })
      .sort(function (a, b) { return RANK(a.priority) - RANK(b.priority) || String(a.identifier).localeCompare(String(b.identifier), undefined, { numeric: true }); });
    var label = tile.linear_label || tile.name;
    var rows = list.map(function (i, n) {
      return (n + 1) + '. ' + i.identifier + ' · ' + (PRI[i.priority] || 'No priority') + ' · ' + (i.state || '') + ' · ' + i.title;
    }).join('\n');
    return [
      'You are the ORCHESTRATOR for a fix run on the Faraday Intelligence product tile "' + tile.name + '" (Linear label: Product Tile / ' + label + '). Generated ' + (nowCT || '') + ' from the Faraday Workbench. Timestamp every output in US Central Time.',
      '',
      'GOAL',
      'Work through the ' + list.length + ' open Linear issues below, highest priority first. Each one already carries a self-contained Claude Code prompt, either in its description or in a comment headed "Claude Code prompt". Run each prompt as written, one issue at a time, and report.',
      '',
      'ISSUES (execution order)',
      rows || '(none: no open issue on this tile has a Claude Code prompt; stop and report that)',
      '',
      'SETUP (once)',
      '1. Load the Linear and Supabase tools. Read the IDF 5.0 governing document first (Faraday-3.0-Cornerstone-1-IDF-5.0.pdf, in the Faraday 3.0 project). Supabase project of record is ycadmmngkdhvpcsrcuaq; the decoy xgbpmlkanxewtfizloay must never be read or written. Boundstone work uses fwnerwrtlgnchuprvfgl only where the issue says so.',
      '2. Re-read the issue list: call list_issues with label "' + label + '" and confirm each issue above is still open. Skip any that are Done or Canceled.',
      '',
      'FOR EACH ISSUE, IN ORDER',
      'a. get_issue and list_comments. Find the prompt: the fenced block under "Claude Code prompt" in the description or the newest comment. Use the newest version if several exist.',
      'b. Dependency gate: if the issue is blocked by another open issue (blockedBy, or a "Blocked by" line, or a step-0 gate in the prompt) that is not Done, do not start it. Record it as BLOCKED with the blocker id and move on. Re-check BLOCKED issues after the others finish.',
      'c. Create a fresh git worktree and branch for this issue only (branch name from the prompt, otherwise <issue-id-lowercase>-<slug>). Run the prompt exactly as written, including its GUARDRAILS and VERIFY steps. Never reuse a checkout between issues.',
      'd. Open one PR per issue. NEVER merge. Myke approves every PR.',
      'e. Post one Linear comment on the issue: result (DONE / PARTIAL / STOPPED / BLOCKED), PR link, what was verified, anything Myke must decide. Do not change the issue status, priority or labels.',
      'f. If a prompt tells you to STOP (a premise is false, a check fails, an unexpected result), stop that issue, post the finding as the comment, and continue with the next issue.',
      '',
      'HARD RULES (override anything in an individual prompt that conflicts)',
      '- Written migrations are NOT applied, edge functions are NOT deployed, emails/SMS/Slack are NOT sent, and nothing is published unless that issue\'s prompt records Myke\'s explicit approval for exactly that action. Read-only SQL is always fine.',
      '- Subscriber-facing messages go only to the two approved addresses in FDY-112 until Myke lifts the allowlist.',
      '- Never print secrets, tokens or keys. Never run destructive SQL without the snapshot and restore path the prompt requires.',
      '- Two issues that touch the same file, function or table run strictly one after the other. Otherwise run sequentially anyway; do not parallelize unless every pair is clearly independent.',
      '- If three issues in a row STOP for the same cause (for example an expired credential or an unreachable database), stop the whole run and report the cause.',
      '',
      'DECISIONS',
      'Where a prompt leaves any choice open, take the option it marks RECOMMENDED. If none is marked, take the safest reversible option and note it in the issue comment.',
      '',
      'FINAL REPORT',
      'One table: issue id, outcome (DONE / PARTIAL / STOPPED / BLOCKED), PR link, one-line note. Then a short list of decisions waiting on Myke, ordered by priority, and a one-sentence summary.'
    ].join('\n');
  }

  return { hasClaudePrompt: hasClaudePrompt, issueHasPrompt: issueHasPrompt, buildFixPrompt: buildFixPrompt };
});
