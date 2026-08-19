# Workbench page tests

Headless-Chromium render tests for the scoring panels
(CC-WORKBENCH-SCORING-PANELS-UI-1.0 §5.4).

Container egress to `*.supabase.co` is policy-blocked, so these do **not** hit the live
endpoint. They serve a captured real payload via a Playwright route intercept, which
exercises the real render path against real data rather than a hand-built fixture.

```bash
npm i playwright                     # or use a global install
# capture a fresh payload (needs DB access):
#   select payload from public.workbench_scoring_cache where id = 1;  -> /tmp/payload.json
node test/scoring-panels.render.mjs  # 28 assertions
node test/scoring-panels.states.mjs  # 10 assertions: age states + failure paths
```

The assertion worth keeping above all others is the structural one: in each panel the
**first child element is a `.caveat` block, and every caveat precedes every data block.**
That is the whole point of the design — if it regresses, the page is lying by omission.
