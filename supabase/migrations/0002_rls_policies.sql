-- =============================================================
-- 0002_rls_policies.sql
-- 啟用 RLS + anon 公開讀取 policy
-- anon 完全唔可以直接寫入，寫入經 RPC（SECURITY DEFINER）
-- =============================================================

-- -------------------------------------------------------------
-- Enable RLS
-- -------------------------------------------------------------
alter table public.trip_areas   enable row level security;
alter table public.places       enable row level security;
alter table public.reviews      enable row level security;
alter table public.invite_codes enable row level security;
alter table public.audit_logs   enable row level security;

-- -------------------------------------------------------------
-- trip_areas: anon 可讀 active / planned，archived 隱藏
-- -------------------------------------------------------------
drop policy if exists "trip_areas_anon_select" on public.trip_areas;
create policy "trip_areas_anon_select"
  on public.trip_areas
  for select
  to anon
  using (status in ('active','planned'));

-- -------------------------------------------------------------
-- places: anon 只可讀 is_archived = false
-- -------------------------------------------------------------
drop policy if exists "places_anon_select" on public.places;
create policy "places_anon_select"
  on public.places
  for select
  to anon
  using (is_archived = false);

-- -------------------------------------------------------------
-- reviews: anon 可讀全部
-- -------------------------------------------------------------
drop policy if exists "reviews_anon_select" on public.reviews;
create policy "reviews_anon_select"
  on public.reviews
  for select
  to anon
  using (true);

-- -------------------------------------------------------------
-- invite_codes: anon 完全唔可以讀寫
-- (無 policy = deny all under RLS)
-- -------------------------------------------------------------

-- -------------------------------------------------------------
-- audit_logs: anon 完全唔可以讀寫
-- -------------------------------------------------------------

-- -------------------------------------------------------------
-- 確保 anon 唔會直接 INSERT/UPDATE/DELETE 任何 table
-- (預設 RLS 啟用後就係 deny，無需額外 policy)
-- 寫入一律經 RPC SECURITY DEFINER
-- -------------------------------------------------------------
