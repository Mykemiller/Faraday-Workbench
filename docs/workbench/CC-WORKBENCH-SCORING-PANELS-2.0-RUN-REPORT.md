# CC-WORKBENCH-SCORING-PANELS-2.0 — run report

**Applied to prod** `ycadmmngkdhvpcsrcuaq` on 2026-08-19. Read-only, additive.
**Score impact: none.** Repo capture: `sql/workbench_scoring_panels.sql`.

Supersedes CC-WORKBENCH-SCORING-PANELS-1.0 — `workbench_scoring_cache` confirmed
absent before any DDL, so 1.0 was never applied and there was nothing to roll back.

---

## 1. What shipped

| Object | Kind | Access |
|---|---|---|
| `workbench_scoring_cache` | table, single row `id=1` | RLS on, no policy; `anon`/`authenticated` revoked |
| `workbench_jpas_panel_compute()` | Panel 1, `stable` | `service_role` only |
| `workbench_jds_panel_compute()` | Panel 2, `stable` | `service_role` only |
| `workbench_jts_panel_compute()` | Panel 3, `stable` | `service_role` only |
| `workbench_scoring_panels_compute()` | assembler, `stable` | `service_role` only |
| `workbench_scoring_panels_refresh()` | writer, `volatile` | `service_role` only |
| `workbench_scoring_panels()` | reader, `stable` | `anon`, `authenticated`, `service_role` |
| `workbench-scoring-panels-refresh-hourly` | pg_cron **jobid 236**, `22 * * * *` | — |

Payload keys: `cc`, `jpas`, `jds`, `jts`, `computed_at`. Cache size **21 kB**.

Compute **11.87 s**; reader **5 ms**. That gap is why the reader is cache-only and
does **not** fall back to `_compute()` the way `workbench_health()` does — the
fallback is the exact query that would blow the anon statement cap.

Cron minute 22 is offset from the two existing Workbench refreshes (jobid 33 at
`*/5`, jobid 150 at `:07`) so the 12 s compute does not stack on them.

## 2. Findings re-verified before any DDL

All ten CC findings were re-queried live and all ten held. Highlights:

- **F4** — 9 live tiers, one weight each, summing to exactly 100; zero tiers carry
  a split weight; every tier's attribute weights sum to exactly 1.0000.
- **F5** — REG-10 remains the only cross-taxonomy divergence (`tier_code=REG`,
  `quality_tier_code=COM`).
- **F6** — imputation percentages match the CC exactly: REG 96.8 · RSC 92.1 ·
  ENV 50.7 · LBR 50.3 · PWR 50.3 · INC 1.1 · COM 1.1 · NET 0.9 · WTR 0.6.
- **F7** — 24 dark-data attributes over 36,854 jurisdiction-rows; PWR-11 is the
  sole live attribute whose `source_pipeline` still reads "GATED, not built".
- **F3** — 27 `is_active` ↔ `quality_is_active` contradictions.
- **F9/F10** — JDS 3,222 counties on `county-v1`, last computed 2026-08-18, **no
  cron**; JTS 0 models / 0 snapshots / 7 registry attributes.

Two CC figures were checked and are marginally off, in the CC's favour to state
precisely: `avg_completeness` reads **32.64** (the CC's §1 table does not quote it;
the JW CLAUDE.md quotes 32.60), and RSC's imputation denominator is **39,159**
jurisdictions rather than 39,307 — 148 breakdowns predate RSC activation and carry
no RSC key at all. The panel reports the real denominator per tier rather than
assuming a uniform one.

## 3. New findings (not in the CC)

**N1 — `jurisdictions.jds_l1..l4_count` are not written by `county-v1`.** All 3,222
scored rows carry `0` in the four flat layer columns while `jds_breakdown ->
demand_canonical` carries the real counts (82 counties with L1, 118 with L2, 127
with L3, 70 with L4; totals 782 / 290 / 385 / 93). Panel 2 was drafted against the
flat columns and rendered an all-zero layer table beside a non-zero score. It now
reads the breakdown — the same D5 rationale that governs the weights — and emits
`layer_coverage.flat_columns_stale: true` so the divergence stays visible. Nothing
was written to repair the columns; that belongs to the JDS composer.

**N2 — "measured" is the wrong word for JDS contention.** 1,542 counties are
imputed and 1,680 are not, but only **1,611** have measured queue coverage. The
69-row gap is exactly the counties where imputation was *suppressed* for having no
infrastructure — neither imputed nor measured. The field is named
`supply_contention_not_imputed` rather than `..._measured` for that reason.

**N3 — `live_with_zero_data` is currently 0.** Every one of the 40 quality-active
attributes has rows. The measure ships anyway as standing instrumentation (D10);
it is designed to be zero.

## 4. Deviations from the CC as written

**The CC text available to this session was truncated** partway through the Phase 2
listing, at `'live_but_registry_says_gated'`. Phase 1 and the bulk of Panel 1 were
applied as supplied. The remainder — the tail of `registry_vs_reality`,
`composer_defects`, Panel 2, Panel 3, the assembler, refresh, reader, grants and
cron — was authored against decisions D1–D12, which specify them completely.
Anything below is an authored choice, flagged for review rather than assumed:

- `registry_vs_reality` carries the four D10 measures plus a `_codes` array for
  each, so a reader can act on a finding without a second query.
- **`live_but_registry_says_gated` matches `(gated|not built)` only.** Four
  quality-active NET attributes (NET-02/04/05/07) have a **NULL** `source_pipeline`.
  That is undocumented, not gated, and folding them in would have mislabelled them.
  PWR-11 alone appears. The NULL-pipeline set is noted here instead.
- `weight_integrity` was added beyond D10: F4 observes the budget invariant holds
  but is undefended, so the panel measures `tiers_with_split_weight` and
  `tiers_attr_weights_off_one` (both 0 today) rather than asserting 100.
- Panel 2's `composer_is_scheduled` is accompanied by a `scheduled_jobs` array so
  the evidence is shown, not asserted. Caveat: `cron.job` is RLS-scoped to the
  calling role, so it reads jobs visible to the function owner.
- Panel 3's per-attribute blocking condition is emitted as a structured
  `blocked_by` (`registry_inactive` | `no_model_registered`) plus the registry's
  verbatim `blocking_note`. The feed list is eight named tables; **exactly one is
  empty — `ferc_form1_plant_additions` at 0 rows**, which is precisely the blocker
  JTS-07's registry note claims, now verifiable rather than asserted.

## 5. Verification

**Access control — 6/6 as designed.** Probed by setting `role anon` in-session:

| Check | Result |
|---|---|
| `workbench_scoring_panels()` | ALLOWED (expected) |
| `select` on `workbench_scoring_cache` | DENIED 42501 (expected) |
| `workbench_jpas_panel_compute()` | DENIED 42501 (expected) |
| `workbench_jds_panel_compute()` | DENIED 42501 (expected) |
| `workbench_jts_panel_compute()` | DENIED 42501 (expected) |
| `workbench_scoring_panels_refresh()` | DENIED 42501 (expected) |

**Read-only boundary (D12), proven two ways.**

1. *Source level.* Five of the six functions are `stable` and contain **no** write
   verb at all. The sixth (`_refresh`) is `volatile` and its only `INSERT` target is
   `workbench_scoring_cache` — a regex over `pg_get_functiondef` counting inserts
   into anything else returns **0** for all six.
2. *State level.* Every scoring surface is byte-identical to the pre-DDL reading
   taken at the top of this session:

   | Surface | Before | After |
   |---|---|---|
   | `jpas_attributes` | 745,507 | 745,507 |
   | `jps_history` | 40,365 | 40,365 |
   | `jw_score_history` | 772,961 | 772,961 |
   | `jts_snapshots` / `jts_model_registry` | 0 / 0 | 0 / 0 |
   | `avg(jpas_quality)` | 58.96 | 58.96 |
   | `avg(jpas_completeness)` | 32.64 | 32.64 |
   | `max(jpas_quality_computed_at)` | 19:12:48.46659 | 19:12:48.46659 |
   | `max(jds_computed_at)` | 2026-08-18 04:57:24 | 2026-08-18 04:57:24 |
   | `quality_is_active` | 40 | 40 |

**Security advisors — delta is exactly 3, all intended, all in-pattern.**
`INFO rls_enabled_no_policy` on `workbench_scoring_cache` (the deliberate deny-all
posture) and the `anon`/`authenticated` `security_definer_function_executable`
WARNs on the reader — the same two WARNs `workbench_health()` and
`workbench_forecast_model()` already carry, and the point of an anon-callable
reader. The five service-role-only functions appear in **neither** WARN list, and
**none** of the six appears under `function_search_path_mutable`.

## 6. Out of scope, recorded not actioned

Repairing `jpas_attributes.tier_code` (F2) · registering a JDS cron (F9) · fixing
either composer defect (F8) · the PWR-11 and WTR-07 registry corrections (F7) ·
the NET NULL-`source_pipeline` rows · the stale flat `jds_l*_count` columns (N1) ·
completing Group 1 activation (PWR-06, PWR-09) · any weight change, JTS model, or
front-end rendering. This CC delivers the data contract only.

## 7. Rollback

Additive only:

```sql
select cron.unschedule('workbench-scoring-panels-refresh-hourly');
drop function if exists public.workbench_scoring_panels();
drop function if exists public.workbench_scoring_panels_refresh();
drop function if exists public.workbench_scoring_panels_compute();
drop function if exists public.workbench_jts_panel_compute();
drop function if exists public.workbench_jds_panel_compute();
drop function if exists public.workbench_jpas_panel_compute();
drop table if exists public.workbench_scoring_cache;
```

Zero scoring impact — nothing downstream reads any of it yet.
