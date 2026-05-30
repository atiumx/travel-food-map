# Pre-migration backup — 2026-05-30

呢個係 migration 前 DB 嘅 snapshot 摘要，正式 backup 詳細 JSON 喺 `pre-migration-trips.json` / `pre-migration-places.json` / `pre-migration-reviews.json`。

## 概況
- `trips`: 2 行
- `places`: 25 行（全部 trip_id = fukuoka-kitakyushu-2026；osaka-2026 trip 為空）
- `reviews`: 19 行（全部 user_name = 'atium'）

## 觀察
1. 舊 schema 有舊 plan 未提及但好有用嘅欄位：
   - `links jsonb` — 統一儲 maps / tabelog / ig / fb / blog
   - `opening_hours`（text）/ `closed_days`（int[]）— 營業時間／定休日
   - `hours_source` / `hours_verified` — 來源同驗證
2. 重複欄位 `openingHours` / `closedDays`（camelCase）全部 NULL，可廢棄
3. 25 個 places 入面，1 個小倉城屬「北九州・小倉」應歸 `kitakyushu`，其餘 24 個（包括 3 個長崎地點）按用戶決策歸 `fukuoka`

## Migration 策略修正
原本 plan 用個別 column（google_url / tabelog_url / ...）儲外部連結。
舊 schema 用 `links jsonb` 已經夠靈活，**保留 links jsonb**，加多幾個 column 反而冗餘。

最終 places 新欄位：
- `trip_area_id uuid` (FK → trip_areas)
- `price_level text` (= 舊 price)
- `google_rating numeric(2,1)` (= 舊 grating)
- `tabelog_rating numeric(3,2)` (= 舊 tabelog)
- `is_archived boolean` (= 舊 is_hidden)

舊欄位全部保留，新 RPC 寫入會同步寫舊欄位（保持舊 app 兼容）。
