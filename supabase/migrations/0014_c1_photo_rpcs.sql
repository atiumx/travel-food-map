-- C2a: photo RPCs (friend/owner can add; owner can delete)

create or replace function public.add_place_photo(
  p_invite_code text,
  p_place_id uuid,
  p_storage_path text,
  p_display_name text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_photo_id uuid;
  v_sort int;
begin
  select id into v_invite_id from public.invite_codes
   where active = true
     and code_hash = extensions.crypt(p_invite_code, code_hash)
   limit 1;
  if v_invite_id is null then
    raise exception 'invalid invite code' using errcode = '28000';
  end if;
  if not exists (select 1 from public.places where id = p_place_id and coalesce(is_archived,false)=false) then
    raise exception 'place not found' using errcode = 'P0001';
  end if;
  if p_storage_path is null or position(('places/'||p_place_id::text||'/') in p_storage_path) <> 1 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;

  select coalesce(max(sort_order),0)+1 into v_sort from public.place_photos where place_id = p_place_id;

  insert into public.place_photos (place_id, storage_path, uploaded_by_name, sort_order)
  values (p_place_id, p_storage_path, p_display_name, v_sort)
  returning id into v_photo_id;

  insert into public.audit_logs (action, target_table, target_id, actor_name, metadata)
  values ('add_place_photo', 'place_photos', v_photo_id::text, coalesce(p_display_name,'anon'),
          jsonb_build_object('place_id', p_place_id, 'storage_path', p_storage_path));

  return v_photo_id;
end;
$$;

grant execute on function public.add_place_photo(text,uuid,text,text) to anon, authenticated;

create or replace function public.add_review_photo(
  p_invite_code text,
  p_review_id uuid,
  p_storage_path text,
  p_display_name text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_place_id uuid;
  v_photo_id uuid;
begin
  select id into v_invite_id from public.invite_codes
   where active = true and code_hash = extensions.crypt(p_invite_code, code_hash) limit 1;
  if v_invite_id is null then
    raise exception 'invalid invite code' using errcode = '28000';
  end if;
  select place_id into v_place_id from public.reviews where id = p_review_id and coalesce(is_hidden,false)=false;
  if v_place_id is null then
    raise exception 'review not found' using errcode = 'P0001';
  end if;
  if p_storage_path is null or position(('reviews/'||p_review_id::text||'/') in p_storage_path) <> 1 then
    raise exception 'invalid storage path' using errcode = '22023';
  end if;

  update public.review_photos set is_hidden = true where review_id = p_review_id and is_hidden = false;

  insert into public.review_photos (review_id, storage_path, uploaded_by_name)
  values (p_review_id, p_storage_path, p_display_name)
  returning id into v_photo_id;

  insert into public.audit_logs (action, target_table, target_id, actor_name, metadata)
  values ('add_review_photo', 'review_photos', v_photo_id::text, coalesce(p_display_name,'anon'),
          jsonb_build_object('review_id', p_review_id, 'storage_path', p_storage_path));

  return v_photo_id;
end;
$$;

grant execute on function public.add_review_photo(text,uuid,text,text) to anon, authenticated;
