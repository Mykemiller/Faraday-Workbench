# Workbench page tests

Headless-Chromium render tests for the scoring panels
(CC-WORKBENCH-SCORING-PANELS-UI-1.0 §5.4).

Container egress to `*.supabase.co` is policy-blocked, so these do **not** hit the live
endpoint. They serve a captured real payload via a Playwright route intercept, which
exercises the real render path against real data rather than a hand-built fixture.

```bash
npm i playwright                     # or use a global install
node test/scoring-panels.render.mjs  # 28 assertions
node test/scoring-panels.states.mjs  # 10 assertions: age states + failure paths
```

Paths are resolved from the test file, so the suite runs from any checkout. A
committed capture of the real payload lives at
`test/fixtures/scoring-panels.payload.json` (taken 2026-09-02), so no manual
capture step is needed to run the suite. To test against fresher data:

```bash
#   select payload from public.workbench_scoring_cache where id = 1;  -> /tmp/payload.json
WB_PAYLOAD=/tmp/payload.json node test/scoring-panels.render.mjs
```

Overrides: `WB_PAYLOAD` · `WB_PAGE` · `WB_CHROME` · `WB_PLAYWRIGHT` · `WB_SHOT`.

Assertions that depend on live values are **derived from the payload, not frozen**
— the imputation red/amber counts and the JDS `NO SCHEDULE` caveat are checked as
rendering *rules* against whatever the payload says. Freezing them meant the suite
failed when the estate improved: REG imputation fell to 89.7% after the NAAQS
rebuild, and the JDS composer acquired a cron (`jds-county-rollup-daily`,
`50 9 * * *`), which flipped `composer_is_scheduled` to true.

The assertion worth keeping above all others is the structural one: in each panel the
**first child element is a `.caveat` block, and every caveat precedes every data block.**
That is the whole point of the design — if it regresses, the page is lying by omission.
