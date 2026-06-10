-- =============================================================
-- Feature B Push 3: list_my_submissions
-- =============================================================
-- Friend / owner 自查自己過往 submit 過嘅 submissions + status。
-- 用 invite_id 識別 (multiple display_name rename 都 cover 到)。
-- 同 list_pending_submissions 唔同：
--   - list_pending_submissions: owner only, 只列 pending/resolved/resolve_failed (待處理)
--   - list_my_submissions: 任何 bound role, 列自己 ALL submissions (包括 approved/rejected)
-- =============================================================

create or replace function public.list_my_submissions(p_invite_code text, p_display_name text)
returns table(
  id uuid,
  raw_url text,
  recommendation smallint,
  comment text,
  url_source text,
  detected_trip_area_slug text,
  status text,
  resolver_error text,
  rejected_reason text,
  approved_place_id uuid,
  approved_place_name text,
  approved_place_trip_area_slug text,
  created_at timestamp with time zone,
  resolved_at timestamp with time zone,
  reviewed_at timestamp with time zone
)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_invite_id uuid;
begin
  -- Lookup invite
  select ic.id into v_invite_id
  from public.invite_codes ic
  where ic.code_lookup_hash = public._invite_code_lookup_hash(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  -- p_display_name unused for security check (invite_code itself proves identity)
  -- but accepted as param for consistency with other RPCs

  return query
  select
    s.id, s.raw_url, s.recommendation, s.comment,
    s.url_source, s.detected_trip_area_slug,
    s.status, s.resolver_error, s.rejected_reason,
    s.approved_place_id,
    p.name as approved_place_name,
    ta.slug as approved_place_trip_area_slug,
    s.created_at, s.resolved_at, s.reviewed_at
  from public.place_submissions s
  left join public.places p on p.id = s.approved_place_id
  left join public.trip_areas ta on ta.id = p.trip_area_id
  where s.submitted_by_invite = v_invite_id
  order by s.created_at desc
  limit 100;
end;
$function$;

-- Grant execute to anon (security definer, internally validates invite)
grant execute on function public.list_my_submissions(text, text) to anon;
