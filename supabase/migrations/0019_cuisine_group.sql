-- Batch G2: Global cuisine_group taxonomy
-- Adds a normalized two-level cuisine system:
--   cuisine_group (8 broad groups) + existing category (free-text sub-type)

-- 1. Enum for cuisine_group
DO $$ BEGIN
  CREATE TYPE public.cuisine_group AS ENUM (
    'japanese',     -- 日本料理：拉麵、壽司、燒肉、居酒屋、天婦羅、丼飯、烏冬、和菓子、喫茶店
    'asian',        -- 亞洲：中餐、台式、韓式、泰式、越南、印度、東南亞
    'western',      -- 西餐：意式、法式、美式、Steakhouse、Bistro
    'cafe_dessert', -- 咖啡甜品：Specialty Coffee、Bakery、甜品、Gelato、麵包
    'bar',          -- 酒吧：清酒吧、Cocktail、Wine Bar、Craft Beer
    'fast',         -- 快食：便利店、Fast Food、Food Court、丼飯快餐
    'attraction',   -- 景點/非餐飲（保留唔影響 schema 既有）
    'lodging',      -- 住宿
    'other'         -- 其他
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add column to places
ALTER TABLE public.places
  ADD COLUMN IF NOT EXISTS cuisine_group public.cuisine_group;

-- 3. Backfill from existing category (Chinese keywords)
UPDATE public.places SET cuisine_group = 'japanese' WHERE cuisine_group IS NULL AND category IN (
  '拉麵','壽司','燒肉','居酒屋','天婦羅','丼飯','博多料理','烏冬','蕎麥','鰻魚','和菓子','喫茶店','日料','日本料理'
);
UPDATE public.places SET cuisine_group = 'asian' WHERE cuisine_group IS NULL AND category IN (
  '中餐','中式','台式','台菜','韓式','韓國','泰式','泰菜','越南','印度','東南亞','馬來','新加坡','港式','粵菜'
);
UPDATE public.places SET cuisine_group = 'western' WHERE cuisine_group IS NULL AND category IN (
  '意式','意大利','法式','法國','美式','美國','西餐','Steakhouse','牛扒','Bistro'
);
UPDATE public.places SET cuisine_group = 'cafe_dessert' WHERE cuisine_group IS NULL AND category IN (
  '咖啡','Café','Cafe','甜品','麵包','Bakery','Gelato','雪糕','蛋糕','下午茶'
);
UPDATE public.places SET cuisine_group = 'bar' WHERE cuisine_group IS NULL AND category IN (
  '清酒','Sake','Cocktail','雞尾酒','Wine','酒吧','Craft Beer','精釀','啤酒'
);
UPDATE public.places SET cuisine_group = 'fast' WHERE cuisine_group IS NULL AND category IN (
  '便利店','Fast Food','Food Court','快餐','美食廣場'
);
UPDATE public.places SET cuisine_group = 'attraction' WHERE cuisine_group IS NULL AND category IN (
  '景點','觀光','博物館','寺廟','神社','公園'
);
UPDATE public.places SET cuisine_group = 'lodging' WHERE cuisine_group IS NULL AND category IN (
  '住宿','酒店','旅館','民宿','Hostel','Hotel'
);
-- catch-all: anything still null becomes 'other'
UPDATE public.places SET cuisine_group = 'other' WHERE cuisine_group IS NULL;

-- 4. Make NOT NULL with default 'other'
ALTER TABLE public.places
  ALTER COLUMN cuisine_group SET DEFAULT 'other'::public.cuisine_group;
ALTER TABLE public.places
  ALTER COLUMN cuisine_group SET NOT NULL;

-- 5. Index for filter performance
CREATE INDEX IF NOT EXISTS idx_places_cuisine_group ON public.places (cuisine_group)
  WHERE coalesce(is_archived,false)=false;

-- 6. Audit log
INSERT INTO public.audit_logs (action, target_table, target_id, metadata, created_at, actor_name)
VALUES (
  'schema.migration',
  'places',
  NULL,
  jsonb_build_object(
    'migration', '0019_cuisine_group',
    'description', 'Add cuisine_group enum + backfill existing places',
    'groups', ARRAY['japanese','asian','western','cafe_dessert','bar','fast','attraction','lodging','other']
  ),
  now(),
  'system'
);
