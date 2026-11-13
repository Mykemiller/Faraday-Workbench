# Workbench Estate truth audit — CC-WORKBENCH-ESTATE-TRUTH-AUDIT-1.0

Run 2026-11-12 17:00–17:35 CT · read-only · branch `audit/estate-truth-1.0` (from `origin/main` dd57234) · nothing pushed, no DB/Linear/Notion writes.
Snapshot baseline: `audits/snapshots/2026-11-12_estate_truth_pre.json` (tiles in full; cache payloads reduced, see its `note`).

## 1. Headline

- **The scorecard is not computed. It is a hardcoded HTML table** (`index.html:447-466`, committed 2026-11-03 18:37 CT, `fa286a6`). Nothing evaluates the DORMANT rule. Dominant root cause for everything below: `FROZEN_SNAPSHOT`.
- Of 11 scorecard rows, **5 are materially wrong**: Signal Room (worst: shown DORMANT 1/10, evidence says ≥6 on measured dimensions), Boundstone (Momentum 0→2, Governance 0→1), ISpyaDC (Delivery 0→1, Momentum 0→2), Briefing Library (Momentum 1→2), Live Agent (shown as a scored DORMANT row; it is a retired, disabled tile). Another 6 rows match on the numbers but carry a 9-day-old stamp. Commercial is `unverified` on every row (no Stripe connector in this session), so the "0" in that column is not evidence.
- **Premise corrected:** the tile layer is mostly live and honest (tiles refresh daily from `workbench_storefront_compute()`; Signal Room's tile already reads `public.signals`). The stale part is the scorecard table plus two human-owned tile fields. The `MISSING_BINDING` theory is wrong: label is the exclusive Linear binding and all 16 tiles have one.
- Two tile fields are stale: Signal Room `status='concept'`/`SR 00.08 · NOT READY` and Estate Security `RED · 5 URGENT` (only 3 are still open).

## 2. Where the scorecard comes from

| Item | Evidence |
|---|---|
| Table | `index.html:449-464` — 11 literal `<tr>` rows; health word, score and five digits are typed in. |
| Stamp | `index.html:438` (`Scorecard <b>2026-11-03 18:12 CT</b>`), `:447`, footer `:566`. All literals. |
| Second frozen copy | `index.html:573-589` `storefronts` array (tags like `DORMANT · 1/10`) is `SF_FALLBACK` (`:660`), shown if `workbench_storefront()` fails. |
| Last edit | `git log -L447,466:index.html` → `fa286a6` 2026-11-03 18:37 CT "Workbench: 2026-11-03 Product Health Scorecard…". Nothing since. |
| Live vs frozen | **Frozen.** `workbench_scoring_cache` (keys `cc,jds,jts,jpas`) and `workbench_health_cache` (`dc,idf,jps,signals,engine_stats`) hold JPAS/JDS/JTS panels and IDF/DC health, **not** this scorecard. No `workbench_product_health()` exists (`pg_proc` scan of `workbench%`, 21 functions). |
| Linked artifact | `claude.ai/artifact/E1pwbjVq1ZhJuPzJZngTFs` is the human source of the numbers; not read in this run. |

**Why Signal Room renders DORMANT:** `index.html:462` is the string `DORMANT` with `1,0,0,0,1,0`, typed on 2026-11-03. The legend (`:448`) says DORMANT = no project, no usage rows, no decision. Today, two of three legs fail: usage rows exist (`signals` 3,785 rows, 602 in 2026-10-29..11-12, newest 2026-11-12 07:30 UTC, written by active cron `auto199-signal-promotion-daily`), and a decision/plan exists (FDY-267 scopes FSR 1.0, build date 2026-12-14). Only "no Linear project" is true. Also, the tile layer says otherwise: `workbench_storefront_compute()` reads `public.signals` for `signal-room` (measured 3,785 in the cache), so the board contradicts its own scorecard.

## 3. Reconciliation matrix

Scale 0–2. `d→e` = displayed → evidenced. `?` = unverified (not scored). Windows: 2026-10-29 00:00 UTC to 2026-11-12 23:59:59 UTC.

| Product | Displayed | Evidenced (measured dims) | Deliv | Substr | Mom | Gov | Comm | Tile status / tag | Root cause | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| ThoughtForge Panel | GREEN 6 | GREEN 6 | 2→2 | 1→1 | 2→2 | 1→1 | 0→? | live / TF 01.05 JUST FUNCTIONING | FROZEN_SNAPSHOT (stamp only) | E1,E5,E7 |
| Faraday Predicts | GREEN 6 | GREEN 6 | 2→2 | 1→1 | 2→2 | 1→1 | 0→? | live / FP 02.04 | FROZEN_SNAPSHOT (stamp only) | E1,E5,E7 |
| Jurisdiction Watch 3.0 | AMBER 5 | AMBER/GREEN 6 | 1→2 | 1→1 | 2→2 | 1→1 | 0→? | build / JW 03.04 NEEDS TUNING | FROZEN_SNAPSHOT; Delivery delta is ladder-vs-judgment (see 4) | E1,E5,E6 |
| Daily Challenge | AMBER 5 | AMBER 5 | 2→2 | 1→1 | 1→1 | 1→1 | 0→? | build / DC 05.02 | FROZEN_SNAPSHOT (stamp only) | E1,E5,E7 |
| Faraday Academy | AMBER 5 | AMBER 4 | 1→? | 2→1 | 1→1 | 1→1 | 0→? | build / FA 04.01 | FROZEN_SNAPSHOT; Substrate 2→1 per ladder (courses last updated 2026-10-02, progress 0 rows) | E2,E5 |
| Briefing Library | AMBER 4 | AMBER 5 | 1→1 | 1→1 | 1→2 | 1→1 | 0→? | build / BL 03.05 NOT READY | FROZEN_SNAPSHOT (Momentum) | E3,E5 |
| Intelligent Alert | AMBER 4 | AMBER 4 | 2→2 | 1→1 | 1→1 | 0→0 | 0→? | build / IA 00.05 NOT READY | FROZEN_SNAPSHOT (stamp only); dead `linear_query` | E1,E4 |
| Boundstone | RED 1 | AMBER 4+ | 0→≥1 | 1→1 | 0→2 | 0→1 | 0→? | warn / BS 01.03 | FROZEN_SNAPSHOT | E3,E8 |
| ISpyaDC | RED 1 | AMBER 4 | 0→1 | 0→? | 0→2 | 1→1 | 0→? | warn / IS 01.04 | FROZEN_SNAPSHOT | E3,E8 |
| Live Agent | DORMANT 2 | RETIRED (not DORMANT) | 0→0 | 1→1 | 0→1 | 1→1 | 0→? | concept, **enabled=false** / LA 00.08 | FROZEN_SNAPSHOT + WRONG_SOURCE (tile metric reads `enrich_batches`, not `live_agent_usage`) | E2,E3,E9 |
| **Signal Room** | **DORMANT 1** | **≥6 (GREEN on measured dims; Comm ?)** | **0→2** | **0→2** | **0→1** | 1→1 | 0→? | **concept / SR 00.08 NOT READY** | **FROZEN_SNAPSHOT + EDITORIAL_LAG (+ LOGIC_BUG if the table is ever auto-computed with this rule)** | E1,E3,E10 |

Rows not on the scorecard are in section 5. Evidence codes are listed in section 9.

## 4. Per-product evidence notes

- **ThoughtForge** — repo `Mykemiller/thoughtforge`; prod https://www.faraday-thoughtforge.com 200; last prod deploy 2026-11-12 ~13:25 UTC (`dpl_8qNRk3xD`). Substrate: `tf_signal_digests` 2 rows, newest 2026-11-10 20:03 UTC; no TF cron found in `cron.job`. Linear: project bound, 25+ issues updated in window (page 1 of 2 only → lower bound). Stripe: `unverified`.
- **Faraday Predicts** — repo `v0-faraday-daily-challenge` ships `/predicts` (Vercel deploy shared with Daily Challenge); https://www.faraday-intelligence.ai/predicts 200 (356 KB). `predictions` 217 rows, 13 created in window, newest 2026-11-09 07:45 UTC despite active daily `faraday-predicts-generate-daily` (last run 11-12 07:45) → cadence not met, Substrate stays 1. Linear: project bound, 40+ in window.
- **Jurisdiction Watch** — repo `faraday-jurisdiction-watch`; https://www.jurisdiction-watch.com 200; deploy 2026-11-12 ~13:19 UTC. `jw_score_history` 1,522,445 rows, newest 2026-11-12 23:00 UTC, 4,882 in window; `jw_briefings` 5,508, newest 2026-08-21, 0 in window; `jw-briefing-generator-sweep` **active=false**, last run 2026-08-23. Delivery 1→2 follows the ladder (200 + real content); the displayed 1 may encode "briefs stale / buyer cannot transact" — Myke's call. Linear: project bound, 30 in window on page 1.
- **Daily Challenge** — repo `v0-faraday-daily-challenge` (`prj_A7MhvdAW…`); https://www.faradaydailychallenge.com 200; deploy 2026-11-12 ~13:18 UTC. `dc_puzzle_bank_staging` 847 rows, 405 scheduled ahead to 2027-01-31 (tile cache), last `synced_at` 2026-08-01; `dc_daily_signal` 3 rows, newest 2026-07-29; no DC cron found. Linear: label and project both resolve 4 issues (FDY-293, 27, 250, 58).
- **Faraday Academy** — repo `faraday-academy`; URL not probed (`unverified`), deploy READY 2026-11-12 ~13:26 UTC. `academy_courses` 126, newest update 2026-10-02; `academy_progress` 0. Linear: project bound, but `linear_label` wins → label resolves 2 (FDY-33, FDY-41).
- **Briefing Library** — repo `Faraday-Briefing-Library-`; https://www.faraday-intelligence.ai/library 200 (17 KB) but tile says storefront gated, so Delivery stays 1. `briefings` 692 rows, 0 published; `library_catalog_cache` 378, synced 2026-11-09 11:00 UTC. Linear: project bound, 17 issues in window (page 1).
- **Intelligent Alert** — substrate `jw_signal_events` 142,750 rows (4,434 in window), newest 2026-11-10 19:01 UTC; cron `auto204-daily-signal-digest` ran 2026-11-12 08:00 UTC. Own Urgent security issue FDY-205 still open, so Gov 0 holds. Linear resolves by label: 1 issue (FDY-201). The raw `linear_query` "signal digest" matches 50+ unrelated issues (raw ≥50, filtered 1) — dead config, see SQL.
- **Boundstone** — repo `boundstone`; deploy READY 2026-11-12 ~13:31 UTC, URL not probed → Delivery recorded as ≥1, not 2. Tile metric `no_feed`. Linear: project bound, ~28 in window. Its Urgent security issue FDY-149 is Completed 2026-11-06 22:21 UTC, so the Gov 0 no longer holds.
- **ISpyaDC** — repo `I-Spy-a-DC`; deploy READY 2026-11-12 ~13:25 UTC; tile calls it an admin test console → ladder 1. Substrate `no_feed`. Linear: project bound, 8 in window (FDY-18,19,20,21,22,23,42,248).
- **Live Agent** — no Vercel project; tile `enabled=false`; `live_agent_usage` 0 rows, `live_agent_plan` 3 rows (2026-06-23). Linear label: 1 issue (FDY-249, shared with Signal Room). DORMANT needs "no decision"; a retirement is recorded in the tile blurb, so it is RETIRED, not DORMANT.
- **Signal Room** — repo `Faraday-Signal-Room`; https://faraday-signal-room.com/signal-room 200 (439 KB), renders Signals dated Nov 7–12 (52 on Nov 12, byline `pipeline:auto:enrichment`); deploy 2026-11-12 ~13:18 UTC. **Outage:** FDY-305 shows prod was down 2026-11-10 22:04 UTC → resolved 2026-11-11 20:34 UTC (wrong service-role key); so Delivery 2 is about 26 hours old. Open decisions in FDY-305: conviction badge visible on public feed, `SWEEP_SECRET`/`RESEND_API_KEY` unset. Linear: no project exists; label resolves 3 (FDY-305, 249, 267).
- **Stripe** — no Stripe connection in this session; Commercial `unverified` for every product.

## 5. Coverage gaps (tiles 16 vs scorecard 11)

| Tile | Product or utility? | Evidence (measured) | Recommendation |
|---|---|---|---|
| Panel Podcast | Product | Deliv 0 (no deployment found), Substr no_feed (0 episodes), Mom 2 (8 issues in window), Gov 1 | Add to scorecard |
| Civic-Host | Product | Deliv ≥1 (deploy READY, last 2026-07-04, URL not probed), Substr no_feed, Mom 0 (label 0), Gov 1 | Add; tile says "usage not measured" |
| League Office | Console for Daily Challenge | Deliv ≥1 (deploy 2026-07-04), `lo_audit_log` 108 rows newest 2026-10-06 (stale), Mom 0 | Fold into Daily Challenge, drop its row |
| Estate Security | Floor, not a product | 3 open Urgent (FDY-205, 206, 208) | Keep as tile only; it feeds Governance |
| IDF Health | Utility | label only | Keep as tile only |
| Live Agent | Retired | tile disabled | Remove from scorecard |

## 6. Proposed binding/config SQL

`sql/proposed/2026-11-12_estate_truth_bindings.sql` — **not executed**. The planned `linear_project_id` backfills are impossible (no such Linear projects) and unnecessary (label is exclusive). The file instead clears the four dead `linear_query` values, with guard, verify and rollback:

```sql
update public.workbench_storefront_tiles
   set linear_query = null
 where slug in ('intelligent-alert','live-agent','signal-room','league-office')
   and linear_label is not null
   and linear_query is not null;
```

## 7. Proposed editorial values (needs Myke — nothing written)

| slug | current status | proposed status | current status_tag | proposed status_tag | justification |
|---|---|---|---|---|---|
| signal-room | concept | build | SR 00.08 · NOT READY | your call: version is set by Promote (ADM-2.1); no change if you keep 00.08 | Public feed 200 with daily signals; open decisions (conviction, sweep) keep it from "live". |
| signal-room (blurb) | "3,681 Signals, 248 in the last 7 days… live status is unconfirmed. 1 open ticket." | "3,785 Signals (602 in 2026-10-29 to 11-12), newest 2026-11-12. Public feed live since the FDY-305 fix on 2026-11-11 20:34 UTC. Open: conviction badge on public feed, delivery sweep secrets (FDY-305), FSR 1.0 scoping (FDY-267)." | | | Numbers and status are stale. |
| estate-security | warn | warn | RED · 5 URGENT | RED · 3 URGENT | FDY-205, 206, 208 open (started); FDY-207, 166, 149 Completed. |
| estate-security (blurb) | "Nine open findings…" | "Three Urgent findings open (FDY-205, 206, 208); FDY-207, 149, 166, 209, 210, 211 are done." | | | Of the nine pinned keys only three remain open. |
| live-agent | concept (disabled) | no change | LA 00.08 · NOT READY | no change | Already retired; fix the scorecard, not the tile. |

## 8. Proposed code fix

Follow-on: **`CC-WORKBENCH-ESTATE-TRUTH-FIX-1.0`** (needs Myke's go).
1. Migration (new file `sql/workbench_product_health.sql`): `workbench_product_health_compute()` returns per-slug five dimensions + `evidence` + `basis` (`measured`/`no_feed`), using the section 4 ladder; `workbench_product_health_refresh()` writes `workbench_scoring_cache` id 2 (or a new `workbench_product_health_cache`); daily cron after `workbench-storefront-refresh-daily`; `workbench_product_health()` reader RPC. Substrate table per slug as in `workbench_storefront_compute()`. Commercial `no_feed` until Stripe is wired. Momentum counted by `completedAt`/`createdAt`, not `updatedAt` (see 10).
2. `index.html:438-466`: replace the literal rows with a renderer over the RPC; stamp from `computed_at`; DORMANT evaluated in SQL; remove literals `:447`, `:566`.
3. `index.html:573-589`: refresh `SF_FALLBACK` or mark it plainly as a dated fallback.
4. `api/workbench-recompute.js`: add the new lane to `RECOMPUTE_LANES` (`index.html:2043`).
5. Tests under `test/` mirroring `scoring-panels.*`.
No diff written; this audit is read-only.

## 9. Verification queries (rerunnable)

- E1 `select count(*), max(fired_at), count(*) filter (where fired_at between '2026-10-29 00:00:00+00' and '2026-11-12 23:59:59+00') from signals;` → 3785 · 2026-11-12 07:30:00.218585+00 · 602
- E2 same shape on `jw_briefings(generated_at)`, `jw_score_history(computed_at)`, `jw_signal_events(triggered_at)`, `predictions(date_created)`, `tf_signal_digests(ingested_at)`, `lo_audit_log(at)`, `academy_courses(updated_at)`, `live_agent_usage(asked_at)`, `briefings(updated_at)`, `library_catalog_cache(synced_at)`, `dc_puzzle_bank_staging(synced_at)`, `dc_daily_signal(created_at)` — results quoted in section 4.
- E3 Linear `list_issues updatedAt>=2026-10-29T00:00:00Z` (page 1 of 2, 250 rows, grouped by project/label); `label=<name>` for Daily Challenge (4), Faraday Academy (2), Signal Room (3), Live Agent (1), Intelligent Alert (1), League Office (0), Civic-Host (0); `query="signal digest"` (50+ unrelated).
- E4 `select jobname, schedule, active, (select max(start_time) from cron.job_run_details d where d.jobid=j.jobid) from cron.job j where jobname ~* '(signal|predict|digest|jw|…)';`
- E5 `curl -sL -o /dev/null -w '%{http_code}'` on the five prod URLs: all 200 on 2026-11-12 ~23:09 UTC.
- E6 `select jobname, active from cron.job where jobname='jw-briefing-generator-sweep';` → false.
- E7 `select pg_get_functiondef('public.workbench_storefront_compute'::regproc);` (tile metric sources).
- E8 Vercel `list_deployments target=production limit=1` per project, dated in section 4.
- E9 `select count(*) from live_agent_usage;` → 0; `select pg_get_functiondef(...)` shows `live-agent` reads `enrich_batches`.
- E10 Linear `get_issue FDY-305`; `curl -sL https://faraday-signal-room.com/signal-room | grep -o 'Nov 12' | wc -l` → 52.
- `git log -L447,466:index.html` on `origin/main`; `grep -n DORMANT index.html`.

## 10. Incidental findings (not fixed)

- Signal Room's public feed shows a conviction badge that the repo README calls internal-only; the delivery sweep secrets are unset (FDY-305, open decisions). Also: where the key for Supabase ref `xgbpmlkanxewtfizloay` came from is unresolved and it may need rotating.
- `jw_briefings` stopped on 2026-08-21 and `jw-briefing-generator-sweep` is disabled while the tile and Linear say JW launches 2026-12-01.
- Linear `updatedAt` is polluted by bulk touches (many issues share `2026-11-07T21:19:30.134Z`, a restructure), so any "14-day activity" built on `updatedAt` overstates Momentum. Momentum above is therefore an upper bound.
- Boundstone's own Urgent FDY-149 closed but the shared "Governance capped at 1 by FDY-205/206/207/208/166/149" note (`index.html:465`) still lists six; three are done.
- `https://faraday-stuff.com` is behind Vercel SSO, so the deployed HTML could not be fetched; code was read from `origin/main` (dd57234, 2026-11-12 16:26 CT) instead. Deployed = main is assumed from the project/repo mapping, not byte-checked.
- Local `main` and this checkout's prior branch (`claude/workbench-storefront-approved-copy`) are behind `origin/main`; the audit branch was cut from `origin/main`.

## 11. Myke actions

1. **Editorial values (section 7):** approve / reject per row — Signal Room status + blurb, Estate Security tag + blurb. Go / no-go each.
2. **Bindings SQL:** approve running the (now much smaller) dead-`linear_query` cleanup as a named migration in the fix CC. Go / no-go.
3. **Draft `CC-WORKBENCH-ESTATE-TRUTH-FIX-1.0`** (computed scorecard). Go / no-go.
4. **Coverage gaps (section 5):** add Panel Podcast and Civic-Host; drop League Office and Live Agent rows? Go / no-go.
5. **Access missing from this run:** Stripe (Commercial unverified on every row), and a way past Vercel SSO on faraday-stuff.com for byte-level deployed-code checks.
6. **Decisions already open elsewhere:** Signal Room conviction badge and sweep secrets (FDY-305).
