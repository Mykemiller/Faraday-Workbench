# CC-WORKBENCH-PILLAR-FEEDS-P2-P5-1.0

> **DRAFT — not open.** Raised by Myke 2026-09-05 at the close of
> CC-WORKBENCH-PILLAR-FRESHNESS-1.0: *"Draft separate CC to investigate and then
> update feeds for P2 and P5."* §1 precheck is deliberately unfilled — this is a
> draft for Myke to open, not an open CC.

| Field | Value |
| --- | --- |
| Status | Draft |
| Version | 1.0 |
| Owner | |
| Opened | |
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

3. **`institution_domain_tags` has no timestamp column at all** — it cannot be a
   last-write source without a schema change. Decide whether P5's binding keys on
   `institutions` alone.

4. **`max_staleness_days` is CHECK-constrained to 1–30** (`pfb_max_staleness_range`).
   `institutions` last moved 2026-08-30 — already 6 days at drafting. If the real cadence
   is slower than monthly, it **cannot be expressed** in the current schema, and the
   honest outcome is a `feed_kind` that is not measurable rather than a false 30.

### 5.2 — Investigation to run

- [ ] Identify what writes `companies` / `company_aliases`. Candidates to check:
      `cron.job` commands, edge functions, `automation_health_log` crawler ids near the
      2026-09-03 timestamps, `jw_data_source_registry` / `source_registry` rows.
- [ ] Same for `institutions` / `institution_domain_tags`.
- [ ] For each writer found, establish: is it scheduled (→ `cron` / `edge_function` /
      `crawler`, measurable) or hand-run (→ `manual`, **not** measurable)?
- [ ] Establish each writer's true cadence, and whether it fits 1–30 days.
- [ ] Choose the last-write column per table and confirm it is monotonic and set on
      every write path (the `company_aliases` `created_at`-only shape means an UPDATE
      would not move it — an update-heavy writer needs `updated_at`).

### 5.3 — Build, only if the investigation supports it

- [ ] Extend `pillar_feed_staleness_check()`'s resolver `CASE` with an arm per newly
      bound `resource_table`. **Version the `crawler_id` to `_v1.2`** (v1.1 is
      CC-WORKBENCH-PILLAR-FRESHNESS-1.0). Change nothing else — band logic, WHERE clause,
      `auto_id='AUTO-PILLAR-FEED'`, and the returned jsonb shape all stay fixed.
- [ ] Insert the P2/P5 bindings. Respect `pfb_feed_ref_presence`: `feed_kind` in
      (`none`,`static`) requires `feed_ref IS NULL`; anything else requires it NOT NULL.
- [ ] Run `pillar_feed_staleness_check()` to populate `last_write_at` + band.
- [ ] Run `workbench_idf_refresh()`; confirm P2/P5 flip `no_feed` → `measured` with a
      percentage that matches a hand count.
- [ ] Confirm P1/P3/P4/P6 `fresh` objects are **byte-identical** before/after.

### 5.4 — Honest-failure path

If a pillar's writer is manual or has no usable timestamp, **bind it with a
non-measurable `feed_kind` and leave it reporting `no_feed`.** Do not invent a
`max_staleness_days` to make the column green. That is the defect this whole lane exists
to prevent, and it is what the P4 binding did before it was corrected.

---

## 6 · Adversarial review

- **Required:** No — provided §5.4 holds and no scoring surface is touched. Flips to
  **Yes — internal** if the CC ends up changing `pillar_feed_staleness_check()` band
  logic or the FR ladder.
- **Reviewer:**
- **Packet sent:** §1–4 only
- **Findings:**
- **Disposition:**

---

## 7 · Decisions proposed at exit

| Proposed decision | Supersedes | Surface | Awaiting approval |
| --- | --- | --- | --- |
| P2 binding: resource table, feed_kind, cadence | — | Ingestion pipelines | Myke |
| P5 binding: resource table, feed_kind, cadence | — | Ingestion pipelines | Myke |
| Whether `institution_domain_tags` gains a timestamp column | — | Schema & storage | Myke |

**A decision that exists only in the session transcript did not happen.**

---

## 8 · Exit state

- What changed:
- What is still open:
- Surfaces released:
- Follow-on CC required:
