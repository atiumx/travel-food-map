-- Don't consume invite use_count for read-only owner pending list (only verify, don't consume)

create or replace function public.list_pending_suggestions(
  p_invite_code text,
  p_display_name text,
  p_place_id uuid
) returns setof public.place_suggestions
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
  v_verify jsonb;
begin
  v_name := trim(coalesce(p_display_name,''));
  if v_name <> 'HM' then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  -- verify only, don't consume
  v_verify := public.verify_invite_code(p_invite_code);
  if (v_verify->>'valid')::boolean is not true then
    raise exception 'invalid_invite' using errcode = '42501';
  end if;

  return query
    select *
      from public.place_suggestions
     where place_id = p_place_id
       and status = 'pending'
     order by created_at desc;
end;
$$;

grant execute on function public.list_pending_suggestions(text, text, uuid) to anon, authenticated;
