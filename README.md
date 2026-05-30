# 旅行美食地圖

長期維護嘅旅行美食地圖系統，集中管理福岡、北九州、大阪及未來其他城市嘅餐廳、咖啡、甜品、住宿同景點資料。

## 技術架構

- **前端**：純靜態網站（HTML + JS）+ Leaflet.js + OpenStreetMap
- **後端**：Supabase（PostgreSQL + RLS + RPC）
- **部署**：GitHub Pages（main branch root）
- **權限**：HM（維護者） / 朋友（邀請碼免登入） / 訪客（公開瀏覽）

## 目錄結構

```
travel-food-map/
├── index.html              # 前端入口
├── config.js               # Supabase 設定（公開 anon key）
├── README.md
├── PROJECT_PLAN.md         # 長期規格書
├── data/                   # 種子資料（首次匯入用）
│   ├── trip_areas.seed.json
│   ├── places.seed.json
│   └── reviews.seed.json
├── docs/                   # 技術文件
│   ├── schema-notes.md
│   └── migration-notes.md
├── supabase/
│   └── migrations/         # SQL migration 檔
└── assets/
```

## 本地預覽

```bash
# 任何靜態 server 都可以
python3 -m http.server 8000
# 開 http://localhost:8000
```

## 部署

Push 入 `main` branch，GitHub Pages 會自動 deploy。

## 安全原則

- `anon` key 可放前端
- 所有 table 必須啟用 RLS
- `service_role` key **絕對不可** 出現於 repo
- 邀請碼以 hash 儲存，不存明文
- 所有寫入操作經 RPC function 驗證

## 維護者

HM
