# CC-WORKBENCH-ESTATE-TRUTH-FIX-1.0 — 2026-11-12 17:50 CT

## Goal
Replace the hardcoded Product Health Scorecard in `index.html` with a table computed from live evidence by a Supabase function on a daily cron, so a product's health can never again contradict the database (trigger case: Signal Room shown DORMANT while `public.signals` gets daily rows and the public feed serves 200).

## Context
- Repo `Mykemiller/Faraday-Workbench`, default branch `main`, deployed to Vercel project `faraday-workbench` (`prj_RFSzXJvknx9uEMoHt5DHAZf1biVS`) at https://faraday-stuff.com (behind Vercel login; read code from the repo). Supabase `ycadmmngkdhvpcsrcuaq`. Read `CLAUDE.md` first (orchestration contract; DB protocol; the 07:00–09:00 UTC apply window ban; one file per `apply_migration`).
- Audit (measured 2026-11-12 17:00–17:35 CT): `audits/2026-11-12_estate_truth_audit.md` and `audits/snapshots/2026-11-12_estate_truth_pre.json` on local branch `audit/estate-truth-1.0` (commit db1b8fc, may be unpushed; if absent, the facts below suffice).
- The scorecard is 11 literal `<tr>` rows at `index.html:449-464`, stamp literals at `:438`, `:447`, footer `:566`; a second frozen copy is `SF_FALLBACK` (`index.html:573-589`, used at `:660`). Last edited 2026-11-03 18:37 CT (`fa286a6`). No function computes it. Existing similar pattern to copy: `workbench_storefront_compute/refresh/()` + cache table `workbench_storefront_cache` + cron `workbench-storefront-refresh-daily` (30 10 * * * UTC) + lane list `RECOMPUTE_LANES` (`index.html:2043`) + `api/workbench-recompute.js`.
- Rules as rendered today: five dimensions 0–2 (Delivery, Substrate, Momentum, Governance, Commercial); GREEN ≥6, AMBER 3–5, RED ≤2; DORMANT = no project, no usage rows, no decision.
- Measured findings the fix must reproduce (all as of 2026-11-12, window 2026-10-29 00:00 UTC to 2026-11-12 23:59:59 UTC): Signal Room evidenced Deliv 2 / Substr 2 / Mom 1 / Gov 1 (≈6, not DORMANT); Boundstone Mom 2, Gov 1; ISpyaDC Deliv 1, Mom 2; Briefing Library Mom 2; Live Agent is retired (tile `enabled=false`), not DORMANT.
- Linear binding: tiles resolve by `linear_label` exclusively (`index.html:868-872`, `api/workbench-linear.js`); 10 Linear projects exist, none for signal-room, intelligent-alert, league-office, live-agent, civic-host, estate-security, idf-health. Linear `updatedAt` is polluted by bulk touches (many issues share `2026-11-07T21:19:30.134Z`).
- Per-product substrate sources (confirmed): signals(`fired_at`), jw_score_history(`computed_at`), jw_briefings(`generated_at`), jw_signal_events(`triggered_at`), predictions(`date_created`), tf_signal_digests(`ingested_at`), lo_audit_log(`at`), academy_courses(`updated_at`)/academy_progress(`updated_at`), briefings(`updated_at`), library_catalog_cache(`synced_at`), dc_puzzle_bank_staging(`synced_at`), live_agent_usage(`asked_at`).

## Requirements
1. New migration `sql/workbench_product_health.sql`: `workbench_product_health_compute()` (SECURITY DEFINER, `search_path=public`), `workbench_product_health_refresh()`, reader RPC `workbench_product_health()`, and cache table `workbench_product_health_cache (id, payload jsonb, computed_at)` with the same grants pattern as `workbench_storefront_cache`.
2. Per slug the payload returns the five dimensions as `0|1|2|null`, `basis` per dimension (`measured|no_feed|unverified`), the evidence (table, row count, newest timestamp, window count), the health word, and the sum over measured dimensions. Unmeasurable dimensions are `null`/`no_feed`, never a fake 0.
3. Ladder (code wins if a code rubric exists; none does): Delivery 0 none / 1 deployed but gated, empty or admin-only / 2 prod URL 200 with real content. Substrate 0 none or empty / 1 populated but stale >7d or no cron / 2 fresh within cadence with active cron. Momentum 0 / 1–4 / ≥5 Linear issues in the 14-day window. Governance: existing cap logic, 0 if the product owns an open Urgent security issue. Commercial: `no_feed` until Stripe is wired. DORMANT only if no Linear binding, zero usage rows and no recorded decision; a disabled tile is `RETIRED`.
4. `index.html`: render the scorecard from the RPC; stamp from `computed_at`; delete the literals at `:438`, `:447`, `:566`; replace the 11 `<tr>` rows; make `SF_FALLBACK` carry no health tags (or a dated fallback label). Keep the legend.
5. Add the lane to `RECOMPUTE_LANES` and `api/workbench-recompute.js`; add a daily cron after `workbench-storefront-refresh-daily` (45 10 * * *-adjacent, not in 07:00–09:00 UTC).
6. Tests under `test/` in the style of `scoring-panels.render.mjs` / `scoring-panels.states.mjs`: the Signal Room, Boundstone and Live Agent cases above, plus a no_feed case and a stale-cache case.
7. Out of scope: editing tile `status`/`status_tag`/`blurb`/`name` (human-owned), pricing, predictions, Stripe wiring, anything Tier 3.

## Recommended Decisions
| # | Decision | Options | Recommendation (why) | Default if I don't reply |
|---|---|---|---|---|
| 1 | Cache location | new table / reuse `workbench_scoring_cache` id 2 | New `workbench_product_health_cache` (no collision with the JPAS/JDS panel payload) | New table |
| 2 | Momentum measure | `updatedAt` / `completedAt`+`createdAt` | `createdAt` or `completedAt` in window; `updatedAt` is inflated by bulk touches | completedAt/createdAt |
| 3 | Linear read in SQL | call Linear from DB / write counts from `api/` route | Counts via `api/workbench-linear.js` style route written into the cache by the recompute endpoint; the SQL function reads them (no outbound HTTP from Postgres) | route-fed counts |
| 4 | Delivery signal | HTTP probe in DB / probe in `api/` | Probe in `api/` (reuse `surface-probe` pattern, `SF_SURFACE` health URLs); store result in cache | api probe, null if unprobed |
| 5 | Scorecard rows | 11 / add Panel Podcast, Civic-Host / drop League Office, Live Agent | Rows = enabled product tiles; Panel Podcast and Civic-Host in; League Office, Estate Security, IDF Health out (utilities); Live Agent shown as RETIRED only if enabled | enabled product tiles only |
| 6 | Cron time | 10:50 UTC | 10:50 UTC daily (after storefront 10:30, outside crawl window) | 10:50 UTC |
| 7 | Migration apply | apply now / PR only | Apply per DB protocol after harness green (Tier 2); claim `DB Lane` first | Apply after green |

## Steps
1. Create the Notion Run Log row (Status Running); claim `DB Lane` on FDY-323 if free; branch `claude/fdy-323-product-health`.
2. Inventory: confirm none of the new objects exist (`to_regclass`, `to_regprocedure`); read `workbench_storefront_compute` via `pg_get_functiondef` and mirror its structure.
3. Write the migration with header gate + rollback; write tests; run them; run all existing `test/*.mjs`.
4. Wire `index.html`, `api/workbench-recompute.js`, `RECOMPUTE_LANES`.
5. Apply the migration (outside 07:00–09:00 UTC), run refresh once, verify per CLAUDE.md protocol step 5; save before/after JSON under `docs/workbench/`.
6. Open the PR with the repo template; fill Human actions (none expected).

## Acceptance Criteria
- `select * from workbench_product_health()` returns a row per enabled product tile, with `computed_at` within the last 26 h after refresh.
- Signal Room is not DORMANT and shows Deliv 2 / Substr 2 / Mom ≥1; Boundstone Mom 2, Gov 1; Live Agent not listed as a scored DORMANT row.
- No scorecard literal remains in `index.html` (`grep -n "2026-11-03" index.html` returns nothing outside comments); stamp equals the cache `computed_at`.
- Commercial renders `no_feed`/unverified, not 0.
- All `test/*.mjs` pass; advisor delta zero or named; `estate_access_for(<owner>,'workbench')` still `usable`.

## Sync
Linear FDY-323 (evidence comment, Done, remove `DB Lane`); Notion Faraday Run Log (https://app.notion.com/p/42aa6cf894e244438127ac80870c9905) row for this session.
