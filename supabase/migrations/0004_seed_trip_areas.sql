-- =============================================================
-- 0004_seed_trip_areas.sql
-- 初始 trip_areas：kyushu（九州）+ osaka（大阪）
-- 命名邏輯：以福岡機場為中心，搭車能到的範圍都歸 kyushu，
-- 包括福岡市、北九州市、長崎縣等。將來去別府／湯布院／佐賀／熊本
-- 都放入 kyushu。
-- 重跑安全：on conflict (slug) do update
-- =============================================================

insert into public.trip_areas (slug, name_zh, name_en, status, sort_order, center_lat, center_lng, default_zoom)
values
  ('kyushu', '九州', 'Kyushu', 'active',  10, 33.5904, 130.4017, 11),
  ('osaka',  '大阪', 'Osaka',  'planned', 30, 34.6937, 135.5023, 13)
on conflict (slug) do update set
  name_zh      = excluded.name_zh,
  name_en      = excluded.name_en,
  status       = excluded.status,
  sort_order   = excluded.sort_order,
  center_lat   = excluded.center_lat,
  center_lng   = excluded.center_lng,
  default_zoom = excluded.default_zoom,
  updated_at   = now();
