-- E2: Update add_place to extract day_tag from jsonb payload + new owner-only update_place_day RPC

CREATE OR REPLACE FUNCTION public.add_place(p_invite_code text, p_display_name text, p_trip_area_slug text, p_place jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_invite_id    uuid;
  v_trip_area_id uuid;
  v_legacy_trip_id uuid;
  v_place_id     uuid;
  v_name         text;
  v_price        text;
  v_links        jsonb;
  v_closed_days  int[];
  v_google_url   text;
  v_tabelog_url  text;
  v_day_tag      smallint;
begin
  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception 'display_name_required';
  end if;
  if length(trim(p_display_name)) > 40 then
    raise exception 'display_name_too_long';
  end if;

  v_name := trim(coalesce(p_place->>'name',''));
  if length(v_name) = 0 then
    raise exception 'place_name_required';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  select id into v_trip_area_id from public.trip_areas where slug = p_trip_area_slug limit 1;
  if v_trip_area_id is null then
    raise exception 'trip_area_not_found';
  end if;

  if p_trip_area_slug = 'kyushu' then
    select id into v_legacy_trip_id from public.trips where slug = 'fukuoka-kitakyushu-2026' limit 1;
  elsif p_trip_area_slug = 'osaka' then
    select id into v_legacy_trip_id from public.trips where slug = 'osaka-2026' limit 1;
  else
    select id into v_legacy_trip_id from public.trips order by created_at limit 1;
  end if;

  v_price := nullif(trim(coalesce(p_place->>'price_level','')), '');
  if v_price is not null and v_price not in ('¥','¥¥','¥¥¥','¥¥¥¥') then
    raise exception 'invalid_price_level';
  end if;

  v_google_url  := nullif(trim(coalesce(p_place->>'google_url','')), '');
  v_tabelog_url := nullif(trim(coalesce(p_place->>'tabelog_url','')), '');

  v_links := coalesce(p_place->'links', '{}'::jsonb);
  if v_google_url is not null then
    v_links := v_links || jsonb_build_object('maps', v_google_url);
  end if;
  if v_tabelog_url is not null then
    v_links := v_links || jsonb_build_object('tabelog', v_tabelog_url);
  end if;

  if jsonb_typeof(p_place->'closed_days') = 'array' then
    select array_agg((v)::int) into v_closed_days
    from jsonb_array_elements_text(p_place->'closed_days') v;
  else
    v_closed_days := '{}'::int[];
  end if;

  v_day_tag := nullif(p_place->>'day_tag','')::smallint;
  if v_day_tag is not null and (v_day_tag < 1 or v_day_tag > 7) then
    raise exception 'invalid_day_tag';
  end if;

  insert into public.places (
    trip_area_id, trip_id, name, category, region,
    price_level, price, lat, lng,
    google_rating, grating, tabelog_rating, tabelog,
    tags, note, address, links, google_url, tabelog_url,
    opening_hours, closed_days, source, day_tag,
    created_by, updated_by, is_archived, is_hidden
  ) values (
    v_trip_area_id, v_legacy_trip_id, v_name,
    nullif(trim(coalesce(p_place->>'category','')), ''),
    nullif(trim(coalesce(p_place->>'region','')), ''),
    v_price, v_price,
    nullif(p_place->>'lat','')::double precision,
    nullif(p_place->>'lng','')::double precision,
    nullif(p_place->>'google_rating','')::numeric,
    nullif(p_place->>'google_rating','')::numeric,
    nullif(p_place->>'tabelog_rating','')::numeric,
    nullif(p_place->>'tabelog_rating','')::numeric,
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_place->'tags')), '{}'::text[]),
    nullif(trim(coalesce(p_place->>'note','')), ''),
    nullif(trim(coalesce(p_place->>'address','')), ''),
    v_links, v_google_url, v_tabelog_url,
    nullif(trim(coalesce(p_place->>'opening_hours','')), ''),
    v_closed_days,
    nullif(trim(coalesce(p_place->>'source','')), ''),
    v_day_tag,
    p_display_name, p_display_name, false, false
  )
  returning id into v_place_id;

  insert into public.audit_logs (actor_name, action, target_table, target_id, metadata)
  values (p_display_name, 'add_place', 'places', v_place_id,
    jsonb_build_object('invite_code_id', v_invite_id, 'trip_area_slug', p_trip_area_slug, 'place_name', v_name, 'day_tag', v_day_tag));

  return v_place_id;
end;
$function$;

-- Owner-only RPC to update day_tag on existing place
CREATE OR REPLACE FUNCTION public.update_place_day(
  p_invite_code text,
  p_display_name text,
  p_place_id uuid,
  p_day_tag smallint
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_invite_id uuid;
begin
  if p_display_name is null or trim(p_display_name) <> 'HM' then
    raise exception 'owner_only';
  end if;
  if p_day_tag is not null and (p_day_tag < 1 or p_day_tag > 7) then
    raise exception 'invalid_day_tag';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  update public.places
     set day_tag = p_day_tag,
         updated_by = p_display_name,
         updated_at = now()
   where id = p_place_id;

  if not found then
    raise exception 'place_not_found';
  end if;

  insert into public.audit_logs (actor_name, action, target_table, target_id, metadata)
  values (p_display_name, 'update_place_day', 'places', p_place_id,
    jsonb_build_object('invite_code_id', v_invite_id, 'day_tag', p_day_tag));
end;
$function$;

GRANT EXECUTE ON FUNCTION public.update_place_day(text, text, uuid, smallint) TO anon, authenticated;
