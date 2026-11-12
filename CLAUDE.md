# CLAUDE.md — Faraday Workbench

## Orchestration contract — read first (v1.0, 2026-11-12)

This section governs every Claude Code session in this repo. It **supersedes** the "Myke applies" /
"WRITTEN, NOT APPLIED" convention in older reports and in the archived CLAUDE.md: those describe the state when
they were written, not a rule. Copies of this contract live in each Faraday repo; keep them identical.

### Systems of record
- **Linear (team `FDY`) holds the work.** One issue = one unit of work = one branch = one PR. The
  Claude Code prompt lives in the issue under a collapsible `+++ Agent notes` section. Label
  **`Agent Ready`** means the prompt is complete and every decision has a recommendation: pick it up
  without asking. No label, or open questions in the issue: work the parts that are decided and list
  the rest in the PR.
- **Notion holds context and the long-running narrative.** Read any Notion links in the issue before
  starting. Log every session in the **Faraday Run Log** database
  (https://app.notion.com/p/42aa6cf894e244438127ac80870c9905, data source
  `collection://fbfb83d3-5c48-4716-8e7e-820dd701b3ff`): create the row at start (Status `Running`),
  update it at close. Decisions Myke makes go to the **Faraday Decision Log** database.
- **The repo holds the durable rules (this file) and the evidence (`docs/`).** Per-issue findings go in
  `docs/<area>/<TICKET>-*.md`, never as new CLAUDE.md sections. Add to CLAUDE.md only a rule a future
  session must obey, in at most ~10 lines, inside the section for its area.

### Authority tiers
- **Tier 1 — just do it:** read anything (repo, Linear, Notion, read-only SQL against prod); write
  code, migrations, tests, docs; run local harnesses; open PRs; update Linear issues and Notion pages.
- **Tier 2 — do it after verification passes, then report:** apply migrations to production with the
  Supabase connector; deploy edge functions; merge your own PR once checks and harnesses are green
  (squash, into the default branch); set your Linear issue to Done.
- **Tier 3 — prepare, never execute (Myke's):** revoking `anon`/`authenticated` grants on live tables;
  lifting an audience gate; anything that emails, texts or charges a real subscriber; setting or
  rotating secrets/API keys; DNS; deleting production rows outside a migration's documented scope;
  Stripe live mode; anything the issue marks as a product decision. Put the exact command and its
  rollback in the PR's "Human actions" field and in a Linear comment.

**When to stop and ask (only these):** a Tier 3 action; a decision with no recommendation that cannot
be undone; a verification that fails after one rollback-and-retry; a required connector that errors
twice. Otherwise make the call, state it in the PR, and keep going.

### Production database protocol (Tier 2)
1. **Claim the lane.** Only one open `FDY` issue may carry the **`DB Lane`** label. If another issue
   has it, finish everything else and wait; never apply in parallel. Remove the label when done.
2. **Window:** never apply or deploy 07:00–09:00 UTC (crawl + Predicts lanes).
3. **Inventory first:** decide applied/not-applied from object existence (`to_regclass`,
   `to_regprocedure`, `information_schema`) as well as `supabase_migrations.schema_migrations`.
4. **One file per `apply_migration` call,** each only after its local harness passes; verify before the next.
5. **Verify** (this replaces "Myke checks the UI"): the file's own gate committed; role probes as
   `anon`/`authenticated` in a rolled-back transaction match the baseline except intended changes;
   service-side readers return the same rows; `estate_access_for(<owner>, 'workbench')` is still
   `usable`; advisor delta is zero or names only intended objects. Save before/after JSON under `docs/`.
6. **Failure:** roll back that one file with its header's rollback, confirm the rollback held, stop.
   Never fix forward in production.
7. Never `DROP FUNCTION` (stalls here; retire by `ALTER … RENAME` + revoke). Patch deployed function
   bodies from the deployed source with asserted `replace()`, never retyped.

### Parallel-safety rules
- Branch name: `claude/fdy-<number>-<slug>`. Never commit to another session's branch or edit files
  another open PR owns; if you must, say so in your PR and in both Linear issues.
- Migration filenames take the **current UTC timestamp when the file is created**. Before merging,
  fetch the default branch, check no other migration shares or follows your timestamp in a way that
  breaks an apply-order dependency, and rebase.
- **Default branch of this repo:** `main`. Supabase project: `ycadmmngkdhvpcsrcuaq` (shared with the
  Faraday engine repo, Mykemiller/Faraday).

### Session close-out (definition of done)
1. PR description = the repo's PR template, fully filled.
2. Linear: evidence comment, status Done (or In Review with the reason), `DB Lane` removed.
3. Notion Run Log row: Status, PR, Prod changes (UTC times), Human actions left (target: none).
4. Final message ends with a one-sentence summary.
