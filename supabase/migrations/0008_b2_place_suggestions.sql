-- B2: place_suggestions table for collaborative correction / recommend / warning with rating

create table if not exists public.place_suggestions (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  suggested_by_invite uuid references public.invite_codes(id) on delete set null,
  suggested_by_name text not null,
  type text not null check (type in ('correction','recommend','warning')),
  rating int2 check (rating between 1 and 5),
  comment text not null check (length(trim(comment)) > 0),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);

create index if not exists place_suggestions_place_idx on public.place_suggestions(place_id);
create index if not exists place_suggestions_status_idx on public.place_suggestions(status);
create index if not exists place_suggestions_created_idx on public.place_suggestions(created_at desc);

alter table public.place_suggestions enable row level security;

-- anon can read approved suggestions only
drop policy if exists place_suggestions_select_approved on public.place_suggestions;
create policy place_suggestions_select_approved on public.place_suggestions
  for select to anon, authenticated
  using (status = 'approved');

-- no direct insert/update/delete from anon; everything via SECURITY DEFINER RPC

-- RPC: submit_place_suggestion
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

  insert into public.audit_logs(action, target_table, target_id, actor_invite, actor_name, payload)
  values (
    'submit_place_suggestion', 'place_suggestions', v_id, v_invite_id, v_name,
    jsonb_build_object('place_id', p_place_id, 'type', p_type, 'rating', p_rating)
  );

  return v_id;
end;
$$;

grant execute on function public.submit_place_suggestion(text, text, uuid, text, int, text) to anon, authenticated;

-- RPC: review_place_suggestion (owner only: HM)
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

  insert into public.audit_logs(action, target_table, target_id, actor_invite, actor_name, payload)
  values (
    'review_place_suggestion', 'place_suggestions', p_suggestion_id, v_invite_id, v_name,
    jsonb_build_object('status', p_status)
  );
end;
$$;

grant execute on function public.review_place_suggestion(text, text, uuid, text) to anon, authenticated;
