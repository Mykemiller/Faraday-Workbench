-- CC-WORKBENCH-FINDINGS-REMEDIATION-1.0
-- Repo capture of the five migrations applied to ycadmmngkdhvpcsrcuaq on 2026-09-05.
-- Applied names, in order:
--   create_workbench_finding_remediation
--   create_workbench_finding_state
--   create_workbench_findings_sync_rpc
--   seed_workbench_finding_remediation_criticals   (9 rows, omitted here - editorial copy
--                                                   is owned by Myke and lives in the table)
--   add_workbench_idf_refresh_cron                 (jobid 348)
-- Every statement is idempotent and safe to re-run.

-- ---------------------------------------------------------------- D2: remediation copy
create table if not exists public.workbench_finding_remediation (
  finding_key     text primary key,
  lane            text not null,
  severity        text not null default 'critical',
  plain_english   text not null,
  cc_prompt_seed  text not null,
  authored_by     text not null default 'Myke',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.workbench_finding_remediation enable row level security;   -- deny-all, zero policies
revoke all on public.workbench_finding_remediation from anon, authenticated;
create index if not exists workbench_finding_remediation_lane_idx
  on public.workbench_finding_remediation (lane, finding_key);

-- ---------------------------------------------------------------- D2 + D4: presence ledger
create table if not exists public.workbench_finding_state (
  finding_key   text primary key,
  lane          text,
  severity      text,
  headline      text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  cleared_at    timestamptz
);
alter table public.workbench_finding_state enable row level security;         -- deny-all, zero policies
revoke all on public.workbench_finding_state from anon, authenticated;
create index if not exists workbench_finding_state_cleared_idx
  on public.workbench_finding_state (cleared_at) where cleared_at is not null;

-- ---------------------------------------------------------------- D7: the missing cron
-- 10:45 UTC sits deliberately after jobid 237 (10:15) and jobid 240 (10:30).
-- Guarded delete-then-schedule: re-running cannot create a duplicate job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'workbench-idf-refresh-daily') then
    perform cron.unschedule('workbench-idf-refresh-daily');
  end if;
  perform cron.schedule('workbench-idf-refresh-daily','45 10 * * *',
                        'select public.workbench_idf_refresh();');
end;
$$;

-- The body of workbench_findings_sync(jsonb) is in migration
-- create_workbench_findings_sync_rpc; see the run report for its contract. The one rule
-- that matters at the call site: pass a COMPLETE report. A partial report looks like an
-- absence and would falsely clear live findings.
