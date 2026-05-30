# Schema Notes

## Table 一覽

| Table | 用途 | RLS |
|---|---|---|
| `trip_areas` | 城市／旅程分區 | anon SELECT 公開 |
| `places` | 地點主資料 | anon SELECT 公開（`is_archived = false`） |
| `reviews` | 地點評論 | anon SELECT 公開 |
| `invite_codes` | 朋友邀請碼 | anon 完全唔可以讀寫 |
| `audit_logs` | 操作紀錄 | anon 完全唔可以讀寫 |

## 寫入流程

anon 角色**唔會直接** INSERT / UPDATE / DELETE 任何 table。所有寫入經 RPC：

- `verify_invite_code(p_code)` — 驗證邀請碼
- `add_place(...)` — 新增地點
- `add_review(...)` — 新增評論

RPC 用 `SECURITY DEFINER` 行，內部驗證 invite code hash 同 active state，然後 INSERT 並寫 audit log。

## 邀請碼

- 用 `pgcrypto.crypt()` + `gen_salt('bf')` 做 bcrypt hash
- 驗證時用 `crypt(p_code, code_hash) = code_hash`
- DB 內**無明文邀請碼**，連 owner 都見唔到（要記住創建時嗰個明文）

## 索引

主要查詢：
- `places` 按 `trip_area_id` filter + `is_archived = false`
- `reviews` 按 `place_id` filter
- `invite_codes` 按 `code_hash` 比對

已加 index：
- `places(trip_area_id, is_archived)`
- `reviews(place_id)`
- `reviews(trip_area_id)`

## 命名規範

- Slug 用 `snake_case` 英文小寫
- Display name 用中文（`name_zh`）
- 時間欄位統一 `timestamptz`
