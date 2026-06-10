-- =============================================================
-- Feature B (Push 1): place_submissions for friend-recommended new places
-- =============================================================
-- Scope: 朋友丟條 link (Google Maps / Tabelog / OpenRice) submit 推薦, 
--        owner 審核 → resolve → 批准 → 寫入 places + reviews
-- 
-- 同 0008 place_suggestions 互補:
--   - 0008 place_suggestions: 朋友對「已有 place」嘅 correction / recommend / warning
--   - 0021 place_submissions:  朋友新增「未有 place」嘅入口
-- =============================================================

-- 1. invite_codes 加 role 欄 (defence in depth: 配合 frontend OWNER_DISPLAY_NAME 雙重 check)
alter table public.invite_codes 
  add column if not exists role text not null default 'friend'
    check (role in ('owner','friend'));

create index if not exists invite_codes_role_idx on public.invite_codes(role) where role = 'owner';

-- 2. places 加 openrice metadata 欄 (純 HK 用, OpenRice rating 永遠唔 import)
alter table public.places 
  add column if not exists openrice_url text,
  add column if not exists openrice_poi_id text;

-- 3. place_submissions table
create table if not exists public.place_submissions (
  id uuid primary key default gen_random_uuid(),
  -- Submission input
  raw_url text not null check (length(trim(raw_url)) > 0),
  recommendation smallint check (recommendation between 1 and 5),
  comment text,
  -- Submitter identity
  submitted_by_invite uuid references public.invite_codes(id) on delete set null,
  submitted_by_name text not null,
  -- URL classification (auto-detected by resolver)
  url_source text check (url_source in ('google_maps','tabelog','openrice','unknown')),
  detected_trip_area_slug text,  -- 例 'hongkong','kyushu' (resolver 判斷)
  -- Lifecycle state
  status text not null default 'pending' 
    check (status in ('pending','resolved','approved','rejected','resolve_failed')),
  resolved_data jsonb,            -- resolver 返嘅 raw JSON (audit trail)
  approved_place_id uuid references public.places(id) on delete set null,
  rejected_reason text,
  resolver_error text,
  retry_count smallint not null default 0 check (retry_count >= 0 and retry_count <= 10),
  -- Timing
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text                -- owner display_name snapshot
);

create index if not exists place_submissions_status_idx on public.place_submissions(status);
create index if not exists place_submissions_created_idx on public.place_submissions(created_at desc);
create index if not exists place_submissions_submitter_idx on public.place_submissions(submitted_by_invite);

alter table public.place_submissions enable row level security;

-- ANON: 完全冇 direct table access — submit 一定要經 RPC
-- (公開 raw_url + 朋友 display_name 連聲 RLS 都唔 expose, 防 enumeration)
drop policy if exists place_submissions_no_anon on public.place_submissions;

-- =============================================================
-- RPC 1: submit_place_submission — 朋友 INSERT
-- =============================================================
create or replace function public.submit_place_submission(
  p_invite_code text,
  p_display_name text,
  p_raw_url text,
  p_recommendation int,
  p_comment text
) returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_id uuid;
  v_name text;
  v_url text;
  v_comment text;
  v_url_source text;
  v_detected_slug text;
begin
  -- Input validation
  v_url := trim(coalesce(p_raw_url, ''));
  if length(v_url) = 0 then
    raise exception 'url_required' using errcode = '22023';
  end if;
  if v_url !~* '^https?://' then
    raise exception 'url_invalid' using errcode = '22023';
  end if;

  v_name := trim(coalesce(p_display_name, ''));
  if length(v_name) = 0 then
    raise exception 'display_name_required' using errcode = '22023';
  end if;

  if p_recommendation is not null and (p_recommendation < 1 or p_recommendation > 5) then
    raise exception 'recommendation_out_of_range' using errcode = '22023';
  end if;

  v_comment := nullif(trim(coalesce(p_comment, '')), '');

  -- Verify + consume invite code (rate limit 喺 existing _consume_invite_code 入面)
  v_invite_id := public._consume_invite_code(p_invite_code);

  -- Auto-classify URL source (resolver 之後仲會 cross-check)
  v_url_source := case
    when v_url ~* 'google\.[a-z\.]+/maps' then 'google_maps'
    when v_url ~* 'maps\.app\.goo\.gl' then 'google_maps'
    when v_url ~* 'goo\.gl/maps' then 'google_maps'
    when v_url ~* 'tabelog\.com' then 'tabelog'
    when v_url ~* 'openrice\.com' then 'openrice'
    else 'unknown'
  end;

  -- Heuristic trip_area detection (resolver 之後會 override)
  v_detected_slug := case
    when v_url_source = 'tabelog' then null  -- 由 resolver 判斷 kyushu/osaka
    when v_url_source = 'openrice' and v_url ~* '/hongkong' then 'hongkong'
    else null
  end;

  insert into public.place_submissions(
    raw_url, recommendation, comment,
    submitted_by_invite, submitted_by_name,
    url_source, detected_trip_area_slug,
    status
  ) values (
    v_url, p_recommendation, v_comment,
    v_invite_id, v_name,
    v_url_source, v_detected_slug,
    'pending'
  ) returning id into v_id;

  -- Audit log
  insert into public.audit_logs(action, actor_name, target_id, metadata)
  values (
    'place_submission_create', v_name, v_id,
    jsonb_build_object('url_source', v_url_source, 'recommendation', p_recommendation)
  );

  return v_id;
end;
$$;

revoke all on function public.submit_place_submission(text,text,text,int,text) from public;
grant execute on function public.submit_place_submission(text,text,text,int,text) to anon, authenticated;

-- =============================================================
-- RPC 2: list_pending_submissions — owner-only, return pending list
-- =============================================================
create or replace function public.list_pending_submissions(
  p_invite_code text,
  p_display_name text
) returns table (
  id uuid,
  raw_url text,
  recommendation smallint,
  comment text,
  submitted_by_name text,
  url_source text,
  detected_trip_area_slug text,
  status text,
  resolver_error text,
  retry_count smallint,
  created_at timestamptz,
  resolved_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_role text;
begin
  -- Verify (NOT consume — owner 開 list 唔扣 use_count) 同時讀 role
  -- 借用 verify_invite_code logic: 用 RPC 但唔 increment use_count
  select ic.id, ic.role into v_invite_id, v_role
  from public.invite_codes ic
  where ic.code_lookup_hash = public._hash_lookup(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  if v_role != 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  return query
  select 
    s.id, s.raw_url, s.recommendation, s.comment,
    s.submitted_by_name, s.url_source, s.detected_trip_area_slug,
    s.status, s.resolver_error, s.retry_count,
    s.created_at, s.resolved_at
  from public.place_submissions s
  where s.status in ('pending','resolved','resolve_failed')
  order by s.created_at desc
  limit 100;
end;
$$;

revoke all on function public.list_pending_submissions(text,text) from public;
grant execute on function public.list_pending_submissions(text,text) to anon, authenticated;

-- =============================================================
-- RPC 3: approve_submission — owner-only, write places + reviews
-- =============================================================
-- 注意: Resolver 唔喺 Postgres 入面跑 (HTTP fetch 慢且難用)
--   實際流程:
--     1. Frontend call Edge Function /resolve-submission?id=xxx
--     2. Edge Function 跑 scraper / Google Places API, return JSON
--     3. Frontend 顯示 → owner edit → call approve_submission(id, edited_jsonb)
--     4. 呢個 RPC 寫 places + reviews + update submission status='approved'
create or replace function public.approve_submission(
  p_invite_code text,
  p_display_name text,
  p_submission_id uuid,
  p_resolved jsonb         -- {name, lat, lng, address, cuisine_group, trip_area_id, google_place_id, google_rating, google_user_ratings_total, openrice_url, openrice_poi_id, tabelog_url, google_url, phone, opening_hours, ...}
) returns uuid              -- 返新 place_id
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_role text;
  v_submission record;
  v_place_id uuid;
  v_trip_area_id uuid;
  v_owner_name text;
begin
  -- Owner verify (NO consume)
  select ic.id, ic.role, coalesce(ic.display_name, p_display_name) 
    into v_invite_id, v_role, v_owner_name
  from public.invite_codes ic
  where ic.code_lookup_hash = public._hash_lookup(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  if v_role != 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  -- Load submission
  select * into v_submission from public.place_submissions where id = p_submission_id;
  if v_submission.id is null then
    raise exception 'submission_not_found' using errcode = 'P0002';
  end if;
  if v_submission.status in ('approved','rejected') then
    raise exception 'submission_already_finalized' using errcode = '22023';
  end if;

  -- Resolve trip_area_id (priority: p_resolved.trip_area_id > slug match)
  if p_resolved ? 'trip_area_id' and (p_resolved->>'trip_area_id') is not null then
    v_trip_area_id := (p_resolved->>'trip_area_id')::uuid;
  elsif p_resolved ? 'trip_area_slug' and (p_resolved->>'trip_area_slug') is not null then
    select id into v_trip_area_id from public.trip_areas where slug = p_resolved->>'trip_area_slug' limit 1;
  end if;

  if v_trip_area_id is null then
    raise exception 'trip_area_required' using errcode = '22023';
  end if;

  -- Validate required fields
  if (p_resolved->>'name') is null or length(trim(p_resolved->>'name')) = 0 then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if (p_resolved->>'lat') is null or (p_resolved->>'lng') is null then
    raise exception 'coords_required' using errcode = '22023';
  end if;

  -- INSERT places
  insert into public.places(
    trip_id, trip_area_id,
    name, category, cuisine_group, region, address,
    lat, lng,
    google_place_id, google_rating, google_user_ratings_total, google_url,
    tabelog_url, openrice_url, openrice_poi_id,
    phone, opening_hours, price_level,
    source, created_by, verified
  ) values (
    -- trip_id legacy column, set to trip_area_id 兼容
    v_trip_area_id, v_trip_area_id,
    p_resolved->>'name',
    coalesce(p_resolved->>'category', 'asian'),
    (coalesce(p_resolved->>'cuisine_group', 'other'))::cuisine_group,
    p_resolved->>'region',
    p_resolved->>'address',
    (p_resolved->>'lat')::double precision,
    (p_resolved->>'lng')::double precision,
    p_resolved->>'google_place_id',
    nullif(p_resolved->>'google_rating','')::numeric,
    nullif(p_resolved->>'google_user_ratings_total','')::int,
    p_resolved->>'google_url',
    p_resolved->>'tabelog_url',
    p_resolved->>'openrice_url',
    p_resolved->>'openrice_poi_id',
    p_resolved->>'phone',
    p_resolved->>'opening_hours',
    p_resolved->>'price_level',
    'submission:' || v_submission.url_source,
    v_submission.submitted_by_name,
    false  -- owner 之後手動 verify
  ) returning id into v_place_id;

  -- INSERT review (朋友 recommendation 變成第一條 review)
  if v_submission.recommendation is not null or v_submission.comment is not null then
    insert into public.reviews(
      place_id, trip_area_id, display_name,
      rating, comment, visit_date
    ) values (
      v_place_id, v_trip_area_id, v_submission.submitted_by_name,
      v_submission.recommendation,
      v_submission.comment,
      current_date
    );
  end if;

  -- UPDATE submission status
  update public.place_submissions
  set status = 'approved',
      approved_place_id = v_place_id,
      reviewed_at = now(),
      reviewed_by = v_owner_name
  where id = p_submission_id;

  -- Audit log
  insert into public.audit_logs(action, actor_name, target_id, metadata)
  values (
    'place_submission_approve', v_owner_name, p_submission_id,
    jsonb_build_object('place_id', v_place_id, 'submitter', v_submission.submitted_by_name)
  );

  return v_place_id;
end;
$$;

revoke all on function public.approve_submission(text,text,uuid,jsonb) from public;
grant execute on function public.approve_submission(text,text,uuid,jsonb) to anon, authenticated;

-- =============================================================
-- RPC 4: reject_submission — owner-only
-- =============================================================
create or replace function public.reject_submission(
  p_invite_code text,
  p_display_name text,
  p_submission_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_id uuid;
  v_role text;
  v_owner_name text;
begin
  select ic.id, ic.role, coalesce(ic.display_name, p_display_name)
    into v_invite_id, v_role, v_owner_name
  from public.invite_codes ic
  where ic.code_lookup_hash = public._hash_lookup(p_invite_code)
    and ic.active = true
    and (ic.expires_at is null or ic.expires_at > now())
  limit 1;

  if v_invite_id is null then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  if v_role != 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  update public.place_submissions
  set status = 'rejected',
      rejected_reason = nullif(trim(coalesce(p_reason,'')), ''),
      reviewed_at = now(),
      reviewed_by = v_owner_name
  where id = p_submission_id
    and status in ('pending','resolved','resolve_failed');

  if not found then
    raise exception 'submission_not_found_or_finalized' using errcode = 'P0002';
  end if;

  insert into public.audit_logs(action, actor_name, target_id, metadata)
  values (
    'place_submission_reject', v_owner_name, p_submission_id,
    jsonb_build_object('reason', p_reason)
  );
end;
$$;

revoke all on function public.reject_submission(text,text,uuid,text) from public;
grant execute on function public.reject_submission(text,text,uuid,text) to anon, authenticated;

-- =============================================================
-- RPC 5: update_submission_resolved — called by Edge Function after resolve
-- =============================================================
-- Edge Function 跑完 resolver → call 呢個 RPC 寫 resolved_data + status='resolved'
-- 用 service_role key (Edge Function 內部已有, 不暴露俾 frontend)
create or replace function public.update_submission_resolved(
  p_submission_id uuid,
  p_resolved_data jsonb,
  p_error_message text default null
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.place_submissions
  set 
    resolved_data = case when p_error_message is null then p_resolved_data else resolved_data end,
    status = case when p_error_message is null then 'resolved' else 'resolve_failed' end,
    resolver_error = p_error_message,
    retry_count = retry_count + 1,
    resolved_at = case when p_error_message is null then now() else resolved_at end
  where id = p_submission_id
    and status in ('pending','resolved','resolve_failed');

  if not found then
    raise exception 'submission_not_found_or_finalized' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.update_submission_resolved(uuid,jsonb,text) from public;
-- 唔 grant 比 anon — 只 service_role (Edge Function) 可以 call
grant execute on function public.update_submission_resolved(uuid,jsonb,text) to service_role;

-- =============================================================
-- Seed: 將你個 owner 邀請碼 mark role='owner'
-- =============================================================
-- (注意: 你要話我知邊個邀請碼 label 係 owner, 例如 hm2026 / HM 系列嘅 active 嗰個)
-- 例: UPDATE public.invite_codes SET role='owner' WHERE label='hm2026';
-- 因為唔知用緊邊個, 呢段留比 user confirm 後手動 apply

comment on column public.invite_codes.role is 
  'owner: full admin (Feature B approve/reject etc); friend: read + submission only. Default friend.';
