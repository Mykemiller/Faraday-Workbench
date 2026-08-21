# CC-WORKBENCH-STOREFRONT-WIRING-1.0 — run report

Run 2026-08-20. Supabase `ycadmmngkdhvpcsrcuaq`. Branch `claude/workbench-storefront-wiring`, PR #13.

The storefront board is now Supabase-backed and daily-refreshed. Editorial copy was
transcribed verbatim and **nothing subscriber-facing was reworded** — proposed
rewordings are in §4, applied to nothing.

---

## 0. Deviation from the CC: the target repo is not `faraday-today`

The CC names `Mykemiller/faraday-today` as the home of the storefront route. It is not.

`faraday-today@origin/main` contains only `app/page.tsx` (Today on Faraday, FAR-283),
`app/api/digest/route.ts` and `lib/*`. It has no storefront tiles, no board, and no
`SYNC` string. `grep -r FAR-221` returns nothing.

The board lives in **`Mykemiller/Faraday-Workbench`** — a static `index.html`
(vanilla JS, no build step) that already reads `workbench_health()` and
`workbench_scoring_panels()` over Supabase REST with a publishable key.

Building into `faraday-today` would have produced a route nobody looks at while the
real board stayed frozen, so the work landed in `Faraday-Workbench`. Two consequences
worth knowing:

- **The local checkout was stale.** `~/Documents/current-project/Faraday-Workbench`
  sat at `224905a`; `origin/main` was at `d0e073c` (PR #12, scoring panels 2). All
  work branched from `origin/main`, not the working tree.
- **A fourth database object was required.** The board is a static page holding only a
  publishable key. With the cache table fenced deny-all as the CC requires, the board
  cannot read it directly. The siblings solve this with a public `SECURITY DEFINER`
  reader RPC (`workbench_health()` is granted to `anon`; `workbench_health_cache` is
  not). `public.workbench_storefront()` follows that exact pattern. Without it,
  DONE WHEN #2 (deny-all) and #5 (board renders `computed_at`) are mutually
  unsatisfiable.

A third table, `workbench_storefront_config`, holds the stale threshold. The CC
requires it live "in a column or config row, not hardcoded", and forbids
`workbench_config`. It is served inside the payload, so retuning is an `UPDATE` with
no redeploy.

---

## 1. Pre-change snapshot — the hardcoded tile array, verbatim

`Faraday-Workbench@d0e073c` → `index.html`, **lines 226–237**. This is the only
restore path for the existing copy.

```js
const storefronts=[
 {n:"Daily Challenge",s:"warn",tag:"LIVE / STALE",note:"Static page live; fresh-content rotation broken — serving, D2 reachability & rotator unwired. Bank healthy: 373 puzzles to 2026-07-31.",jira:"FAR-21",url:"https://mykesfoundry.atlassian.net/browse/FAR-21"},
 {n:"Intelligent Alert",s:"live",tag:"LIVE",note:"3 test issues sent manually via Beehiiv.",jira:"FAR-26",url:"https://mykesfoundry.atlassian.net/browse/FAR-26"},
 {n:"Jurisdiction Watch",s:"live",tag:"LIVE",note:"Phases 1–5 deployed at jurisdiction-watch.com; first-dollar chain pending Stripe secrets.",jira:"FAR-27",url:"https://mykesfoundry.atlassian.net/browse/FAR-27"},
 {n:"Briefing Library",s:"live",tag:"LIVE / BUILD",note:"19 canonical briefings live; 417 Coming Soon placeholders seeded.",jira:"FAR-28",url:"https://mykesfoundry.atlassian.net/browse/FAR-28"},
 {n:"Live Agent",s:"build",tag:"IN BUILD",note:"Enrichment cleared 1,493/1,493; RAG Q&A acceptance underway.",jira:"FAR-29",url:"https://mykesfoundry.atlassian.net/browse/FAR-29"},
 {n:"Faraday Academy",s:"build",tag:"IN BUILD",note:"36 courses in Draft; Academy Course Template in progress.",jira:"FAR-30",url:"https://mykesfoundry.atlassian.net/browse/FAR-30"},
 {n:"Signal Room",s:"build",tag:"IN BUILD",note:"Configurator surface; update in progress 6-20-26.",jira:"FAR-31",url:"https://mykesfoundry.atlassian.net/browse/FAR-31"},
 {n:"Thought Forge",s:"concept",tag:"CONCEPT",note:"Commission surface — engine and storefront both pre-build.",jira:"FAR-32",url:"https://mykesfoundry.atlassian.net/browse/FAR-32"},
 {n:"League Office",s:"live",tag:"LIVE",note:"Daily Challenge Commissioner console — Tier 1 read screens + Tier 2 audited write-actions shipped (FAR-221 PRs #82/#83). Staff-gated, mykemiller@gmail.com allowlist.",jira:"FAR-221",url:"https://mykesfoundry.atlassian.net/browse/FAR-221"},
 {n:"Civic-Host",s:"live",tag:"LIVE",note:"Free, verified township websites — a Jurisdiction Watch company. Live within 24 hours, no IT department required, free for first 3 years.",jira:"FAR-305",url:"https://mykesfoundry.atlassian.net/browse/FAR-305"}
];
```

The render line that produced the fake stamp, `index.html:287`:

```js
<div class="meta"><a href="${s.url}" target="_blank" rel="noopener">${s.jira} ↗</a><span>SYNC 06-20-26</span></div></div>
```

This array is **retained in the file** as the offline fallback, unmodified.

---

## 2. Dry-run payload — produced before any write

`select jsonb_pretty(public.workbench_storefront_compute());` run read-only. The
cache table was still empty at this point.

```json
{
  "generated_at": "2026-08-21T00:28:23.769493+00:00",
  "stale_lanes": [],
  "tiles": [
    { "slug": "daily-challenge",    "name": "Daily Challenge",    "status": "warn",    "status_tag": "LIVE / STALE",  "jira_key": "FAR-21",  "metric_basis": "measured", "display_order": 1,  "metrics": { "bank_rows": 252, "max_go_live_date": "2026-09-04" } },
    { "slug": "intelligent-alert",  "name": "Intelligent Alert",  "status": "live",    "status_tag": "LIVE",          "jira_key": "FAR-26",  "metric_basis": "no_feed",  "display_order": 2,  "metrics": {} },
    { "slug": "jurisdiction-watch", "name": "Jurisdiction Watch", "status": "live",    "status_tag": "LIVE",          "jira_key": "FAR-27",  "metric_basis": "measured", "display_order": 3,  "metrics": { "briefings": 5483, "promoted_jurisdictions": 325 } },
    { "slug": "briefing-library",   "name": "Briefing Library",   "status": "live",    "status_tag": "LIVE / BUILD",  "jira_key": "FAR-28",  "metric_basis": "measured", "display_order": 4,  "metrics": { "catalog_rows": 388 } },
    { "slug": "live-agent",         "name": "Live Agent",         "status": "build",   "status_tag": "IN BUILD",      "jira_key": "FAR-29",  "metric_basis": "measured", "display_order": 5,  "metrics": { "enrich_batches": 817 } },
    { "slug": "faraday-academy",    "name": "Faraday Academy",    "status": "build",   "status_tag": "IN BUILD",      "jira_key": "FAR-30",  "metric_basis": "measured", "display_order": 6,  "metrics": { "courses_total": 126, "by_status": { "approved": 90, "backlog": 36 } } },
    { "slug": "signal-room",        "name": "Signal Room",        "status": "build",   "status_tag": "IN BUILD",      "jira_key": "FAR-31",  "metric_basis": "measured", "display_order": 7,  "metrics": { "signals": 1104 } },
    { "slug": "thought-forge",      "name": "Thought Forge",      "status": "concept", "status_tag": "CONCEPT",       "jira_key": "FAR-32",  "metric_basis": "no_feed",  "display_order": 8,  "metrics": {} },
    { "slug": "league-office",      "name": "League Office",      "status": "live",    "status_tag": "LIVE",          "jira_key": "FAR-221", "metric_basis": "measured", "display_order": 9,  "metrics": { "audit_log_rows": 75 } },
    { "slug": "civic-host",         "name": "Civic-Host",         "status": "live",    "status_tag": "LIVE",          "jira_key": "FAR-305", "metric_basis": "no_feed",  "display_order": 10, "metrics": {} }
  ]
}
```

`blurb` and `jira_url` are present on every tile in the real payload; elided above for
width only. 7 tiles `measured`, 3 `no_feed`, 0 probe errors.

Every value matches the CC's known-drift baseline except two, both benign live
movement between the CC being written and the run: `enrich_batches` 815 → **817**,
and `lo_audit_log` (no baseline given) = **75**.

---

## 3. Migrations applied, in order

| # | Name | Contents |
|---|------|----------|
| 1 | `workbench_storefront_tiles_and_cache` | `workbench_storefront_tiles` (10 seeded rows, verbatim), `workbench_storefront_cache` (singleton), `workbench_storefront_config` (`stale_after_hours` = 26); RLS on all three, zero policies, `service_role` only |
| 2 | `workbench_storefront_refresh_fn` | `workbench_storefront_compute()`, `workbench_storefront_refresh()`, `workbench_storefront()` public reader; grants |
| 3 | `workbench_storefront_cron_daily` | pg_cron `workbench-storefront-refresh-daily` @ `30 10 * * *`; `ingest_staleness_watch` row `workbench:storefront` |

**Cron placement.** `30 10 * * *` is 15 minutes after jobid 237
(`workbench-scoring-panels-refresh-daily`, `15 10 * * *`) so the two heaviest workbench
recomputes never overlap. 10:30 UTC is otherwise unclaimed — the nearest neighbours are
jobid 155 at 09:00, 231 at 09:45 and 239 at 09:50.

**Idempotency.** `CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING` on the seed,
`CREATE OR REPLACE FUNCTION`, singleton `ON CONFLICT (id) DO UPDATE`,
`cron.unschedule` guarded before `cron.schedule`, and `ON CONFLICT (watch_key) DO UPDATE`
on the watch. Re-running the refresh a second time left **1 cache row, 10 tile rows,
1 cron job**.

---

## 4. Copy discrepancy table — AWAITING MYKE, APPLIED TO NOTHING

Several blurbs are materially wrong. Nothing below was applied; the board still shows
the left-hand column.

| Tile | Board claim (live today) | Live value | Proposed wording |
|---|---|---|---|
| **Daily Challenge** | "Bank healthy: 373 puzzles to 2026-07-31." | 252 rows, max go-live **2026-09-04** | "Static page live; fresh-content rotation broken — serving, D2 reachability & rotator unwired. Bank healthy: 252 puzzles through 2026-09-04." |
| **Briefing Library** | "19 canonical briefings live; 417 Coming Soon placeholders seeded." | 388 catalog rows: **25 Available, 363 Coming Soon** | "25 briefings available; 363 Coming Soon placeholders seeded." |
| **Live Agent** | "Enrichment cleared 1,493/1,493" | **817 batches**, 179,988 artifacts submitted, 179,813 succeeded (816 completed, 1 draining) | "Enrichment cleared 179,813/179,988 artifacts across 817 batches; RAG Q&A acceptance underway." |
| **Faraday Academy** | "36 courses in Draft" | **126 courses: 90 approved, 36 backlog** | "126 courses — 90 approved, 36 in backlog; Academy Course Template in progress." |
| **Signal Room** | "update in progress 6-20-26" | **1,104 signals**, 933 in last 30d, most recent **2026-08-20** | "Configurator surface live; 1,104 signals, 933 in the last 30 days." |
| **Jurisdiction Watch** | "Phases 1–5 deployed…; first-dollar chain pending Stripe secrets." | 325 promoted, 5,483 briefings — not contradicted | No change proposed. Counts now render on the tile. |
| **League Office** | "Tier 1 read screens + Tier 2 audited write-actions shipped" | 75 audit rows — consistent | No change proposed. |
| **Intelligent Alert** | "3 test issues sent manually via Beehiiv." | No Supabase feed; unverifiable from here | No change proposed — see status chip below. |
| **Thought Forge** | "Commission surface — engine and storefront both pre-build." | No feed; consistent with CONCEPT | No change proposed. |
| **Civic-Host** | "Free, verified township websites…" | No feed; marketing copy, not a status claim | No change proposed. |

### Status chips that look wrong given live state

| Tile | Chip today | Why it looks wrong | Proposed |
|---|---|---|---|
| **Intelligent Alert** | `LIVE` | Its own blurb says only "3 test issues sent **manually**". A manual test send is not a live product. This is the one chip that overstates. | `IN BUILD` |
| **Signal Room** | `IN BUILD` | 933 signals in the last 30 days, most recent today, and `sfLinks` already points at a public surface at faraday-signal-room.com | `LIVE` |
| **Faraday Academy** | `IN BUILD` | 90 of 126 courses are `approved`, not draft | `LIVE / BUILD` |
| **Daily Challenge** | `LIVE / STALE` | The bank is forward-dated to 2026-09-04, so the *bank* is not stale. If the rotator is still unwired the chip may stand — that is a claim I cannot verify from Supabase. | Your call — see MYKE ACTION 2 |

---

## 5. Verification — queries and actual output

```
select computed_at, now()-computed_at as age from workbench_storefront_cache where id=1;
 computed_at                    | age
 2026-08-21 00:28:53.867389+00  | 00:00:32.365145

select jobid, jobname, schedule, active from cron.job where jobname='workbench-storefront-refresh-daily';
 240 | workbench-storefront-refresh-daily | 30 10 * * * | t

select jsonb_array_length(payload->'tiles') from workbench_storefront_cache where id=1;
 10

select jsonb_array_length(payload->'stale_lanes') from workbench_storefront_cache where id=1;
 0

select * from ingest_staleness_watch where watch_key ilike '%storefront%';
 workbench:storefront | Workbench storefront board — daily cache refresh | data |
 public.workbench_storefront_cache | computed_at | daily | 1.5 | enabled | workbench-storefront-refresh-daily
```

**The cron was verified by reading the cache, not `cron.job_run_details`** — per the CC,
and per the warning baked into `ingest-staleness-healthcheck` itself: these jobs return
as soon as a request is queued, so a green cron history proves only that something was
enqueued.

The watch was proven to actually *evaluate*, not merely to exist:

```
select * from fn_ingest_staleness_check() where watch_key='workbench:storefront';
 threshold: 1 day 12:00:00 | last_event_at: 2026-08-21 00:28:53+00 | age: 00:00:54 | breached: false
```

Alert threshold is 36h (daily × 1.5 grace), deliberately looser than the board's 26h
badge: the board goes visibly stale first, and email escalates only on a real stall.

### RLS fence, proven over HTTP with the board's own publishable key

```
POST /rest/v1/rpc/workbench_storefront        → HTTP 200
     tiles: 10 | computed_at: 2026-08-21T00:28:53Z | stale_after_hours: 26 | stale_lanes: 0
GET  /rest/v1/workbench_storefront_cache      → HTTP 401  permission denied for table
GET  /rest/v1/workbench_storefront_tiles      → HTTP 401  permission denied for table
```

### Rendered board

Served locally against live Supabase. 10 cards, real stamps, no console errors:

- **fresh** → `FAR-21 ↗ SYNC 08/20/26, 07:28 PM`, no badge
- **stale** (computed_at forced 30h old) → `STALE >26H` on all 10 cards
- **RPC unreachable** → fallback array renders, `SYNC UNAVAILABLE` + `STALE >26H`,
  metrics read `metrics unavailable`. Copy is intact and the board never silently
  shows a stale number as if it were fresh.
- no-feed tiles render `no feed — not zero`, never `0`

---

## 6. Repo diff

Branch `claude/workbench-storefront-wiring` (from `origin/main` @ `d0e073c`), PR **#13**.

- `index.html` — +78/−6. Removed the hardcoded render block and the `SYNC 06-20-26`
  literal; added `renderStorefronts()`, `metricsHtml()`, `loadStorefront()`, the
  `SF_FALLBACK` normaliser and `.p-stale` / `.card .metrics` CSS.
- `docs/workbench/CC-WORKBENCH-STOREFRONT-WIRING-1.0-RUN-REPORT.md` — this file.

Compare: https://github.com/Mykemiller/Faraday-Workbench/compare/main...claude/workbench-storefront-wiring

Not deployed. Not merged.

---

## 7. Out of scope, recorded not actioned

- The `engineStats` array (11 hardcoded engine counters: "39,324 Jurisdictions",
  "5,191 Artifacts", "93 Automations ran · 24h") is **still hardcoded** and carries the
  same class of drift the storefront tiles had. Its subhead is already overwritten by
  the live `workbench_health()` render, which makes the mismatch harder to spot, not
  easier. Out of scope here; worth its own CC.
- `sfLinks` describes Faraday Academy as "LearnWorlds · 36 draft courses" — the same
  stale 36 as the Academy tile. Left alone; it is editorial copy.
- `faraday-today` was left untouched.

---

## 8. Rollback

```sql
select cron.unschedule('workbench-storefront-refresh-daily');
delete from public.ingest_staleness_watch where watch_key = 'workbench:storefront';
drop function if exists public.workbench_storefront();
drop function if exists public.workbench_storefront_refresh();
drop function if exists public.workbench_storefront_compute();
drop table if exists public.workbench_storefront_cache;
drop table if exists public.workbench_storefront_config;
drop table if exists public.workbench_storefront_tiles;
```

Front end: close PR #13 without merging. `origin/main` is untouched, and the verbatim
tile array in §1 restores the original copy exactly.

---

## 9. Applied after review — Myke approved 2026-08-20

Migration `workbench_storefront_approved_copy_and_chips`.

**Blurbs (5).** Applied as approved. Live Agent's figures were re-measured immediately
before the write and had already moved from the §4 proposal (179,813/179,988 across 817
→ **180,052/180,165 across 818**, in roughly one hour); the approved wording was kept and
the current values used.

| Tile | Blurb now |
|---|---|
| Daily Challenge | "…Bank healthy: 252 puzzles through 2026-09-04." |
| Briefing Library | "25 briefings available; 363 Coming Soon placeholders seeded." |
| Live Agent | "Enrichment cleared 180,052/180,165 artifacts across 818 batches; RAG Q&A acceptance underway." |
| Faraday Academy | "126 courses — 90 approved, 36 in backlog; Academy Course Template in progress." |
| Signal Room | "Configurator surface live; 1,104 signals, 933 in the last 30 days." |

**Chips (3).** `Intelligent Alert` LIVE → **IN BUILD**; `Signal Room` IN BUILD → **LIVE**;
`Faraday Academy` IN BUILD → **LIVE / BUILD**.

**Daily Challenge chip left at `LIVE / STALE`** — deliberately not changed. It was posed
as an open question in §4 (the rotator claim is not verifiable from Supabase) and was not
ruled on. One `UPDATE` when you decide.

The in-page fallback array in `index.html` was updated to match, so an RPC outage cannot
serve superseded copy. Verified in-browser: 10 cards, new chips and blurbs, no console
errors.

### Open concern: four of the five approved blurbs now carry counts that will drift

This is the drift the CC set out to kill, re-entering through the copy layer. Live Agent's
numbers moved *while this change was being applied*. Each of these tiles also renders a
live metrics line directly beneath the blurb, so the board now states the same quantity
twice — once live, once frozen. On Daily Challenge the two lines are adjacent and
identical today ("Bank healthy: 252 puzzles through 2026-09-04" above `bank 252 thru
2026-09-04`), and will visibly disagree as soon as the bank changes.

Recommended follow-up, not applied: strip the counts from the blurbs and let them carry
only the qualitative status, since the metrics line already carries the number. E.g.
Live Agent → "Enrichment pipeline draining; RAG Q&A acceptance underway." That is one
`UPDATE` per tile plus the fallback array.
