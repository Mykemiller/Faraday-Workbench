-- Applied to Supabase project ycadmmngkdhvpcsrcuaq as migration
-- `workbench_forecast_model_cached_rpc`. Checked in for provenance — the
-- Workbench's DDL (workbench_health() and friends) has otherwise only ever
-- existed inside Supabase's own migration table.
--
-- Read path for the "Faraday Forecast Model" panel in index.html.
-- v_legacy_span_counts scans ~2.2M rows across 16 source tables (~2s warm) and
-- blows the anon statement timeout, so this mirrors the workbench_health()
-- shape: heavy _compute() behind service_role, a one-row cache table, a cron'd
-- _refresh(), and a thin anon-callable reader.
--
-- The reader deliberately does NOT fall back to _compute() on a cache miss
-- (workbench_health() does) — here that fallback is the exact query that times
-- out, so an honest empty payload beats a hung request.

create table if not exists public.workbench_forecast_model_cache (
  id          integer primary key default 1 check (id = 1),
  payload     jsonb       not null,
  computed_at timestamptz not null default now()
);

alter table public.workbench_forecast_model_cache enable row level security;
revoke all on table public.workbench_forecast_model_cache from anon, authenticated;

-- Heavy read. Service-role only; never called on the request path.
create or replace function public.workbench_forecast_model_compute()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    -- Newest row = "this week", the one before = "last week". Never assumes a
    -- weekly grid; ad-hoc snapshot rows are handled by taking the two newest.
    'snapshots', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.captured_at desc)
      from (
        select captured_at,
               total_backlog_years,
               vintages_total,
               observations_total,
               active_but_empty,
               health_fail_rate_7d,
               briefs_generated_7d,
               edgar_artifacts_total,
               cited_depth_pct,
               multi_vintage_sources
        from public.forecast_model_metrics_snapshots
        order by captured_at desc
        limit 2
      ) s
    ), '[]'::jsonb),
    'spans', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'span',        v.span,
                 'legacy_rows', v.legacy_rows,
                 'span_start',  v.span_start
               ) order by v.span_start
             )
      from public.v_legacy_span_counts v
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.workbench_forecast_model_refresh()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.workbench_forecast_model_cache (id, payload, computed_at)
  values (1, public.workbench_forecast_model_compute(), now())
  on conflict (id) do update
    set payload     = excluded.payload,
        computed_at = excluded.computed_at;
end;
$function$;

-- Anon-callable reader: cache only, cannot hang.
create or replace function public.workbench_forecast_model()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select payload || jsonb_build_object('computed_at', computed_at)
       from public.workbench_forecast_model_cache where id = 1),
    '{"snapshots": [], "spans": [], "computed_at": null}'::jsonb
  );
$function$;

revoke all on function public.workbench_forecast_model_compute() from public, anon, authenticated;
revoke all on function public.workbench_forecast_model_refresh() from public, anon, authenticated;
revoke all on function public.workbench_forecast_model()         from public;
grant execute on function public.workbench_forecast_model_compute() to service_role;
grant execute on function public.workbench_forecast_model_refresh() to service_role;
grant execute on function public.workbench_forecast_model()         to anon, authenticated, service_role;

comment on function public.workbench_forecast_model() is
  'Read-only forecast-model status payload for the Faraday Workbench static page. Reads workbench_forecast_model_cache; SECURITY DEFINER over RLS-denied forecast_model_metrics_snapshots + v_legacy_span_counts, same posture as workbench_health().';

-- Sources move on weekly crons + a draining backfill queue; hourly matches the
-- revalidate=3600 the engine-side version used.
select cron.schedule(
  'workbench-forecast-model-refresh-hourly',
  '7 * * * *',
  $cron$select public.workbench_forecast_model_refresh();$cron$
);

select public.workbench_forecast_model_refresh();
