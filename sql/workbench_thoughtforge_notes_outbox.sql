-- CC-TF-NOTES-OUTBOX-1.0 · 2026-11-08 CT
-- Durable save + Linear outbox for notes saved on the ThoughtForge Panel tile.
--
-- Additive only. The existing table, its open/done `status` and MARK DONE stay as they are.
-- Sync state lives in a separate `sync_status` column so the two meanings never collide.
--   client_id   uuid generated in the browser; the idempotency key for every retry
--   sync_status null (tile does not sync) | pending_sync | linear_pending | synced | failed | dry_run
--
-- Idempotent: every statement is IF NOT EXISTS / guarded / CREATE OR REPLACE.
-- Reversal: alter table public.workbench_product_notes drop column client_id, drop column source,
--   drop column sync_status, drop column attempts, drop column last_error, drop column linear_issue_id,
--   drop column linear_identifier, drop column linear_url, drop column prompt_source,
--   drop column updated_at; then re-run the workbench_product_notes() body from
--   sql/workbench_notes_linear.sql.

alter table public.workbench_product_notes
  add column if not exists client_id         uuid,
  add column if not exists source            text,
  add column if not exists sync_status       text,
  add column if not exists attempts          int  not null default 0,
  add column if not exists last_error        text,
  add column if not exists linear_issue_id   text,
  add column if not exists linear_identifier text,
  add column if not exists linear_url        text,
  add column if not exists prompt_source     text,
  add column if not exists updated_at        timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workbench_product_notes_source_chk') then
    alter table public.workbench_product_notes add constraint workbench_product_notes_source_chk
      check (source is null or source in ('voice','typed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workbench_product_notes_sync_status_chk') then
    alter table public.workbench_product_notes add constraint workbench_product_notes_sync_status_chk
      check (sync_status is null or sync_status in ('pending_sync','linear_pending','synced','failed','dry_run'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workbench_product_notes_prompt_source_chk') then
    alter table public.workbench_product_notes add constraint workbench_product_notes_prompt_source_chk
      check (prompt_source is null or prompt_source in ('model','template'));
  end if;
  -- A synced row must carry its Linear issue. This is the invariant the report's verification query checks.
  if not exists (select 1 from pg_constraint where conname = 'workbench_product_notes_synced_has_issue_chk') then
    alter table public.workbench_product_notes add constraint workbench_product_notes_synced_has_issue_chk
      check (sync_status is distinct from 'synced' or linear_issue_id is not null);
  end if;
end $$;

create unique index if not exists workbench_product_notes_client_id_key
  on public.workbench_product_notes (client_id);
create index if not exists workbench_product_notes_sync_status_idx
  on public.workbench_product_notes (sync_status, updated_at)
  where sync_status is not null;

-- updated_at follows every write so the cron's "older than 2 minutes" test is honest.
create or replace function public.workbench_product_notes_touch()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
revoke all on function public.workbench_product_notes_touch() from public, anon, authenticated;

drop trigger if exists workbench_product_notes_touch on public.workbench_product_notes;
create trigger workbench_product_notes_touch before update on public.workbench_product_notes
  for each row execute function public.workbench_product_notes_touch();

-- RLS stays on and anon/authenticated stay revoked (from workbench_notes_linear.sql). Re-assert it.
alter table public.workbench_product_notes enable row level security;
revoke all on public.workbench_product_notes from anon, authenticated;

-- Read side: same anon RPC, now also carrying the sync fields the panel shows.
-- Note bodies were already exposed through this RPC; no new column carries a secret.
create or replace function public.workbench_product_notes()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(slug, items), '{}'::jsonb) from (
    select slug, jsonb_agg(jsonb_build_object(
             'id', id, 'kind', kind, 'body', body, 'status', status,
             'created_at', created_at, 'done_at', done_at,
             'client_id', client_id, 'source', source, 'sync_status', sync_status,
             'attempts', attempts, 'last_error', last_error,
             'linear_identifier', linear_identifier, 'linear_url', linear_url,
             'prompt_source', prompt_source) order by status, created_at desc) items
      from public.workbench_product_notes group by slug) s;
$$;
revoke all on function public.workbench_product_notes() from public;
grant execute on function public.workbench_product_notes() to anon, authenticated;
