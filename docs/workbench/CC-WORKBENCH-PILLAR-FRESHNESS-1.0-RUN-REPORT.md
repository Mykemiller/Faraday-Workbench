# CC-WORKBENCH-PILLAR-FRESHNESS-1.0 — run report

Executed 2026-09-05. Backend: Supabase `ycadmmngkdhvpcsrcuaq`. Frontend: this repo.

## 1 · Dry run (§0), verbatim

| pillar | name | bindings_total | measurable | on_cadence | fresh_24h | fresh_7d |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Jurisdictions | 33 | 18 | 12 | 0 | 7 |
| 3 | People | 1 | 1 | 1 | 1 | 1 |
| 4 | Data Center Facilities | 1 | 0 | 0 | 0 | 0 |
| 6 | Sources | 2 | 2 | 2 | 2 | 2 |

Matched the CC's expected values exactly (P1 33/18/12 · P3 1/1/1 · P4 1/0/0 · P6 2/2/2).
P2 and P5 absent from the result set entirely, as predicted — which is precisely why the
map generates the pillar series rather than deriving it from binding rows.

## 2 · Snapshot

`public.pillar_feed_bindings_snapshot_20260904` — **37 rows**, equal to live.
Pre-change `workbench_idf_cache.computed_at` = **2026-09-03 16:04:07 UTC** (~33h stale).

## 3 · Migrations applied

| # | Migration | Result |
| --- | --- | --- |
| §1 | `pillar_feed_bindings_add_last_write_at` | ok |
| §2 | `pillar_feed_staleness_check_persist_last_write` | ok — v1.1 |
| §2 | `pillar_feed_staleness_check_backfill_last_write` | ok — 21 bindings banded |
| §3 | `pillar_feed_bindings_fix_p4_basis` | ok — see deviation below |
| §4 | `pillar_freshness_map_fn` | ok |
| §5 | `workbench_idf_compute_add_feed_freshness` | ok |
| §5 | `workbench_idf_refresh_after_freshness` | ok — asserted 6/6 `fresh` keys |
| §6 | `cron_workbench_idf_refresh_daily` | ok — jobid 347 |
| — | `pillar_feed_bindings_snapshot_rls_hardening` | ok — see §7 |

### Deviation, §3 — vocabulary CHECK

§3 was specified as a bare `UPDATE`, but `freshness_basis` carries
`pfb_freshness_basis_vocab`, a closed four-value CHECK
(`write_day_distribution | cron_binding | declared_static | manual_attestation`) that does
not admit `derivation_not_measured`. The bare UPDATE raised 23514 and rolled back.

Since the CC forbids improvising strings, the constraint was extended to admit **exactly
the value the CC specified** rather than substituting a different one. Additive only — no
existing value loosened or removed.

## 4 · P4 binding — corrected

| | before | after |
| --- | --- | --- |
| `freshness_band` | FR4 | **FR2** |
| `freshness_basis` | cron_binding | **derivation_not_measured** |
| `freshness_certainty` | 0.95 | **null** |

The band was changed per Myke 2026-09-05 ("Update P4"). FR4 asserts *measured, and beyond
its staleness window* — never true for this row: `pillar_feed_staleness_check()` excludes
`feed_kind='derivation'` from its WHERE clause, so the binding was never evaluated. FR2 is
the estate's established band for not-measured — it is what the check itself assigns when
`last_write` is null, and what the 14 `feed_kind='none'` P1 bindings already carry.

No FR-ladder registry table exists, so no registry semantics were contradicted.
**Reversal:** `update pillar_feed_bindings set freshness_band='FR4', freshness_basis='cron_binding',
freshness_certainty=0.95 where pillar_no=4 and feed_kind='derivation';`

## 5 · Backfill coverage

| pillar | measurable | with `last_write_at` | newest write |
| --- | --- | --- | --- |
| 1 | 18 | 18 | 2026-09-02 01:40 UTC |
| 3 | 1 | 1 | 2026-09-05 00:45 UTC |
| 4 | 0 | 0 | — |
| 6 | 2 | 2 | 2026-09-05 01:12 UTC |

21 of 21 measurable bindings populated. The v1.1 health-log row is contract-identical to
v1.0 — `artifacts_found/new/duped` = 21/6/15 on both, `auto_id='AUTO-PILLAR-FEED'`
unchanged; only `crawler_id` moved.

## 6 · Post-refresh payload

| pillar | state | measurable | on cadence | 24h | 7d |
| --- | --- | --- | --- | --- | --- |
| 1 Jurisdictions | measured | 18 | **67%** | 0% | 39% |
| 2 Companies | **no_feed** | 0 | — | — | — |
| 3 People | measured | 1 | 100% | 100% | 100% |
| 4 DC Facilities | **no_feed** | 0 | — | — | — |
| 5 Reg. & Research Bodies | **no_feed** | 0 | — | — | — |
| 6 Sources | measured | 2 | 100% | 100% | 100% |

`workbench_idf_cache.computed_at` refreshed to 2026-09-05 01:16 UTC (age 0.1h).
Cron `workbench-idf-refresh-daily` created as jobid **347**, `35 9 * * *`, active.

> **⚠ SUPERSEDED SAME DAY — the live schedule is `45 10 * * *` (jobid 348).**
> A parallel session (CC-WORKBENCH-FINDINGS-REMEDIATION-1.0) replaced jobid 347 while
> regrouping the daily workbench refreshes into one sequence: scoring `15 10` → storefront
> `30 10` → IDF `45 10`. **Left in place deliberately.** This CC's requirement was
> *ordering* — the refresh must run after `pillar-feed-staleness-check-daily` (`20 9`) so
> bands and `last_write_at` are current — and 10:45 satisfies it with more margin than
> 09:35 did. DONE-WHEN #5 names the literal `35 9 * * *`; **production and that string
> disagree, and production is correct.** Both crons were later observed firing
> autonomously: staleness check 09:20:00, IDF refresh 10:45:00, both succeeded.

**The honesty pattern holds:** no pillar renders 0% for "nothing bound". P1 is the case
the column exists for — 67% on cadence against 0% at 24h, because its feeds are weekly
and monthly publishers that are healthy while being nowhere near daily.

## 7 · Security

The §0 snapshot was created with `CREATE TABLE AS`, which does not enable RLS — this
raised a new **ERROR** `rls_disabled_in_public`. Corrected in the same pass to the estate
deny-all posture (RLS on, no policy, grants revoked). Advisor delta for the whole CC is
now exactly **+1 INFO `rls_enabled_no_policy`**; ERROR count fell 8 → 7.
`pillar_freshness_map()` raises no advisor (EXECUTE revoked from PUBLIC/anon/authenticated).

## 8 · Frontend

`index.html` — `renderIdf()`. Confirmed reading `workbench_idf()` via
`${SB_URL}/rest/v1/rpc/workbench_idf`. Column added between REVIEW and GEOGRAPHIC
ATTAINMENT (FA); caption block added beside "FA is structure, not values". Colour
thresholds reuse the FA column's existing `<50%` rule rather than introducing a second
convention. Fixture updated with the live `fresh` capture so the suite exercises the
measured branch. `npm test` green across all three files.

## 9 · Still open

- **Not pushed, not deployed** — per CC §7 and the autonomy boundary.
- P2/P5 feed bindings: `CC-WORKBENCH-PILLAR-FEEDS-P2-P5-1.0` drafted alongside this.
- The staleness resolver still covers only three `resource_table` values; anything else
  falls through to FR2 silently. Owned by the P2/P5 CC.


## 10 · Follow-up: the silent-resolver trap is closed (2026-09-05)

Migration `pillar_feed_resolvable_tables_guard`.

`pillar_feed_staleness_check()` resolves a last-write for exactly three tables. A fourth
would fall through its `CASE` to NULL and band **FR2 with no error and no log line** —
sitting in the `measurable` denominator forever, dragging `pct_on_cadence` down while
measuring nothing. That is the same class of defect as the P4 binding, one layer up.

- **`pillar_feed_resolvable_tables`** (deny-all RLS) is the allowlist, seeded with the
  three tables and each one's resolver expression.
- **`trg_pillar_feed_binding_resolvable`** rejects any *measurable* binding
  (`feed_kind` in cron/edge_function/crawler **with** `max_staleness_days`) on a table not
  in that list. The error names the fix: add the resolver arm **and** the allowlist row, or
  declare the binding non-measurable.
- **`pillar_feed_resolver_drift_check()`** guards the dangerous direction — an allowlisted
  table whose name no longer appears in the resolver body (arm removed or renamed). The
  opposite direction fails safe: a new arm without an allowlist row just makes the guard
  stricter than necessary, and the error says so.

Nothing was in the bad state: all 21 measurable bindings already sat on the three
resolvable tables, so the guard is preventive, not corrective. Verified by a
self-rolling-back probe — a measurable binding on `companies` was **rejected**, the same
table as `derivation` was **allowed**, and a measurable binding on `entities` was
**allowed**. Zero residue after rollback; 40 bindings before and after; P1 still `measured`.

**Known limitation:** the allowlist duplicates knowledge held in the resolver's `CASE`,
so the two can drift. `pillar_feed_resolver_drift_check()` detects the direction that
matters. Folding the resolver itself onto the config table would remove the duplication
and is the better long-term shape — deliberately not done here, as it means rewriting a
function this CC had pinned.
