-- =============================================================
-- 0003_rpc_functions.sql
-- 3 個 RPC：verify_invite_code / add_place / add_review
-- 全部 SECURITY DEFINER
-- 注意：呢個版本兼容舊 schema：
--   - places 用 trip_area_id（新）但同時寫 trip_id（舊兼容）
--   - 用 links jsonb 統一儲外部連結（同舊 schema 一致）
--   - reviews 用 display_name（新）但同時寫 user_name（舊兼容）
-- =============================================================

-- -------------------------------------------------------------
-- verify_invite_code
-- -------------------------------------------------------------
create or replace function public.verify_invite_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.invite_codes%rowtype;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return jsonb_build_object('valid', false, 'reason', 'empty_code');
  end if;

  select * into v_row
  from public.invite_codes
  where code_hash = crypt(p_code, code_hash)
  limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;
  if not v_row.active then
    return jsonb_build_object('valid', false, 'reason', 'inactive');
  end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  if v_row.max_uses is not null and v_row.use_count >= v_row.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'exhausted');
  end if;

  return jsonb_build_object('valid', true, 'label', v_row.label);
end;
$$;

revoke all on function public.verify_invite_code(text) from public;
grant execute on function public.verify_invite_code(text) to anon, authenticated;


-- -------------------------------------------------------------
-- _consume_invite_code (內部 helper)
-- -------------------------------------------------------------
create or replace function public._consume_invite_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.invite_codes%rowtype;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'invite_code_required';
  end if;

  select * into v_row
  from public.invite_codes
  where code_hash = crypt(p_code, code_hash)
  for update
  limit 1;

  if not found then raise exception 'invite_code_invalid'; end if;
  if not v_row.active then raise exception 'invite_code_inactive'; end if;
  if v_row.expires_at is not null and v_row.expires_at < now() then
    raise exception 'invite_code_expired';
  end if;
  if v_row.max_uses is not null and v_row.use_count >= v_row.max_uses then
    raise exception 'invite_code_exhausted';
  end if;

  update public.invite_codes
  set use_count = use_count + 1
  where id = v_row.id;

  return v_row.id;
end;
$$;

revoke all on function public._consume_invite_code(text) from public;


-- -------------------------------------------------------------
-- add_place
-- p_place jsonb 結構：
-- {
--   "name": "...", "category": "...", "region": "...",
--   "price_level": "¥¥", "lat": 33.5, "lng": 130.4,
--   "google_rating": 4.2, "tabelog_rating": 3.55,
--   "tags": ["..."], "note": "...", "address": "...",
--   "links": { "maps": "...", "tabelog": "...", "ig": "...", "fb": "...", "blog": "..." },
--   "opening_hours": "...", "closed_days": [0,3],
--   "source": "..."
-- }
-- -------------------------------------------------------------
create or replace function public.add_place(
  p_invite_code     text,
  p_display_name    text,
  p_trip_area_slug  text,
  p_place           jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite_id    uuid;
  v_trip_area_id uuid;
  v_legacy_trip_id uuid;
  v_place_id     uuid;
  v_name         text;
  v_price        text;
  v_links        jsonb;
  v_closed_days  int[];
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

  select id into v_trip_area_id
  from public.trip_areas
  where slug = p_trip_area_slug
  limit 1;

  if v_trip_area_id is null then
    raise exception 'trip_area_not_found';
  end if;

  -- 揾返對應舊 trip_id（為咗滿足舊 NOT NULL 約束）
  if p_trip_area_slug = 'kyushu' then
    select id into v_legacy_trip_id from public.trips where slug = 'fukuoka-kitakyushu-2026' limit 1;
  elsif p_trip_area_slug = 'osaka' then
    select id into v_legacy_trip_id from public.trips where slug = 'osaka-2026' limit 1;
  else
    -- 預設用第一條 trip
    select id into v_legacy_trip_id from public.trips order by created_at limit 1;
  end if;

  v_price := nullif(trim(coalesce(p_place->>'price_level','')), '');
  if v_price is not null and v_price not in ('¥','¥¥','¥¥¥','¥¥¥¥') then
    raise exception 'invalid_price_level';
  end if;

  v_links := coalesce(p_place->'links', '{}'::jsonb);

  -- closed_days: array of ints
  if jsonb_typeof(p_place->'closed_days') = 'array' then
    select array_agg((v)::int) into v_closed_days
    from jsonb_array_elements_text(p_place->'closed_days') v;
  else
    v_closed_days := '{}'::int[];
  end if;

  insert into public.places (
    trip_area_id, trip_id,
    name, category, region,
    price_level, price,
    lat, lng,
    google_rating, grating,
    tabelog_rating, tabelog,
    tags, note, address,
    links,
    opening_hours, closed_days,
    source, created_by, updated_by,
    is_archived, is_hidden
  ) values (
    v_trip_area_id, v_legacy_trip_id,
    v_name,
    nullif(trim(coalesce(p_place->>'category','')), ''),
    nullif(trim(coalesce(p_place->>'region','')), ''),
    v_price,
    v_price,                                            -- 同步寫舊欄
    nullif(p_place->>'lat','')::double precision,
    nullif(p_place->>'lng','')::double precision,
    nullif(p_place->>'google_rating','')::numeric,
    nullif(p_place->>'google_rating','')::numeric,      -- 同步寫舊欄 grating
    nullif(p_place->>'tabelog_rating','')::numeric,
    nullif(p_place->>'tabelog_rating','')::numeric,     -- 同步寫舊欄 tabelog
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(p_place->'tags')),
      '{}'::text[]
    ),
    nullif(trim(coalesce(p_place->>'note','')), ''),
    nullif(trim(coalesce(p_place->>'address','')), ''),
    v_links,
    nullif(trim(coalesce(p_place->>'opening_hours','')), ''),
    v_closed_days,
    nullif(trim(coalesce(p_place->>'source','')), ''),
    p_display_name,
    p_display_name,
    false,
    false                                                -- 同步寫舊欄 is_hidden
  )
  returning id into v_place_id;

  insert into public.audit_logs (actor_name, action, target_table, target_id, metadata)
  values (
    p_display_name, 'add_place', 'places', v_place_id,
    jsonb_build_object(
      'invite_code_id', v_invite_id,
      'trip_area_slug', p_trip_area_slug,
      'place_name', v_name
    )
  );

  return v_place_id;
end;
$$;

revoke all on function public.add_place(text, text, text, jsonb) from public;
grant execute on function public.add_place(text, text, text, jsonb) to anon, authenticated;


-- -------------------------------------------------------------
-- add_review
-- 注意：舊 reviews.rating 有 check 1..5，新 plan 容許 0..5
-- 為咗兼容舊 check，新 RPC 強制 1..5
-- -------------------------------------------------------------
create or replace function public.add_review(
  p_invite_code   text,
  p_display_name  text,
  p_place_id      uuid,
  p_rating        numeric,
  p_comment       text,
  p_visit_date    date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite_id    uuid;
  v_trip_area_id uuid;
  v_review_id    uuid;
begin
  if p_display_name is null or length(trim(p_display_name)) = 0 then
    raise exception 'display_name_required';
  end if;
  if length(trim(p_display_name)) > 40 then
    raise exception 'display_name_too_long';
  end if;
  if p_comment is null or length(trim(p_comment)) = 0 then
    raise exception 'comment_required';
  end if;
  if length(p_comment) > 2000 then
    raise exception 'comment_too_long';
  end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating_out_of_range';
  end if;

  v_invite_id := public._consume_invite_code(p_invite_code);

  select trip_area_id into v_trip_area_id
  from public.places
  where id = p_place_id and coalesce(is_archived, is_hidden, false) = false
  limit 1;

  if v_trip_area_id is null then
    raise exception 'place_not_found';
  end if;

  insert into public.reviews (
    place_id, trip_area_id,
    display_name, user_name,
    rating, comment, visit_date,
    is_hidden
  ) values (
    p_place_id, v_trip_area_id,
    p_display_name, p_display_name,   -- 同步寫舊欄 user_name
    p_rating, p_comment, p_visit_date,
    false
  )
  returning id into v_review_id;

  insert into public.audit_logs (actor_name, action, target_table, target_id, metadata)
  values (
    p_display_name, 'add_review', 'reviews', v_review_id,
    jsonb_build_object(
      'invite_code_id', v_invite_id,
      'place_id', p_place_id,
      'rating', p_rating
    )
  );

  return v_review_id;
end;
$$;

revoke all on function public.add_review(text, text, uuid, numeric, text, date) from public;
grant execute on function public.add_review(text, text, uuid, numeric, text, date) to anon, authenticated;
