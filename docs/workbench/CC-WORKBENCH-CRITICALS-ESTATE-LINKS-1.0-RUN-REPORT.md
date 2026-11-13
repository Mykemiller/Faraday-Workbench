# CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0 — run report (FDY-324)

Measured 2026-11-13 00:05–00:15 UTC (2026-11-12 18:05–18:15 CT). **No production write was made.** `DB Lane` is held by FDY-324's neighbour FDY-323 (CLAUDE.md: one lane at a time), so the three migrations are committed as files, dry-run against prod read-only, and **not applied**.

## 0. Premises that did not match live state
| Brief said | Measured |
|---|---|
| 15 findings cleared ~13:19 UTC | 12 cleared, at **22:27:05 UTC** (nothing cleared 13:00–13:40). 13:19 UTC is the GitHub push time of several repos. |
| JTS has zero models | `models_registered=5`, `formula_exists=true`, `feeds_empty=0` (workbench_scoring_panels(), 20:56 UTC cache) |
| Estate Security: FDY-205/206/207/208/149 open | 207 and 149 are **Done**. Open Urgent with the label: 205, 206, 208 and **119** (Todo, "Subscriber configurator UI", likely mislabelled) |
| D-1 moves Boundstone to amber | Boundstone has **1 open Urgent (FDY-77, Todo)** under its label, so D-1 keeps it **red**, now with an accurate reason. ISpyaDC has 0 → amber |
| Estate emitter in `api/` or `sql/` | It is client-side: `index.html` `renderStorefronts()`. No SQL migration is needed for D-1 |
| Cleared findings stay cleared | The shared ledger **flaps**: at 00:04:49 UTC `LIVE_STALE`, `BANK_EXHAUSTED`, `ACTIVE_BUT_EMPTY`, `THREE_ENGINES_LIVE`, `NEVER_COMPUTED`, `FLAT_LAYER_COLUMNS_STALE`, `JTS.NO_MODEL_REGISTERED` were re-written open. Their predicates are false on live data. Cause: any browser with a degraded read (fetch failed / hardcoded fallback board) syncs as a "complete" report. Fixed in code (see §2) |

## 1. Six criticals
| Finding | Action | New severity | Evidence |
|---|---|---|---|
| ESTATE.BOUNDSTONE…JUST_FUNCTIONING | re-rated by D-1; FIX → FDY-77 | red (1 Urgent open: FDY-77) | Linear label query; no health endpoint wired |
| ESTATE.ISPYADC…JUST_FUNCTIONING | re-rated by D-1; FIX → FDY-248 | amber ("maturity") | 0 Urgent open for label ISpyaDC |
| ESTATE.ESTATE_SECURITY.RED_5_URGENT | kept red; FIX lists 205/206/208/119 with links | red | FDY-205/206/208 In Progress |
| SCORING.JPAS.CONF_MULT_COMPLETENESS_ONLY | linked → FDY-325 (new, diagnosis only) | red | no scoring write |
| SCORING.JPAS.RSC_IMPUTED_91PCT | linked → FDY-312 / JH-08 | red | |
| SCORING.JDS.SUPPLY_IMPUTED_CONTENTION | linked → FDY-326 (new, diagnosis only) | red | |

The tile `status_tag` "RED · 5 URGENT" is now stale (always-human, not edited): flag for Myke.

## 2. Mass-clear audit (12 findings, cleared 22:27:05 UTC)
Predicates are in `index.html` (line numbers on this branch via `grep -n <KEY> index.html`); each was re-evaluated against the live RPC the page reads.
| Finding | Predicate (code) | Live value | Still true? | Action |
|---|---|---|---|---|
| SCORING.JTS.NO_MODEL_REGISTERED | `!t.formula_exists` (scoringConditions) | formula_exists=true, 5 models | no | confirmed cleared. Stale text left on JTS attributes (`blocked_by: no_model_registered`) and in `readiness_note`: flag |
| SCORING.JTS.FEEDS_EMPTY | `t.feeds_empty>0` | 0 | no | confirmed cleared |
| SCORING.JDS.FLAT_LAYER_COLUMNS_STALE | `layer_coverage.flat_columns_stale` | null (columns declared retired) | no | confirmed cleared |
| SCORING.JPAS.ACTIVE_FLAG_CONTRADICTIONS | `rvr.active_flag_contradictions>0` | 0 | no | confirmed cleared |
| SCORING.CACHE.NEVER_COMPUTED | `!p.computed_at` | 2026-11-12 20:56 UTC | no | confirmed cleared |
| ESTATE.STOREFRONT.CACHE_STALE | cache age >26h | 20:56 UTC cache | no | confirmed cleared |
| ESTATE.DAILY_CHALLENGE.LIVE_STALE | tile `status==='warn'` + tag | tile is now `build` / NEEDS TUNING (editorial change, #approved-copy) | no | confirmed cleared (condition removed by data, not a deleted detector) |
| FEEDS.DAILY_CHALLENGE.BANK_EXHAUSTED | `ahead===0&&cached===0` | ahead 405, cached 1 | no | confirmed cleared. `CACHE_THIN` (cached<=1) is still correctly open |
| FEEDS.DAILY_CHALLENGE.SEASON_ENDING | `days_left<=3` | 80 | no | confirmed cleared |
| FEEDS.IDF_SUBDOMAINS.NO_FEED | `subdomains_no_feed>0` | 0 (3 in feed_shortfall, a separate metric) | no | confirmed cleared |
| FEEDS.SOURCES.ACTIVE_BUT_EMPTY | forecast `active_but_empty>0` | 0 (snapshots 11-02, 11-09) | no | confirmed cleared |
| IDF5.LINKAGE.THREE_ENGINES_LIVE | `eng.live>1` | 1 live (ledger); entity_link, tagspine not live | no | confirmed cleared |

**No detector was removed; none reopened (none still true).** `SCORING.JDS.COMPOSER_NO_SCHEDULE` has no ledger row now (purged after 24h or never present); live `composer_is_scheduled=true`, so also not true.
The ledger currently shows 7 of these open again because of the degraded-client writes above. **Code fix in this PR:** `syncFindings()` no longer syncs when any lane reports `*.FETCH_FAILED` or the storefront is on `FALLBACK_COPY`. Suspected writers (not confirmed): stale cached deploy, local file/preview opens, headless test runs. Until the PR deploys, expect more flapping.

## 3. live_url map (GET, 10 s, 2xx/3xx only; measured 2026-11-12 ~23:40 UTC)
| slug | URL | HTTP | written (on apply) |
|---|---|---|---|
| jurisdiction-watch | https://jurisdiction-watch.com | 3xx→200 | yes |
| faraday-predicts | https://www.faraday-intelligence.ai/predicts | 200 | yes |
| thought-forge | https://www.faraday-thoughtforge.com/ | 200 | yes |
| daily-challenge | https://faradaydailychallenge.com | 3xx→200 | yes |
| faraday-academy | https://faraday-academy.vercel.app/academy | 200 | yes |
| briefing-library | https://www.faraday-intelligence.ai/library | 200 (/briefing-library redirects here) | yes |
| intelligent-alert | https://www.faraday-intelligence.ai/intelligent-alert | 200 | yes |
| ispyadc | https://ispyadc.com | 200 | yes |
| signal-room | https://faraday-signal-room.com/signal-room | 200 | yes |
| league-office | https://league-office.vercel.app | 200 | yes. Confirm this is the admin surface |
| civic-host | https://civic-host.com | 200 | yes |
| estate-security | https://www.faraday-stuff.com/#estate | 302 (Vercel SSO) | yes |
| idf-health | https://www.faraday-stuff.com/#feeds | 302 (Vercel SSO) | yes |
| boundstone | www.boundstone.org, boardstone.vercel.app | **401** both | **no, NULL**: needs your URL or a decision that 401 (gated) counts |
| panel-podcast | none found (no repo, no Vercel project) | – | no, NULL |
| live-agent | tile disabled | – | no, NULL |

## 4. Migrations (files, NOT applied) and PR
`sql/wb_criticals_prestate_snapshots.sql` → `wb_storefront_tiles_add_live_url.sql` → `wb_finding_remediation_seed_estate.sql`. Dry run (read-only, prod): function anchor found exactly once; `live_url` not yet in the body; 13 of 13 mapped slugs exist; no Estate-severity SQL migration (the rule is client-side). Apply order, one file per `apply_migration`, outside 07:00–09:00 UTC, after FDY-323 releases `DB Lane`.

## 5. Linear
FDY-324 (this work), FDY-325 (JPAS conf_mult shadow proposal), FDY-326 (JDS contention shadow proposal), both related to FDY-312.

## 6. Verification (pre-apply, 2026-11-13 00:05 UTC)
`select severity,count(*) … cleared_at is null` → red 10, amber 13. Reds with no remediation row: `SCORING.CACHE.NEVER_COMPUTED`, `FEEDS.DAILY_CHALLENGE.BANK_EXHAUSTED` (both polluted-writer reopenings; predicates false). The three Estate reds have no row until the seed migration applies. After apply, expected: 0 rows from the remediation join for the six named criticals; `select slug, live_url …` shows 13 URLs and 3 NULL.

## 7. Rollback
```sql
-- after apply:
update workbench_finding_remediation r set plain_english=p.plain_english, updated_at=p.updated_at from cc_wbcrit_prestate_remediation p where r.finding_key=p.finding_key;
delete from workbench_finding_remediation where finding_key in ('ESTATE.BOUNDSTONE.BS_01_03_JUST_FUNCTIONING','ESTATE.ISPYADC.IS_01_04_JUST_FUNCTIONING','ESTATE.ESTATE_SECURITY.RED_5_URGENT');
alter table workbench_storefront_tiles drop column live_url;   -- then restore workbench_storefront_compute without the 'live_url' pair
```
Code: revert the PR. Snapshots: `cc_wbcrit_prestate_{finding_state,remediation,tiles}`.

## 8. Myke actions
1. Release or finish FDY-323's `DB Lane`, then have a session apply the three files (or say "apply now" to override).
2. Review and merge the PR, then deploy faraday-workbench.
3. Boundstone: confirm FDY-77 as a real Urgent, and give a URL or accept the 401 gate as live. Panel Podcast: give a URL.
4. Estate Security tile `status_tag` still says "RED · 5 URGENT" (3 Urgent + FDY-119 open); decide the wording. Check whether FDY-119 belongs under the Estate Security label.
5. Confirm the amber headline wording `<Tile> — maturity <tag>` (editorial).
6. Gate 0 on FDY-325 and FDY-326.
7. Stale JTS text (`blocked_by`, `readiness_note`) is a scoring-panel payload edit: yours.
