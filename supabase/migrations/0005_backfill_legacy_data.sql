-- =============================================================
-- 0005_backfill_legacy_data.sql
-- 將舊 trips / places / reviews 資料 backfill 入新欄位
-- 必須喺 0004_seed_trip_areas 之後跑（要 trip_areas 先存在）
-- =============================================================

-- -------------------------------------------------------------
-- places: trip_id → trip_area_id
--   - fukuoka-kitakyushu-2026 trip 嘅所有 25 個 places → kyushu
--     （包括福岡市、小倉、長崎全部）
--   - osaka-2026 trip 而家為空，但預埋 mapping
-- -------------------------------------------------------------
update public.places p
set trip_area_id = ta.id
from public.trip_areas ta
where p.trip_area_id is null
  and p.trip_id in (select id from public.trips where slug = 'fukuoka-kitakyushu-2026')
  and ta.slug = 'kyushu';

update public.places p
set trip_area_id = ta.id
from public.trip_areas ta
where p.trip_area_id is null
  and p.trip_id in (select id from public.trips where slug = 'osaka-2026')
  and ta.slug = 'osaka';

-- -------------------------------------------------------------
-- places: 舊欄位 → 新欄位 backfill
-- -------------------------------------------------------------
update public.places
set price_level = price
where price_level is null and price is not null;

update public.places
set google_rating = grating
where google_rating is null and grating is not null;

update public.places
set tabelog_rating = tabelog
where tabelog_rating is null and tabelog is not null;

update public.places
set is_archived = coalesce(is_hidden, false)
where is_archived is distinct from coalesce(is_hidden, false);

update public.places
set updated_at = created_at
where updated_at is null;

update public.places
set updated_by = created_by
where updated_by is null and created_by is not null;

-- -------------------------------------------------------------
-- reviews: backfill trip_area_id（透過 place）
-- -------------------------------------------------------------
update public.reviews r
set trip_area_id = p.trip_area_id
from public.places p
where r.place_id = p.id
  and r.trip_area_id is null
  and p.trip_area_id is not null;

-- -------------------------------------------------------------
-- reviews: user_name → display_name
-- -------------------------------------------------------------
update public.reviews
set display_name = user_name
where display_name is null and user_name is not null;

update public.reviews
set updated_at = created_at
where updated_at is null;
