-- LOCAL TEST FIXTURE ONLY (FDY-288). Never apply this copy to a Supabase project.
-- Verbatim copy of the Faraday repo migration 20261110150000_fdy288_access_pause_persona.sql,
-- loaded after estate-phase1-subset.sql by test/people-localdb.mjs.

-- FDY-288 (ADM-1.1, People directory and Person page) — two additions to the FDY-252 Phase 1 model.
-- WRITTEN, NOT APPLIED. Myke applies with apply_migration after approving the PR.
-- Requires 20261106222000_fdy252_estate_people_phase1.sql (applied 2026-11-09, ADM-0.1); refuses otherwise.
--
--   1. product_access.status gains 'paused' (Myke, 2026-11-10). A paused row is NOT usable:
--      estate_access_for() already answers usable only for status = 'active', so it needs no change.
--      estate_access_set() accepts 'paused' and audits access.pause / access.resume.
--   2. estate_people.persona_preset (MF-01 … MF-21, NULL = not set) and its one writer,
--      estate_person_set_persona(), which appends admin_audit in the same transaction.
--
-- Idempotent: a second apply changes nothing. One transaction, fail-closed gate at the end.
-- No DROP FUNCTION (it stalls on this project): estate_access_set is patched IN PLACE from its
-- deployed source with asserted replace() calls, same signature, so no overload is created.
-- Additive only: no row is rewritten, no grant is widened, nothing is sent.
--
-- Rollback (only while no row is 'paused' and no persona is set that you want to keep):
--   update public.product_access set status = 'revoked' where status = 'paused';
--   alter table public.product_access drop constraint product_access_status_check;
--   alter table public.product_access add constraint product_access_status_check check (status in ('active', 'revoked'));
--   alter table public.estate_people drop column persona_preset;
--   revoke execute on function public.estate_person_set_persona(text, text, text, text, boolean, text) from service_role;
--   (estate_access_set: re-apply section 7c of the Phase 1 migration.)

do $pre$
begin
  if to_regclass('public.product_access') is null or to_regclass('public.estate_people') is null
     or to_regclass('public.admin_audit') is null
     or to_regprocedure('public.estate_access_set(text,text,text,text,timestamptz,text,text,text,boolean,text)') is null then
    raise exception 'FDY-288 depends on FDY-252 Phase 1 (estate_people, product_access, admin_audit, estate_access_set). Apply that first.';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------------
-- 1. product_access.status: active | paused | revoked
-- ---------------------------------------------------------------------------
do $c$
declare r record;
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.product_access'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) like '%paused%') then
    for r in select conname from pg_constraint
              where conrelid = 'public.product_access'::regclass and contype = 'c'
                and pg_get_constraintdef(oid) like '%status%' loop
      execute format('alter table public.product_access drop constraint %I', r.conname);
    end loop;
    alter table public.product_access
      add constraint product_access_status_check check (status in ('active', 'paused', 'revoked'));
  end if;
end
$c$;

comment on table public.product_access is
  'FDY-252 / FDY-288. Access to a surface: usable iff status=active AND (expires_at is null OR expires_at > now()). status paused = kept but not usable until resumed; revoked = ended. Written ONLY by estate_access_set(); read by estate_access_for() (ISpyaDC getViewer, D-02b). RLS on, service_role only.';

-- estate_access_set: accept 'paused', audit pause and resume. Patched in place from the deployed body.
do $p$
declare
  v_sig constant regprocedure := 'public.estate_access_set(text,text,text,text,timestamptz,text,text,text,boolean,text)'::regprocedure;
  v_src text := pg_get_functiondef(v_sig);
  v_new text;
begin
  if position('''paused''' in v_src) > 0 then
    return;   -- already patched
  end if;
  v_new := v_src;

  assert position('if p_status not in (''active'', ''revoked'') then' in v_new) > 0, 'FDY-288: status check not found in estate_access_set';
  v_new := replace(v_new, 'if p_status not in (''active'', ''revoked'') then', 'if p_status not in (''active'', ''paused'', ''revoked'') then');

  assert position('status must be active or revoked (got %)' in v_new) > 0, 'FDY-288: status message not found in estate_access_set';
  v_new := replace(v_new, 'status must be active or revoked (got %)', 'status must be active, paused or revoked (got %)');

  assert position('when v_old.status = ''active'' and v_new.status = ''revoked'' then ''access.revoke''' in v_new) > 0, 'FDY-288: action mapping not found in estate_access_set';
  v_new := replace(v_new,
    'when v_old.status = ''active'' and v_new.status = ''revoked'' then ''access.revoke''',
    'when v_old.status <> ''paused'' and v_new.status = ''paused'' then ''access.pause''
    when v_old.status = ''paused'' and v_new.status = ''active'' then ''access.resume''
    when v_old.status <> ''revoked'' and v_new.status = ''revoked'' then ''access.revoke''');

  assert v_new <> v_src, 'FDY-288: estate_access_set patch changed nothing';
  execute v_new;
end
$p$;

comment on function public.estate_access_set(text, text, text, text, timestamptz, text, text, text, boolean, text) is
  'FDY-252 / FDY-288. Upsert product_access + admin_audit atomically. status active | paused | revoked; audits access.add / update / pause / resume / revoke / restore. Unchanged input ⇒ changed=false, no audit row. service_role only.';

-- ---------------------------------------------------------------------------
-- 2. estate_people.persona_preset + its one audited writer
-- ---------------------------------------------------------------------------
alter table public.estate_people add column if not exists persona_preset text null;
do $c2$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.estate_people'::regclass and conname = 'estate_people_persona_preset_shape') then
    alter table public.estate_people
      add constraint estate_people_persona_preset_shape check (persona_preset is null or persona_preset ~ '^MF-(0[1-9]|1[0-9]|2[01])$');
  end if;
end
$c2$;
create index if not exists estate_people_persona_idx on public.estate_people (persona_preset) where persona_preset is not null;
comment on column public.estate_people.persona_preset is
  'FDY-288. The My Faraday persona preset this person is reviewed under: MF-01 … MF-21, NULL = not set. Written ONLY by estate_person_set_persona().';

create or replace function public.estate_person_set_persona(
  p_email text, p_persona text, p_actor text, p_reason text,
  p_actor_verified boolean default false, p_via text default 'sql')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := lower(btrim(p_email));
  v_persona text := nullif(upper(btrim(coalesce(p_persona, ''))), '');
  v_old     text;
  v_id      uuid;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'estate_person_set_persona: actor is required';
  end if;
  if v_persona is not null and v_persona !~ '^MF-(0[1-9]|1[0-9]|2[01])$' then
    raise exception 'estate_person_set_persona: persona must be MF-01 to MF-21 or empty (got %)', p_persona;
  end if;
  select id, persona_preset into v_id, v_old from public.estate_people where email_normalised = v_email for update;
  if not found then
    raise exception 'estate_person_set_persona: no person with that email (%)', p_email;
  end if;
  if v_old is not distinct from v_persona then
    return jsonb_build_object('changed', false, 'person_id', v_id, 'persona_preset', v_old);
  end if;
  update public.estate_people set persona_preset = v_persona where id = v_id;
  insert into public.admin_audit (actor, actor_verified, product, subject_email, action, reason, old_value, new_value, via)
  values (btrim(p_actor), coalesce(p_actor_verified, false), 'estate', v_email, 'person.persona', p_reason,
          jsonb_build_object('persona_preset', v_old), jsonb_build_object('persona_preset', v_persona), coalesce(p_via, 'sql'));
  return jsonb_build_object('changed', true, 'person_id', v_id, 'persona_preset', v_persona);
end
$$;
comment on function public.estate_person_set_persona(text, text, text, text, boolean, text) is
  'FDY-288. Set or clear a person''s persona preset (MF-01 … MF-21) + admin_audit atomically. Unchanged ⇒ changed=false, no audit row. service_role only.';

-- EXECUTE posture, by name (the FDY-166 lesson: Supabase grants anon/authenticated explicitly at CREATE).
revoke execute on function public.estate_person_set_persona(text, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.estate_person_set_persona(text, text, text, text, boolean, text) to service_role;
revoke execute on function public.estate_access_set(text, text, text, text, timestamptz, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.estate_access_set(text, text, text, text, timestamptz, text, text, text, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Gate (fail closed: any failure rolls the whole migration back)
-- ---------------------------------------------------------------------------
do $g$
declare f regprocedure;
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'estate_access_set') <> 1 then
    raise exception 'FDY-288 gate: estate_access_set must have exactly one signature';
  end if;
  if position('''paused''' in pg_get_functiondef('public.estate_access_set(text,text,text,text,timestamptz,text,text,text,boolean,text)'::regprocedure)) = 0 then
    raise exception 'FDY-288 gate: estate_access_set does not accept paused';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.product_access'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) like '%paused%') then
    raise exception 'FDY-288 gate: product_access status check does not allow paused';
  end if;
  if exists (select 1 from public.product_access where status not in ('active', 'paused', 'revoked')) then
    raise exception 'FDY-288 gate: unexpected product_access status present';
  end if;
  foreach f in array array[
    'public.estate_person_set_persona(text,text,text,text,boolean,text)'::regprocedure,
    'public.estate_access_set(text,text,text,text,timestamptz,text,text,text,boolean,text)'::regprocedure] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'FDY-288 gate: % is executable by anon or authenticated', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'FDY-288 gate: % is not executable by service_role', f;
    end if;
  end loop;
  raise notice 'FDY-288 gate: paused status live, persona_preset column + writer live, anon/authenticated cannot execute either function.';
end
$g$;
