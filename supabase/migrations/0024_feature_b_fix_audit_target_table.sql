-- =============================================================
-- Feature B fix 0024: audit_logs.target_table NOT NULL
-- =============================================================
-- audit_logs.target_table 係 NOT NULL 但 0021 嘅 4 個 RPC INSERT
-- 漏咗 target_table 欄，所以 audit log 寫唔入。
-- Fix: submit / reject / approve / update_resolved 4 個 RPC 都 populate target_table。
-- =============================================================

create or replace function public.submit_place_submission(p_invite_code text, p_display_name text, p_raw_url text, p_recommendation integer, p_comment text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_invite_id uuid;
  v_id uuid;
  v_name text;
  v_url text;
  v_comment text;
  v_url_source text;
  v_detected_slug text;
begin
  v_url := trim(coalesce(p_raw_url, ''));
  if length(v_url) = 0 then raise exception 'url_required' using errcode = '22023'; end if;
  if v_url !~* '^https?://' then raise exception 'url_invalid' using errcode = '22023'; end if;

  v_name := trim(coalesce(p_display_name, ''));
  if length(v_name) = 0 then raise exception 'display_name_required' using errcode = '22023'; end if;

  if p_recommendation is not null and (p_recommendation < 1 or p_recommendation > 5) then
    raise exception 'recommendation_out_of_range' using errcode = '22023';
  end if;

  v_comment := nullif(trim(coalesce(p_comment, '')), '');

  v_invite_id := public._consume_invite_code(p_invite_code);

  v_url_source := case
    when v_url ~* 'google\.[a-z\.]+/maps' then 'google_maps'
    when v_url ~* 'maps\.app\.goo\.gl' then 'google_maps'
    when v_url ~* 'goo\.gl/maps' then 'google_maps'
    when v_url ~* 'tabelog\.com' then 'tabelog'
    when v_url ~* 'openrice\.com' then 'openrice'
    else 'unknown'
  end;

  v_detected_slug := case
    when v_url_source = 'tabelog' then null
    when v_url_source = 'openrice' and v_url ~* '/hongkong' then 'hongkong'
    else null
  end;

  insert into public.place_submissions(raw_url, recommendation, comment, submitted_by_invite, submitted_by_name, url_source, detected_trip_area_slug, status)
  values (v_url, p_recommendation, v_comment, v_invite_id, v_name, v_url_source, v_detected_slug, 'pending')
  returning id into v_id;

  insert into public.audit_logs(action, actor_name, target_table, target_id, metadata)
  values ('place_submission_create', v_name, 'place_submissions', v_id,
    jsonb_build_object('url_source', v_url_source, 'recommendation', p_recommendation));

  return v_id;
end;
$function$;

create or replace function public.reject_submission(p_invite_code text, p_display_name text, p_submission_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_invite_id uuid;
  v_role text;
  v_owner_name text;
begin
  select ic.id, ic.role, coalesce(ic.display_name, p_display_name)
    into v_invite_id, v_role, v_owner_name
  from public.invite_codes ic
  where ic.code_lookup_hash = public._invite_code_lookup_hash(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
  if v_role != 'owner' then raise exception 'not_owner' using errcode = '42501'; end if;

  update public.place_submissions
  set status = 'rejected', rejected_reason = nullif(trim(coalesce(p_reason,'')), ''),
      reviewed_at = now(), reviewed_by = v_owner_name
  where id = p_submission_id
    and status in ('pending','resolved','resolve_failed');

  if not found then raise exception 'submission_not_found_or_finalized' using errcode = 'P0002'; end if;

  insert into public.audit_logs(action, actor_name, target_table, target_id, metadata)
  values ('place_submission_reject', v_owner_name, 'place_submissions', p_submission_id, jsonb_build_object('reason', p_reason));
end;
$function$;

create or replace function public.approve_submission(p_invite_code text, p_display_name text, p_submission_id uuid, p_resolved jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_invite_id uuid;
  v_role text;
  v_submission record;
  v_place_id uuid;
  v_trip_area_id uuid;
  v_trip_id uuid;
  v_owner_name text;
begin
  select ic.id, ic.role, coalesce(ic.display_name, p_display_name)
    into v_invite_id, v_role, v_owner_name
  from public.invite_codes ic
  where ic.code_lookup_hash = public._invite_code_lookup_hash(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then raise exception 'invite_invalid' using errcode = 'P0001'; end if;
  if v_role != 'owner' then raise exception 'not_owner' using errcode = '42501'; end if;

  select * into v_submission from public.place_submissions where id = p_submission_id;
  if v_submission.id is null then raise exception 'submission_not_found' using errcode = 'P0002'; end if;
  if v_submission.status in ('approved','rejected') then
    raise exception 'submission_already_finalized' using errcode = '22023';
  end if;

  if p_resolved ? 'trip_area_id' and (p_resolved->>'trip_area_id') is not null then
    v_trip_area_id := (p_resolved->>'trip_area_id')::uuid;
  elsif p_resolved ? 'trip_area_slug' and (p_resolved->>'trip_area_slug') is not null then
    select id into v_trip_area_id from public.trip_areas where slug = p_resolved->>'trip_area_slug' limit 1;
  end if;

  if v_trip_area_id is null then raise exception 'trip_area_required' using errcode = '22023'; end if;
  if (p_resolved->>'name') is null or length(trim(p_resolved->>'name')) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if (p_resolved->>'lat') is null or (p_resolved->>'lng') is null then
    raise exception 'coords_required' using errcode = '22023';
  end if;

  select p.trip_id into v_trip_id from public.places p where p.trip_area_id = v_trip_area_id limit 1;
  if v_trip_id is null then
    select id into v_trip_id from public.trips where is_active = true order by created_at limit 1;
  end if;
  if v_trip_id is null then raise exception 'no_trip_available' using errcode = '22023'; end if;

  insert into public.places(
    trip_id, trip_area_id, name, category, cuisine_group, region, address,
    lat, lng, google_place_id, google_rating, google_user_ratings_total, google_url,
    tabelog_url, openrice_url, openrice_poi_id, phone, opening_hours, price_level,
    source, created_by, verified
  ) values (
    v_trip_id, v_trip_area_id, p_resolved->>'name',
    coalesce(p_resolved->>'category', 'asian'),
    (coalesce(p_resolved->>'cuisine_group', 'other'))::cuisine_group,
    p_resolved->>'region', p_resolved->>'address',
    (p_resolved->>'lat')::double precision, (p_resolved->>'lng')::double precision,
    p_resolved->>'google_place_id',
    nullif(p_resolved->>'google_rating','')::numeric,
    nullif(p_resolved->>'google_user_ratings_total','')::int,
    p_resolved->>'google_url',
    p_resolved->>'tabelog_url', p_resolved->>'openrice_url', p_resolved->>'openrice_poi_id',
    p_resolved->>'phone', p_resolved->>'opening_hours', p_resolved->>'price_level',
    'submission:' || v_submission.url_source,
    v_submission.submitted_by_name, false
  ) returning id into v_place_id;

  if v_submission.recommendation is not null or v_submission.comment is not null then
    insert into public.reviews(place_id, trip_area_id, display_name, rating, comment, visit_date)
    values (v_place_id, v_trip_area_id, v_submission.submitted_by_name,
      v_submission.recommendation, v_submission.comment, current_date);
  end if;

  update public.place_submissions
  set status = 'approved', approved_place_id = v_place_id,
      reviewed_at = now(), reviewed_by = v_owner_name
  where id = p_submission_id;

  insert into public.audit_logs(action, actor_name, target_table, target_id, metadata)
  values ('place_submission_approve', v_owner_name, 'places', v_place_id,
    jsonb_build_object('submission_id', p_submission_id, 'submitter', v_submission.submitted_by_name));

  return v_place_id;
end;
$function$;
