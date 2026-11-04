-- CC-WORKBENCH-NOTES-LINEAR-1.0 · 2026-11-03 19:20 CT
-- 1. Per-product notes/actions, written only through /api/workbench-notes (service role).
-- 2. Linear project binding on each tile, so /api/workbench-linear can list open issues.
-- 3. Tile payload carries updated_at so the page can stamp "last updated".
-- Reversal: drop table public.workbench_product_notes; alter table workbench_storefront_tiles
--   drop column linear_project_id, drop column linear_query; re-create compute() from
--   sql/workbench_dc_bank_live.sql; select workbench_storefront_refresh().

alter table public.workbench_storefront_tiles
  add column if not exists linear_project_id uuid,
  add column if not exists linear_query text;

update public.workbench_storefront_tiles t set linear_project_id = v.id::uuid from (values
  ('jurisdiction-watch','53245a65-691e-4ad5-b510-c20a3e8b4344'),
  ('faraday-predicts','f86e8a82-e6a5-486b-8cd0-91a3759c018f'),
  ('thought-forge','37afb079-7822-4253-8c72-e126646d26dd'),
  ('daily-challenge','8f6ad748-708b-4ebe-93d8-396ef48d1201'),
  ('faraday-academy','40a4c13f-93d1-453c-b638-cbe720a32841'),
  ('briefing-library','9675417b-19bd-4d57-98a0-c96e2d911d2e'),
  ('boundstone','3a5aa8ce-d851-4a35-95cf-30e4fddb358a'),
  ('ispyadc','6f06bef0-66fd-4b82-ad54-2f6f08f07719'),
  ('panel-podcast','048a62fd-400b-4594-8a08-fd8acab77aa7')
) as v(slug,id) where t.slug = v.slug;

-- Products with no Linear project fall back to a title/description search.
update public.workbench_storefront_tiles set linear_query = 'signal digest'   where slug = 'intelligent-alert';
update public.workbench_storefront_tiles set linear_query = 'League Office'   where slug = 'league-office';
update public.workbench_storefront_tiles set linear_query = 'Live Agent'      where slug = 'live-agent';
update public.workbench_storefront_tiles set linear_query = 'Signal Room'     where slug = 'signal-room';
update public.workbench_storefront_tiles set linear_query = 'Civic-Host'      where slug = 'civic-host';

create table if not exists public.workbench_product_notes (
  id          bigserial primary key,
  slug        text not null references public.workbench_storefront_tiles(slug) on delete cascade,
  kind        text not null default 'note' check (kind in ('note','action')),
  body        text not null check (length(body) between 1 and 2000),
  status      text not null default 'open' check (status in ('open','done')),
  author      text not null default 'myke',
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists workbench_product_notes_slug_idx on public.workbench_product_notes (slug, created_at desc);
alter table public.workbench_product_notes enable row level security;
revoke all on public.workbench_product_notes from anon, authenticated;
revoke all on sequence public.workbench_product_notes_id_seq from anon, authenticated;

-- Read side: anon-callable, returns everything (the page is Myke-only by convention, noindex).
create or replace function public.workbench_product_notes()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(slug, items), '{}'::jsonb) from (
    select slug, jsonb_agg(jsonb_build_object(
             'id', id, 'kind', kind, 'body', body, 'status', status,
             'created_at', created_at, 'done_at', done_at) order by status, created_at desc) items
      from public.workbench_product_notes group by slug) s;
$$;
revoke all on function public.workbench_product_notes() from public;
grant execute on function public.workbench_product_notes() to anon, authenticated;

-- Tile payload: add updated_at, linear_project_id, linear_query. Body otherwise identical to
-- sql/workbench_dc_bank_live.sql §2.
create or replace function public.workbench_storefront_compute()
returns jsonb language plpgsql stable security definer set search_path = public as $function$
declare
  r         record;
  v_tiles   jsonb := '[]'::jsonb;
  v_stale   jsonb := '[]'::jsonb;
  v_metrics jsonb;
  v_basis   text;
  v_today   date := (now() at time zone 'America/Chicago')::date;
begin
  for r in
    select * from public.workbench_storefront_tiles where enabled order by display_order, slug
  loop
    v_metrics := '{}'::jsonb;
    v_basis   := 'no_feed';
    begin
      case r.slug
        when 'daily-challenge' then
          select jsonb_build_object(
                   'bank_rows',        count(*),
                   'max_go_live_date', max(go_live_date),
                   'scheduled_ahead',  count(*) filter (where go_live_date >= v_today
                                                          and coalesce(published,'') <> 'Retired'),
                   'days_cached',      (select count(*) from public.dc_daily_page_content
                                         where puzzle_date >= v_today
                                           and jsonb_array_length(coalesce(about_content->'games','[]'::jsonb)) > 0))
            into v_metrics from public.dc_puzzle_bank_staging;
          v_basis := 'measured';
        when 'briefing-library' then
          select jsonb_build_object('catalog_rows', count(*)) into v_metrics from public.library_catalog_cache;
          v_basis := 'measured';
        when 'jurisdiction-watch' then
          select jsonb_build_object(
                   'promoted_jurisdictions', (select count(*) from public.jurisdictions where editorial_status = 'promoted'),
                   'briefings', (select count(*) from public.jw_briefings))
            into v_metrics;
          v_basis := 'measured';
        when 'faraday-academy' then
          select jsonb_build_object(
                   'courses_total', (select count(*) from public.academy_courses),
                   'by_status', coalesce((select jsonb_object_agg(s, c) from (select status::text as s, count(*) as c from public.academy_courses group by 1) t), '{}'::jsonb))
            into v_metrics;
          v_basis := 'measured';
        when 'live-agent' then
          select jsonb_build_object('enrich_batches', count(*)) into v_metrics from public.enrich_batches;
          v_basis := 'measured';
        when 'signal-room' then
          select jsonb_build_object('signals', count(*)) into v_metrics from public.signals;
          v_basis := 'measured';
        when 'league-office' then
          select jsonb_build_object('audit_log_rows', count(*)) into v_metrics from public.lo_audit_log;
          v_basis := 'measured';
        when 'faraday-predicts' then
          select jsonb_build_object('predictions', count(*)) into v_metrics from public.predictions;
          v_basis := 'measured';
        when 'intelligent-alert' then
          select jsonb_build_object('signal_events', count(*),
                                    'digest_pending', count(*) filter (where digest_status = 'pending'))
            into v_metrics from public.jw_signal_events;
          v_basis := 'measured';
        else
          v_metrics := '{}'::jsonb; v_basis := 'no_feed';
      end case;
    exception when others then
      v_metrics := '{}'::jsonb; v_basis := 'probe_error';
      v_stale := v_stale || jsonb_build_array(jsonb_build_object(
        'slug', r.slug, 'detail', left(regexp_replace(SQLERRM, '\s+', ' ', 'g'), 240), 'sqlstate', SQLSTATE));
    end;
    v_tiles := v_tiles || jsonb_build_array(jsonb_build_object(
      'slug', r.slug, 'name', r.name, 'status', r.status, 'status_tag', r.status_tag,
      'jira_key', r.jira_key, 'jira_url', r.jira_url, 'blurb', r.blurb,
      'display_order', r.display_order, 'updated_at', r.updated_at,
      'linear_project_id', r.linear_project_id, 'linear_query', r.linear_query,
      'metrics', v_metrics, 'metric_basis', v_basis));
  end loop;
  return jsonb_build_object('generated_at', now(), 'tiles', v_tiles, 'stale_lanes', v_stale);
end;
$function$;

select public.workbench_storefront_refresh();
