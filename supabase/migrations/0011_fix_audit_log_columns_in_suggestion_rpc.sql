-- Fix: audit_logs uses (actor_name, metadata), not (actor_invite, payload).

create or replace function public.submit_place_suggestion(
  p_invite_code text,
  p_display_name text,
  p_place_id uuid,
  p_type text,
  p_rating int,
  p_comment text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_id uuid;
  v_name text;
  v_comment text;
begin
  if p_type not in ('correction','recommend','warning') then
    raise exception 'invalid_type' using errcode = '22023';
  end if;

  if p_type in ('recommend','warning') and p_rating is null then
    raise exception 'rating_required' using errcode = '22023';
  end if;

  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating_out_of_range' using errcode = '22023';
  end if;

  v_comment := trim(coalesce(p_comment,''));
  if length(v_comment) = 0 then
    raise exception 'comment_required' using errcode = '22023';
  end if;

  v_name := trim(coalesce(p_display_name,''));
  if length(v_name) = 0 then
    raise exception 'display_name_required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.places where id = p_place_id and coalesce(is_archived,false) = false) then
    raise exception 'place_not_found' using errcode = 'P0002';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  insert into public.place_suggestions(
    place_id, suggested_by_invite, suggested_by_name,
    type, rating, comment, status
  )
  values (
    p_place_id, v_invite_id, v_name,
    p_type, p_rating, v_comment, 'pending'
  )
  returning id into v_id;

  insert into public.audit_logs(action, target_table, target_id, actor_name, metadata)
  values (
    'submit_place_suggestion', 'place_suggestions', v_id, v_name,
    jsonb_build_object('place_id', p_place_id, 'type', p_type, 'rating', p_rating)
  );

  return v_id;
end;
$$;

grant execute on function public.submit_place_suggestion(text, text, uuid, text, int, text) to anon, authenticated;

create or replace function public.review_place_suggestion(
  p_invite_code text,
  p_display_name text,
  p_suggestion_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_name text;
begin
  if p_status not in ('approved','rejected') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  v_name := trim(coalesce(p_display_name,''));
  if v_name <> 'HM' then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  update public.place_suggestions
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = v_name
   where id = p_suggestion_id
     and status = 'pending';

  if not found then
    raise exception 'suggestion_not_found_or_already_reviewed' using errcode = 'P0002';
  end if;

  insert into public.audit_logs(action, target_table, target_id, actor_name, metadata)
  values (
    'review_place_suggestion', 'place_suggestions', p_suggestion_id, v_name,
    jsonb_build_object('status', p_status)
  );
end;
$$;

grant execute on function public.review_place_suggestion(text, text, uuid, text) to anon, authenticated;
