# Rule: a file under `sql/` is not done until it is applied

Added by CC-WORKBENCH-NOTES-SAVE-FIX-1.0 (2026-11-11 CT).

The files in `sql/` are provenance. Merging one does not change the database. On
2026-11-08 the SQL for CC-TF-NOTES-OUTBOX-1.0 was merged with code that depended on it,
and was never applied. Every note save then failed until the gap was found three days later.

**The rule.** A pull request that adds or changes a file under `sql/` must state, in its
description, before it is merged:

1. the applied migration **name**, and
2. the applied migration **version** (the timestamp in `supabase_migrations.schema_migrations`).

If the SQL has not been applied yet, the pull request stays a draft. If the SQL is
deliberately staged and not meant to be applied, the description says so in those words and
names what applies it later.

Record both in the PR template's "Production state → Migrations" row.

**How to check.**

```sql
select version, name from supabase_migrations.schema_migrations where name = '<migration name>';
```

**What the test covers.** `test/notes-schema-contract.mjs` fails when the notes API names a
column that no file in `sql/` declares. It runs offline, so it cannot see the database. This
rule covers the other half: that the declared SQL was really applied.
