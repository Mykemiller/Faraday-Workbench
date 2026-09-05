# CC-WORKBENCH-PILLAR-FEEDS-P2-P5-1.0

> **CLOSED 2026-09-05.** Raised by Myke at the close of
> CC-WORKBENCH-PILLAR-FRESHNESS-1.0 (*"Draft separate CC to investigate and then
> update feeds for P2 and P5"*), then opened and executed on his
> *"All open items are reviewed, proceed with recommendations."*
>
> **Verdict: neither pillar has a feed.** The investigation reached §5.4, the
> honest-failure path, and no measurable binding was created. See §5.1a.

| Field | Value |
| --- | --- |
| Status | Closed |
| Version | 1.0 |
| Owner | Claude (executed) |
| Opened | 2026-09-05 |
| Product | Faraday Workbench / IDF 5.0 |
| Jira | |
| Supersedes CC | — |
| Notion CC record | |

**Surfaces held:** Ingestion pipelines · Schema & storage
**Surfaces explicitly NOT held:** Scoring models · Geo spine · Taxonomy & vocabulary ·
Public claims & surface. This CC does not touch `jpas_attributes`, JPS posture, JDS, or
any scoring composer, and it does not alter the Six Pillars table beyond the values that
already flow through `pillar_freshness_map()`.

---

## 0 · Version delta

First version.

---

## 1 · Entry precheck

- [ ] Surfaces held declared above
- [ ] Surfaces explicitly NOT held declared
- [ ] Faraday Decision Log queried for `Status = Accepted` on Ingestion pipelines + Schema & storage
- [ ] `Affects` followed one hop from each loaded decision
- [ ] `Decisions in force` populated below AND in the Notion CC record
- [ ] Conflicts surfaced below, not resolved silently

**Decisions in force:**

| DEC | Decision | Surface | Bears on this CC how |
| --- | --- | --- | --- |
| | | | |

**Conflicts or ambiguities found at entry:**

---

## 2 · Objective

At close, Pillars 2 (Companies) and 5 (Reg. & Research Bodies) either carry declared,
resolvable feed bindings in `public.pillar_feed_bindings` — so the Workbench Six Pillars
`FEED FRESHNESS` column reports a measured on-cadence percentage for them — or they carry
a written, evidenced finding that no automated feed exists to bind, and continue to report
`no_feed` honestly rather than being given a binding that cannot be measured.

**The question this CC answers is not "are P2 and P5 fed?" It is "is what feeds them
declarable and measurable?"** Those are different, and the pre-work below shows the
distinction is live.

---

## 3 · Out of scope

- Creating new ingestion pipelines for companies or institutions. If the finding is
  "nothing writes these tables on a cadence", building the writer is a separate CC.
- P4 (DC Facilities). Its single binding is `feed_kind='derivation'`, corrected to
  `freshness_basis='derivation_not_measured'` / `FR2` by CC-WORKBENCH-PILLAR-FRESHNESS-1.0.
  A derivation confers no freshness by definition; giving P4 a real feed is its own CC.
- Any change to the band ladder FR0–FR5 or to `pillar_feed_staleness_check()`'s band logic.
- Any subscriber-facing surface. The Workbench is admin-only.

---

## 4 · Preconditions

Exact `COUNT(*)` only — never `pg_class.reltuples`.

| Check | Query / method | Expected | Actual | Pass |
| --- | --- | --- | --- | --- |
| P2/P5 still unbound | `select pillar_no, count(*) from pillar_feed_bindings where pillar_no in (2,5) group by 1` | 0 rows | | |
| Freshness column live | `select p->'fresh'->>'state' from jsonb_array_elements(workbench_idf()->'pillars') p` | `no_feed` at P2 and P5 | | |
| IDF cache is fresh | `select computed_at from workbench_idf_cache where id=1` | < 24h old | | |
| Staleness cron alive | `select active from cron.job where jobname='pillar-feed-staleness-check-daily'` | `t` | | |

---

## ▼ REVIEW PACKET BOUNDARY ▼

---

## 5 · Work

### 5.1 — Pre-work already done (2026-09-05, carried from CC-WORKBENCH-PILLAR-FRESHNESS-1.0)

Measured live. **These four findings are the reason this CC is worth opening, and they
change its likely shape:**

| Table | Rows | Newest write | Reading |
| --- | --- | --- | --- |
| `companies` | 7,953 | 2026-09-03 08:39 UTC | **Actively written** |
| `company_aliases` | 9,930 | 2026-09-03 07:22 UTC (`created_at`) | **Actively written** |
| `institutions` | 176 | 2026-08-30 00:36 UTC | **Actively written** |
| `institution_domain_tags` | 402 | no timestamp column | Unknown |

1. **P2 and P5 are not cold.** Both home tables carry recent writes. The pillars report
   `no_feed` because **nothing is declared in `pillar_feed_bindings`** — not because
   nothing is flowing. The investigation is therefore mostly *attribution*: find the
   writer, name it, bind it. That is a much smaller job than building a feed.

2. **⚠ The resolver is the real blocker, and it is a hard prerequisite.**
   `pillar_feed_staleness_check()` resolves last-write for exactly three
   `resource_table` values — `jpas_attributes`, `source_registry`, `entities`. Anything
   else **falls through the `CASE` to NULL and is banded `FR2` silently**. So a binding
   created for `companies` or `institutions` today would be declared, would be counted in
   `measurable`, and would then drag `pct_on_cadence` down while reporting nothing real.
   **Binding P2/P5 without extending the resolver first makes the column *less* honest,
   not more.** Extending the resolver was explicitly out of scope for
   CC-WORKBENCH-PILLAR-FRESHNESS-1.0; this CC owns it.

3. ~~**`institution_domain_tags` has no timestamp column at all**~~ — **WRONG, corrected
   at execution.** It has `created_at` (but no `updated_at`). Moot regardless: P5 has no
   writer, so no last-write source of any kind is needed.

4. **`max_staleness_days` is CHECK-constrained to 1–30** (`pfb_max_staleness_range`).
   `institutions` last moved 2026-08-30 — already 6 days at drafting. If the real cadence
   is slower than monthly, it **cannot be expressed** in the current schema, and the
   honest outcome is a `feed_kind` that is not measurable rather than a false 30.

### 5.1a — INVESTIGATION RESULT (2026-09-05): no feed on either pillar

The draft's framing — *"mostly attribution: find the writer, name it, bind it"* — was
**wrong, and the error was in the optimistic direction.** Recent writes are not evidence of
a feed. Both pillars are written by things that ingest nothing.

**P2 Companies — 7 active cron jobs, every one a derivation.**

| job | id | schedule | writes `companies`? | inserts? |
| --- | --- | --- | --- | --- |
| companies-entity-binder-nightly | 294 | `15 3 * * *` | no | no |
| companies-signal-rollup-nightly | 295 | `35 3 * * *` | no | no |
| companies-sec-summary-nightly | 296 | `45 3 * * *` | no | no |
| companies-confidence-recompute-nightly | 297 | `55 3 * * *` | **yes** | no |
| companies-alias-miner-weekly | 299 | `10 5 * * 1` | no | aliases only |
| companies-registry-recount-daily | 300 | `45 5 * * *` | no | no |
| companies-about-page-weekly | 343 | `40 4 * * 0` | no | no |

**Not one of the nine backing functions INSERTs into `companies`.** The single writer,
`fn_company_confidence_recompute`, recomputes confidence from rows already present — the
exact P4 pattern. `fn_company_alias_generate` does insert, but it *generates* aliases from
names already stored; there is no external source.

**The decisive evidence is a timing contradiction:** jobs 294/295/296/297/300 all
**succeeded between 03:15 and 05:45 on 2026-09-05**, while `max(companies.updated_at)` still
reads **2026-09-03**. The recompute is skip-identical, so it writes nothing when nothing
changes. No new `companies` row has been created since **2026-08-29**. The 6,568-row spike
on 09-03 was one bulk event, not a cadence.

**Had P2 been bound as the draft assumed** — `companies` / `cron` / `updated_at` /
`max_staleness_days` 1–7 — it would have shown FR5 for a day or two after each bulk
recompute and then decayed to FR4, reporting *"this feed is broken"* about a feed that does
not exist, while seven cron jobs ran green. Strictly worse than `no_feed`.

**P5 Reg. & Research Bodies — no writer at all.** Zero functions insert or update
`public.institutions`; zero cron jobs reference it. All 176 rows were promoted once from
`stg_institution_candidates` on 2026-08-28..30 (`source_table` is that staging table on
every row). Nothing has touched it since 2026-08-30.

### 5.2 — What was built (§5.4 honest-failure path)

Migration `pillar_feed_bindings_declare_p2_p5_non_measurable`. Three bindings, all with
**non-measurable `feed_kind`**, so they are invisible both to
`pillar_feed_staleness_check()` (filters `feed_kind in ('cron','edge_function','crawler')
AND max_staleness_days is not null`) and to `pillar_freshness_map()`'s `measurable` count:

| pillar | resource_table | feed_kind | feed_ref | band | basis | max_staleness_days |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | `companies` | `derivation` | companies-confidence-recompute-nightly | FR2 | derivation_not_measured | **null** |
| 2 | `company_aliases` | `derivation` | companies-alias-miner-weekly | FR2 | derivation_not_measured | **null** |
| 5 | `institutions` | `none` | *(null)* | FR2 | manual_attestation | **null** |

Each carries its evidence in `notes`. **The pillars gain a recorded reason, not a
percentage** — both still render `— · no_feed`.

`max_staleness_days` is deliberately **null** on all three. Giving a derivation a staleness
window is what produced the P4 defect. (Note P4 itself still carries a vestigial `30`; it is
inert, because the check's `feed_kind` filter excludes it first. Left alone — out of scope.)

### 5.3 — Verification

In-transaction assertions (migration would have rolled back on any failure): P2 and P5 still
`state='no_feed'`, `measurable=0`, `pct_on_cadence=null`; `bindings_total` 0→2 and 0→1;
P1/P3/P6 still `measured` at 67 / 100 / 100; and no P2/P5 binding carries a measurable
`feed_kind`. Post-refresh payload confirms all six pillars unchanged in state.

**Resolver prerequisite is MOOT.** The draft called extending
`pillar_feed_staleness_check()`'s three-arm resolver to `companies` / `institutions` a hard
prerequisite. There is nothing measurable to resolve, so the resolver was **not touched** —
it remains at three arms.

> **The trap it left is now closed (2026-09-05, migration `pillar_feed_resolvable_tables_guard`).**
> A table outside those three arms still falls through to FR2 silently — but a *measurable*
> binding can no longer be declared on one. `pillar_feed_resolvable_tables` is the allowlist
> and `trg_pillar_feed_binding_resolvable` enforces it, so the failure mode is now a loud
> error at write time instead of a wrong number forever. Detail:
> `CC-WORKBENCH-PILLAR-FRESHNESS-1.0-RUN-REPORT.md` §10.

### 5.4 — Honest-failure path (as designed, and as taken)

Neither pillar was given a `max_staleness_days` to make the column green. Recorded here
because it is the outcome the section existed to permit.

---
## 6 · Adversarial review

- **Required:** **No.** §5.4 held, the FR ladder and band logic were untouched, and no
  scoring surface was involved. The trigger condition (changing
  `pillar_feed_staleness_check()` band logic) did not occur — the function was not modified.
- **Reviewer:** n/a
- **Packet sent:** n/a
- **Findings:** n/a
- **Disposition:** n/a

---

## 7 · Decisions proposed at exit

| Proposed decision | Supersedes | Surface | Awaiting approval |
| --- | --- | --- | --- |
| P2 is a derivation surface, not a feed: `companies` + `company_aliases` bound as `derivation` / not-measured | — | Ingestion pipelines | Applied 2026-09-05 |
| P5 has no writer: `institutions` bound as `none` / `manual_attestation` | — | Ingestion pipelines | Applied 2026-09-05 |
| `institution_domain_tags` timestamp column — **withdrawn**, it already has `created_at` and P5 needs no last-write source | — | Schema & storage | n/a |
| **A pillar reads `no_feed` until an INGEST exists. Building one for P2 or P5 is a separate CC.** | — | Ingestion pipelines | Myke |

**A decision that exists only in the session transcript did not happen.**

---

## 8 · Exit state

- **What changed:** three non-measurable bindings declared (migration
  `pillar_feed_bindings_declare_p2_p5_non_measurable`); `workbench_idf_cache` refreshed.
  No function, no resolver, no band logic, no scoring surface touched. Zero
  `jpas_attributes` / JPS / JDS writes.
- **What is still open:** P2 and P5 remain `no_feed` and will until someone builds an
  ingest. Nothing here brings one closer — it records why there isn't one.
- **Surfaces released:** Ingestion pipelines · Schema & storage.
- **Follow-on CC required:** yes, if Myke wants either pillar measurable — that is an
  ingest-building CC, explicitly out of scope here (§3). The three-arm resolver limit
  is a standing trap for any future binding and should be fixed by whichever CC first
  needs it.
- **Rollback:** `delete from public.pillar_feed_bindings where pillar_no in (2,5) and
  freshness_basis in ('derivation_not_measured','manual_attestation');` then
  `select public.workbench_idf_refresh();` — restores `bindings_total` 0/0. No other
  state is involved.
