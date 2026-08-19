# CC-WORKBENCH-SCORING-PANELS-UI-1.0

| Field | Value |
| --- | --- |
| Status | **Closed** 2026-08-19 |
| Version | 1.0 |
| Owner | Myke |
| Opened | 2026-08-19 |
| Product | Faraday Workbench |
| Jira | — |
| Supersedes CC | None. Companion to CC-WORKBENCH-SCORING-PANELS-2.0 (merged, PR #8) |
| Notion CC record | — |

**Surfaces held:** Public claims & surface (the Workbench page) · Agent operations (refresh cadence)

**Surfaces explicitly NOT held:** Scoring models · Schema & storage · Ingestion pipelines · Taxonomy & vocabulary · Geo spine · Brand & identity

> This CC adds **no** new SQL objects and changes **no** score. It renders a payload that
> already exists and moves one cron. A parallel CC may safely touch any scoring model,
> ingestion lane or registry row while this runs — this one only reads.

---

## 0 · Version delta

First version. CC-WORKBENCH-SCORING-PANELS-2.0 shipped the data contract
(`workbench_scoring_panels()`, cron jobid 236) and explicitly deferred front-end
rendering. This CC closes that deferral. No decision from 2.0 moves; two are
**operationalised** for the first time (D9 imputation coverage and D11 composer
defects become visible rather than merely emitted), and one is **changed**: 2.0's
hourly refresh becomes daily (§5.3).

---

## 1 · Entry precheck

*Draft — the session that opens this CC completes the checklist. Boxes are unticked
because a draft is not open.*

- [ ] Surfaces held declared above
- [ ] Surfaces explicitly NOT held declared
- [ ] Faraday Decision Log queried for `Status = Accepted` on Public claims & surface, Agent operations
- [ ] `Affects` followed one hop from each loaded decision
- [ ] `Decisions in force` populated below AND in the Notion CC record
- [ ] Conflicts surfaced below, not resolved silently

**Decisions in force** *(carried from CC-2.0 and the JW canon; confirm each against the
Decision Log at entry — they are cited here from CLAUDE.md and the 2.0 run report, not
from a Log query):*

| DEC | Decision | Surface | Bears on this CC how |
| --- | --- | --- | --- |
| CC-2.0 D2 | One shared cache, three payload keys, one cron | Agent operations | One fetch serves all three panels. Do not add a second fetch or a second cron. |
| CC-2.0 D4 | Live lane authoritative; `is_active` labelled dead | Public claims & surface | The page must not render `is_active` as if it gates anything. |
| CC-2.0 D7 | Panel 3 is JTS **Readiness**, not JTS Formula | Public claims & surface | The page must not render a trajectory score, and must not present PFI as JTS. |
| CC-2.0 D9 | Per-tier imputation coverage is emitted | Public claims & surface | This CC makes it *visible*. Rendering a tier weight without its imputation rate is the failure D9 exists to prevent. |
| CC-2.0 D11 | Composer defects emitted as structured caveats | Public claims & surface | Same: they must render as warnings, not tooltips. |
| CC-2.0 D12 | Read-only | Schema & storage | The page is a reader. No write path is introduced. |
| DEC-31 | `tier_quality` divides by returning attributes ("absence is free") | Scoring models | **Proposed, not Confirmed.** The page must render its status honestly as Proposed. |
| JW invariant #2 | JPS weighting model/formula never sent to the client | Scoring models | See conflict C1. JPS weights are **not** in the payload; JPAS quality tier weights are. |

**Conflicts or ambiguities found at entry:**

**C1 — The page is `noindex`, not access-controlled, and this CC's premise is that it is
internal.** `vercel.json` sets `X-Robots-Tag: noindex, nofollow` and `index.html` carries
the same meta tag. There is **no** Vercel Deployment Protection, no auth, and the
Supabase publishable key is embedded in the page source (`index.html:309`). "Internal
only" is therefore enforced by obscurity, not by a control. Two things follow, and they
point in opposite directions:

- *Against alarm:* this CC adds **discoverability, not access**. Every field it renders is
  already retrievable today by anyone holding that key, because CC-2.0 granted
  `workbench_scoring_panels()` to `anon`. **Verified 2026-08-19, not assumed:** a POST to
  `/rest/v1/rpc/workbench_scoring_panels` carrying only the publishable key from
  `index.html:309` returns **HTTP 200 and the full 21,303-byte payload**, tier weights
  included. Rendering it changes nothing about who *can* read it.
- *For alarm:* CLAUDE.md records a standing discipline that JPAS tier weights are
  service-role-only and "never select client-side (invariant #2 discipline, same as
  `jpas_breakdown`)". Panel 1 emits the **live tier weight vector** (PWR 30 · COM 15 ·
  WTR 10 · NET 10 · ENV 10 · REG 10 · INC 5 · LBR 5 · RSC 5). That is the JPAS quality
  model config, not per-jurisdiction `jpas_quality_breakdown`, and not JPS weights — but
  it is close enough to the discipline's intent that it should be ruled on rather than
  assumed.

**RULED 2026-08-19 — Myke: "proceed as is."** Read as: the access posture is left
unchanged (no Deployment Protection), and the CC proceeds. Per the terms below, that
obliges §7 to carry the Proposed decision explicitly, rather than let the CLAUDE.md
JPAS-weight note be contradicted in silence. It is recorded there. **The page now renders
the live JPAS tier weight vector to any holder of the publishable key.**

Original recommendation, retained for the record:
enable Vercel Deployment Protection on the `faraday-workbench` project before merge, then
render everything. That makes "internal only" true, and it retires the ambiguity for the
existing two panels as well. If protection is declined, the CC should still proceed —
because of the *against alarm* point above — but §7 should carry a Proposed decision
stating plainly that JPAS quality tier weights are public-by-anon-key, so the discipline
in CLAUDE.md is documented as no longer holding rather than quietly contradicted.

**C2 — Daily refresh makes staleness a rendering problem.** See §5.3. Not a blocker; it
is why §5.2.A exists.

---

## 2 · Objective

At close, `index.html` renders the three scoring panels — JPAS tier status, JDS status,
JTS readiness — from the single `workbench_scoring_panels()` RPC, in the Observability
section beside the existing health and forecast panels, with every caveat the payload
carries rendered **above** the numbers it qualifies rather than beneath them; and the
refresh cron runs once daily rather than hourly, matching the cadence at which the
underlying scores actually change. A reader who opens the page and reads only the top of
each panel should come away knowing what is broken, what is imputed, and what is not
computed at all — before they see a single score.

---

## 3 · Out of scope

- **Any change to a score, weight, registry row, or composer.** Every defect this page
  renders stays unfixed by this CC: the JDS cron (F9), both composer defects (F8), the
  PWR-11 / WTR-07 registry corrections (F7), the stale flat `jds_l*_count` columns,
  the four NET attributes with NULL `source_pipeline`.
- **New SQL objects.** No table, function, view or grant. The payload is consumed as-is.
- **Reshaping the payload.** If a field is missing for the design, the design bends, not
  the contract — reopening `workbench_*_panel_compute()` is a CC-2.1, not this.
- **The existing IDF / Daily Challenge / Forecast panels.** Untouched, including their
  markup and their fetches.
- **Auth on the Workbench page.** C1 recommends it; enabling it is a Vercel project
  setting and a separate action, not a code change in this repo.
- **Any marketing, narrative or persuasive framing.** This is an instrument panel.

---

## 4 · Preconditions

Run before work begins. Exact `COUNT(*)` only.

| Check | Query / method | Expected | Actual | Pass |
| --- | --- | --- | --- | --- |
| Payload reachable as anon | `POST /rest/v1/rpc/workbench_scoring_panels` with the page's publishable key | HTTP 200, JSON with keys `cc, jpas, jds, jts, computed_at` | **200, 21,303 bytes, all keys present** (verified 2026-08-19) | ✅ |
| Cache is populated | `select count(*) from workbench_scoring_cache where id = 1` | 1 | 1 | ✅ |
| Cron 236 exists and is hourly | `select schedule, active from cron.job where jobname = 'workbench-scoring-panels-refresh-hourly'` | `22 * * * *`, `active = true` | as expected | ✅ |
| No competing scoring-panel cron | `select count(*) from cron.job where command ilike '%scoring_panels%'` | 1 | 1 | ✅ |
| Page currently calls two RPCs | `grep -o 'rpc/[a-z_]*' index.html \| sort -u` | exactly `rpc/workbench_health`, `rpc/workbench_forecast_model` | exactly those two | ✅ |
| Page does not already reference the panels | `grep -c 'scoring_panels' index.html` | 0 | 0 | ✅ |
| Payload carries the caveat fields the design depends on | `select public.workbench_scoring_panels() -> 'jpas' ? 'composer_defects'`, and likewise `jds ? 'caveats'`, `jts ? 'formula_exists'` | `true` ×3 | `true` ×3 | ✅ |
| Deployment protection decision recorded (C1) | Myke's ruling captured in §7 | Recorded either way | "proceed as is" — recorded in §1 C1 and §7 | ✅ |

---

## ▼ REVIEW PACKET BOUNDARY ▼

*Everything ABOVE this line is the adversarial review packet. Everything BELOW is the
work and the reasoning that produced it — withhold it from the reviewer.*

---

## 5 · Work

**Applied 2026-08-19.** Sections 5.1–5.3 describe what was built; 5.4 is the verification
actually run, with results.

### 5.1 · Where it goes

One new `<div class="subhead">` + container per panel in the existing Observability
`.wrap` in `index.html`, directly after `#forecast-model` (line ~177), following the
established pattern exactly:

```html
<div class="subhead">JPAS — tier status</div>
<div id="jpas-panel"><div class="hnote">Loading JPAS tier status…</div></div>

<div class="subhead">JDS — demand signal status</div>
<div id="jds-panel"><div class="hnote">Loading JDS status…</div></div>

<div class="subhead">JTS — readiness</div>
<div id="jts-panel"><div class="hnote">Loading JTS readiness…</div></div>
```

One `loadScoringPanels()` doing a single POST to `/rest/v1/rpc/workbench_scoring_panels`
(D2 — one payload, one fetch), dispatching to three `render*()` functions. Failure
follows the existing convention: a red `.hnote` per panel saying the live fetch failed,
never a silent blank and never a stale number presented as current.

Reuses existing CSS only — `.subhead`, `.hnote`, `.dscroll`, `.dtable`, `.feed-ok`,
`.feed-no`, and the `--red` / `--amber` / `--live` / `--idle` vars. One new class is
justified: `.caveat` (see 5.2.A).

### 5.2 · Caveat-forward rendering

The governing rule, and the thing a reviewer should check first: **in every panel, the
caveat block renders before the data block.** A reader who stops after the first screen
of a panel must have received the bad news.

**A. Payload age banner** — one line at the top of the scoring block, above all three
panels, reading `computed_at` and its age. Green under 26h, amber 26–50h, red beyond 50h
or when `computed_at` is null. This is load-bearing precisely *because* the refresh
becomes daily (§5.3): a health dashboard that can be a day old must say how old it is.
This is the one new CSS class.

**B. Panel 1 — JPAS.** Caveat block first:

- Both `composer_defects` as named warnings, each with its `effect` and its `status`
  rendered verbatim — including "Proposed, not Confirmed" for DEC-31. The page must not
  round a Proposed decision up to a fact.
- `weight_integrity`: the budget, `budget_is_100`, `tiers_with_split_weight`,
  `tiers_attr_weights_off_one`, and the `composer_divisor` note that the divisor is a
  hardcoded `/100.0`. Red if the budget is not 100 or either count is non-zero.
- `legacy_flag_note` verbatim, with the `active_flag_contradictions` count (27 today).

Then the tier table: tier · weight · attrs live · attrs at zero weight · rows ·
jurisdictions with data · **% imputed** · confidence mix · last write. The imputation
column is colour-coded — red at ≥90%, amber at ≥50% — so REG at 96.8% and RSC at 92.1%
read as alarms in the same glance as their weights (10 and 5). That pairing *is* the
point of D9: RSC carries 5 points of weight and 92% of it is a state median.

Then `registry_vs_reality` as its own small table — dark-data attributes and their codes,
live-with-zero-data, live-but-registry-says-gated, flag contradictions — each with its
code list rendered, so a finding is actionable without a second query.

**C. Panel 2 — JDS.** Caveat block first, driven by the payload's own `caveats` array
plus two computed emphases:

- `composer_is_scheduled: false` renders **red**: "NO SCHEDULE — nothing refreshes this
  score", with days since `last_computed_at` (2026-08-18 as of drafting).
- Imputation: `pct_supply_contention_imputed` with the 69-row nuance stated —
  1,542 imputed, 1,680 not imputed, but only 1,611 *measured*; the gap is where
  imputation was suppressed for absent infrastructure. The field is deliberately named
  `supply_contention_not_imputed`, and the page must not relabel it "measured".
- `layer_coverage.flat_columns_stale: true` renders red: the flat
  `jurisdictions.jds_l*_count` columns are zero on all 3,222 rows and any other consumer
  reading them sees an empty pipeline.

Then weights (from the persisted breakdown, per D5), formula versions, tier
distribution, and layer coverage from the breakdown.

**D. Panel 3 — JTS.** `formula_exists: false` is the headline, rendered red at the top:
"NO MODEL REGISTERED — nothing computes a trajectory score." Then the 7-attribute table
with `blocked_by` and the verbatim `blocking_note`; then the feed table with the single
empty feed (`ferc_form1_plant_additions`, 0 rows) flagged `.feed-no`, which is exactly
the blocker JTS-07's registry note claims. Then the PFI block, visually separated and
captioned from `adjacent_live_system.relationship` — "Adjacent, not JTS" — so it can
never be read as a trajectory score (D7).

### 5.3 · Refresh cadence: hourly → daily

```sql
select cron.unschedule('workbench-scoring-panels-refresh-hourly');
select cron.schedule(
  'workbench-scoring-panels-refresh-daily',
  '15 10 * * *',
  $cron$select public.workbench_scoring_panels_refresh();$cron$
);
```

The job is renamed, not just rescheduled — a job called `…-hourly` running daily is the
kind of small lie that costs an hour of someone's life later.

**Why daily is the right cadence, not merely the instructed one:** hourly implied a
freshness the sources do not have. JDS last computed 2026-08-18 and is on no cron at all.
JPAS quality recompute is a manual/batch operation. The daily JPAS-writing jobs finish by
08:45 UTC (`bls-quality-settle`), and the daily ingest/health band ends at 09:45. Cost is
not the argument — the compute is 11.87 s, so hourly costs ~4.7 min of DB time a day and
daily costs ~12 s; either is free. The argument is honesty about cadence.

**10:15 UTC** is proposed because it is empty in `cron.job` and sits after the daily
ingest band (ends 09:45) and before the engine band (`engine-jps-scorer` 11:30). Move it
freely; nothing depends on the exact minute.

**Consequence, stated plainly:** the panel can be up to ~24h stale, so it will not show a
break that happened this morning. That is acceptable for a status board over
daily-or-slower sources, and it is why §5.2.A exists. To force a fresh read:
`select public.workbench_scoring_panels_refresh();` under `service_role`.

### 5.4 · Verification — run 2026-08-19

Container egress to `*.supabase.co` is policy-blocked, so the page could not be tested
against the live endpoint from here. Instead the **real 21,252-byte payload** was pulled
server-side, written to disk, and served to a headless Chromium via a route intercept —
so the render path was exercised against real data, not a hand-built fixture.

**Suite 1 — render against the real payload: 28/28 pass.**

- No JS exceptions. (Network console noise from the two deliberately-aborted sibling RPCs
  and `file://` font loads is excluded — it is not a defect in this code.)
- **The governing rule is asserted mechanically, per panel:** the first child element of
  each of `#jpas-panel`, `#jds-panel`, `#jts-panel` is a `.caveat` block, and every caveat
  precedes every data block. This is the assertion to keep if any other is dropped.
- JPAS: 9 tier rows; 4 registry-vs-reality rows; **exactly two tiers red at ≥90% imputed
  (REG 96.8%, RSC 92.1%)** and three amber at ≥50%; DEC-31 renders titled "Proposed, not
  Confirmed"; the `conf_mult` defect renders titled "Live"; weight budget renders green.
- JDS: "No schedule" and "Flat layer columns are stale" both present and red; the
  measured-vs-not-imputed distinction stated verbatim; 1,611 shown.
- JTS: "No model registered" headline; PFI labelled adjacent/not a trajectory score;
  `ferc_form1_plant_additions` named and flagged empty.

**Suite 2 — states and failure paths: 10/10 pass.**

| Case | Result |
| --- | --- |
| 3h old | green |
| 30h old | amber |
| 80h old | red, "3d old" |
| `computed_at` absent | red, "the refresh has never run" |
| HTTP 500 | all three panels report unavailable; **age banner cleared** so no stale age is shown as current; no exceptions |
| `jds` key null | honest per-panel message, not a crash |

**One real defect found and fixed during verification.** `.codes` lost specificity to the
existing `.dtable td{white-space:nowrap}`, so the attribute-code lists refused to wrap and
forced a very wide horizontal scroll — the same trap the file's own CSS already warns
about two rules above ("must out-specify `.dtable td{color:…}`"). Corrected to
`.dtable td.codes` with a `max-width`.

**Read-only re-proof.** No scoring surface was touched by this CC: it adds no SQL object
and the only database change is the cron swap. `select count(*) from cron.job where
command ilike '%scoring_panels%'` = **2** after the swap (the daily job plus the dated
one-off), and the hourly job is gone.

## 6 · Adversarial review

- **Required:** **No.** No scoring model changes, no grain change, no geo spine, no
  decision superseding an Accepted record. This CC renders an existing payload and moves
  a cron.
- **But:** if Myke rules on C1 in the direction of "render the weights without enabling
  deployment protection", that ruling *is* a public-claims decision and should be written
  to the Decision Log as Proposed (§7) — the review requirement attaches to that decision,
  not to this rendering work.

---

## 7 · Decisions proposed at exit

| Proposed decision | Supersedes | Surface | Awaiting approval |
| --- | --- | --- | --- |
| Workbench scoring panels refresh **daily at 10:15 UTC**, not hourly — cadence matches source cadence, and payload age is rendered on the page | CC-2.0 D2 (cadence only; the one-cache/one-cron shape stands) | Agent operations | **Approved by Myke 2026-08-19** ("the timing is fine") |
| The Workbench page is an **internal instrument panel**: caveats render above the data they qualify, and no field is withheld for presentation | — | Public claims & surface | **Approved by Myke 2026-08-19** |
| JPAS **quality** tier weights are rendered client-side on the Workbench. The CLAUDE.md "service-role-only, invariant-#2 discipline" note is scoped to per-jurisdiction `jpas_quality_breakdown` rows and to JPS weights, and does **not** extend to the registry tier vector. **Consequence, stated plainly: the live weight vector is readable by any holder of the publishable key, because the page is not access-controlled.** | Clarifies the CLAUDE.md note | Scoring models · Public claims & surface | **Proposed** — flows from Myke's "proceed as is" (§1 C1); should be flipped to Accepted or reversed deliberately, not left implicit |

**A decision that exists only in the session transcript did not happen.**

---

## 8 · Exit state

- **What changed:** `index.html` renders the three scoring panels from one
  `workbench_scoring_panels()` fetch, caveat-block-first, with a payload-age banner and a
  stated colour grammar (red = live defect or not running · amber = documented
  characteristic or Proposed decision · green = invariant holding). Cron 236
  (`…-hourly`, `22 * * * *`) unscheduled; **237 `workbench-scoring-panels-refresh-daily`
  (`15 10 * * *`)** and **238 `workbench-scoring-panels-initial-pass` (`0 21 19 8 *`,
  the one-off 16:00 America/Chicago run Myke asked for)** created. No new SQL object; no
  score touched.
- **Initial pass verified and cleaned up (2026-08-19 21:08 UTC):** job 238 fired at
  **21:00:00.13 UTC** exactly (16:00 America/Chicago), `status = succeeded`, and
  `workbench_scoring_cache.computed_at` advanced to **21:00:00.14 UTC**. Job 238 has been
  **unscheduled**; `cron.job` now matches exactly one row on `%scoring_panels%` — jobid 237
  `workbench-scoring-panels-refresh-daily` `15 10 * * *`. Nothing date-pinned remains.
  - **Correction to the ~12 s figure quoted in §5.3:** that was a warm in-session
    measurement. The real cron run took **26.3 s** end-to-end. Still far inside any
    tolerance for a background job, and 10:15 UTC is a quiet slot, but the honest number
    is 26 s, not 12.
- **What is still open:**
  - Every defect the panels render remains unfixed by design (§3). The page now states
    each of them in red or amber, every day, until someone acts.
  - The C1 Proposed decision in §7 awaits Accept-or-reverse.
- **Surfaces released:** Public claims & surface · Agent operations
- **Follow-on CC required:** registering a JDS cron is the strongest candidate — the panel
  now says "NO SCHEDULE" in red on every load until it exists.
