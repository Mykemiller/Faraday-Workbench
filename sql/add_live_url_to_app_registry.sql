-- FDY-360 · migration add_live_url_to_app_registry
-- ONE canonical live-site URL per app: public.app_registry.live_url. The status board reads it through
-- app_registry.tile_slug inside workbench_storefront_compute(); the Admin Panel Apps cards read it directly.
-- SUPERSEDES FDY-324's sql/wb_storefront_tiles_add_live_url.sql (never applied; deleted in this PR). The
-- workbench_storefront_tiles.live_url column is deliberately NOT created: two stores can drift, one cannot.
--
-- Dry run 2026-11-13 (read-only, prod): app_registry has 15 rows and no URL-like column except console_url
-- (WB only, '/admin'); the compute function has no 'live_url'; the anchor below occurs exactly once.
-- URLs: each answered HTTP 2xx/3xx to a GET from Postgres on 2026-11-13 (see docs/workbench/FDY-360-RUN-REPORT.md).
-- Left NULL: BS (boundstone.org, www and boardstone.vercel.app all answer 401), PP (no repo/project/domain).
--
-- Idempotent: IF NOT EXISTS everywhere, the snapshot is created once, the backfill touches only rows
-- whose value differs, and the compute patch is skipped when 'live_url' is already in the body.
-- Rollback (the pre-change rows are in public._snapshot_app_registry_20261113):
--   update public.app_registry r set live_url = null;
--   alter table public.app_registry drop constraint app_registry_live_url_https;
--   alter table public.app_registry drop column live_url;
--   alter function public.app_registry_set_live_url(text,text,text,text,boolean,text) rename to app_registry_set_live_url_retired;
--   revoke all on function public.app_registry_set_live_url_retired(text,text,text,text,boolean,text) from service_role;   -- retire by rename + revoke, per CLAUDE.md
--   workbench_storefront_compute: restore the pre-change body saved in the PR (docs/workbench/FDY-360-RUN-REPORT.md), or
--   re-run a replace() that removes the one 'live_url' pair added in step 5.

-- 1. Snapshot first (deny-all, service-role only).
create table if not exists public._snapshot_app_registry_20261113 as table public.app_registry;
alter table public._snapshot_app_registry_20261113 enable row level security;
revoke all on table public._snapshot_app_registry_20261113 from public, anon, authenticated;
grant select on table public._snapshot_app_registry_20261113 to service_role;

-- 2. Column + https-only constraint.
alter table public.app_registry add column if not exists live_url text;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.app_registry'::regclass and conname = 'app_registry_live_url_https') then
    alter table public.app_registry add constraint app_registry_live_url_https check (live_url is null or live_url ~ '^https://');
  end if;
end $$;

-- 3. Audited Owner write (same shape as app_registry_set_state; writes its own admin_audit row).
create or replace function public.app_registry_set_live_url(
  p_code text, p_live_url text, p_actor text, p_reason text,
  p_actor_verified boolean default false, p_via text default 'sql')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_code text := upper(btrim(p_code));
  v_url  text := nullif(btrim(coalesce(p_live_url, '')), '');
  v_old  public.app_registry;
begin
  if p_actor is null or btrim(p_actor) = '' then raise exception 'app_registry_set_live_url: actor is required'; end if;
  if v_url is not null and (v_url !~ '^https://[^[:space:]/?#]+' or v_url ~ '[[:space:]<>"'']' or length(v_url) > 300) then
    raise exception 'app_registry_set_live_url: live_url must be a full https:// address of at most 300 characters (got %)', p_live_url;
  end if;
  select * into v_old from public.app_registry where code = v_code for update;
  if not found then raise exception 'app_registry_set_live_url: no app with code %', p_code; end if;
  if v_old.live_url is not distinct from v_url then
    return jsonb_build_object('changed', false, 'code', v_code, 'live_url', v_old.live_url);
  end if;
  update public.app_registry set live_url = v_url where code = v_code;
  insert into public.admin_audit (actor, actor_verified, product, subject_email, action, reason, old_value, new_value, via)
  values (btrim(p_actor), coalesce(p_actor_verified, false), 'registry', '*', 'app.live_url', p_reason,
          jsonb_build_object('code', v_code, 'live_url', v_old.live_url),
          jsonb_build_object('code', v_code, 'live_url', v_url), coalesce(p_via, 'sql'));
  return jsonb_build_object('changed', true, 'code', v_code, 'live_url', v_url);
end
$fn$;
-- Revoke BY NAME (default privileges grant anon/authenticated EXECUTE); service role only.
revoke all on function public.app_registry_set_live_url(text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.app_registry_set_live_url(text, text, text, text, boolean, text) to service_role;

-- 4. Backfill: only rows whose value differs. WB serves faraday-stuff.com from the www host (the bare
--    domain is not attached to the faraday-workbench project and does not resolve).
update public.app_registry r set live_url = v.u
from (values
  ('BL','https://www.faraday-intelligence.ai/library'),
  ('CH','https://civic-host.com'),
  ('DC','https://www.faradaydailychallenge.com'),
  ('FA','https://faraday-academy.vercel.app/academy'),          -- preview-grade (*.vercel.app): consider a custom domain
  ('FP','https://www.faraday-intelligence.ai/predicts'),
  ('IA','https://www.faraday-intelligence.ai/intelligent-alert'),
  ('IS','https://ispyadc.com'),
  ('JW','https://www.jurisdiction-watch.com'),
  ('LA','https://www.faraday-live-agent.com'),
  ('LO','https://league-office.vercel.app'),                    -- preview-grade (*.vercel.app): consider a custom domain
  ('SR','https://faraday-signal-room.com/signal-room'),
  ('TF','https://www.faraday-thoughtforge.com/'),
  ('WB','https://www.faraday-stuff.com')
) as v(code, u)
where r.code = v.code and r.live_url is distinct from v.u;

-- 5. Board payload: add 'live_url' (looked up through tile_slug) to every tile. Patched from the DEPLOYED
--    body with an asserted replace(), never retyped.
do $$
declare
  v_def text;
  v_anchor constant text := E'\'linear_label\', r.linear_label,';
begin
  select pg_get_functiondef('public.workbench_storefront_compute'::regproc) into v_def;
  if position('''live_url''' in v_def) > 0 then return; end if;                 -- idempotent
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'add_live_url_to_app_registry: anchor not found exactly once; aborting';
  end if;
  execute replace(v_def, v_anchor, v_anchor || E'\n      \'live_url\', (select ar.live_url from public.app_registry ar where ar.tile_slug = r.slug limit 1),');
end $$;
