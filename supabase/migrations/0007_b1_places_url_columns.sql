-- B1: places 加 tabelog_url + google_url 兩個 dedicated columns，並 backfill 舊 links jsonb

alter table public.places
  add column if not exists tabelog_url text,
  add column if not exists google_url text;

-- Backfill from links jsonb
update public.places
   set tabelog_url = links->>'tabelog'
 where tabelog_url is null and links ? 'tabelog';

update public.places
   set google_url = links->>'maps'
 where google_url is null and links ? 'maps';

-- Update add_place RPC: write both new columns + keep merging into links jsonb (backward compat)
create or replace function public.add_place(
  p_invite_code text,
  p_display_name text,
  p_trip_area_slug text,
  p_place jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_trip_area_id uuid;
  v_id uuid;
  v_name text;
  v_tabelog text;
  v_google text;
  v_links jsonb;
begin
  v_name := trim(coalesce(p_display_name,''));
  if length(v_name) = 0 then
    raise exception 'display_name_required' using errcode = '22023';
  end if;

  select id into v_trip_area_id from public.trip_areas where slug = p_trip_area_slug;
  if v_trip_area_id is null then
    raise exception 'trip_area_not_found' using errcode = 'P0002';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  v_tabelog := nullif(trim(coalesce(p_place->>'tabelog_url','')), '');
  v_google  := nullif(trim(coalesce(p_place->>'google_url','')), '');

  -- Merge into links jsonb for backward compat
  v_links := coalesce(p_place->'links', '{}'::jsonb);
  if v_tabelog is not null then v_links := v_links || jsonb_build_object('tabelog', v_tabelog); end if;
  if v_google  is not null then v_links := v_links || jsonb_build_object('maps', v_google);    end if;

  insert into public.places(
    trip_area_id, trip_id, name, category, region, price_level, lat, lng,
    google_rating, tabelog_rating, tags, note, address,
    links, opening_hours, closed_days,
    tabelog_url, google_url,
    created_by, updated_by, source
  )
  values (
    v_trip_area_id,
    nullif(p_place->>'trip_id',''),
    trim(p_place->>'name'),
    nullif(p_place->>'category',''),
    nullif(p_place->>'region',''),
    nullif((p_place->>'price_level')::int, null),
    (p_place->>'lat')::double precision,
    (p_place->>'lng')::double precision,
    nullif((p_place->>'google_rating')::numeric, null),
    nullif((p_place->>'tabelog_rating')::numeric, null),
    coalesce(p_place->'tags', '[]'::jsonb),
    nullif(p_place->>'note',''),
    nullif(p_place->>'address',''),
    v_links,
    nullif(p_place->>'opening_hours',''),
    nullif(p_place->>'closed_days',''),
    v_tabelog,
    v_google,
    v_name, v_name, 'web'
  )
  returning id into v_id;

  insert into public.audit_logs(action, target_table, target_id, actor_invite, actor_name, payload)
  values ('add_place', 'places', v_id, v_invite_id, v_name, jsonb_build_object('name', trim(p_place->>'name')));

  return v_id;
end;
$$;

grant execute on function public.add_place(text, text, text, jsonb) to anon, authenticated;
