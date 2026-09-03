# CC-WORKBENCH-IA-1.0 — view split, triage bar, and one live bug

## The problem

The page had grown to ten panels and roughly 130 rows and cards in a single
column: **10,618px, about 11.8 screens at 900px**. The only way to learn whether
anything was broken was to scroll all of it, every time.

## What changed

**Five views instead of one column.** Estate · Feeds · Scoring · IDF 5.0 · Links,
as ARIA tabs in the sticky header. Deepest single view is now **3,162px (~3.5
screens) — 70% less scrolling to reach the bottom of anything**, and the two views
you open most (Estate 1.7, Links 1.2) are effectively one screen.

**A triage bar above every view.** This is not decoration; it is what makes the
tabs legal. `CC-WORKBENCH-SCORING-PANELS-UI-1.0` §5.2 requires that a reader who
stops after the first screen already has the bad news. Tabs alone would have
buried four views' worth of defects behind a click. So each loader reports its
red and amber conditions to a central registry, and the bar renders them above
every view with a link back to the owning panel. §5.2 was a per-panel rule; this
applies it to the page.

Rules that hold, and are asserted:

- **Every critical condition renders inline. None is ever placed behind a
  disclosure.** Warnings fold, because a dozen documented characteristics would
  otherwise drown the criticals.
- **Severity grammar is unchanged.** RED = a live defect or something not
  running; AMBER = a documented characteristic, or a decision still *Proposed*
  rather than Confirmed. A Proposed decision is never rounded up to a fact —
  `sevOf()` is the single place that decides, and both the panels and the bar
  read it.
- **No caveat is ever nested inside a fold.**
- Conditions come from the same payload the panel renders, so the bar and the
  panel cannot disagree.

**The bar is deliberately not sticky.** At the live count (8 critical) the chips
wrap to three rows; a sticky bar that tall would permanently consume ~200px of
viewport and undo the fix it ships with. Persistent awareness after you scroll
comes from the per-view count badges in the sticky header instead.

**Long tables fold** behind a one-line headline that carries the number that
matters: the 23-domain feed table, the JTS candidate feeds, and the JTS attribute
table (whose registry notes are paragraphs). Folds open automatically when they
contain something red.

**Progressive enhancement.** `body.js-views` is set by script, so with JS dead
every section stays visible and the page degrades to exactly what it was. Legacy
anchors (`#observability`, `#jds-panel`, …) still resolve to the right view.

## One live bug found and fixed

The Daily Challenge panel tested `season_status !== "open"`. The vocabulary in
`seasons` is **`active` | `closed` | `upcoming`** — there is no `"open"`, so that
test was *unconditionally true*. A running season had always rendered as
**CLOSED**, with "0 days left · between seasons" and a "· ended" date in the
future. Verified against the live table (1 active, 2 closed, 3 upcoming) and
against `workbench_health_compute`, which itself orders by `status = 'active'`.
The panel now reads the real word and states days-left truthfully.

## Verification

`npm test` — **70 assertions across three suites, all passing.**

- `scoring-panels.render.mjs` (28) and `scoring-panels.states.mjs` (10) — the
  pre-existing §5.2 structural suite, unchanged in intent.
- `information-architecture.mjs` (32, new) — one view visible at a time, all ten
  panels render regardless of visibility, no critical condition behind a
  disclosure, chips link back, keyboard navigation, deep links including legacy
  anchors, the season fix, no caveat inside a fold, the scrolling budget, and the
  JS-disabled fallback.

Checked for horizontal overflow at 390 / 768 / 1280px: clean at all three.

### Test-suite notes

The suite could not previously run: it imported playwright from an absolute
`/tmp` path, loaded the page from a hardcoded `/home/user` path, and needed a
manual payload capture nobody had. All three are now resolved from the test file
with env overrides (`WB_PAYLOAD` / `WB_PAGE` / `WB_CHROME` / `WB_PLAYWRIGHT` /
`WB_SHOT`), and real captures are committed as fixtures.

Four assertions were failing before any of this work, none of them regressions —
they had frozen values the estate has since moved past. REG imputation fell to
89.7% after the NAAQS rebuild, so only one tier is still red at ≥90%; and the JDS
composer acquired a cron (`jds-county-rollup-daily`, `50 9 * * *`), so
`composer_is_scheduled` is now true and the NO SCHEDULE caveat correctly no
longer renders. Both are now asserted as **rendering rules derived from the
payload**, so an estate that improves updates the expectation instead of failing
the suite.

## Also brought in

The committed `index.html` was behind the page being served: it had no IDF 5.0
section at all. The nav entry, the six-pillar / P4 / linkage / drift markup and
the `workbench_idf()` reader are now committed. No CSS was added for it — the
section reuses the existing design system verbatim.
