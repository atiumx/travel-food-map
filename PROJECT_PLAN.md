# 旅行美食地圖系統 — 長期規格書與行動計劃

> 文件版本：2026-05-27  
> 維護人：HM

---

## 專案定位

建立一個可長期維護的旅行美食地圖系統，集中管理福岡、北九州、大阪，以及未來其他城市的餐廳、咖啡、甜品、住宿與景點資料。前端以 GitHub Pages 提供公開瀏覽，後端以 Supabase 提供資料儲存、權限控制、同步與備份能力。

系統設計目標包括：
- 單一系統管理多個旅程／城市。
- 支援 HM 作為主要維護者。
- 支援朋友以邀請碼免登入方式提交地點與評論。
- 維持公開可瀏覽、受控可寫入的資料流。
- 預留日後擴充更多 `trip_area`、更多欄位與更多協作者的空間。

---

## 最終技術架構

### 前端

| 項目 | 設定 |
|---|---|
| 應用形式 | 純靜態網站 |
| 主要入口 | `index.html` |
| 地圖引擎 | Leaflet.js |
| 地圖底圖 | OpenStreetMap |
| 部署平台 | GitHub Pages |
| Repository | `atiumx/travel-food-map` |
| Branch | `main` |
| 部署方式 | GitHub Pages 從 `main` branch root 部署 |

### 後端

| 項目 | 設定 |
|---|---|
| 平台 | Supabase |
| 資料庫 | PostgreSQL |
| Region | Northeast Asia（Tokyo） |
| Project Ref | `toxqfrsdkvfcmmgzbyux` |
| Project URL | `https://toxqfrsdkvfcmmgzbyux.supabase.co` |

### 前後端關係

- 前端負責地圖顯示、列表瀏覽、搜尋、篩選、地點詳情、評論呈現與提交表單。
- Supabase 負責儲存 `trip_areas`、`places`、`reviews`、`invite_codes`、`audit_logs` 等資料。
- 所有公開資料讀取由 anon role 進行。
- 所有寫入操作經由 RPC function 控制，並配合 Row Level Security。

---

## Supabase 設定

### Project URL

```txt
https://toxqfrsdkvfcmmgzbyux.supabase.co
```

### Anon Public Key

```txt
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRveHFmcnNka3ZmY21tZ3pieXV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MjA2MDQsImV4cCI6MjA5NTM5NjYwNH0.aGcqog-WVrTqLnT3vmH2cRvw5TxotAtnC6BKVUmekyA
```

### 安全原則

- Supabase anon public key 可放前端。
- 所有資料表必須啟用 RLS。
- `service_role` key 絕不可出現在前端、GitHub repo、README 或公開文件。
- 寫入流程必須經 RPC function 驗證。
- 邀請碼不得以明文保存於資料表，應以 hash 方式儲存。

---

## 使用者與權限模型

### HM

| 項目 | 設定 |
|---|---|
| 顯示名 | `HM` |
| 角色 | 系統維護者 |
| 權限 | 管理所有地點、評論、邀請碼、匯出與備份 |

### 朋友

採用 **邀請碼免登入** 模式。

朋友使用流程：
- 輸入邀請碼。
- 驗證成功後進入朋友模式。
- 使用自定顯示名新增地點或評論。
- 所有提交資料都會標記建立者名稱。

### 訪客

- 可公開瀏覽地圖與資料。
- 可搜尋及篩選。
- 不可新增、修改或刪除資料。

---

## trip_area 長期設計

`trip_area` 作為整個系統的第一層分區鍵，用於表示城市、旅程、或區域性資料集合。所有地點與評論都應能對應到一個明確的 `trip_area`。

### 設計原則

- `trip_area` 使用英文 slug。
- 前端顯示名稱與資料識別碼分離。
- 可以按城市，也可以按特定旅程拆分。
- 同一城市不同年份旅程，必要時可拆成不同 slug。

### 初始 trip_area（2026-05-30 修正）

| slug | 顯示名稱 | 狀態 | 說明 |
|---|---|---|---|
| `kyushu` | 九州 | active | 以福岡機場為中心，搭車能到的範圍：福岡市、北九州、長崎、佐賀、熊本等 |
| `osaka` | 大阪 | planned | 大阪／關西 |

**命名邏輯**：以福岡機場為中心嘅 day-trip 範圍全部歸 `kyushu`，唔再細分 `fukuoka` / `kitakyushu`。將來去別府／湯布院／佐賀／熊本都放入 `kyushu`。

### 未來可擴充 trip_area

| slug | 顯示名稱 | 用途示例 |
|---|---|---|
| `tokyo` | 東京 | 之後新增東京資料 |
| `nagoya` | 名古屋 | 之後新增名古屋資料 |
| `kyoto` | 京都 | 之後新增京都資料 |
| `fukuoka_2027` | 福岡 2027 | 同城市不同年度分流 |

---

## 資料模型

### 1. `trip_areas`

定義城市或旅程分區。

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | uuid | 主鍵 |
| `slug` | text | 唯一識別碼，例如 `fukuoka` |
| `name_zh` | text | 中文顯示名稱 |
| `name_en` | text | 英文顯示名稱 |
| `status` | text | `active` / `planned` / `archived` |
| `sort_order` | integer | 顯示排序 |
| `center_lat` | double precision | 地圖中心緯度 |
| `center_lng` | double precision | 地圖中心經度 |
| `default_zoom` | integer | 預設縮放 |
| `created_at` | timestamptz | 建立時間 |
| `updated_at` | timestamptz | 更新時間 |

### 2. `places`

儲存地點主資料。

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | uuid | 主鍵 |
| `trip_area_id` | uuid | FK → `trip_areas.id` |
| `name` | text | 地點名稱 |
| `category` | text | 分類 |
| `region` | text | 地區 |
| `price_level` | text | `¥` / `¥¥` / `¥¥¥` / `¥¥¥¥` |
| `lat` | double precision | 緯度 |
| `lng` | double precision | 經度 |
| `google_rating` | numeric(2,1) | Google 評分 |
| `tabelog_rating` | numeric(3,2) | Tabelog 評分 |
| `tags` | text[] | 標籤陣列 |
| `note` | text | 備註 |
| `address` | text | 地址 |
| `google_url` | text | Google Maps 連結 |
| `tabelog_url` | text | Tabelog 連結 |
| `instagram_url` | text | Instagram 連結 |
| `facebook_url` | text | Facebook 連結 |
| `blog_url` | text | Blog 連結 |
| `source` | text | 資料來源 |
| `created_by` | text | 建立者顯示名 |
| `updated_by` | text | 更新者顯示名 |
| `is_archived` | boolean | 是否隱藏 |
| `created_at` | timestamptz | 建立時間 |
| `updated_at` | timestamptz | 更新時間 |

### 3. `reviews`

儲存地點評論。

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | uuid | 主鍵 |
| `place_id` | uuid | FK → `places.id` |
| `trip_area_id` | uuid | FK → `trip_areas.id` |
| `display_name` | text | 評論者顯示名 |
| `rating` | numeric(2,1) | 評分 |
| `comment` | text | 評論內容 |
| `visit_date` | date | 到訪日期 |
| `created_at` | timestamptz | 建立時間 |
| `updated_at` | timestamptz | 更新時間 |

### 4. `invite_codes`

管理朋友邀請碼。

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | uuid | 主鍵 |
| `label` | text | 邀請碼備註 |
| `code_hash` | text | 邀請碼 hash |
| `active` | boolean | 是否有效 |
| `max_uses` | integer | 最大使用次數 |
| `use_count` | integer | 已使用次數 |
| `expires_at` | timestamptz | 到期時間 |
| `created_at` | timestamptz | 建立時間 |

### 5. `audit_logs`

記錄重要操作。

| 欄位 | 類型 | 說明 |
|---|---|---|
| `id` | uuid | 主鍵 |
| `actor_name` | text | 操作者顯示名 |
| `action` | text | 操作類型 |
| `target_table` | text | 目標資料表 |
| `target_id` | uuid | 目標 ID |
| `metadata` | jsonb | 附加資料 |
| `created_at` | timestamptz | 建立時間 |

---

## 正式資料表定義（SQL 草案）

### `trip_areas`

```sql
create table if not exists public.trip_areas (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name_zh text not null,
  name_en text,
  status text not null default 'planned',
  sort_order integer not null default 100,
  center_lat double precision,
  center_lng double precision,
  default_zoom integer default 13,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `places`

```sql
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  trip_area_id uuid not null references public.trip_areas(id) on delete restrict,
  name text not null,
  category text,
  region text,
  price_level text,
  lat double precision,
  lng double precision,
  google_rating numeric(2,1),
  tabelog_rating numeric(3,2),
  tags text[] default '{}',
  note text,
  address text,
  google_url text,
  tabelog_url text,
  instagram_url text,
  facebook_url text,
  blog_url text,
  source text,
  created_by text,
  updated_by text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `reviews`

```sql
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.places(id) on delete cascade,
  trip_area_id uuid not null references public.trip_areas(id) on delete restrict,
  display_name text not null,
  rating numeric(2,1),
  comment text not null,
  visit_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `invite_codes`

```sql
create table if not exists public.invite_codes (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  code_hash text not null,
  active boolean not null default true,
  max_uses integer,
  use_count integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
```

### `audit_logs`

```sql
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_name text,
  action text not null,
  target_table text not null,
  target_id uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

---

## 分類與欄位規範

### 建議分類

- 拉麵
- 壽司
- 燒肉
- 燒鳥
- 天婦羅
- 居酒屋
- 咖啡
- 甜品
- 博多料理
- 烏冬
- 丼飯
- 麵包
- 住宿
- 景點
- 其他

### 福岡／北九州／大阪地區範例

| trip_area | region 建議值 |
|---|---|
| `kyushu` | 博多、天神、中洲川端、大名、藥院、祇園、ももち・小戸、北九州・小倉、門司港、長崎、佐賀、熊本、別府、湯布院、其他 |
| `osaka` | 梅田、難波、心齋橋、日本橋、天王寺、新世界、北濱、其他 |

### 價格規範

| 值 | 說明 |
|---|---|
| `¥` | 平價 |
| `¥¥` | 中等 |
| `¥¥¥` | 偏貴 |
| `¥¥¥¥` | 高價 |

---

## RLS 與 RPC 設計原則

### RLS 原則

所有表必須啟用 RLS。

| Table | anon SELECT | anon INSERT | anon UPDATE | anon DELETE |
|---|---:|---:|---:|---:|
| `trip_areas` | 可以 | 不直接允許 | 不直接允許 | 不直接允許 |
| `places` | 可以（`is_archived = false`） | 不直接允許 | 不直接允許 | 不直接允許 |
| `reviews` | 可以 | 不直接允許 | 不直接允許 | 不直接允許 |
| `invite_codes` | 不允許 | 不允許 | 不允許 | 不允許 |
| `audit_logs` | 不允許 | 不允許 | 不允許 | 不允許 |

### RPC 建議

#### `verify_invite_code(p_code text)`
- 驗證邀請碼是否有效
- 驗證是否 active
- 驗證是否過期
- 驗證是否超出使用次數

#### `add_place(p_invite_code text, p_display_name text, p_trip_area_slug text, p_place jsonb)`
- 驗證邀請碼
- 依 `trip_area` 建立地點
- 記錄 `created_by`
- 更新邀請碼使用次數
- 寫入 audit log

#### `add_review(p_invite_code text, p_display_name text, p_place_id uuid, p_rating numeric, p_comment text, p_visit_date date)`
- 驗證邀請碼
- 新增評論
- 更新邀請碼使用次數
- 寫入 audit log

---

## 前端功能範圍

### 核心功能

- 地圖顯示
- Marker 顯示
- 地點列表
- 搜尋
- 分類篩選
- 地區篩選
- 價格篩選
- trip_area 切換
- 地點詳情
- 外部連結顯示
- 評論顯示
- 新增地點
- 新增評論
- 邀請碼輸入

### 後續功能

- 想去 / 已去狀態
- 收藏
- 排行榜
- 照片上傳
- 匯出 JSON
- 匯出 CSV
- 管理員審核模式

---

## Repo 結構重新命名建議

```txt
travel-food-map/
├── README.md
├── PROJECT_PLAN.md
├── index.html
├── config.js
├── data/
│   ├── places.seed.json
│   ├── reviews.seed.json
│   └── trip_areas.seed.json
├── docs/
│   ├── schema-notes.md
│   └── migration-notes.md
└── assets/
```

### 命名原則

- 專案名稱由地區限定的 `fukuoka-map-dashboard` 升級為較中性的 `travel-food-map`。
- `seed` 檔案與正式前端檔案分離。
- 技術說明文件集中放入 `docs/`。
- 日後擴充其他城市時，不需再改 repository 名稱。

---

## 行動計劃

### 階段 1：專案基線整理

- [ ] 將專案命名整理為長期可用結構
- [ ] 建立 `PROJECT_PLAN.md`
- [ ] 建立 `docs/` 目錄
- [ ] 建立 `data/` 目錄
- [ ] 分離 seed data 與前端執行檔
- [ ] 確認 repo 不含 service role key
- [ ] 確認 repo 不含私人邀請碼明文
- [ ] 確認 repo 不含私人連結或敏感資料

### 階段 2：Supabase 資料庫建置

- [ ] 建立 `trip_areas` table
- [ ] 建立 `places` table
- [ ] 建立 `reviews` table
- [ ] 建立 `invite_codes` table
- [ ] 建立 `audit_logs` table
- [ ] 啟用所有 table 的 RLS
- [ ] 建立公開讀取 policy
- [ ] 建立邀請碼驗證 RPC
- [ ] 建立新增地點 RPC
- [ ] 建立新增評論 RPC
- [ ] 建立第一條測試邀請碼

### 階段 3：前端接入 Supabase

- [ ] 加入 Supabase JavaScript SDK
- [ ] 建立 `config.js`
- [ ] 初始化 Supabase client
- [ ] 由 Supabase 讀取 `trip_areas`
- [ ] 由 Supabase 讀取 `places`
- [ ] 由 Supabase 讀取 `reviews`
- [ ] 新增地點改用 RPC
- [ ] 新增評論改用 RPC
- [ ] 建立 HM / 朋友 / 訪客的前端狀態流程

### 階段 4：資料遷移與整理

- [ ] 整理福岡資料
- [ ] 整理北九州資料
- [ ] 整理大阪資料骨架
- [ ] 統一欄位格式
- [ ] 移除私人連結
- [ ] 匯入 `trip_areas`
- [ ] 匯入 `places`
- [ ] 匯入 `reviews`
- [ ] 驗證搜尋、篩選、切換與地圖顯示

### 階段 5：朋友共享測試

- [ ] 建立朋友測試邀請碼
- [ ] 測試朋友新增地點
- [ ] 測試朋友新增評論
- [ ] 檢查 `created_by` 與 `display_name`
- [ ] 檢查 `audit_logs`
- [ ] 停用測試邀請碼
- [ ] 驗證停用後不可再寫入

### 階段 6：後續擴充

- [ ] 加入更多 `trip_area`
- [ ] 評估圖片上傳（Supabase Storage）
- [ ] 評估想去 / 已去欄位
- [ ] 評估收藏與排名功能
- [ ] 定期匯出備份資料

---

## 固定設定摘要

```txt
Owner display name: HM
Friend access: 邀請碼免登入
Frontend hosting: GitHub Pages
Backend: Supabase
Database: PostgreSQL
Map engine: Leaflet + OpenStreetMap
Primary trip areas: kyushu, osaka
Repository target name: travel-food-map
```

---

## 最終決策

採用以下架構：

```txt
GitHub Pages + Supabase + 邀請碼免登入 + trip_area 分區模型
```

原因：
- 部署簡單
- 成本低
- 容易長期維護
- 可支援多城市與多旅程資料
- 可讓朋友免登入補資料
- 權限可透過 RLS + RPC 控制
- 後續擴充更一致

