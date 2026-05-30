// Supabase 設定
// anon key 設計上可以公開，受 RLS 保護
// 如需 rotate，喺 Supabase Dashboard → Settings → API → Reset anon key
// 然後同步更新呢個檔案再 push

window.APP_CONFIG = {
  SUPABASE_URL: "https://toxqfrsdkvfcmmgzbyux.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRveHFmcnNka3ZmY21tZ3pieXV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MjA2MDQsImV4cCI6MjA5NTM5NjYwNH0.aGcqog-WVrTqLnT3vmH2cRvw5TxotAtnC6BKVUmekyA",

  // 預設顯示 trip_area
  DEFAULT_TRIP_AREA: "kyushu",

  // 維護者顯示名（用於前端 UI 識別 owner 模式）
  OWNER_DISPLAY_NAME: "HM",

  // 地圖預設設定
  MAP_TILE_URL: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  MAP_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
};
