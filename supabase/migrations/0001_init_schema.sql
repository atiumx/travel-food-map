-- =============================================================
-- 0001_init_schema.sql
-- 新建 trip_areas / invite_codes / audit_logs
-- 已存在嘅 places / reviews 用 ALTER 加新欄位（保留舊欄位）
-- =============================================================

create extension if not exists pgcrypto;

-- -------------------------------------------------------------
-- trip_areas (新建)
-- -------------------------------------------------------------
create table if not exists public.trip_areas (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name_zh       text not null,
  name_en       text,
  status        text not null default 'planned'
                check (status in ('active','planned','archived')),
  sort_order    integer not null default 100,
  center_lat    double precision,
  center_lng    double precision,
  default_zoom  integer default 13,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists trip_areas_status_sort_idx
  on public.trip_areas (status, sort_order);

-- -------------------------------------------------------------
-- places (已存在，加新欄位)
-- 舊欄位保留：trip_id / price / grating / tabelog / is_hidden /
--   visited / links / opening_hours / closed_days / hours_source /
--   hours_verified / address / created_by 等
-- -------------------------------------------------------------
alter table public.places
  add column if not exists trip_area_id  uuid references public.trip_areas(id) on delete restrict,
  add column if not exists price_level   text,
  add column if not exists google_rating numeric(2,1),
  add column if not exists tabelog_rating numeric(3,2),
  add column if not exists is_archived   boolean not null default false,
  add column if not exists updated_by    text,
  add column if not exists updated_at    timestamptz;

-- price_level 約束（容許 NULL）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'places_price_level_chk'
  ) then
    alter table public.places
      add constraint places_price_level_chk
      check (price_level is null or price_level in ('¥','¥¥','¥¥¥','¥¥¥¥'));
  end if;
end$$;

create index if not exists places_trip_area_archived_idx
  on public.places (trip_area_id, is_archived);
create index if not exists places_category_idx
  on public.places (category);

-- -------------------------------------------------------------
-- reviews (已存在，加新欄位)
-- 舊欄位保留：user_name / rating / comment / source / is_hidden
-- -------------------------------------------------------------
alter table public.reviews
  add column if not exists trip_area_id  uuid references public.trip_areas(id) on delete restrict,
  add column if not exists display_name  text,
  add column if not exists visit_date    date,
  add column if not exists updated_at    timestamptz;

create index if not exists reviews_trip_area_idx
  on public.reviews (trip_area_id);

-- -------------------------------------------------------------
-- invite_codes (新建)
-- -------------------------------------------------------------
create table if not exists public.invite_codes (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  code_hash   text not null,
  active      boolean not null default true,
  max_uses    integer,
  use_count   integer not null default 0,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invite_codes_active_idx on public.invite_codes (active);

-- -------------------------------------------------------------
-- audit_logs (新建)
-- -------------------------------------------------------------
create table if not exists public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_name    text,
  action        text not null,
  target_table  text not null,
  target_id     uuid,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_action_idx on public.audit_logs (action);

-- -------------------------------------------------------------
-- updated_at trigger function
-- -------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_trip_areas_updated on public.trip_areas;
create trigger trg_trip_areas_updated
  before update on public.trip_areas
  for each row execute function public.set_updated_at();

drop trigger if exists trg_places_updated on public.places;
create trigger trg_places_updated
  before update on public.places
  for each row execute function public.set_updated_at();

drop trigger if exists trg_reviews_updated on public.reviews;
create trigger trg_reviews_updated
  before update on public.reviews
  for each row execute function public.set_updated_at();
