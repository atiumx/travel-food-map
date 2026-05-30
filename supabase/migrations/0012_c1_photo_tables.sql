-- C2a: photo storage tables + RLS

create table if not exists public.place_photos (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  storage_path text not null,
  uploaded_by_name text,
  is_hidden boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists place_photos_place_idx on public.place_photos(place_id) where is_hidden = false;

create table if not exists public.review_photos (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  storage_path text not null,
  uploaded_by_name text,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists review_photos_unique_review on public.review_photos(review_id) where is_hidden = false;

alter table public.place_photos enable row level security;
alter table public.review_photos enable row level security;

drop policy if exists place_photos_select_anon on public.place_photos;
create policy place_photos_select_anon on public.place_photos
  for select to anon, authenticated
  using (is_hidden = false);

drop policy if exists review_photos_select_anon on public.review_photos;
create policy review_photos_select_anon on public.review_photos
  for select to anon, authenticated
  using (is_hidden = false);
