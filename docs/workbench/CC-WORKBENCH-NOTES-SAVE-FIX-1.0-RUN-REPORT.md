# CC-WORKBENCH-NOTES-SAVE-FIX-1.0 — run report

Stamped 2026-11-11 19:30 CT. Counts and checksums only; no row data.

**Status: resolved 2026-11-12 22:24 UTC; see section 7 (Resolution).** The paragraph below is
the original finding as written 2026-11-11 and is kept unchanged. When it was written the
migration was not applied and note saving was broken in production.

> Original status: migration NOT applied. Note saving is still broken in production. The code
> guard, the error message and the change-control rule in this pull request are done. The
> database change is waiting on an approval that did not reach the operator (see section 2).

## 1. Phase A findings

Supabase project `ycadmmngkdhvpcsrcuaq`. Repo `main` at `e9ff679`.

| Check | Result |
|---|---|
| A1 columns of `public.workbench_product_notes` | 8: `id, slug, kind, body, status, author, created_at, done_at` |
| A1 migrations named like `%outbox%` | 0 |
| A1 recorded statements adding `client_id` to the table | 0 |
| A1 migrations that mention the table | `20261104011426 workbench_notes_linear_1_0`; `20261107140923 fdy166_function_exposure_by_name` (allow-list reference only) |
| A2 `sql/workbench_thoughtforge_notes_outbox.sql` | Matches the CC: 10 columns, 4 check constraints, 2 indexes, touch function and trigger, replaced read function. File md5 `131ec255919787d3203557ae2f502797` |
| A3 row count | 14 (all `author='claude'`, all created 2026-11-05) |
| A3 content checksum | `0628eb4b46e656455fbfef312e843516` |
| A3 `workbench_product_notes()` definition md5 | `1ec3c427d40b49ff61610d935c1ebcb2` |
| A3 `workbench_product_notes()` ACL | EXECUTE held by `postgres`, `service_role`, `anon`, `authenticated`; not PUBLIC |
| A3 table posture | RLS enabled, 0 policies, 0 grants to anon / authenticated / PUBLIC, 0 triggers |
| A4 dry run | **Not run.** Attempted twice; the Supabase connector asked for confirmation and timed out unanswered both times. Skipped on the operator's instruction ("Go, skip the dry run"). |

The drift described in the CC was confirmed exactly. Nothing in Phase A differed from the
CC's Context section.

## 2. Phase B — migration

**Not applied.** `apply_migration` with name `workbench_thoughtforge_notes_outbox_1_0`
(the file content plus `notify pgrst, 'reload schema';`) was submitted once after GO. The
connector asked for confirmation, received no answer, and timed out after 230 seconds.

State verified immediately afterwards: 8 columns, 14 rows, checksum
`0628eb4b46e656455fbfef312e843516`, no `workbench_product_notes_touch` function, 0 rows in
`supabase_migrations.schema_migrations` with that name. Production is unchanged.

| Done When | Status |
|---|---|
| 1. 10 new columns | pending (migration not applied) |
| 2. 2 indexes, 4 check constraints, touch trigger | pending |
| 3. read function returns the 8 new keys | pending |
| 4. function EXECUTE grants | pending (pre-state for the read function already correct) |
| 5. RLS on, 0 policies, no anon/authenticated grants | holds today; re-check after apply |
| 6. count 14 and checksum unchanged | holds today; re-check after apply |
| 7. one migration row `workbench_thoughtforge_notes_outbox_1_0` | pending |
| 8. draft pull request with test and report | done (this pull request) |

## 3. Verification queries (run after the migration is applied)

```sql
select column_name, data_type from information_schema.columns
 where table_schema='public' and table_name='workbench_product_notes' order by ordinal_position;

select version, name from supabase_migrations.schema_migrations
 where name = 'workbench_thoughtforge_notes_outbox_1_0';

select has_function_privilege('anon','public.workbench_product_notes()','EXECUTE') as anon_read,
       has_function_privilege('anon','public.workbench_product_notes_touch()','EXECUTE') as anon_touch;

select relrowsecurity from pg_class where oid='public.workbench_product_notes'::regclass;

select id, slug, kind, author, source, sync_status, client_id is not null as has_client_id, created_at
  from public.workbench_product_notes where author='myke' order by created_at desc limit 5;

-- content check: expect 14 and 0628eb4b46e656455fbfef312e843516
select count(*),
       md5(string_agg(id||'|'||slug||'|'||kind||'|'||md5(body)||'|'||status||'|'||author||'|'||created_at||'|'||coalesce(done_at::text,''), ',' order by id))
  from public.workbench_product_notes;
```

## 4. Rollback (documented, not executed; corrected 2026-11-12 to retire the touch function instead of dropping it)

```sql
drop trigger if exists workbench_product_notes_touch on public.workbench_product_notes;
-- Never DROP FUNCTION (CLAUDE.md, production database protocol step 7): retire it instead.
alter function public.workbench_product_notes_touch() rename to workbench_product_notes_touch_retired_20261112;
revoke all on function public.workbench_product_notes_touch_retired_20261112() from public, anon, authenticated;
drop index if exists public.workbench_product_notes_client_id_key;
drop index if exists public.workbench_product_notes_sync_status_idx;
alter table public.workbench_product_notes
  drop constraint if exists workbench_product_notes_source_chk,
  drop constraint if exists workbench_product_notes_sync_status_chk,
  drop constraint if exists workbench_product_notes_prompt_source_chk,
  drop constraint if exists workbench_product_notes_synced_has_issue_chk;
alter table public.workbench_product_notes
  drop column if exists client_id, drop column if exists source, drop column if exists sync_status,
  drop column if exists attempts, drop column if exists last_error, drop column if exists linear_issue_id,
  drop column if exists linear_identifier, drop column if exists linear_url,
  drop column if exists prompt_source, drop column if exists updated_at;

-- the read function body saved in A3
CREATE OR REPLACE FUNCTION public.workbench_product_notes()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(jsonb_object_agg(slug, items), '{}'::jsonb) from (
    select slug, jsonb_agg(jsonb_build_object(
             'id', id, 'kind', kind, 'body', body, 'status', status,
             'created_at', created_at, 'done_at', done_at) order by status, created_at desc) items
      from public.workbench_product_notes group by slug) s;
$function$;
revoke all on function public.workbench_product_notes() from public;
grant execute on function public.workbench_product_notes() to anon, authenticated;
notify pgrst, 'reload schema';
```

## 5. Phase C — code and tests

- `test/notes-schema-contract.mjs` (new, in the `test` script): fails when `COLS` in
  `api/_tfsync.js`, a key `api/workbench-notes.js` writes, or a filter column names a column
  that no `sql/*.sql` file declares for `workbench_product_notes`. Checked both ways: it
  passes on this branch (17 columns used, 18 declared) and fails, naming 10 columns, when
  `sql/workbench_thoughtforge_notes_outbox.sql` is removed.
- `api/workbench-notes.js`: a PostgREST `PGRST204` answer now returns "The database is
  missing a column this page needs. A migration has not been applied." with the status code
  kept. Applies to POST and PATCH. Nothing else in the handler changed.
- `docs/change-control/SQL-MIGRATION-RULE.md`: a pull request that touches `sql/` must state
  the applied migration name and version before merge.

`npm test` in the build container: **does not complete.** The script chains tests with `&&`
and stops at `test/auth-page.mjs`. Run one by one, 14 of 22 files pass, including the new one.
The 8 that fail are all headless-browser tests (`auth-page`, `scoring-panels.render`,
`scoring-panels.states`, `information-architecture`, `surface-probe`, `fix-these.render`,
`admin-tab`, `tf-notes-panel`). The same 8 fail the same way on unmodified `main` in this
container, so they are not caused by this change; the cause was not diagnosed. The suite
should be run once on a machine where it normally passes before merge.

## 6. Myke actions

0. **Apply the migration.** Approve the Supabase connector prompt when the agent retries, or
   apply `sql/workbench_thoughtforge_notes_outbox.sql` plus `notify pgrst, 'reload schema';`
   through the Supabase CLI under the name `workbench_thoughtforge_notes_outbox_1_0`. Then run
   section 3 and add the version to this pull request's description.
1. Open faraday-stuff.com, Signal Room tile, press Save on the waiting draft. Expect it in the
   list. Run the last query in section 3; expect one row with `slug='signal-room'`,
   `sync_status` null.
2. Decide whether ThoughtForge notes should create live TH issues now. `TF_NOTES_DRY_RUN` is
   not set and `LINEAR_API_KEY` is, so they will, as soon as saving works. Recommended: yes, as
   designed in PR #30, after test 1 passes.
3. Set `CRON_SECRET` on the Vercel project (production) so the 15-minute retry cron stops
   answering 503. Recommended.
4. Set `ANTHROPIC_API_KEY` on the Vercel project so ThoughtForge issues get a generated prompt
   instead of the template. Recommended.
5. Decide whether `Mykemiller/faraday-workbench` should be private. Recommended: private.
6. Review and merge this pull request, after action 0.

## 7. Resolution (2026-11-12, CC-WORKBENCH-PR43-RESOLVE-1.0, Linear FDY-309)

Sections 1 to 6 above are the original findings and stay as written. This section supersedes
their "NOT applied" status and the "Myke applies" convention (CLAUDE.md, Orchestration contract v1.0).

| Item | Result |
|---|---|
| Merge | `origin/main` (1f0500d) merged into the PR branch; one conflict, `package.json`, resolved by taking main's `test` chain (32 files) and appending ` && node test/notes-schema-contract.mjs` (33). |
| Dry run | `BEGIN; <file>; ROLLBACK` through `execute_sql` at 22:2x UTC: 18 columns, 4 indexes, 7 check constraints, 1 trigger, 14 rows, checksum unchanged, `anon` has no EXECUTE on the touch function. Rollback confirmed (8 columns, no migration row, no touch function). |
| Applied | `workbench_thoughtforge_notes_outbox_1_0`, version `20261112222452`, 2026-11-12 22:24:52 UTC, one `apply_migration` call (file content + `notify pgrst, 'reload schema';`). File md5 `131ec255919787d3203557ae2f502797`. |
| After | 18 columns, 4 indexes (2 new), 7 check constraints (4 new), 1 trigger, RLS on, 0 policies, 14 rows, checksum `0628eb4b46e656455fbfef312e843516` (unchanged), 0 rows touched. |
| Roles | `anon` and `authenticated`: no table privileges; `workbench_product_notes()` still executable and returns 14 slugs (probed in rolled-back transactions); neither can execute the touch function. |
| Owner access | `estate_access_for(<owner>,'workbench')` is still `usable`. |
| Advisors | Security advisor findings 626 before and 626 after; added 0, removed 0. |
| Evidence | `docs/workbench/PR43-prod-before.json`, `docs/workbench/PR43-prod-after.json` |

Section 3's verification queries were run in substance: column list, migration row, function
privileges, RLS, and the 14-row checksum. The last query (`author='myke'` rows) returns none
until someone presses Save, which is left to Myke (action 1 below).

**Tests.** `test/notes-schema-contract.mjs` passes on the merged tree. Nine headless-browser test
files fail on this branch and fail identically on clean `origin/main` (1f0500d) after
`npx playwright install chromium`: `auth-page`, `scoring-panels.render`, `scoring-panels.states`,
`information-architecture`, `surface-probe`, `findings-keys`, `fix-these.render`, `admin-tab`,
`tf-notes-panel`. They are pre-existing, not caused by this change; see "Found, not changed" in the PR.
Every other file passes (24 of 33 on the branch; 23 of 32 on main).

**Rollback** is section 4 as corrected above. Not executed: verification passed.

**Still Myke's (Tier 3):** press Save on the Signal Room tile; decide TF_NOTES_DRY_RUN
(recommended: live, as designed in PR #30); set `CRON_SECRET` and `ANTHROPIC_API_KEY` in Vercel
production; make the repo private. Exact places and rollbacks are in the PR description.

