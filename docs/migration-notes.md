# Migration Notes

## 執行順序

```
supabase/migrations/
├── 0001_init_schema.sql        # 5 個 table + index
├── 0002_rls_policies.sql       # RLS enable + policies
├── 0003_rpc_functions.sql      # 3 個 RPC
└── 0004_seed_trip_areas.sql    # 初始 trip_areas 資料
```

順序敏感：必須由小到大依次執行。

## 執行方法

### 方法 A：Supabase Dashboard SQL Editor
1. 開 https://supabase.com/dashboard/project/toxqfrsdkvfcmmgzbyux/sql
2. 逐個檔貼上 → Run

### 方法 B：Supabase CLI
```bash
supabase link --project-ref toxqfrsdkvfcmmgzbyux
supabase db push
```

### 方法 C：經 Computer 嘅 Supabase connector
由 agent 逐個檔執行，每步確認。

## 建立第一條邀請碼

migration 跑完後喺 SQL Editor 跑（**用 service_role 權限**）：

```sql
-- 建立一條測試邀請碼，明文係 'HMTEST2026'
insert into public.invite_codes (label, code_hash, active, max_uses)
values (
  'HM 自用測試',
  crypt('HMTEST2026', gen_salt('bf')),
  true,
  null  -- 無限次使用
);
```

**重要**：明文邀請碼**只會出現喺呢一刻**，之後 DB 只剩 hash。建議寫入 1Password / Bitwarden / 紙仔。

## Rollback

如果要清晒重來：

```sql
drop function if exists public.add_review(text, text, uuid, numeric, text, date);
drop function if exists public.add_place(text, text, text, jsonb);
drop function if exists public.verify_invite_code(text);
drop table if exists public.audit_logs;
drop table if exists public.invite_codes;
drop table if exists public.reviews;
drop table if exists public.places;
drop table if exists public.trip_areas;
```

⚠️ 會清光所有資料。Production 唔好亂跑。
