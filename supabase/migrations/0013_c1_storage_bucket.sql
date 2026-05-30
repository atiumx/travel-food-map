-- create public bucket for photos
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'food-map-photos',
  'food-map-photos',
  true,
  3145728, -- 3MB hard limit (frontend resize to <2MB)
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- storage RLS policies
-- public read for this bucket
drop policy if exists "food_map_photos_read_public" on storage.objects;
create policy "food_map_photos_read_public" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'food-map-photos');

-- anon insert allowed (we will validate via RPC-side path enforcement; alternative would be edge function)
-- since user identifies via invite_code in app layer not auth, we let anon upload but require RPC to record row
drop policy if exists "food_map_photos_insert_anon" on storage.objects;
create policy "food_map_photos_insert_anon" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'food-map-photos');

-- no anon delete
drop policy if exists "food_map_photos_delete_owner" on storage.objects;
create policy "food_map_photos_delete_owner" on storage.objects
  for delete to anon, authenticated
  using (false);
