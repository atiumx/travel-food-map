-- =============================================================
-- Feature B fix 0023: approve_submission populate places.trip_id
-- =============================================================
-- places.trip_id 係 NOT NULL FK → trips.id，但 0021/0022 嘅 approve_submission
-- 漏咗 set，所以 approve 一定撞 not_null_violation。
-- Fix: 由 existing places (同 trip_area_id) 借 trip_id，
--      fallback 攞第一隻 active trip。
-- =============================================================

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

  -- 0023 fix: derive trip_id (NOT NULL FK)
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

  insert into public.audit_logs(action, actor_name, target_id, metadata)
  values ('place_submission_approve', v_owner_name, v_place_id,
    jsonb_build_object('submission_id', p_submission_id, 'submitter', v_submission.submitted_by_name));

  return v_place_id;
end;
$function$;
