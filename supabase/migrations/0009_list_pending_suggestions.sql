-- Owner-only RPC to list pending suggestions (RLS only exposes approved publicly)
-- Superseded by 0010 to avoid consuming invite use_count on every detail view.

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
  v_invite_id uuid;
  v_name text;
begin
  v_name := trim(coalesce(p_display_name,''));
  if v_name <> 'HM' then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  return query
    select *
      from public.place_suggestions
     where place_id = p_place_id
       and status = 'pending'
     order by created_at desc;
end;
$$;

grant execute on function public.list_pending_suggestions(text, text, uuid) to anon, authenticated;
