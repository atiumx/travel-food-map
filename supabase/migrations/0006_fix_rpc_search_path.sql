-- =============================================================
-- 0006_fix_rpc_search_path.sql
-- pgcrypto 位於 extensions schema，SECURITY DEFINER 函式
-- 必須將 extensions 加入 search_path，否則 crypt() / gen_salt() 揾唔到
-- 全部 4 個 RPC 重建（只改 set search_path）
-- =============================================================

create or replace function public.verify_invite_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.invite_codes%rowtype;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return jsonb_build_object('valid', false, 'reason', 'empty_code');
  end if;

  select * into v_row
  from public.invite_codes
  where code_hash = crypt(p_code, code_hash)
  limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;
  if not v_row.active then
    return jsonb_build_object('valid', false, 'reason', 'inactive');
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  if v_row.max_uses is not null and v_row.use_count >= v_row.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'exhausted');
  end if;

  return jsonb_build_object('valid', true, 'label', v_row.label);
end;
$$;

create or replace function public._consume_invite_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.invite_codes%rowtype;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'invite_code_required';
  end if;

  select * into v_row
  from public.invite_codes
  where code_hash = crypt(p_code, code_hash)
  for update
  limit 1;

  if not found then raise exception 'invite_code_invalid'; end if;
  if not v_row.active then raise exception 'invite_code_inactive'; end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    raise exception 'invite_code_expired';
  end if;
  if v_row.max_uses is not null and v_row.use_count >= v_row.max_uses then
    raise exception 'invite_code_exhausted';
  end if;

  update public.invite_codes set use_count = use_count + 1 where id = v_row.id;
  return v_row.id;
end;
$$;

-- add_place / add_review 不用 crypt，但統一 search_path
-- （內容同 0003 一致，只係 set search_path 加 extensions）
-- 完整版見 0003，呢度 alter set 即可

alter function public.add_place(text, text, text, jsonb) set search_path = public, extensions;
alter function public.add_review(text, text, uuid, numeric, text, date) set search_path = public, extensions;
