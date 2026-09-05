# CC-WORKBENCH-FINDINGS-REMEDIATION-1.0 — run report

Branch `claude/workbench-findings-remediation-z8lj1o`. Supabase `ycadmmngkdhvpcsrcuaq`.
Pre-change snapshot: `workbench-pre-change-snapshot-20260905T0045Z.md` (repo root).

## 0. Three premise corrections

1. **Repo.** The CC names `Mykemiller/faraday-today`. The Workbench is not there —
   that repo is a separate Next.js ops dashboard, one branch, zero occurrences of
   "workbench" or "finding". Vercel `prj_RFSzXJvknx9uEMoHt5DHAZf1biVS` deploys
   `www.faraday-stuff.com` from **`Mykemiller/Faraday-Workbench`** @ `24a2dbb`,
   which is the commit this branch is cut from.
2. **Shape.** It is a single static `index.html` (1,286 lines, no build step, no
   `api/`, no middleware, no env vars) reading five SECURITY DEFINER RPCs with a
   hardcoded publishable key. The CC's "API route" did not exist; this CC creates
   the repo's first server-side component.
3. **Gate.** "MYKE ONLY" is a `<span>`, not access control. Vercel SSO protection is
   `all_except_custom_domains`, so `faraday-stuff.com` itself is unauthenticated.
   D8's "behind the existing MYKE ONLY gate" had nothing to sit behind. Myke's call:
   his own lock and key via a Vercel env var. Implemented as `WORKBENCH_REFRESH_SECRET`.

## 1. finding_key assignment — all 20 live findings

Reconciled against live payloads: **9 CRITICAL / 11 WARNING**, Estate 1/1 · Feeds 1/2 ·
Scoring 6/4 · IDF 5.0 1/4. Counts preserved exactly; no headline, severity or lane changed.

| # | Sev | Lane | finding_key | Headline |
|--|--|--|--|--|
| 1 | red | Estate | `ESTATE.DAILY_CHALLENGE.LIVE_STALE` | Daily Challenge — LIVE / STALE |
| 2 | amber | Estate | `ESTATE.AUTOMATIONS.FAILED_24H` | 7 automations failed in 24h |
| 3 | red | Feeds | `FEEDS.SOURCES.ACTIVE_BUT_EMPTY` | Active-but-empty sources: 6 |
| 4 | amber | Feeds | `FEEDS.IDF_SUBDOMAINS.NO_FEED` | 52 of 117 subdomains have no feed |
| 5 | amber | Feeds | `FEEDS.DAILY_CHALLENGE.SEASON_ENDING` | Season ends in 0 day(s) |
| 6 | red | Scoring | `SCORING.JPAS.CONF_MULT_COMPLETENESS_ONLY` | conf_mult feeds completeness only |
| 7 | red | Scoring | `SCORING.JPAS.RSC_IMPUTED_91PCT` | RSC is 91.7% imputed at weight 5 |
| 8 | red | Scoring | `SCORING.JDS.COMPOSER_NO_SCHEDULE` | JDS composer runs on no schedule |
| 9 | red | Scoring | `SCORING.JDS.FLAT_LAYER_COLUMNS_STALE` | JDS flat layer columns are stale |
| 10 | red | Scoring | `SCORING.JDS.SUPPLY_IMPUTED_CONTENTION` | Half the supply term rests on imputed contention |
| 11 | red | Scoring | `SCORING.JTS.NO_MODEL_REGISTERED` | JTS: no model registered |
| 12 | amber | Scoring | `SCORING.JPAS.TIER_QUALITY_DIVISOR` | tier_quality divisor (DEC-31, Proposed) |
| 13 | amber | Scoring | `SCORING.JPAS.LIVE_BUT_REGISTRY_GATED` | PWR-11 live but registry says gated |
| 14 | amber | Scoring | `SCORING.JPAS.DARK_DATA_ATTRIBUTES` | 25 attributes hold data but are not scored |
| 15 | amber | Scoring | `SCORING.JTS.FEEDS_EMPTY` | 1 candidate feed(s) empty |
| 16 | red | IDF 5.0 | `IDF5.LINKAGE.THREE_ENGINES_LIVE` | Three IDF linkage engines are live at once |
| 17 | amber | IDF 5.0 | `IDF5.LINKAGE.PILLARS_UNLINKED` | 3 pillar(s) not linked |
| 18 | amber | IDF 5.0 | `IDF5.PILLARS.NO_GEOGRAPHIC_ATTAINMENT` | Geographic attainment empty on 5 of 6 |
| 19 | amber | IDF 5.0 | `IDF5.PILLAR4.NO_BUILD_STAGE` | 16,604 rows carry no build stage |
| 20 | amber | IDF 5.0 | `IDF5.PILLAR4.UNBOUND_JURISDICTION` | 1,797 rows unbound to a jurisdiction |

17 further keys are assigned to conditions that exist in code but are not firing today
(fetch failures, cache-age tiers, weight-budget breach, storefront probe/fallback, dark
IDF domains, season-not-active). They are dormant, not missing.

### Keys are derived from structure, never from a measurement
`SCORING.JPAS.RSC_IMPUTED_91PCT` is generated from `tier_code`, so **"91PCT" is a frozen
label, not a live reading** — the key holds still while the percentage moves. Proven by
test: re-render at 93.4% / weight 7 and the key is byte-identical while the headline
updates. A key that tracked the value would break "before vs after" the moment the
finding it names improved, which is exactly what this CC exists to measure. Renaming it
is Myke's call; the seeded remediation row matches it as-is.

## 2. The FEEDS discrepancy (Section C)

**The registry query in the CC is the wrong query — it reads a different registry.**

The app never queries `jw_data_source_registry` for this. `index.html:780` declares
`{k:"active_but_empty", good:"zero"}` and `:846` reds any `good:"zero"` metric that is
> 0. The value comes from `workbench_forecast_model_cache.payload.snapshots[0]`, written
by `public.fn_capture_forecast_metrics` as:

```sql
select count(*) from v_source_backlog_queue where action_class = 'active_but_empty'
```

`v_source_backlog_queue` is built on **`source_registry`** (the forecast/IDF ingestion
registry), not `jw_data_source_registry` (the JW scoring registry). `action_class =
'active_but_empty'` means: `source_type in (government_feed, industry_entity,
data_portal, company_feed)` AND `destination_table is not null` AND `years_ingested is
null` AND `status = 'active'` AND `temporal_semantics <> 'presence'`.

Live re-run today = **6**, agreeing with the displayed value. The six are all municipal
agenda feeds writing to `opposition_signals`:

| source_key | name |
|--|--|
| `agenda:4b5ba634…` | https://co.ellis.tx.us (custom) |
| `agenda:805dfeda…` | maricopa (legistar) |
| `agenda:82928fee…` | https://www.pwcva.gov/… (custom) |
| `agenda:8fbdf76a…` | cook-county (legistar) |
| `agenda:c6b9cc2d…` | dupage (legistar) |
| `agenda:e9cddd5c…` | https://www.celebratedouglascounty.com (custom) |

The CC's assumed query returns a **disjoint** set of 3 (`dc:epoch-ai`,
`dol:davis-bacon`, `eia:ct-crosswalk-resolved`). Neither registry is "wrong" — they
measure different things, and no row overlaps. Per the CC the predicate and the count
are unchanged; the key `FEEDS.SOURCES.ACTIVE_BUT_EMPTY` is assigned to the app's real
definition.

**Consequence worth noting:** the displayed figure is a *snapshot*, not live. The
2026-08-31 snapshot read 4; the 2026-09-03 one reads 6. The seeded remediation text names
the three `jw_data_source_registry` sources, which are not the six this finding counts —
worth an edit when Myke reviews the copy.

## 3. Performance (Section D)

Measured from 14 days of `cron.job_run_details` — real production runs, not synthetic:

| lane | runs | avg | max |
|--|--|--|--|
| `workbench_health_refresh` | 4026 ok / 6 bad | 28.60s | **114.40s** |
| `workbench_scoring_panels_refresh` | 14 ok | 21.76s | 27.36s |
| `workbench_forecast_model_refresh` | 336 ok | 9.95s | 20.71s |
| `workbench_storefront_refresh` | 14 ok | 0.22s | 0.25s |
| `workbench_idf_refresh` | — | unmeasured | unmeasured |

IDF is unmeasured because it had no cron and the MCP role lacks EXECUTE on it
(`42501: permission denied`). It will be measured on the first firing of jobid 348.

**Decision: parallel, health excluded, `maxDuration: 60`.** Sequential is not viable —
worst case exceeds 190s. The CC flagged scoring as the risk; the real risk is health at
114.4s, which alone would blow any reasonable function budget. Myke's call was to skip
it: cron 33 refreshes health every 5 minutes, so on-demand health buys nothing. The
remaining four fire in parallel, bounded by the slowest (scoring, 27.4s worst observed)
rather than their sum, comfortably inside 60s.

## 4. What changed

Migrations (all applied, all idempotent):
- `create_workbench_finding_remediation`
- `create_workbench_finding_state`
- `create_workbench_findings_sync_rpc`
- `seed_workbench_finding_remediation_criticals` (9 rows, `ON CONFLICT … DO UPDATE`)
- `add_workbench_idf_refresh_cron` (jobid **348**, `45 10 * * *`, guarded delete-then-schedule)
- `probe_workbench_findings_sync_rollback` — self-rolling-back behavioural probe, T1–T5, zero residue

Files:
- `index.html` — 37 `cond()` call sites now carry a key; key helpers; CLEARED chips;
  remediation panels; Re-read / Recompute controls; per-lane stamps; `loadAll()` orchestration
- `api/workbench-recompute.js` — new; the only holder of the service key
- `vercel.json` — `functions: { "api/*.js": { maxDuration: 60 } }`
- `test/findings-keys.mjs` — new, 26 assertions; wired into `npm test`

`npm test` = **97 assertions, 0 failures** across 4 files.

## 5. Security posture

- Both new tables: RLS enabled, **zero policies**, anon/authenticated grants revoked.
  Verified: `has_table_privilege('anon', …, 'SELECT')` = false on both.
- The five `workbench_*_refresh` RPCs were **already** `anon=false, authenticated=false,
  service_role=true`. D8's "the anon key must never be able to invoke a refresh RPC" was
  already true at the database level and remains so — verified after the change.
- `workbench_findings_sync` is SECURITY DEFINER granted to anon. This is the **same
  pattern the five read RPCs already use**, and it carries the identical
  `anon_security_definer_function_executable` WARN they each carry — not a new class of
  exposure. It cannot touch a cache table or a refresh RPC. It is required because
  RLS is deny-all, so the page cannot read its own remediation copy otherwise.
- `/api/workbench-recompute` **fails closed**: missing `WORKBENCH_REFRESH_SECRET` or
  `SUPABASE_SERVICE_ROLE_KEY` → 503, never an open endpoint. Secret compared with
  `crypto.timingSafeEqual`. The service key is server-only and never reaches the bundle.
- Advisor delta: exactly **2 INFO** (`rls_enabled_no_policy`, one per new table — the
  intended posture) and 2 WARN on the sync RPC as described above.

## 6. Observation not caused by this CC

`workbench_idf_cache.computed_at` moved from `2026-09-03 16:04:07` to
`2026-09-05 01:16:41` during this session. Jobid 348 has **zero** run history and does
not fire until 10:45 UTC; nothing else in the database calls `workbench_idf_refresh`
(`pg_proc` swept); and this session never executed it (the MCP role is denied). Some
other actor on this shared production database refreshed it. Recorded rather than
explained away.
