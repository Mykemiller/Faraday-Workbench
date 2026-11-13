-- CC-WORKBENCH-CRITICALS-ESTATE-LINKS-1.0 (FDY-324) · migration wb_storefront_tiles_add_live_url
-- Adds workbench_storefront_tiles.live_url, fills it ONLY for URLs that returned HTTP 2xx/3xx to a
-- GET with a 10 s timeout on 2026-11-12 (D-4), and emits live_url from workbench_storefront_compute().
-- Left NULL (shown as NO LIVE URL): boundstone (www.boundstone.org and boardstone.vercel.app answer 401),
-- panel-podcast (no repo / Vercel project / domain found), live-agent (tile disabled).
-- The compute function is patched from the DEPLOYED body with an asserted replace(), never retyped.
-- Rollback: alter table public.workbench_storefront_tiles drop column live_url;  then re-run
--           the previous body (select pg_get_functiondef from the pre-change deploy, or drop the 'live_url' pair).
alter table public.workbench_storefront_tiles add column if not exists live_url text;

update public.workbench_storefront_tiles t set live_url = v.u
from (values
  ('jurisdiction-watch','https://jurisdiction-watch.com'),
  ('faraday-predicts',  'https://www.faraday-intelligence.ai/predicts'),
  ('thought-forge',     'https://www.faraday-thoughtforge.com/'),
  ('daily-challenge',   'https://faradaydailychallenge.com'),
  ('faraday-academy',   'https://faraday-academy.vercel.app/academy'),
  ('briefing-library',  'https://www.faraday-intelligence.ai/library'),
  ('intelligent-alert', 'https://www.faraday-intelligence.ai/intelligent-alert'),
  ('ispyadc',           'https://ispyadc.com'),
  ('signal-room',       'https://faraday-signal-room.com/signal-room'),
  ('league-office',     'https://league-office.vercel.app'),
  ('civic-host',        'https://civic-host.com'),
  ('estate-security',   'https://www.faraday-stuff.com/#estate'),
  ('idf-health',        'https://www.faraday-stuff.com/#feeds')
) as v(slug,u)
where t.slug = v.slug and t.live_url is distinct from v.u;

do $$
declare
  v_def text;
  v_anchor constant text := E'\'linear_label\', r.linear_label,';
begin
  select pg_get_functiondef('public.workbench_storefront_compute'::regproc) into v_def;
  if position('''live_url''' in v_def) > 0 then return; end if;                 -- idempotent
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'wb_storefront_tiles_add_live_url: anchor not found exactly once; aborting';
  end if;
  execute replace(v_def, v_anchor, v_anchor || E'\n      \'live_url\', r.live_url,');
end $$;
