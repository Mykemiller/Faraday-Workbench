-- PROPOSED — NOT EXECUTED. CC-WORKBENCH-ESTATE-TRUTH-AUDIT-1.0, 2026-11-12 17:30 CT.
-- Scope: binding/config only. No status / status_tag / blurb / name writes (human-owned).
--
-- Premise correction from the audit: the "NULL linear_project_id" tiles do NOT need a project
-- UUID. Linear has 10 projects in total and none exists for signal-room, intelligent-alert,
-- league-office, live-agent, civic-host, estate-security or idf-health (list_projects, 2026-11-12).
-- All 16 tiles carry linear_label, and api/workbench-linear.js + index.html:868-872 make label the
-- EXCLUSIVE binding (project/q/keys are ignored when a label is set). So those tiles already resolve.
--
-- What remains is dead config: linear_query is ignored wherever linear_label is set, and
-- "signal digest" on intelligent-alert would match 50+ unrelated issues if the label were ever
-- removed. Clearing the four dead queries removes that trap. Idempotent, guarded.

begin;

update public.workbench_storefront_tiles
   set linear_query = null
 where slug in ('intelligent-alert','live-agent','signal-room','league-office')
   and linear_label is not null
   and linear_query is not null;   -- guard: only touches rows that still carry the dead value

-- Verify (expect 0 rows):
--   select slug from public.workbench_storefront_tiles
--    where linear_label is not null and linear_query is not null;

commit;

-- Rollback (restores the pre-audit values recorded in audits/snapshots/2026-11-12_estate_truth_pre.json):
--   update public.workbench_storefront_tiles set linear_query='signal digest' where slug='intelligent-alert' and linear_query is null;
--   update public.workbench_storefront_tiles set linear_query='Live Agent'    where slug='live-agent'        and linear_query is null;
--   update public.workbench_storefront_tiles set linear_query='Signal Room'   where slug='signal-room'       and linear_query is null;
--   update public.workbench_storefront_tiles set linear_query='League Office' where slug='league-office'     and linear_query is null;
