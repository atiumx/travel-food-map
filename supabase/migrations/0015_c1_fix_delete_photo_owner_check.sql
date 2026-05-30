drop function if exists public.delete_photo(text,uuid,text);

create or replace function public.delete_photo(
  p_invite_code text,
  p_display_name text,
  p_photo_id uuid,
  p_kind text
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_name text;
  v_storage_path text;
begin
  v_name := trim(coalesce(p_display_name,''));
  if v_name <> 'HM' then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  select id into v_invite_id from public.invite_codes
   where active = true and code_hash = extensions.crypt(p_invite_code, code_hash) limit 1;
  if v_invite_id is null then
    raise exception 'invalid invite code' using errcode = '28000';
  end if;

  if p_kind = 'place' then
    update public.place_photos set is_hidden = true where id = p_photo_id returning storage_path into v_storage_path;
  elsif p_kind = 'review' then
    update public.review_photos set is_hidden = true where id = p_photo_id returning storage_path into v_storage_path;
  else
    raise exception 'invalid kind' using errcode = '22023';
  end if;

  if v_storage_path is null then
    return false;
  end if;

  insert into public.audit_logs (action, target_table, target_id, actor_name, metadata)
  values ('delete_photo', p_kind||'_photos', p_photo_id::text, v_name,
          jsonb_build_object('storage_path', v_storage_path));

  return true;
end;
$$;

grant execute on function public.delete_photo(text,text,uuid,text) to anon, authenticated;
