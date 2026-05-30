-- E2: 逐日 itinerary tags
ALTER TABLE public.places
  ADD COLUMN IF NOT EXISTS day_tag SMALLINT NULL
  CHECK (day_tag IS NULL OR (day_tag >= 1 AND day_tag <= 7));

ALTER TABLE public.trip_areas
  ADD COLUMN IF NOT EXISTS total_days SMALLINT NOT NULL DEFAULT 0
  CHECK (total_days >= 0 AND total_days <= 7);

CREATE INDEX IF NOT EXISTS places_day_tag_idx ON public.places(trip_area_id, day_tag) WHERE day_tag IS NOT NULL;

COMMENT ON COLUMN public.places.day_tag IS 'Day number in itinerary (1-7), NULL = unassigned';
COMMENT ON COLUMN public.trip_areas.total_days IS 'Total planned days for this trip area';
