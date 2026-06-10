-- ============================================================
-- Migration 0026: Feature C — Owner invite code management
-- 3 RPC: list / create / toggle_active
-- All SECURITY DEFINER, owner-only via code_lookup_hash + role='owner'
-- Applied to prod via Supabase MCP apply_migration on 2026-06-10.
-- ============================================================

-- ---------- 1. list_owner_invite_codes ----------
CREATE OR REPLACE FUNCTION public.list_owner_invite_codes(
  p_invite_code text,
  p_display_name text
)
RETURNS TABLE (
  id          uuid,
  label       text,
  role        text,
  active      boolean,
  max_uses    integer,
  use_count   integer,
  expires_at  timestamptz,
  created_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_invite_id uuid;
  v_role text;
begin
  select ic.id, ic.role into v_invite_id, v_role
  from public.invite_codes ic
  where ic.code_lookup_hash = public._invite_code_lookup_hash(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
  if v_role != 'owner' then raise exception 'not_owner' using errcode = '42501'; end if;

  return query
  select ic.id, ic.label, ic.role, ic.active, ic.max_uses, ic.use_count,
         ic.expires_at, ic.created_at
  from public.invite_codes ic
  order by ic.active desc, ic.created_at desc
  limit 200;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.list_owner_invite_codes(text, text) TO anon, authenticated;


-- ---------- 2. create_invite_code ----------
-- Server-side generates code: <prefix>-<3-alpha>-<3-alphanumeric>
-- prefix derived from role: 'fr' for friend, 'ow' for owner
-- Returns {id, label, role, code_plaintext} — code shown ONCE
CREATE OR REPLACE FUNCTION public.create_invite_code(
  p_invite_code text,
  p_display_name text,
  p_label text,
  p_role text,
  p_max_uses integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_invite_id uuid;
  v_role text;
  v_prefix text;
  v_alphabet text := 'abcdefghijkmnpqrstuvwxyz23456789'; -- 32 chars, no 0/1/l/o/i
  v_code text;
  v_attempt int := 0;
  v_new_id uuid;
  v_dup int;
begin
  -- ---- auth: owner only ----
  select ic.id, ic.role into v_invite_id, v_role
  from public.invite_codes ic
  where ic.code_lookup_hash = public._invite_code_lookup_hash(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
  if v_role != 'owner' then raise exception 'not_owner' using errcode = '42501'; end if;

  -- ---- input validation ----
  if p_label is null or length(trim(p_label)) = 0 then
    raise exception 'label_required';
  end if;
  if length(p_label) > 200 then
    raise exception 'label_too_long';
  end if;
  if p_role not in ('friend','owner') then
    raise exception 'invalid_role';
  end if;
  if p_max_uses is not null and p_max_uses < 1 then
    raise exception 'invalid_max_uses';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expires_at_in_past';
  end if;

  -- ---- unique label check ----
  select count(*) into v_dup from public.invite_codes where label = trim(p_label);
  if v_dup > 0 then
    raise exception 'label_duplicate';
  end if;

  v_prefix := case p_role when 'owner' then 'ow' else 'fr' end;

  -- ---- code generation with retry on hash collision ----
  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 10 then
      raise exception 'code_gen_failed_after_10_attempts';
    end if;

    v_code := v_prefix || '-' ||
      substr(v_alphabet, 1+floor(random()*32)::int, 1) ||
      substr(v_alphabet, 1+floor(random()*32)::int, 1) ||
      substr(v_alphabet, 1+floor(random()*32)::int, 1) || '-' ||
      substr(v_alphabet, 1+floor(random()*32)::int, 1) ||
      substr(v_alphabet, 1+floor(random()*32)::int, 1) ||
      substr(v_alphabet, 1+floor(random()*32)::int, 1);

    select count(*) into v_dup
    from public.invite_codes
    where code_lookup_hash = public._invite_code_lookup_hash(v_code);
    if v_dup = 0 then exit; end if;
  end loop;

  -- ---- insert ----
  insert into public.invite_codes (
    label, code_hash, code_lookup_hash, active, max_uses, use_count,
    expires_at, role
  ) values (
    trim(p_label),
    crypt(v_code, gen_salt('bf', 10)),
    public._invite_code_lookup_hash(v_code),
    true,
    p_max_uses,
    0,
    p_expires_at,
    p_role
  ) returning id into v_new_id;

  return jsonb_build_object(
    'id', v_new_id,
    'label', trim(p_label),
    'role', p_role,
    'code_plaintext', v_code
  );
end;
$function$;

GRANT EXECUTE ON FUNCTION public.create_invite_code(text, text, text, text, integer, timestamptz) TO anon, authenticated;


-- ---------- 3. toggle_invite_code_active ----------
-- Self-protection: owner cannot deactivate the code they are currently using
CREATE OR REPLACE FUNCTION public.toggle_invite_code_active(
  p_invite_code text,
  p_display_name text,
  p_target_invite_id uuid,
  p_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_invite_id uuid;
  v_role text;
  v_target_row public.invite_codes%rowtype;
begin
  select ic.id, ic.role into v_invite_id, v_role
  from public.invite_codes ic
  where ic.code_lookup_hash = public._invite_code_lookup_hash(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
  if v_role != 'owner' then raise exception 'not_owner' using errcode = '42501'; end if;

  if v_invite_id = p_target_invite_id and p_active = false then
    raise exception 'cannot_deactivate_self';
  end if;

  select * into v_target_row from public.invite_codes where id = p_target_invite_id;
  if not found then raise exception 'target_not_found'; end if;

  update public.invite_codes
  set active = p_active
  where id = p_target_invite_id;

  return jsonb_build_object(
    'id', p_target_invite_id,
    'label', v_target_row.label,
    'active', p_active
  );
end;
$function$;

GRANT EXECUTE ON FUNCTION public.toggle_invite_code_active(text, text, uuid, boolean) TO anon, authenticated;
