-- LOCAL TEST FIXTURE ONLY (FDY-285). Never apply this to a Supabase project.
--
-- The parts of the Faraday repo migration 20261106222000_fdy252_estate_people_phase1.sql that
-- Workbench sign-in reads and writes: estate_people, product_access, admin_audit and the three
-- estate_* RPCs. Copied verbatim, except that estate_people's two bridge columns lose their
-- foreign keys (subscribers and dc_subscribers are not created here) and the grants cover only
-- these three tables. test/auth-localdb.mjs loads it into a throwaway local database.

do $r$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $r$;
grant usage on schema public to anon, authenticated, service_role;

create table if not exists public.estate_people (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  email_normalised text generated always as (lower(btrim(email))) stored,
  display_name     text null,
  subscriber_id    uuid null,     -- D-01 bridge (JW / commerce)
  dc_subscriber_id uuid null,  -- Daily Challenge bridge
  auth_user_id     uuid null,   -- Faraday auth.users.id once the person signs in (Phase 2 OTP); no FK by design
  source           text not null,   -- 'predicts-approved' | 'dailychallenge' | 'predicts' | 'workbench' | 'access:<product>' …
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint estate_people_email_shape check (position('@' in btrim(email)) > 1),
  constraint estate_people_source_nonempty check (btrim(source) <> '')
);
create unique index if not exists estate_people_email_uniq on public.estate_people (email_normalised);
create unique index if not exists estate_people_subscriber_uniq on public.estate_people (subscriber_id) where subscriber_id is not null;
create unique index if not exists estate_people_dc_subscriber_uniq on public.estate_people (dc_subscriber_id) where dc_subscriber_id is not null;
create unique index if not exists estate_people_auth_user_uniq on public.estate_people (auth_user_id) where auth_user_id is not null;
comment on table public.estate_people is
  'FDY-252 D-01/D-12. Canonical person, keyed by lowercased+trimmed email. Owned by the estate (Workbench). Products read it and create rows only through estate_person_ensure(); they never update it. NOT public.people (IDF Key Players). RLS on, service_role only.';


create table if not exists public.product_access (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.estate_people(id),
  product     text not null check (product in ('ispyadc', 'workbench', 'dailychallenge', 'jw', 'predicts')),
  role        text not null check (btrim(role) <> ''),
  status      text not null default 'active' check (status in ('active', 'revoked')),
  expires_at  timestamptz null,   -- NULL = no expiry
  note        text null,
  added_by    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (person_id, product)
);
comment on table public.product_access is
  'FDY-252. Access to a surface: usable iff status=active AND (expires_at is null OR expires_at > now()). Written ONLY by estate_access_set(); read by estate_access_for() (ISpyaDC getViewer, D-02b). RLS on, service_role only.';


create table if not exists public.admin_audit (
  id             uuid primary key default gen_random_uuid(),
  at             timestamptz not null default now(),
  actor          text not null check (btrim(actor) <> ''),
  actor_verified boolean not null,
  product        text not null,
  subject_email  text not null,
  action         text not null,
  reason         text null,
  old_value      jsonb null,
  new_value      jsonb null,
  via            text not null
);
create index if not exists admin_audit_subject_idx on public.admin_audit (subject_email, at desc);
comment on table public.admin_audit is
  'FDY-252 §4.8. Append-only (UPDATE/DELETE/TRUNCATE raise). actor_verified=false until the Workbench has OTP sign-in (D-04, Phase 2). RLS on, service_role SELECT/INSERT only.';

create or replace function public.admin_audit_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'admin_audit is append-only (% refused)', tg_op;
end
$$;
create or replace trigger admin_audit_no_update before update or delete on public.admin_audit
  for each row execute function public.admin_audit_append_only();
create or replace trigger admin_audit_no_truncate before truncate on public.admin_audit
  for each statement execute function public.admin_audit_append_only();


alter table public.estate_people   enable row level security;
alter table public.product_access  enable row level security;
alter table public.admin_audit     enable row level security;
revoke all on public.estate_people, public.product_access, public.admin_audit from public, anon, authenticated;
grant select, insert, update on public.estate_people, public.product_access to service_role;
grant select, insert on public.admin_audit to service_role;
revoke update, delete, truncate on public.admin_audit from service_role;

-- 7a. estate_person_ensure(email, source) → person id. The ONLY way a product creates a person.
create or replace function public.estate_person_ensure(p_email text, p_source text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_id    uuid;
begin
  if v_email is null or position('@' in v_email) <= 1 then
    raise exception 'estate_person_ensure: not an email address (%)', p_email;
  end if;
  if p_source is null or btrim(p_source) = '' then
    raise exception 'estate_person_ensure: source is required';
  end if;
  select id into v_id from public.estate_people where email_normalised = v_email;
  if found then
    return v_id;
  end if;
  insert into public.estate_people (email, source) values (v_email, btrim(p_source))
  on conflict (email_normalised) do nothing
  returning id into v_id;
  if v_id is null then   -- lost a race: someone else inserted it
    select id into v_id from public.estate_people where email_normalised = v_email;
    return v_id;
  end if;
  insert into public.admin_audit (actor, actor_verified, product, subject_email, action, new_value, via)
  values ('system:estate_person_ensure', true, 'estate', v_email, 'person.create',
          jsonb_build_object('person_id', v_id, 'source', btrim(p_source)), 'rpc:estate_person_ensure');
  return v_id;
end
$$;
comment on function public.estate_person_ensure(text, text) is
  'FDY-252. Find-or-create the estate person for an email (lowercased+trimmed). Audits person.create only when a row is created. service_role only.';

-- 7b. estate_access_for(email, product) — the read path ISpyaDC getViewer() uses (D-02b).
create or replace function public.estate_access_for(p_email text, p_product text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
              'person_id', a.person_id, 'product', a.product, 'role', a.role, 'status', a.status,
              'expires_at', a.expires_at,
              'usable', a.status = 'active' and (a.expires_at is null or a.expires_at > now()))
       from public.product_access a
       join public.estate_people p on p.id = a.person_id
      where p.email_normalised = lower(btrim(p_email)) and a.product = p_product),
    jsonb_build_object('product', p_product, 'usable', false, 'status', 'none'));
$$;
comment on function public.estate_access_for(text, text) is
  'FDY-252 D-02b. {usable, role, status, expires_at} for (email, product); absence ⇒ usable=false. Same rule as ISpyaDC lib/auth/access.ts. service_role only.';

-- 7c. estate_access_set — the ONLY writer of product_access. No-op (and no audit row) when unchanged.
create or replace function public.estate_access_set(
  p_email text, p_product text, p_role text, p_status text, p_expires_at timestamptz,
  p_note text, p_actor text, p_reason text,
  p_actor_verified boolean default false, p_via text default 'sql')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person uuid;
  v_old    public.product_access;
  v_new    public.product_access;
  v_action text;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'estate_access_set: actor is required';
  end if;
  if p_status not in ('active', 'revoked') then
    raise exception 'estate_access_set: status must be active or revoked (got %)', p_status;
  end if;
  v_person := public.estate_person_ensure(p_email, 'access:' || p_product);
  select * into v_old from public.product_access where person_id = v_person and product = p_product;
  if found and v_old.role = p_role and v_old.status = p_status
     and v_old.expires_at is not distinct from p_expires_at and v_old.note is not distinct from p_note then
    return jsonb_build_object('changed', false, 'person_id', v_person, 'product', p_product,
                              'role', v_old.role, 'status', v_old.status, 'expires_at', v_old.expires_at);
  end if;
  insert into public.product_access (person_id, product, role, status, expires_at, note, added_by)
  values (v_person, p_product, p_role, p_status, p_expires_at, p_note, btrim(p_actor))
  on conflict (person_id, product) do update
     set role = excluded.role, status = excluded.status, expires_at = excluded.expires_at, note = excluded.note
  returning * into v_new;
  v_action := case
    when v_old.id is null then 'access.add'
    when v_old.status = 'active' and v_new.status = 'revoked' then 'access.revoke'
    when v_old.status = 'revoked' and v_new.status = 'active' then 'access.restore'
    else 'access.update' end;
  insert into public.admin_audit (actor, actor_verified, product, subject_email, action, reason, old_value, new_value, via)
  values (btrim(p_actor), coalesce(p_actor_verified, false), p_product, lower(btrim(p_email)), v_action, p_reason,
          case when v_old.id is null then null
               else jsonb_build_object('role', v_old.role, 'status', v_old.status, 'expires_at', v_old.expires_at, 'note', v_old.note) end,
          jsonb_build_object('role', v_new.role, 'status', v_new.status, 'expires_at', v_new.expires_at, 'note', v_new.note),
          coalesce(p_via, 'sql'));
  return jsonb_build_object('changed', true, 'action', v_action, 'person_id', v_person, 'product', p_product,
                            'role', v_new.role, 'status', v_new.status, 'expires_at', v_new.expires_at);
end
$$;
comment on function public.estate_access_set(text, text, text, text, timestamptz, text, text, text, boolean, text) is
  'FDY-252. Upsert product_access + admin_audit atomically. Unchanged input ⇒ changed=false, no audit row. service_role only.';


revoke execute on function public.estate_person_ensure(text, text) from public, anon, authenticated;
revoke execute on function public.estate_access_for(text, text) from public, anon, authenticated;
revoke execute on function public.estate_access_set(text, text, text, text, timestamptz, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.estate_person_ensure(text, text) to service_role;
grant execute on function public.estate_access_for(text, text) to service_role;
grant execute on function public.estate_access_set(text, text, text, text, timestamptz, text, text, text, boolean, text) to service_role;
