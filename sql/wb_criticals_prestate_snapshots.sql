-- CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0 (FDY-324) · migration wb_criticals_prestate_snapshots
-- Full copies of the three tables the migrations below touch. CTAS with IF NOT EXISTS so a
-- re-run never overwrites the true pre-state. Apply FIRST.
-- Rollback (restore): see docs/workbench/CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0-RUN-REPORT.md §Rollback.
create table if not exists public.cc_wbcrit_prestate_finding_state as select * from public.workbench_finding_state;
create table if not exists public.cc_wbcrit_prestate_remediation   as select * from public.workbench_finding_remediation;
create table if not exists public.cc_wbcrit_prestate_tiles         as select * from public.workbench_storefront_tiles;
alter table public.cc_wbcrit_prestate_finding_state enable row level security;   -- deny-all, zero policies
alter table public.cc_wbcrit_prestate_remediation   enable row level security;
alter table public.cc_wbcrit_prestate_tiles         enable row level security;
revoke all on public.cc_wbcrit_prestate_finding_state, public.cc_wbcrit_prestate_remediation,
              public.cc_wbcrit_prestate_tiles from anon, authenticated;
