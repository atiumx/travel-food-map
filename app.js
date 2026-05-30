// =============================================================
// 旅行美食地圖 — 前端邏輯
// 三種 user state: guest / friend / owner
//   - guest: 只可瀏覽
//   - friend: 通過邀請碼驗證，可新增地點同評論
//   - owner: friend 用 OWNER_DISPLAY_NAME 自動標示
// =============================================================

(() => {
  const cfg = window.APP_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // 預設分類選項（同 PROJECT_PLAN.md 一致）
  // G2: cuisine_group → display label + emoji + sub-categories
  const CUISINE_GROUPS = {
    japanese:     { label: "日本料理",   emoji: "🍱", subs: ["拉麵","壽司","燒肉","燒鳥","天婦羅","居酒屋","丼飯","烏冬","蕎麥","鰻魚","和菓子","喫茶店","博多料理"] },
    asian:        { label: "亞洲",       emoji: "🥢", subs: ["中餐","台式","韓式","泰式","越南","印度","東南亞","港式","粵菜","小籠包","夜市小食"] },
    western:      { label: "西餐",       emoji: "🍝", subs: ["意式","法式","美式","Steakhouse","Bistro","Brunch","Pizza","Burger"] },
    cafe_dessert: { label: "咖啡甜品",   emoji: "☕", subs: ["咖啡","Specialty Coffee","甜品","麵包","Bakery","Gelato","雪糕","蛋糕","下午茶"] },
    bar:          { label: "酒吧",       emoji: "🍶", subs: ["清酒","Sake","Cocktail","Wine","Craft Beer","啤酒"] },
    fast:         { label: "快食",       emoji: "🍙", subs: ["便利店","Fast Food","Food Court","快餐","美食廣場"] },
    attraction:   { label: "景點",       emoji: "📷", subs: ["景點","觀光","博物館","寺廟","神社","公園"] },
    lodging:      { label: "住宿",       emoji: "🏨", subs: ["住宿","酒店","旅館","民宿","Hostel"] },
    other:        { label: "其他",       emoji: "🍽️", subs: ["其他"] },
  };
  // Flat CATEGORIES kept for legacy modal sub-type field (free-text style)
  const CATEGORIES = Object.values(CUISINE_GROUPS).flatMap(g => g.subs);

  // 分類 → emoji icon (legacy mapping for sub-categories on markers)
  const CATEGORY_EMOJI = {
    "拉麵": "🍜", "壽司": "🍣", "燒肉": "🥩", "燒鳥": "🍗",
    "天婦羅": "🍤", "居酒屋": "🍶", "咖啡": "☕", "甜品": "🍰",
    "博多料理": "🍲", "烏冬": "🍜", "丼飯": "🍚", "麵包": "🥐",
    "住宿": "🏨", "景點": "📷", "其他": "🍽️",
    "小籠包": "🥟", "夜市小食": "🌮", "中餐": "🥡", "台式": "🧋",
    "韓式": "🍲", "泰式": "🍛", "越南": "🍜", "印度": "🍛",
    "港式": "🍤", "粵菜": "🥢",
    "意式": "🍝", "法式": "🥐", "美式": "🍔", "Steakhouse": "🥩",
    "Bistro": "🍷", "Brunch": "🍳", "Pizza": "🍕", "Burger": "🍔",
    "Specialty Coffee": "☕", "Bakery": "🥖", "Gelato": "🍨",
    "雪糕": "🍦", "蛋糕": "🎂", "下午茶": "🫖",
    "清酒": "🍶", "Sake": "🍶", "Cocktail": "🍸", "Wine": "🍷",
    "Craft Beer": "🍺", "啤酒": "🍺",
    "便利店": "🏪", "Fast Food": "🍟", "Food Court": "🍱", "快餐": "🍱",
    "美食廣場": "🍱",
    "觀光": "📷", "博物館": "🏛️", "寺廟": "🛕", "神社": "⛩️", "公園": "🌳",
    "酒店": "🏨", "旅館": "🏨", "民宿": "🏡", "Hostel": "🛏️",
    "蕎麥": "🍝", "鰻魚": "🍣", "和菓子": "🍡", "喫茶店": "☕"
  };
  const DEFAULT_EMOJI = "🍽️";

  // Bookmark 狀態（localStorage 跟 device 走）
  const BOOKMARK_STORAGE_KEY = "tfm_bookmarks_v1";
  const BOOKMARK_LABEL = { wishlist: "⭐ 想去", been: "✅ 已去", favorite: "❤️ 最愛" };
  const BOOKMARK_ICON  = { wishlist: "⭐", been: "✅", favorite: "❤️" };

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(BOOKMARK_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function saveBookmarks(map) {
    try { localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(map)); } catch {}
  }
  function getBookmark(placeId) { return state.bookmarks[placeId] || null; }
  function setBookmark(placeId, status) {
    if (status === null || status === undefined) delete state.bookmarks[placeId];
    else state.bookmarks[placeId] = status;
    saveBookmarks(state.bookmarks);
    // J2: budget depends on bookmarks; refresh panel if mounted
    if (typeof renderBudgetPanel === "function") {
      try { renderBudgetPanel(); } catch (e) {}
    }
  }

  // -----------------------------------------------------------
  // 步行圈常數
  // 一般市區步行 ~80 m/min；加 0.7 路程保險因子（直線 vs 實際）
  // 5/10/15 min → 280/560/840m
  // -----------------------------------------------------------
  const WALK_SPEED_MPS = 80 * 0.7 / 60;  // metres / sec, 顯示用 m/min = 56
  const WALK_METRES_PER_MIN = 56;
  const WALK_MINUTES = [5, 10, 15];

  // -----------------------------------------------------------
  // State
  // -----------------------------------------------------------
  const state = {
    role: "guest",            // guest | friend | owner
    inviteCode: null,         // friend / owner 模式記住碼
    displayName: null,
    tripAreas: [],
    currentTripAreaSlug: cfg.DEFAULT_TRIP_AREA,
    places: [],
    filtered: [],
    selectedPlaceId: null,
    markers: new Map(),       // place_id -> marker
    bookmarks: {},            // place_id -> 'wishlist'|'been'|'favorite'
    sortBy: "default",
    openFilter: "",           // "" | "now" | "today" | "weekday-N"
    bookmarkFilter: "",       // "" | "wishlist" | "been" | "favorite" | "none"
    dayFilter: "",            // "" | "1"."7" | "none"
    tagFacets: new Set(),     // I2: 多選 facet tag filter（OR 邏輯）
    tagTagsSelected: new Set(),  // I2-extra: 多選用戶 tag filter（AND 邏輯 + tags array contains）

    // 步行圈（多 anchor）
    walking: {
      enabled: false,
      minutes: 5,
      anchors: [],           // [{ id, mode:"map"|"geo"|"place"|"station", lat, lng, label, placeId?, stationId?, color }]
      lastError: null,
    },

    // 車站 preset
    stations: [],            // [{ id, name, name_en, lat, lng, sys, area, line }]
    showStations: false,

    // J1: heatmap layer
    heatEnabled: false,
  };
  state.bookmarks = loadBookmarks();

  // 步行圈 layers
  const walkingLayer = L.layerGroup();
  const anchorMarkers = new Map(); // anchor.id -> L.circleMarker
  const ANCHOR_COLORS = ["#b8412c", "#2c6fb8", "#3a8a3a", "#c87f0a", "#8a3aa8"];
  const MAX_ANCHORS = 5;
  let anchorIdCounter = 1;
  const nextAnchorId = () => `a${anchorIdCounter++}`;

  // -----------------------------------------------------------
  // I2: Facet tag definitions — quality signals
  // -----------------------------------------------------------
  // 每個 facet 對應 1 個 chip，配對邏輯由 matchFacet() 處理
  // 用 keyword OR-match 喺 tags[] 入面，避免依賴單一 exact tag
  const FACET_DEFS = [
    { key: "michelin",   label: "🌟 米其林",         keywords: ["米其林"] },
    { key: "bib",        label: "🍽️ 必比登",         keywords: ["必比登"] },
    { key: "asia50",     label: "🏆 Asia 50 Best",   keywords: ["Asia 50 Best", "asia 50", "亞洲50"] },
    { key: "tabelog",    label: "🇯🇵 百名店",          keywords: ["Tabelog", "百名店"] },
    { key: "oldshop",    label: "⏳ 老店",            keywords: ["老店", "老牌", "老舗", "古早味"] },
    { key: "verified",   label: "✓ 已驗證",           keywords: [], verifiedOnly: true },
    { key: "unverified", label: "⚠ 只睇未驗證",        keywords: [], unverifiedOnly: true },
  ];

  function matchFacet(place, tags, facetKey) {
    const def = FACET_DEFS.find(f => f.key === facetKey);
    if (!def) return false;
    if (def.verifiedOnly) return place.verified === true;
    if (def.unverifiedOnly) return place.verified === false;
    const lower = tags.map(t => String(t).toLowerCase());
    for (const kw of def.keywords) {
      const kl = kw.toLowerCase();
      if (lower.some(t => t.includes(kl))) return true;
    }
    return false;
  }

  function bindFacetChips() {
    const wrap = document.getElementById("facetChips");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (const def of FACET_DEFS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "facet-chip";
      btn.dataset.facet = def.key;
      btn.textContent = def.label;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        if (state.tagFacets.has(def.key)) {
          state.tagFacets.delete(def.key);
          btn.classList.remove("active");
          btn.setAttribute("aria-pressed", "false");
        } else {
          state.tagFacets.add(def.key);
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
        }
        applyFilters();
      });
      wrap.appendChild(btn);
    }
    // Optional clear-all
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "facet-chip facet-clear";
    clearBtn.textContent = "清除";
    clearBtn.title = "清除所有 facet 篩選";
    clearBtn.addEventListener("click", () => {
      state.tagFacets.clear();
      syncFacetChipsUI();
      applyFilters();
    });
    wrap.appendChild(clearBtn);
    syncFacetChipsUI();
  }

  function syncFacetChipsUI() {
    const wrap = document.getElementById("facetChips");
    if (!wrap) return;
    wrap.querySelectorAll(".facet-chip[data-facet]").forEach(btn => {
      const on = state.tagFacets.has(btn.dataset.facet);
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // -----------------------------------------------------------
  // I3: Day timeline strip
  // -----------------------------------------------------------
  // 根據 state.places 中出現過的 day_tag 動態生成 pill。
  // Click pill = toggle state.dayFilter 到該 day。
  // 與 #dayFilter <select> 雙向同步。
  function renderDayStrip() {
    const wrap = document.getElementById("dayStrip");
    if (!wrap) return;
    const counts = new Map();   // day -> count (only places.day_tag != null)
    let unassigned = 0;
    for (const p of state.places || []) {
      if (p.day_tag == null) { unassigned++; continue; }
      const d = parseInt(p.day_tag, 10);
      if (isNaN(d)) continue;
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    // Hide strip entirely if no day_tag data at all
    if (counts.size === 0) {
      wrap.style.display = "none";
      wrap.innerHTML = "";
      return;
    }
    wrap.style.display = "";
    const days = Array.from(counts.keys()).sort((a, b) => a - b);
    wrap.innerHTML = "";

    // "全部" pill (clears dayFilter)
    const allBtn = makeDayPill("全部", null, (state.places || []).length, !state.dayFilter, () => {
      setDayFilter("");
    });
    wrap.appendChild(allBtn);

    for (const d of days) {
      const active = state.dayFilter === String(d);
      const btn = makeDayPill(`Day ${d}`, d, counts.get(d), active, () => {
        // Toggle behavior: click active pill → clear
        setDayFilter(active ? "" : String(d));
      });
      wrap.appendChild(btn);
    }
    if (unassigned > 0) {
      const active = state.dayFilter === "none";
      const btn = makeDayPill("未分配", "none", unassigned, active, () => {
        setDayFilter(active ? "" : "none");
      });
      btn.classList.add("day-none");
      wrap.appendChild(btn);
    }
  }

  function makeDayPill(label, dayKey, count, active, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-pill";
    if (active) btn.classList.add("active");
    btn.dataset.day = dayKey == null ? "" : String(dayKey);
    btn.innerHTML = `<span>${label}</span><span class="pill-count">${count}</span>`;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.addEventListener("click", onClick);
    return btn;
  }

  function setDayFilter(val) {
    state.dayFilter = val;
    const sel = document.getElementById("dayFilter");
    if (sel) sel.value = val;
    applyFilters();
    // Re-render strip so active state updates
    renderDayStrip();
  }

  // -----------------------------------------------------------
  // J1: Heatmap layer (rating-weighted density)
  // -----------------------------------------------------------
  // Heat intensity per point = (rating - 3.0) / 2.0 clamped to [0.1, 1.0]
  // → rating 5.0 = full intensity 1.0; rating 3.0 = 0.1; missing rating = 0.3
  // Re-built on every applyFilters() so heat respects active filters.
  let heatLayer = null;
  function heatIntensity(p) {
    const r = Math.max(p.google_rating || 0, p.tabelog_rating || 0);
    if (!r) return 0.3;
    const v = (r - 3.0) / 2.0;
    return Math.max(0.1, Math.min(1.0, v));
  }
  function renderHeatLayer() {
    // Always destroy first (filter changes → rebuild)
    if (heatLayer) {
      try { map.removeLayer(heatLayer); } catch (e) {}
      heatLayer = null;
    }
    if (!state.heatEnabled) return;
    if (typeof L.heatLayer !== "function") {
      console.warn("leaflet.heat not loaded");
      return;
    }
    const pts = [];
    for (const p of state.filtered || []) {
      if (p.lat == null || p.lng == null) continue;
      pts.push([p.lat, p.lng, heatIntensity(p)]);
    }
    if (pts.length === 0) return;
    heatLayer = L.heatLayer(pts, {
      radius: 28,
      blur: 22,
      maxZoom: 17,
      minOpacity: 0.35,
      gradient: { 0.2: "#3a78c2", 0.4: "#5ac08a", 0.6: "#e6c54a", 0.8: "#e08a3a", 1.0: "#c23a3a" },
    });
    heatLayer.addTo(map);
  }
  function setHeatEnabled(on) {
    state.heatEnabled = !!on;
    const cb = document.getElementById("heatToggle");
    if (cb) cb.checked = state.heatEnabled;
    const fab = document.getElementById("fabHeat");
    if (fab) fab.classList.toggle("active", state.heatEnabled);
    renderHeatLayer();
  }

  // -----------------------------------------------------------
  // J2: Budget tracker (per-capita estimate, localStorage)
  // -----------------------------------------------------------
  // 人均估算單價（當地貨幣），以 trip_area slug 為 key。可讓用戶於 UI 調整。
  // 計算範圍 = bookmark in [wishlist, been, favorite]
  // 無 price_level 用該區中位數（其他 4 級平均）
  // 貨幣：日本區 = JPY（¥）、台北 = TWD（NT$）
  const BUDGET_CURRENCY = {
    "kyushu":  { code: "JPY", symbol: "¥"   },
    "osaka":   { code: "JPY", symbol: "¥"   },
    "taipei":  { code: "TWD", symbol: "NT$" },
    "_default":{ code: "JPY", symbol: "¥"   },
  };
  const BUDGET_DEFAULTS = {
    "kyushu":  { "¥": 1000, "¥¥": 2500, "¥¥¥": 6000, "¥¥¥¥": 15000 },
    "osaka":   { "¥": 1000, "¥¥": 2500, "¥¥¥": 6000, "¥¥¥¥": 15000 },
    "taipei":  { "¥":  200, "¥¥":  500, "¥¥¥": 1200, "¥¥¥¥":  3000 },
    "_default":{ "¥": 1000, "¥¥": 2500, "¥¥¥": 6000, "¥¥¥¥": 15000 },
  };
  function getCurrencyForArea(slug) {
    return BUDGET_CURRENCY[slug] || BUDGET_CURRENCY["_default"];
  }
  function loadBudgetRates() {
    try {
      const raw = localStorage.getItem("tfm_budget_rates");
      if (raw) return Object.assign({}, BUDGET_DEFAULTS, JSON.parse(raw));
    } catch (e) {}
    return JSON.parse(JSON.stringify(BUDGET_DEFAULTS));
  }
  function saveBudgetRates(rates) {
    try { localStorage.setItem("tfm_budget_rates", JSON.stringify(rates)); } catch (e) {}
  }
  function getBudgetRatesForArea(slug) {
    const all = loadBudgetRates();
    return all[slug] || all["_default"];
  }
  function estimateCost(place, rates) {
    if (place.price_level && rates[place.price_level]) return rates[place.price_level];
    // fallback: median of 4 levels
    const vals = ["¥","¥¥","¥¥¥","¥¥¥¥"].map(k => rates[k] || 0).filter(Boolean).sort((a,b)=>a-b);
    return vals.length ? vals[Math.floor(vals.length/2)] : 0;
  }
  function computeBudget() {
    const slug = state.currentTripAreaSlug;
    const rates = getBudgetRatesForArea(slug);
    const bookmarkedKinds = new Set(["wishlist","been","favorite"]);
    const byBookmark = { wishlist:{count:0,sum:0}, been:{count:0,sum:0}, favorite:{count:0,sum:0} };
    const byDay = new Map(); // day(number|null) -> {count,sum}
    let totalCount = 0, totalSum = 0;
    for (const p of state.places || []) {
      const bm = getBookmark(p.id);
      if (!bm || !bookmarkedKinds.has(bm)) continue;
      const cost = estimateCost(p, rates);
      byBookmark[bm].count += 1;
      byBookmark[bm].sum += cost;
      const dKey = (p.day_tag != null) ? p.day_tag : "none";
      if (!byDay.has(dKey)) byDay.set(dKey, { count:0, sum:0 });
      const dEntry = byDay.get(dKey);
      dEntry.count += 1;
      dEntry.sum += cost;
      totalCount += 1;
      totalSum += cost;
    }
    const cur = getCurrencyForArea(slug);
    return { totalCount, totalSum, byBookmark, byDay, rates, slug, currency: cur };
  }
  function fmtMoney(n, currency) {
    const sym = (currency && currency.symbol) || "¥";
    return sym + Math.round(n).toLocaleString("en-US");
  }
  function renderBudgetPanel() {
    const panel = document.getElementById("budgetBody");
    if (!panel) return;
    const b = computeBudget();
    const cur = b.currency;
    if (b.totalCount === 0) {
      panel.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:6px 4px;" data-i18n="budget.empty">未收藏任何餐廳。加⭐/✅/❤️ 後顯示總預算。</div>';
      applyI18n();
      return;
    }
    // Day rows (sorted: 1,2,3..., then none)
    const dayKeys = Array.from(b.byDay.keys()).sort((a,b)=> {
      if (a === "none") return 1;
      if (b === "none") return -1;
      return a - b;
    });
    const dayRows = dayKeys.map(k => {
      const e = b.byDay.get(k);
      const label = (k === "none") ? "<span data-i18n=\"budget.unassigned\">未分配</span>" : ("Day " + k);
      return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;"><span>${label} · ${e.count} 店</span><span>${fmtMoney(e.sum, cur)}</span></div>`;
    }).join("");
    const bmRow = (key, emoji) => {
      const e = b.byBookmark[key];
      if (e.count === 0) return "";
      return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:1px 0;color:var(--muted);"><span>${emoji} ${e.count}</span><span>${fmtMoney(e.sum, cur)}</span></div>`;
    };
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <span style="font-weight:600;" data-i18n="budget.total">人均總預算</span>
        <span style="font-size:14px;font-weight:600;color:#b8412c;">${fmtMoney(b.totalSum, cur)} <span style="font-size:10px;font-weight:400;color:var(--muted);">${cur.code}</span></span>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px;">${b.totalCount} <span data-i18n="budget.places_unit">間店</span> · ${fmtMoney(b.totalSum / Math.max(b.totalCount,1), cur)} <span data-i18n="budget.per_place">/店</span></div>
      ${bmRow("wishlist","⭐")}
      ${bmRow("been","✅")}
      ${bmRow("favorite","❤️")}
      <div style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px;">${dayRows}</div>
      <div style="margin-top:6px;font-size:10px;color:var(--muted);">¥/¥¥/¥¥¥/¥¥¥¥ = ${b.rates["¥"]}/${b.rates["¥¥"]}/${b.rates["¥¥¥"]}/${b.rates["¥¥¥¥"]} ${cur.code}/人·店（估算）</div>
      <button class="btn-sm" id="budgetEditRates" style="margin-top:4px;width:100%;font-size:11px;" data-i18n="budget.edit_rates">調整單價 ⚙️</button>
    `;
    const editBtn = document.getElementById("budgetEditRates");
    if (editBtn) editBtn.addEventListener("click", openBudgetRateEditor);
    applyI18n();
  }
  function openBudgetRateEditor() {
    const slug = state.currentTripAreaSlug;
    const rates = getBudgetRatesForArea(slug);
    const cur = getCurrencyForArea(slug);
    const labels = ["¥","¥¥","¥¥¥","¥¥¥¥"];
    const newRates = {};
    for (const lvl of labels) {
      const curVal = rates[lvl];
      const v = prompt(`${slug} · ${lvl} = ? ${cur.code}/人`, String(curVal));
      if (v === null) return; // user cancelled → abort all
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) { alert("請輸入非負整數"); return; }
      newRates[lvl] = n;
    }
    const all = loadBudgetRates();
    all[slug] = newRates;
    saveBudgetRates(all);
    renderBudgetPanel();
  }

  // -----------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const roleBadge       = $("roleBadge");
  const tripAreaSelect  = $("tripAreaSelect");
  const searchInput     = $("searchInput");
  const categoryFilter  = $("categoryFilter");
  const priceFilter     = $("priceFilter");
  const placeListEl     = $("placeList");
  const inviteBtn       = $("inviteBtn");
  const addPlaceBtn     = $("addPlaceBtn");

  // -----------------------------------------------------------
  // Map
  // -----------------------------------------------------------
  const map = L.map("map", { zoomControl: true }).setView([33.5904, 130.4017], 13);

  // -----------------------------------------------------------
  // K2: Map style switcher (OSM / Satellite / Dark / Terrain)
  // -----------------------------------------------------------
  const MAP_STYLES = {
    osm: {
      name: "OSM",
      url: cfg.MAP_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: cfg.MAP_ATTRIBUTION || "© OpenStreetMap",
      maxZoom: 19
    },
    satellite: {
      name: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles © Esri",
      maxZoom: 19
    },
    dark: {
      name: "Dark",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution: "© OpenStreetMap © CARTO",
      maxZoom: 19
    },
    terrain: {
      name: "Terrain",
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap © OpenTopoMap",
      maxZoom: 17
    }
  };
  let _currentTileLayer = null;
  function getMapStyle() {
    const saved = localStorage.getItem("tfm_map_style");
    if (saved && MAP_STYLES[saved]) return saved;
    return "osm";
  }
  function setMapStyle(key) {
    if (!MAP_STYLES[key]) return;
    localStorage.setItem("tfm_map_style", key);
    applyMapStyle();
    const sel = document.getElementById("mapStyleSelect");
    if (sel) sel.value = key;
  }
  function applyMapStyle() {
    const s = MAP_STYLES[getMapStyle()];
    if (_currentTileLayer) { map.removeLayer(_currentTileLayer); }
    _currentTileLayer = L.tileLayer(s.url, { attribution: s.attribution, maxZoom: s.maxZoom }).addTo(map);
  }
  applyMapStyle();
  // Perf-A: chunkedLoading splits marker addition across animation frames
  // so 500+ markers don't block the main thread (~16ms per chunk)
  const cluster = L.markerClusterGroup({
    disableClusteringAtZoom: 16,
    maxClusterRadius: 40,
    chunkedLoading: true,
    chunkInterval: 50,    // ms per chunk before yielding
    chunkDelay: 16,       // ms idle between chunks
    removeOutsideVisibleBounds: true,  // Perf-A: cull markers outside viewport
  });
  map.addLayer(cluster);

  // Station layer (toggleable)
  const stationLayer = L.layerGroup();
  const stationMarkers = new Map(); // station_id -> marker

  // -----------------------------------------------------------
  // I4: i18n (zh-TW / en / ja)
  // -----------------------------------------------------------
  const I18N = {
    "zh-TW": { "app.title":"旅行美食地圖", "role.guest":"訪客", "search.placeholder":"搜尋名稱／標籤／備註", "filter.all_cuisine":"所有菜系", "filter.all_category":"所有菜系／分類", "filter.all_price":"所有價位", "filter.hours_all":"營業時間：所有", "filter.hours_now":"而家開緊", "filter.hours_today":"今日有開", "filter.hours_title":"營業時間篩選", "filter.bookmark_all":"收藏：所有", "filter.bookmark_wish":"⭐ 想去", "filter.bookmark_been":"✅ 已去", "filter.bookmark_fav":"❤️ 最愛", "filter.bookmark_none":"— 未收藏", "filter.bookmark_title":"收藏狀態篩選", "filter.day_all":"日子：所有", "filter.day_none":"— 未分配", "filter.day_title":"日子篩選", "filter.sort_title":"排序", "sort.default":"排序：預設", "sort.distance":"距離（步行圈）", "sort.rating":"評分（高→低）", "sort.recent":"最新加入", "sort.name":"名稱（A→Z）", "sort.random":"隨機", "btn.here":"📍 我而家", "btn.here_title":"用我而家位置做起點", "btn.share_title":"複製連結（含篩選）", "btn.heat":"🔥 熱力圖（按評分加權）", "btn.heat_title":"熱力圖 toggle", "budget.header":"💰 人均預算估算", "budget.total":"人均總預算", "budget.places_unit":"間店", "budget.per_place":"/店", "budget.unassigned":"未分配", "budget.empty":"未收藏任何餐廳。加⭐/✅/❤️ 後顯示總預算。", "budget.edit_rates":"調整單價 ⚙️", "theme.toggle":"切換亮/暗主題", "mapstyle.title":"地圖樣式", "empty.walking.title":"步行圈內未有地點", "empty.walking.hint":"可試擴大步行距離或重設起點", "empty.search.title":"找不到結果", "empty.search.hint":"以「{q}」為關鍵字沒有匹配。試調整篩選條件", "empty.places.title":"未有地點", "empty.places.hint":"可以由你開始新增", "detail.back_label":"返回列表", "detail.back":"返回列表" },
    "en": { "app.title":"Travel Food Map", "role.guest":"Guest", "search.placeholder":"Search name / tags / notes", "filter.all_cuisine":"All cuisines", "filter.all_category":"All cuisines & categories", "filter.all_price":"All prices", "filter.hours_all":"Hours: All", "filter.hours_now":"Open now", "filter.hours_today":"Open today", "filter.hours_title":"Filter by opening hours", "filter.bookmark_all":"Bookmark: All", "filter.bookmark_wish":"⭐ Wishlist", "filter.bookmark_been":"✅ Visited", "filter.bookmark_fav":"❤️ Favorite", "filter.bookmark_none":"— Unbookmarked", "filter.bookmark_title":"Filter by bookmark state", "filter.day_all":"Day: All", "filter.day_none":"— Unassigned", "filter.day_title":"Filter by trip day", "filter.sort_title":"Sort", "sort.default":"Sort: Default", "sort.distance":"Distance (walking)", "sort.rating":"Rating (high→low)", "sort.recent":"Recently added", "sort.name":"Name (A→Z)", "sort.random":"Random", "btn.here":"📍 Here", "btn.here_title":"Use current location as anchor", "btn.share_title":"Copy share link (with filters)", "btn.heat":"🔥 Heatmap (rating-weighted)", "btn.heat_title":"Toggle heatmap layer", "budget.header":"💰 Per-capita budget", "budget.total":"Estimated total", "budget.places_unit":"places", "budget.per_place":"/place", "budget.unassigned":"Unassigned", "budget.empty":"No bookmarks yet. Add ⭐/✅/❤️ to see totals.", "budget.edit_rates":"Edit rates ⚙️", "theme.toggle":"Toggle light/dark theme", "mapstyle.title":"Map style", "empty.walking.title":"No places in walking range", "empty.walking.hint":"Try expanding the radius or moving the anchor", "empty.search.title":"No results", "empty.search.hint":"No matches for “{q}”. Try adjusting filters.", "empty.places.title":"No places yet", "empty.places.hint":"Be the first to add one.", "detail.back_label":"Back to list", "detail.back":"Back to list" },
    "ja": { "app.title":"旅行グルメマップ", "role.guest":"ゲスト", "search.placeholder":"名称／タグ／メモを検索", "filter.all_cuisine":"全ての料理", "filter.all_category":"全料理／カテゴリ", "filter.all_price":"全価格帯", "filter.hours_all":"営業時間：全て", "filter.hours_now":"今開店中", "filter.hours_today":"本日営業", "filter.hours_title":"営業時間フィルター", "filter.bookmark_all":"ブックマーク：全て", "filter.bookmark_wish":"⭐ 行きたい", "filter.bookmark_been":"✅ 行った", "filter.bookmark_fav":"❤️ お気に入り", "filter.bookmark_none":"— 未登録", "filter.bookmark_title":"ブックマーク状態", "filter.day_all":"日付：全て", "filter.day_none":"— 未割当", "filter.day_title":"旅程日フィルター", "filter.sort_title":"並び替え", "sort.default":"並び：デフォルト", "sort.distance":"距離（徒歩圏）", "sort.rating":"評価（高→低）", "sort.recent":"新着順", "sort.name":"名前（A→Z）", "sort.random":"ランダム", "btn.here":"📍 現在地", "btn.here_title":"現在地をアンカーに設定", "btn.share_title":"共有リンクをコピー", "btn.heat":"🔥 ヒートマップ（評価加重）", "btn.heat_title":"ヒートマップを切り替え", "budget.header":"💰 一人あたり予算", "budget.total":"一人予算合計", "budget.places_unit":"店舗", "budget.per_place":"/店", "budget.unassigned":"未割当", "budget.empty":"ブックマーク未登録。⭐/✅/❤️ を追加して予算を表示。", "budget.edit_rates":"単価設定 ⚙️", "theme.toggle":"テーマ切替", "mapstyle.title":"地図スタイル", "empty.walking.title":"徒歩圈内に地点なし", "empty.walking.hint":"距離を拡げるか起点を再設定", "empty.search.title":"該当なし", "empty.search.hint":"「{q}」に一致しません。フィルターを調整してください。", "empty.places.title":"地点未登録", "empty.places.hint":"あなたから追加してください。", "detail.back_label":"リストに戻る", "detail.back":"リストに戻る" }
  };
  function getLang() { return localStorage.getItem("tfm_lang") || "zh-TW"; }
  function setLang(l) { localStorage.setItem("tfm_lang", l); applyI18n(); }
  function applyI18n() {
    const dict = I18N[getLang()] || I18N["zh-TW"];
    document.querySelectorAll("[data-i18n]").forEach(el => { const k = el.dataset.i18n; if (dict[k]) el.textContent = dict[k]; });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => { const k = el.dataset.i18nPlaceholder; if (dict[k]) el.placeholder = dict[k]; });
    document.querySelectorAll("[data-i18n-title]").forEach(el => { const k = el.dataset.i18nTitle; if (dict[k]) el.title = dict[k]; });
    document.documentElement.lang = getLang();
  }

  // -----------------------------------------------------------
  // K1: Dark mode theme toggle
  // -----------------------------------------------------------
  function getTheme() {
    const saved = localStorage.getItem("tfm_theme");
    if (saved === "dark" || saved === "light") return saved;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  function applyTheme() {
    const t = getTheme();
    document.documentElement.setAttribute("data-theme", t);
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = (t === "dark") ? "☀️" : "🌙";
  }
  function setTheme(t) {
    localStorage.setItem("tfm_theme", t);
    applyTheme();
  }

  // -----------------------------------------------------------
  // K1: Skeleton loading for placeList
  // -----------------------------------------------------------
  // K2: Empty state illustrations (contextual)
  function renderEmptyState() {
    const dict = I18N[getLang()] || I18N["zh-TW"];
    let icon, title, hint;
    const q = (state.filters && (state.filters.search || "")).trim();
    if (state.walking && state.walking.enabled) {
      icon = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="7"/><path d="M12 17v5"/><circle cx="12" cy="10" r="2.5"/></svg>';
      title = dict["empty.walking.title"] || "步行圈內未有地點";
      hint = dict["empty.walking.hint"] || "可試擴大步行距離或重設起點";
    } else if (q) {
      icon = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
      title = dict["empty.search.title"] || "找不到結果";
      hint = (dict["empty.search.hint"] || "以「{q}」為關鍵字沒有匹配。試調整篩選條件。").replace("{q}", q.replace(/</g, "&lt;"));
    } else {
      icon = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18l-2 13H5L3 6z"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v4M14 11v4"/></svg>';
      title = dict["empty.places.title"] || "未有地點";
      hint = dict["empty.places.hint"] || "可以由你開始新增。";
    }
    return '<div class="list-empty" style="text-align:center;padding:24px 12px;color:var(--muted);">'
         + '<div style="color:var(--muted);opacity:0.55;margin-bottom:8px;">' + icon + '</div>'
         + '<div style="font-size:14px;color:var(--text);margin-bottom:4px;">' + title + '</div>'
         + '<div style="font-size:12px;">' + hint + '</div>'
         + '</div>';
  }

  function renderListSkeleton(n = 8) {
    const listEl = document.getElementById("placeList");
    if (!listEl) return;
    listEl.setAttribute("aria-busy", "true");
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push('<div class="skeleton-row" aria-hidden="true"><div class="skeleton skeleton-line mid"></div><div class="skeleton skeleton-line short"></div></div>');
    }
    listEl.innerHTML = rows.join("");
  }

  // -----------------------------------------------------------
  // Init
  // -----------------------------------------------------------
  async function init() {
    populateCategorySelects();
    bindEvents();
    // K1: theme
    applyTheme();
    const themeBtn = document.getElementById("themeToggle");
    if (themeBtn) themeBtn.addEventListener("click", () => setTheme(getTheme() === "dark" ? "light" : "dark"));
    // K2: map style switcher
    const styleSel = document.getElementById("mapStyleSelect");
    if (styleSel) { styleSel.value = getMapStyle(); styleSel.addEventListener("change", e => setMapStyle(e.target.value)); }
    // I4: language switcher
    const langSel = document.getElementById("langSwitch");
    if (langSel) { langSel.value = getLang(); langSel.addEventListener("change", e => setLang(e.target.value)); }
    applyI18n();
    await loadTripAreas();
    // URL state 要喺 tripAreas load 完先 apply（要識 slug）
    restoreStateFromURL();
    // E1: restore persisted anchors for current area
    restoreAnchorsForCurrentArea();
    renderAnchorList();
    updateWalkingUI();
    await loadPlacesForCurrentArea();
    // restoreStateFromURL 已 set filter values，但要 applyFilters 一次
    applyFilters();
    // 背景 load 站點，唔阻主流程
    loadStations().catch(err => console.warn("loadStations failed", err));
    // PWA: register service worker
    registerServiceWorker().catch(err => console.warn("SW reg failed", err));
    setupOnlineStatus();
    // F: mobile gestures + bottom sheet + zoom relocation
    initMobile();
  }

  // -----------------------------------------------------------
  // Batch F: Mobile bottom sheet + gestures + haptic + zoom relocate
  // -----------------------------------------------------------
  const MOBILE_BP = 720;
  function isMobile() { return window.innerWidth <= MOBILE_BP; }
  function haptic(ms = 10) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  function initMobile() {
    // Only run mobile setup if needed. Re-init on resize.
    setupBottomSheet();
    setupMobileZoom();
    setupMarkerLongPress();
    setupDetailSwipe();
    setupDetailHalfSheet();
    setupPullToRefresh();
    setupMapFabs();
    setupFilterCollapse();
    window.addEventListener("resize", () => {
      // Re-position zoom control when crossing the breakpoint
      setupMobileZoom();
    });
  }

  // Mobile filter collapse: inject [篩選 ▾] toggle inside .filters container.
  // body.filters-collapsed hides filter-row/facet-row/day-strip/walking-panel/budgetPanel/sort-row.
  // List remains visible because .list has flex:1 + min-height:0.
  function setupFilterCollapse() {
    if (!isMobile()) return;
    if (document.getElementById("filterToggleRow")) return; // idempotent
    const filters = document.querySelector(".filters");
    const search = document.getElementById("searchInput");
    if (!filters || !search) return;
    const row = document.createElement("div");
    row.id = "filterToggleRow";
    row.className = "filter-toggle-row";
    row.innerHTML = `<button type="button" id="filterToggleBtn" class="filter-toggle-btn" aria-expanded="false">
      <span class="label">篩選</span>
      <span class="badge" id="filterToggleBadge" hidden>0</span>
      <span class="chev">▾</span>
    </button>`;
    // Insert AFTER searchInput, still inside .filters container
    if (search.nextSibling) filters.insertBefore(row, search.nextSibling);
    else filters.appendChild(row);
    // Default collapsed
    document.body.classList.add("filters-collapsed");
    const btn = row.querySelector("#filterToggleBtn");
    btn.addEventListener("click", () => {
      const collapsed = document.body.classList.toggle("filters-collapsed");
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.querySelector(".chev").textContent = collapsed ? "▾" : "▴";
      haptic(8);
    });
    refreshFilterToggleBadge();
  }

  function refreshFilterToggleBadge() {
    const badge = document.getElementById("filterToggleBadge");
    if (!badge) return;
    let n = 0;
    if (categoryFilter && categoryFilter.value) n++;
    if (priceFilter && priceFilter.value) n++;
    const hf = document.getElementById("hoursFilter");
    if (hf && hf.value) n++;
    const bf = document.getElementById("bookmarkFilter");
    if (bf && bf.value) n++;
    const df = document.getElementById("dayFilter");
    if (df && df.value) n++;
    const sf = document.getElementById("sortFilter");
    if (sf && sf.value && sf.value !== "default") n++;
    if (state.walking && state.walking.enabled) n++;
    if (state.tagFacets && state.tagFacets.size > 0) n += state.tagFacets.size;
    if (state.tagTagsSelected && state.tagTagsSelected.size > 0) n += state.tagTagsSelected.size;
    if (n > 0) { badge.hidden = false; badge.textContent = String(n); }
    else       { badge.hidden = true; }
  }

  // ---- G1: Map FABs (mobile only) ----
  let _userLocMarker = null;
  let _userLocCircle = null;
  function setupMapFabs() {
    const fabLocate = $("fabLocate");
    const fabWalking = $("fabWalking");
    if (!fabLocate || !fabWalking) return;

    fabLocate.addEventListener("click", () => {
      haptic(15);
      if (!navigator.geolocation) {
        toast("瀏覽器唔支援定位");
        return;
      }
      fabLocate.disabled = true;
      fabLocate.textContent = "…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude: lat, longitude: lng, accuracy } = pos.coords;
          map.setView([lat, lng], 16);
          if (_userLocMarker) { try { map.removeLayer(_userLocMarker); } catch(e){} }
          if (_userLocCircle) { try { map.removeLayer(_userLocCircle); } catch(e){} }
          _userLocMarker = L.circleMarker([lat, lng], {
            radius: 7, color: "#1d6fb8", weight: 2, fillColor: "#3a9bff", fillOpacity: 0.9
          }).addTo(map);
          if (accuracy && accuracy < 500) {
            _userLocCircle = L.circle([lat, lng], {
              radius: accuracy, color: "#3a9bff", weight: 1, fillColor: "#3a9bff", fillOpacity: 0.1
            }).addTo(map);
          }
          fabLocate.classList.add("active");
          fabLocate.textContent = "📍";
          fabLocate.disabled = false;
          toast("已定位");
        },
        (err) => {
          fabLocate.textContent = "📍";
          fabLocate.disabled = false;
          toast("取位置失敗：" + (err.message || err.code));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });

    fabWalking.addEventListener("click", () => {
      haptic(15);
      const toggle = $("walkingToggle");
      if (!toggle) return;
      // Toggle the state
      const willEnable = !state.walking.enabled;
      toggle.checked = willEnable;
      toggle.dispatchEvent(new Event("change"));
      fabWalking.classList.toggle("active", willEnable);
      if (willEnable && state.walking.anchors.length === 0) {
        // Auto-add geo anchor for one-tap convenience
        if (typeof window.__addAnchor === "function") {
          window.__addAnchor("geo");
        } else {
          // fallback: try clicking the "+位置" button
          const btn = $("addAnchorGeo");
          if (btn) btn.click();
        }
        toast("步行圈已開、攞緊你位置");
      } else if (!willEnable) {
        toast("步行圈已關");
      } else {
        toast("步行圈已開");
      }
    });
  }

  function toast(msg, ms = 1800) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  // ---- Bottom sheet: 3-snap (peek / half / full) ----
  function setupBottomSheet() {
    const sheet = $("sidebar");
    const handle = $("sheetHandle");
    if (!sheet || !handle) return;
    let startY = 0, startTranslate = 0, dragging = false, currentSnap = "peek";

    // Continuously sync FAB position with sheet's actual top (handles drag mid-flight + transitionend)
    function updateFabFromSheet() {
      if (!isMobile()) return;
      const rect = sheet.getBoundingClientRect();
      const vh = window.innerHeight;
      // FAB sits 12px above sheet top edge
      const fabBottom = vh - rect.top + 12;
      document.documentElement.style.setProperty("--fab-bottom", `${fabBottom}px`);
      // Hide FAB when sheet is near top (< 140px from viewport top): map barely visible
      const tooHigh = rect.top < 140;
      document.body.classList.toggle("fab-hidden", tooHigh);
    }

    function snapTo(target) {
      sheet.classList.remove("snap-half", "snap-full", "dragging");
      // Mirror snap state on <body> for sticky-filter CSS & any external observers
      document.body.classList.remove("sheet-peek", "sheet-half", "sheet-full");
      if (target === "half") {
        sheet.classList.add("snap-half");
        document.body.classList.add("sheet-half");
      } else if (target === "full") {
        sheet.classList.add("snap-full");
        document.body.classList.add("sheet-full");
      } else {
        document.body.classList.add("sheet-peek");
      }
      currentSnap = target;
      sheet.style.top = ""; // clear inline so CSS class wins
      haptic(8);
      // Update FAB position now and after transition
      requestAnimationFrame(updateFabFromSheet);
    }

    function onStart(clientY) {
      if (!isMobile()) return;
      dragging = true;
      startY = clientY;
      // capture current rendered top (in px)
      startTranslate = sheet.getBoundingClientRect().top;
      sheet.classList.add("dragging");
    }
    function onMove(clientY) {
      if (!dragging) return;
      const dy = clientY - startY;
      const vh = window.innerHeight;
      const minTop = 44; // full-snap upper bound
      const maxTop = vh - 80; // never push beyond near-bottom
      const newTop = Math.max(minTop, Math.min(maxTop, startTranslate + dy));
      sheet.style.top = `${newTop}px`;
      updateFabFromSheet();
    }
    function onEnd(clientY) {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove("dragging");
      const dy = clientY - startY;
      const vh = window.innerHeight;
      // Decide snap by current position + drag delta direction
      const endY = sheet.getBoundingClientRect().top;
      const fullThreshold = 100;            // near top
      const halfThreshold = vh * 0.55;
      let target;
      if (endY < fullThreshold) target = "full";
      else if (endY < halfThreshold) target = "half";
      else target = "peek";
      snapTo(target);
    }

    // Touch events
    handle.addEventListener("touchstart", (e) => { onStart(e.touches[0].clientY); }, { passive: true });
    handle.addEventListener("touchmove", (e) => { onMove(e.touches[0].clientY); }, { passive: true });
    handle.addEventListener("touchend", (e) => {
      const y = e.changedTouches[0]?.clientY || 0;
      onEnd(y);
    });
    // Click handle to toggle peek <-> half
    handle.addEventListener("click", () => {
      if (!isMobile()) return;
      if (currentSnap === "peek") snapTo("half");
      else if (currentSnap === "half") snapTo("full");
      else snapTo("peek");
    });

    // Auto-snap to half when user focuses on filter/search
    const expanders = ["searchInput", "categoryFilter", "priceFilter", "openFilter", "bookmarkFilter", "dayFilter", "sortBy"];
    expanders.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("focus", () => {
        if (isMobile() && currentSnap === "peek") snapTo("half");
      });
    });

    window.__sheetSnapTo = snapTo;
    // Initialize body sheet-peek class + first FAB sync
    document.body.classList.add("sheet-peek");
    // Initial sync after layout settles
    requestAnimationFrame(() => requestAnimationFrame(updateFabFromSheet));
    // Re-sync on sheet CSS transition end (snap animation) + on resize
    sheet.addEventListener("transitionend", (e) => {
      if (e.propertyName === "top") updateFabFromSheet();
    });
    window.addEventListener("resize", updateFabFromSheet);
    window.addEventListener("orientationchange", () => setTimeout(updateFabFromSheet, 100));
  }

  // ---- Move Leaflet zoom to bottom-right on mobile ----
  function setupMobileZoom() {
    if (!map || !map.zoomControl) return;
    try {
      if (isMobile()) {
        if (map._zoomControlPosition !== "bottomright") {
          map.zoomControl.setPosition("bottomright");
          map._zoomControlPosition = "bottomright";
        }
      } else {
        if (map._zoomControlPosition !== "topleft") {
          map.zoomControl.setPosition("topleft");
          map._zoomControlPosition = "topleft";
        }
      }
    } catch (e) { /* noop */ }
  }

  // ---- Long-press marker (500ms) opens detail ----
  function setupMarkerLongPress() {
    // Markers are rebuilt in renderMarkers. We piggyback on the global map click
    // and use Leaflet's contextmenu (which on mobile = long-press).
    if (!map) return;
    map.on("contextmenu", (e) => {
      // Prevent default context menu on long-press background
      e.originalEvent && e.originalEvent.preventDefault && e.originalEvent.preventDefault();
    });
  }

  // ---- Swipe in detail panel: left/right → prev/next place ----
  function setupDetailSwipe() {
    const panel = $("detailPanel");
    if (!panel) return;
    let sx = 0, sy = 0, st = 0;
    // attach to detail body so left/right swipe doesn't conflict with handle vertical drag
    const swipeTarget = document.getElementById("detailBody") || panel;
    swipeTarget.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now();
    }, { passive: true });
    swipeTarget.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      const dt = Date.now() - st;
      if (dt > 500) return;
      // Horizontal swipe ≥ 60px, dominantly horizontal
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
      const visible = state.filtered || [];
      if (visible.length === 0) return;
      const idx = visible.findIndex(p => p.id === state.selectedPlaceId);
      if (idx < 0) return;
      let next;
      if (dx < 0) next = visible[(idx + 1) % visible.length];
      else        next = visible[(idx - 1 + visible.length) % visible.length];
      if (next) {
        haptic(12);
        openPlaceDetail(next.id);
      }
    });
  }

  // G3b: handle drag for detail half-sheet (snap between half / expanded / close)
  function setupDetailHalfSheet() {
    const panel = $("detailPanel");
    const handle = document.getElementById("detailHandle");
    if (!panel || !handle) return;
    let startY = 0, dragging = false, dy = 0;

    function onStart(clientY) {
      if (!isMobile()) return;
      dragging = true;
      startY = clientY;
      dy = 0;
      panel.style.transition = "none";
    }
    function onMove(clientY) {
      if (!dragging) return;
      dy = clientY - startY;
      // Allow follow-finger only downward when in half state, upward only if not expanded
      const isExpanded = panel.classList.contains("expanded");
      const base = isExpanded ? 0 : 0;
      let translate = Math.max(-200, dy);  // clamp upward drag
      panel.style.transform = `translateY(${translate}px)`;
    }
    function onEnd(clientY) {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      panel.style.transform = "";
      const isExpanded = panel.classList.contains("expanded");
      // Decide action based on dy magnitude
      if (dy > 120) {
        // big downward swipe → close
        if (isExpanded) {
          panel.classList.remove("expanded"); // first go back to half
          haptic(8);
        } else {
          panel.classList.remove("open");
          document.querySelectorAll(".emoji-marker.selected").forEach(el => el.classList.remove("selected"));
          haptic(8);
        }
      } else if (dy < -60 && !isExpanded) {
        // swipe up → expand to full
        panel.classList.add("expanded");
        haptic(8);
      } else if (dy > 40 && isExpanded) {
        // small down from expanded → back to half
        panel.classList.remove("expanded");
        haptic(8);
      }
      // else: no change
    }

    handle.addEventListener("touchstart", (e) => onStart(e.touches[0].clientY), { passive: true });
    handle.addEventListener("touchmove",  (e) => onMove(e.touches[0].clientY),  { passive: true });
    handle.addEventListener("touchend",   (e) => onEnd(e.changedTouches[0]?.clientY || 0));
    // Tap handle to toggle half <-> expanded
    handle.addEventListener("click", () => {
      if (!isMobile()) return;
      if (panel.classList.contains("expanded")) panel.classList.remove("expanded");
      else panel.classList.add("expanded");
      haptic(6);
    });
  }

  // ---- Pull-to-refresh on list (only when at top) ----
  function setupPullToRefresh() {
    const list = document.getElementById("placeList") || document.querySelector(".list");
    if (!list) return;
    let sy = 0, dragging = false;
    let indicator = null;

    function ensureIndicator() {
      if (indicator) return indicator;
      indicator = document.createElement("div");
      indicator.id = "ptrIndicator";
      indicator.style.cssText = "position:absolute;left:50%;transform:translateX(-50%);top:0;padding:6px 12px;background:var(--accent-soft);color:var(--accent);border-radius:0 0 8px 8px;font-size:12px;pointer-events:none;opacity:0;transition:opacity .2s;z-index:1000;";
      indicator.textContent = "↓ 下拉重新載入";
      list.parentElement && list.parentElement.style && (list.parentElement.style.position = "relative");
      list.parentElement && list.parentElement.appendChild(indicator);
      return indicator;
    }

    list.addEventListener("touchstart", (e) => {
      if (!isMobile()) return;
      if (list.scrollTop > 0) return;
      sy = e.touches[0].clientY;
      dragging = true;
    }, { passive: true });
    list.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const dy = e.touches[0].clientY - sy;
      if (dy > 10) {
        const ind = ensureIndicator();
        ind.style.opacity = Math.min(1, dy / 80);
        if (dy > 80) ind.textContent = "↑ 釋放重載";
        else ind.textContent = "↓ 下拉重新載入";
      }
    }, { passive: true });
    list.addEventListener("touchend", async (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = (e.changedTouches[0]?.clientY || sy) - sy;
      if (indicator) {
        indicator.style.opacity = 0;
        indicator.textContent = "↓ 下拉重新載入";
      }
      if (dy > 80) {
        haptic(20);
        try {
          showToast && showToast("重新載入中…");
          await loadPlacesForCurrentArea();
          applyFilters && applyFilters();
          showToast && showToast("已更新");
        } catch (err) {
          showToast && showToast("重載失敗");
        }
      }
    });
  }

  // -----------------------------------------------------------
  // PWA / offline
  // -----------------------------------------------------------
  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Nuke option: ?nuke=1 unregisters SW + clears caches then reloads clean
    try {
      const usp = new URLSearchParams(location.search);
      if (usp.get("nuke") === "1") {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        usp.delete("nuke");
        const clean = location.pathname + (usp.toString() ? "?" + usp.toString() : "");
        location.replace(clean);
        return;
      }
    } catch (e) { console.warn("nuke failed", e); }
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      // Auto-reload once when a new SW takes control (avoids stuck old shell)
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
      // Listen for updates: when a new worker installs, show a toast
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            showToast("有新版本，刷新以更新");
          }
        });
      });
    } catch (e) {
      console.warn("sw register error", e);
    }
  }

  function setupOnlineStatus() {
    const el = document.createElement("div");
    el.id = "offlineBadge";
    el.style.cssText = "position:fixed;top:8px;right:8px;background:#d84315;color:#fff;padding:4px 8px;border-radius:4px;font-size:11px;z-index:2500;display:none;pointer-events:none;";
    el.textContent = "離線模式";
    document.body.appendChild(el);
    const update = () => { el.style.display = navigator.onLine ? "none" : "block"; };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  // -----------------------------------------------------------
  // URL state (export/share)
  // -----------------------------------------------------------
  function restoreStateFromURL() {
    const params = new URLSearchParams(location.search);
    const area = params.get("area");
    if (area && state.tripAreas.find(t => t.slug === area)) {
      state.currentTripAreaSlug = area;
      tripAreaSelect.value = area;
    }
    const q = params.get("q");      if (q) searchInput.value = q;
    // Merged categoryFilter accepts "cg:<key>", "cat:<sub>" or legacy bare sub-category name.
    const cat = params.get("cat");
    if (cat) {
      let mapped = cat;
      if (!cat.startsWith("cg:") && !cat.startsWith("cat:")) {
        // Legacy bare value → cat:<sub>
        mapped = `cat:${cat}`;
      }
      categoryFilter.value = mapped;
      // Also sync hidden cuisineGroupFilter for parent group (for applyFilters legacy fallback)
      const cgFilterEl = $("cuisineGroupFilter");
      if (mapped.startsWith("cat:") && cgFilterEl) {
        const sub = mapped.slice(4);
        const parent = Object.entries(CUISINE_GROUPS).find(([_, g]) => g.subs.includes(sub));
        cgFilterEl.value = parent ? parent[0] : "";
      } else if (mapped.startsWith("cg:") && cgFilterEl) {
        cgFilterEl.value = mapped.slice(3);
      }
    }
    // Legacy ?cg=<key> still supported for older shared links
    const cgUrl = params.get("cg");
    if (cgUrl) {
      const cgFilterEl = $("cuisineGroupFilter");
      if (cgFilterEl) cgFilterEl.value = cgUrl;
      if (!cat) categoryFilter.value = `cg:${cgUrl}`;
    }
    const price = params.get("price"); if (price) priceFilter.value = price;
    const sort = params.get("sort");   if (sort) { $("sortBy").value = sort; state.sortBy = sort; }
    const open = params.get("open");   if (open) { $("openFilter").value = open; state.openFilter = open; }
    const bm = params.get("bm");       if (bm) { $("bookmarkFilter").value = bm; state.bookmarkFilter = bm; }
    const day = params.get("day");     if (day) { $("dayFilter").value = day; state.dayFilter = day; }
    const facets = params.get("facets");
    if (facets) {
      state.tagFacets = new Set(facets.split(",").filter(Boolean));
      // chip active state restored after DOM render
      setTimeout(syncFacetChipsUI, 0);
    }
    // 步行圈 state
    const walk = params.get("walk");
    if (walk) {
      const mins = parseInt(walk, 10);
      if (!isNaN(mins) && WALK_MINUTES.includes(mins)) {
        state.walking.minutes = mins;
        document.querySelectorAll(".chip-row .chip").forEach(b => b.classList.toggle("active", parseInt(b.dataset.min,10) === mins));
      }
    }
  }

  function buildShareURL() {
    const params = new URLSearchParams();
    if (state.currentTripAreaSlug) params.set("area", state.currentTripAreaSlug);
    if (searchInput.value.trim()) params.set("q", searchInput.value.trim());
    if (categoryFilter.value)     params.set("cat", categoryFilter.value);
    if (priceFilter.value)        params.set("price", priceFilter.value);
    if (state.sortBy && state.sortBy !== "default") params.set("sort", state.sortBy);
    if (state.openFilter)         params.set("open", state.openFilter);
    if (state.bookmarkFilter)     params.set("bm", state.bookmarkFilter);
    if (state.dayFilter)          params.set("day", state.dayFilter);
    if (state.tagFacets && state.tagFacets.size > 0) {
      params.set("facets", Array.from(state.tagFacets).join(","));
    }
    if (state.walking.enabled)    params.set("walk", state.walking.minutes);
    const url = `${location.origin}${location.pathname}?${params.toString()}`;
    return url;
  }

  function showToast(msg, duration = 2200) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("show"), duration);
  }

  function populateCategorySelects() {
    // Merged cuisine + category select with 2-level <optgroup>.
    // Value scheme:
    //   ""            = all
    //   "cg:<key>"    = whole cuisine group (matches places.cuisine_group)
    //   "cat:<sub>"   = exact sub-category (matches places.category)
    if (categoryFilter && categoryFilter.options.length <= 1) {
      const prevVal = categoryFilter.value;
      categoryFilter.innerHTML = '<option value="" data-i18n="filter.all_category">所有菜系／分類</option>';
      for (const [key, g] of Object.entries(CUISINE_GROUPS)) {
        const og = document.createElement("optgroup");
        og.label = `${g.emoji} ${g.label}`;
        // Group-level option: 「全部〇〇」 (match cuisine_group)
        const allOpt = new Option(`全部${g.label}`, `cg:${key}`);
        og.appendChild(allOpt);
        for (const sub of g.subs) {
          og.appendChild(new Option(`· ${sub}`, `cat:${sub}`));
        }
        categoryFilter.appendChild(og);
      }
      if (prevVal) categoryFilter.value = prevVal;
    }
    // Hidden legacy cuisineGroupFilter — keep populated for URL compat (saveStateToURL reads it indirectly via state.cuisineGroup? No: applyFilters reads .value directly, so we sync below.)
    const cgFilter = $("cuisineGroupFilter");
    if (cgFilter && cgFilter.options.length <= 1) {
      for (const [key, g] of Object.entries(CUISINE_GROUPS)) {
        cgFilter.appendChild(new Option(`${g.emoji} ${g.label}`, key));
      }
    }
    // Modal cuisine_group + sub-category pickers (unchanged 2-step UX in modal)
    const pmCG = $("pmCuisineGroup");
    if (pmCG && pmCG.options.length === 0) {
      pmCG.appendChild(new Option("—", ""));
      for (const [key, g] of Object.entries(CUISINE_GROUPS)) {
        pmCG.appendChild(new Option(`${g.emoji} ${g.label}`, key));
      }
      pmCG.addEventListener("change", () => {
        repopulateCategoryOptions(pmCG.value);
      });
    }
    repopulateCategoryOptions(""); // initial modal sub-list
  }

  function repopulateCategoryOptions(groupKey) {
    // Only repopulates the modal "pmCategory" sub-category picker now.
    // The main filter (categoryFilter) is a single static merged select.
    const subs = groupKey && CUISINE_GROUPS[groupKey]
      ? CUISINE_GROUPS[groupKey].subs
      : CATEGORIES;
    const pmCat = $("pmCategory");
    if (pmCat) {
      const cur2 = pmCat.value;
      pmCat.innerHTML = "";
      pmCat.appendChild(new Option("—", ""));
      for (const c of subs) pmCat.appendChild(new Option(c, c));
      if (subs.includes(cur2)) pmCat.value = cur2;
    }
  }

  function bindEvents() {
    tripAreaSelect.addEventListener("change", async () => {
      state.currentTripAreaSlug = tripAreaSelect.value;
      // Switch trip area → swap anchors to new area's persisted set
      state.walking.anchors = [];
      hideRoutePanel();
      restoreAnchorsForCurrentArea();
      renderAnchorList();
      updateWalkingUI();
      // Bug fix: close any open detail panel since it shows a place from the previous area
      const detailPanel = $("detailPanel");
      if (detailPanel) {
        detailPanel.classList.remove("open");
        detailPanel.classList.remove("expanded");
        document.querySelectorAll(".emoji-marker.selected").forEach(el => el.classList.remove("selected"));
      }
      state.selectedPlaceId = null;
      await loadPlacesForCurrentArea();
      if (state.showStations) renderStationMarkers();
    });
    searchInput.addEventListener("input", applyFilters);
    // Merged cuisine+category filter: parse value prefix and sync hidden legacy cuisineGroupFilter
    categoryFilter.addEventListener("change", () => {
      const v = categoryFilter.value;
      const cgFilterEl = $("cuisineGroupFilter");
      if (!v) {
        if (cgFilterEl) cgFilterEl.value = "";
      } else if (v.startsWith("cg:")) {
        if (cgFilterEl) cgFilterEl.value = v.slice(3);
      } else if (v.startsWith("cat:")) {
        // Sub-category implies its parent group too (for URL/state consistency)
        const sub = v.slice(4);
        const parent = Object.entries(CUISINE_GROUPS).find(([_, g]) => g.subs.includes(sub));
        if (cgFilterEl) cgFilterEl.value = parent ? parent[0] : "";
      }
      applyFilters();
    });
    priceFilter.addEventListener("change", applyFilters);

    $("openFilter").addEventListener("change", (e) => {
      state.openFilter = e.target.value;
      applyFilters();
    });
    $("bookmarkFilter").addEventListener("change", (e) => {
      state.bookmarkFilter = e.target.value;
      applyFilters();
    });
    $("dayFilter").addEventListener("change", (e) => {
      state.dayFilter = e.target.value;
      applyFilters();
      renderDayStrip();  // I3: keep pills in sync with dropdown
    });
    // I2: Facet tag chips
    bindFacetChips();
    $("sortBy").addEventListener("change", (e) => {
      state.sortBy = e.target.value;
      applyFilters();
    });

    // 「我而家」: 一鍵啟用步行圈 + geo anchor
    $("hereBtn").addEventListener("click", () => {
      if (!state.walking.enabled) {
        state.walking.enabled = true;
        $("walkingToggle").checked = true;
        $("walkingBody").classList.add("open");
      }
      // 清空現有 anchors，只剩一個 geo
      state.walking.anchors = state.walking.anchors.filter(a => a.mode !== "geo");
      renderAnchorList();
      addAnchor("geo");
    });

    // Share URL
    $("shareBtn").addEventListener("click", async () => {
      const url = buildShareURL();
      try {
        await navigator.clipboard.writeText(url);
        showToast("連結已複製");
      } catch {
        showToast("複製失敗，請手動複製");
        prompt("複製連結：", url);
      }
    });

    // Bookmark buttons in detail panel
    document.querySelectorAll(".bookmark-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!state.selectedPlaceId) return;
        const status = btn.dataset.status;
        const current = getBookmark(state.selectedPlaceId);
        // toggle：同一個再按就移除
        setBookmark(state.selectedPlaceId, current === status ? null : status);
        renderBookmarkButtons();
        applyFilters(); // 更新 list / marker / icon border
      });
    });

    // -------- 步行圈 events --------
    $("walkingToggle").addEventListener("change", (e) => {
      state.walking.enabled = e.target.checked;
      $("walkingBody").classList.toggle("open", state.walking.enabled);
      if (state.walking.enabled && state.walking.anchors.length === 0) {
        // 預設加一個「地圖中心」anchor
        addAnchor("map");
        return; // addAnchor 內部會 update + applyFilters
      }
      renderAnchorList();
      updateWalkingUI();
      applyFilters();
    });

    document.querySelectorAll(".chip-row .chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const m = parseInt(btn.dataset.min, 10);
        state.walking.minutes = m;
        document.querySelectorAll(".chip-row .chip").forEach(b => b.classList.toggle("active", b === btn));
        updateWalkingUI();
        if (state.walking.enabled) applyFilters();
      });
    });

    $("addAnchorMap").addEventListener("click", () => addAnchor("map"));
    $("addAnchorGeo").addEventListener("click", () => addAnchor("geo"));
    $("addAnchorPlace").addEventListener("click", () => addAnchor("place"));
    $("addAnchorStation").addEventListener("click", () => addAnchor("station"));
    $("clearAnchorsBtn").addEventListener("click", () => {
      if (state.walking.anchors.length === 0) return;
      if (confirm(`清除 ${state.walking.anchors.length} 個 anchor？`)) clearAllAnchors();
    });
    $("planRouteBtn").addEventListener("click", () => planWalkingRoute());

    // 車站 search autocomplete
    $("stationSearchInput").addEventListener("input", handleStationSearchInput);
    $("stationSearchInput").addEventListener("focus", handleStationSearchInput);
    $("stationSearchInput").addEventListener("blur", () => {
      // delay 為 result click 趕到
      setTimeout(() => { $("stationSearchResults").style.display = "none"; }, 200);
    });

    $("showStationsToggle").addEventListener("change", (e) => {
      state.showStations = e.target.checked;
      renderStationMarkers();
    });

    // J1: heatmap toggle (desktop checkbox + mobile FAB)
    const heatToggleEl = document.getElementById("heatToggle");
    if (heatToggleEl) {
      heatToggleEl.addEventListener("change", (e) => setHeatEnabled(e.target.checked));
    }
    const fabHeatEl = document.getElementById("fabHeat");
    if (fabHeatEl) {
      fabHeatEl.addEventListener("click", () => setHeatEnabled(!state.heatEnabled));
    }

    // 地圖中心模式 anchor：拖動地圖要重新計
    map.on("moveend", () => {
      if (!state.walking.enabled) return;
      const mapAnchors = state.walking.anchors.filter(a => a.mode === "map");
      if (mapAnchors.length === 0) return;
      const c = map.getCenter();
      for (const a of mapAnchors) { a.lat = c.lat; a.lng = c.lng; }
      renderAnchorList();
      updateWalkingUI();
      saveAnchorsToStorage();
      applyFilters();
    });

    inviteBtn.addEventListener("click", () => openModal("inviteModal"));
    $("inviteCancel").addEventListener("click", () => closeModal("inviteModal"));
    $("inviteConfirm").addEventListener("click", handleInviteConfirm);

    addPlaceBtn.addEventListener("click", () => {
      if (state.role === "guest") return;
      // pre-fill 用地圖中心
      const c = map.getCenter();
      $("pmLat").value = c.lat.toFixed(6);
      $("pmLng").value = c.lng.toFixed(6);
      openModal("placeModal");
    });
    $("pmCancel").addEventListener("click", () => closeModal("placeModal"));
    $("pmConfirm").addEventListener("click", handleAddPlace);

    function closeDetailPanel() {
      const panel = $("detailPanel");
      panel.classList.remove("open");
      panel.classList.remove("expanded");
      // G3e: clear marker selection
      document.querySelectorAll(".emoji-marker.selected").forEach(el => el.classList.remove("selected"));
    }
    $("detailClose").addEventListener("click", closeDetailPanel);
    const detailBackBtn = $("detailBack");
    if (detailBackBtn) {
      detailBackBtn.addEventListener("click", () => {
        closeDetailPanel();
        // K1-fix: after back, restore main sheet to half-snap so list is visible
        if (isMobile()) {
          // Use central snapTo so body class stays in sync (FAB visibility, etc.)
          if (typeof window.__sheetSnapTo === "function") {
            window.__sheetSnapTo("half");
          }
        }
      });
    }
    $("addReviewBtn").addEventListener("click", () => {
      if (state.role === "guest" || !state.selectedPlaceId) return;
      const place = state.places.find(p => p.id === state.selectedPlaceId);
      $("rmPlaceName").textContent = place ? place.name : "";
      openModal("reviewModal");
    });
    $("rmCancel").addEventListener("click", () => closeModal("reviewModal"));
    $("rmConfirm").addEventListener("click", handleAddReview);

    // Photo upload listeners
    $("placePhotoBtn").addEventListener("click", () => $("placePhotoInput").click());
    $("placePhotoInput").addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) await handlePlacePhotoUpload(f);
    });
    $("rmPhotoInput").addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0];
      const statusEl = $("rmPhotoStatus");
      const previewEl = $("rmPhotoPreview");
      state.pendingReviewPhoto = null;
      previewEl.innerHTML = "";
      if (!f) { statusEl.textContent = ""; return; }
      statusEl.textContent = "處理中…";
      const blob = await resizeImage(f);
      if (!blob) { statusEl.textContent = "格式不支援"; return; }
      if (blob.size > 2 * 1024 * 1024) {
        statusEl.textContent = `太大 ${(blob.size/1024/1024).toFixed(2)}MB`;
        return;
      }
      state.pendingReviewPhoto = blob;
      statusEl.textContent = `已縮小 → ${(blob.size/1024).toFixed(0)}KB`;
      const url = URL.createObjectURL(blob);
      previewEl.innerHTML = `<img src="${url}" style="max-width:100%;max-height:150px;border-radius:4px;" />`;
    });
    $("photoLightbox").addEventListener("click", () => $("photoLightbox").classList.remove("open"));

    // Suggestion flow
    $("addSuggestionBtn").addEventListener("click", () => {
      if (state.role === "guest" || !state.selectedPlaceId) return;
      const place = state.places.find(p => p.id === state.selectedPlaceId);
      $("sgPlaceName").textContent = place ? place.name : "";
      $("sgType").value = "correction";
      $("sgRating").value = "";
      $("sgComment").value = "";
      $("sgErr").textContent = "";
      updateSuggestionRatingHint();
      openModal("suggestionModal");
    });
    $("sgType").addEventListener("change", updateSuggestionRatingHint);
    $("sgCancel").addEventListener("click", () => closeModal("suggestionModal"));
    $("sgConfirm").addEventListener("click", handleSubmitSuggestion);
  }

  function updateSuggestionRatingHint() {
    const t = $("sgType").value;
    const hint = $("sgRatingHint");
    if (t === "recommend" || t === "warning") {
      hint.textContent = "必填";
      hint.style.color = "var(--accent)";
    } else {
      hint.textContent = "可空（資料更正可不填）";
      hint.style.color = "var(--muted)";
    }
  }

  // -----------------------------------------------------------
  // Trip areas
  // -----------------------------------------------------------
  async function loadTripAreas() {
    const { data, error } = await sb
      .from("trip_areas")
      .select("*")
      .order("sort_order");
    if (error) { console.error(error); return; }
    state.tripAreas = data || [];

    tripAreaSelect.innerHTML = "";
    for (const ta of state.tripAreas) {
      const label = ta.status === "planned" ? `${ta.name_zh}（規劃中）` : ta.name_zh;
      tripAreaSelect.appendChild(new Option(label, ta.slug));
    }
    if (state.tripAreas.find(t => t.slug === state.currentTripAreaSlug)) {
      tripAreaSelect.value = state.currentTripAreaSlug;
    } else if (state.tripAreas.length > 0) {
      state.currentTripAreaSlug = state.tripAreas[0].slug;
      tripAreaSelect.value = state.currentTripAreaSlug;
    }
    centerMapOnCurrentArea();
  }

  function centerMapOnCurrentArea() {
    const ta = state.tripAreas.find(t => t.slug === state.currentTripAreaSlug);
    if (ta && ta.center_lat && ta.center_lng) {
      map.setView([ta.center_lat, ta.center_lng], ta.default_zoom || 13);
    }
  }

  // -----------------------------------------------------------
  // Places
  // -----------------------------------------------------------
  function showMapLoading(show) {
    const el = document.getElementById("mapLoading");
    if (!el) return;
    el.style.display = show ? "flex" : "none";
    el.setAttribute("aria-hidden", show ? "false" : "true");
  }

  async function loadPlacesForCurrentArea() {
    renderListSkeleton(8);
    showMapLoading(true);
    centerMapOnCurrentArea();
    const ta = state.tripAreas.find(t => t.slug === state.currentTripAreaSlug);
    if (!ta) { state.places = []; renderDayStrip(); applyFilters(); showMapLoading(false); return; }

    try {
      const { data, error } = await sb
        .from("places")
        .select("*")
        .eq("trip_area_id", ta.id)
        .eq("is_archived", false)
        .order("created_at", { ascending: false })
        .limit(2000);  // Perf-D: bump from Supabase default 1000 to support 400+/area
      if (error) { console.error(error); return; }
      state.places = data || [];
      // I3: Refresh day strip on every area data load
      renderDayStrip();
      // I2-extra: rebuild popular tag chips for this area (clear stale selections from previous area)
      state.tagTagsSelected = new Set();
      renderTagFacetChips();
      applyFilters();
    } finally {
      showMapLoading(false);
    }
  }

  // I2-extra: build chips from the top 8 most-common user tags in current area's places.
  // Selected tags filter places with AND semantics (place must contain all selected tags).
  function renderTagFacetChips() {
    const wrap = document.getElementById("tagFacetChips");
    if (!wrap) return;
    const counts = new Map();
    for (const p of (state.places || [])) {
      const tags = p.tags || [];
      for (const t of tags) {
        if (!t) continue;
        const k = String(t).trim();
        if (!k) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    // sort by count desc, then alpha; take top 8
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);
    wrap.innerHTML = "";
    if (top.length === 0) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    for (const [tag, count] of top) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "facet-chip tag-chip";
      btn.dataset.tag = tag;
      btn.textContent = `${tag} (${count})`;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        if (state.tagTagsSelected.has(tag)) {
          state.tagTagsSelected.delete(tag);
          btn.classList.remove("active");
          btn.setAttribute("aria-pressed", "false");
        } else {
          state.tagTagsSelected.add(tag);
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
        }
        applyFilters();
      });
      wrap.appendChild(btn);
    }
  }

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    // Merged select value: "" | "cg:<key>" | "cat:<sub>"
    const rawCat = categoryFilter.value;
    let catFilter = "", cgFromMerged = "";
    if (rawCat.startsWith("cat:")) catFilter = rawCat.slice(4);
    else if (rawCat.startsWith("cg:")) cgFromMerged = rawCat.slice(3);
    const price = priceFilter.value;

    // 步行圈：AND filter、取 max distance 作為「最差頂 anchor」
    const w = state.walking;
    const validAnchors = w.enabled
      ? w.anchors.filter(a => a.lat != null && a.lng != null)
      : [];
    const radiusM = validAnchors.length > 0 ? w.minutes * WALK_METRES_PER_MIN : null;

    // Prefer merged-select group; fall back to legacy hidden cuisineGroupFilter (for URL restore)
    const cgVal = cgFromMerged || (($("cuisineGroupFilter") && $("cuisineGroupFilter").value) || "");
    state.filtered = state.places.filter(p => {
      if (cgVal && p.cuisine_group !== cgVal) return false;
      if (catFilter && p.category !== catFilter) return false;
      if (price && p.price_level !== price) return false;
      if (q) {
        const hay = [
          p.name, p.note, p.region, p.address,
          ...(p.tags || [])
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (radiusM != null) {
        if (p.lat == null || p.lng == null) return false;
        // 所有 anchor 都要 within radius（AND）
        let maxD = 0;
        for (const a of validAnchors) {
          const d = haversine(a.lat, a.lng, p.lat, p.lng);
          if (d > radiusM) return false;
          if (d > maxD) maxD = d;
        }
        p._distance_m = maxD;       // 最遠 anchor 距離 = 「瓶頸距離」
      } else {
        p._distance_m = null;
      }
      return true;
    });

    // 營業時間 filter
    if (state.openFilter) {
      state.filtered = state.filtered.filter(p => openMatches(p, state.openFilter));
    }
    // Bookmark filter
    if (state.bookmarkFilter) {
      state.filtered = state.filtered.filter(p => {
        const b = getBookmark(p.id);
        if (state.bookmarkFilter === "none") return !b;
        return b === state.bookmarkFilter;
      });
    }
    // E2: Day filter
    if (state.dayFilter) {
      if (state.dayFilter === "none") {
        state.filtered = state.filtered.filter(p => p.day_tag == null);
      } else {
        const dn = parseInt(state.dayFilter, 10);
        state.filtered = state.filtered.filter(p => p.day_tag === dn);
      }
    }
    // I3: Day strip refresh on every filter pass (cheap; reads counts only)
    // Note: counts on strip reflect entire state.places, NOT filtered — they
    // show the trip's total day distribution as a navigation aid.
    // I2: Facet tags filter (OR semantics — match ANY selected facet)
    if (state.tagFacets && state.tagFacets.size > 0) {
      state.filtered = state.filtered.filter(p => {
        const tags = p.tags || [];
        for (const facet of state.tagFacets) {
          if (matchFacet(p, tags, facet)) return true;
        }
        return false;
      });
    }
    // I2-extra: user tag filter (AND semantics — must contain ALL selected tags)
    if (state.tagTagsSelected && state.tagTagsSelected.size > 0) {
      state.filtered = state.filtered.filter(p => {
        const tags = (p.tags || []).map(String);
        for (const need of state.tagTagsSelected) {
          if (!tags.includes(need)) return false;
        }
        return true;
      });
    }

    // Sorting
    applySort(radiusM != null);

    renderList();
    renderMarkers();
    renderWalkingCircles();
    renderHeatLayer();
    renderBudgetPanel();
    refreshFilterToggleBadge();
  }

  function applySort(hasDistance) {
    const s = state.sortBy;
    if (s === "default") {
      if (hasDistance) state.filtered.sort((a, b) => (a._distance_m ?? Infinity) - (b._distance_m ?? Infinity));
      // else: 保留 server order (created_at desc)
      return;
    }
    if (s === "distance") {
      state.filtered.sort((a, b) => (a._distance_m ?? Infinity) - (b._distance_m ?? Infinity));
    } else if (s === "rating") {
      const r = (p) => Math.max(p.google_rating || 0, p.tabelog_rating || 0);
      state.filtered.sort((a, b) => r(b) - r(a));
    } else if (s === "recent") {
      state.filtered.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    } else if (s === "name") {
      state.filtered.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-Hant"));
    } else if (s === "random") {
      // Fisher-Yates
      for (let i = state.filtered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.filtered[i], state.filtered[j]] = [state.filtered[j], state.filtered[i]];
      }
    }
  }

  // -----------------------------------------------------------
  // 營業時間判斷
  // -----------------------------------------------------------
  // closed_days: array of weekday number (0=Sun..6=Sat)
  // opening_hours: free-text string, try parse "HH:MM-HH:MM" segments
  function parseHourSegments(text) {
    if (!text) return null;
    if (/24小時|24h|24hr|二十四小時/i.test(text)) return [[0, 1440]];
    // 提取所有 HH:MM-HH:MM 段
    const segs = [];
    const re = /(\d{1,2}):(\d{2})\s*[-~–到至]\s*(\d{1,2}):(\d{2})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = parseInt(m[1],10)*60 + parseInt(m[2],10);
      let end = parseInt(m[3],10)*60 + parseInt(m[4],10);
      if (end <= start) end += 1440; // 跨日（如 18:00-02:00）
      segs.push([start, end]);
    }
    return segs.length > 0 ? segs : null;
  }

  function isOpenAt(place, date) {
    const wd = date.getDay(); // 0=Sun
    const closed = place.closed_days || [];
    if (closed.includes(wd)) return false;
    const segs = parseHourSegments(place.opening_hours);
    if (segs == null) return null; // unknown
    const mins = date.getHours()*60 + date.getMinutes();
    for (const [s, e] of segs) {
      if (mins >= s && mins < e) return true;
      // 跨日尾段：尋日嘅後段都可能覆蓋而家。簡化：fallback 用 mins+1440 對比
      if ((mins + 1440) >= s && (mins + 1440) < e) return true;
    }
    return false;
  }

  function isOpenOnWeekday(place, wd) {
    const closed = place.closed_days || [];
    if (closed.includes(wd)) return false;
    const segs = parseHourSegments(place.opening_hours);
    if (segs == null) return null; // unknown
    return segs.length > 0;
  }

  function openMatches(p, filter) {
    // 「景點 / 住宿 / 麵包」呢類冇 opening_hours data 嘅，filter 寬鬆：unknown 都顯示
    if (filter === "now") {
      const r = isOpenAt(p, new Date());
      return r !== false; // true or null（未知）都過
    }
    if (filter === "today") {
      const r = isOpenOnWeekday(p, new Date().getDay());
      return r !== false;
    }
    if (filter.startsWith("weekday-")) {
      const wd = parseInt(filter.split("-")[1], 10);
      const r = isOpenOnWeekday(p, wd);
      return r !== false;
    }
    return true;
  }

  // H3: List ↔ Map bidirectional sync helpers
  function highlightMarker(placeId, on) {
    const m = state.markers.get(placeId);
    if (m && m._icon) m._icon.classList.toggle("list-hover", !!on);
  }
  function highlightListItem(placeId, on) {
    const el = placeListEl && placeListEl.querySelector(`.place-item[data-place-id="${placeId}"]`);
    if (el) el.classList.toggle("marker-hover", !!on);
  }
  function scrollListItemIntoView(placeId) {
    let el = placeListEl && placeListEl.querySelector(`.place-item[data-place-id="${placeId}"]`);
    // Perf-B: item may not be rendered yet under chunked virtualization —
    // force-render up to and including the target item.
    if (!el && Array.isArray(state.filtered)) {
      const idx = state.filtered.findIndex(p => p.id === placeId);
      if (idx >= 0) _ensureListRendered(idx);
      el = placeListEl.querySelector(`.place-item[data-place-id="${placeId}"]`);
    }
    if (el && typeof el.scrollIntoView === "function") {
      try { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) { el.scrollIntoView(); }
    }
  }

  // Perf-B: force-render list items up to targetIdx (inclusive), used by
  // scrollListItemIntoView when user clicks a marker whose list row is still virtualized.
  function _ensureListRendered(targetIdx) {
    if (!placeListEl || !Array.isArray(state.filtered)) return;
    const sentinel = placeListEl.querySelector(".list-sentinel");
    if (!sentinel) return; // already fully rendered
    const rendered = placeListEl.querySelectorAll(".place-item").length;
    if (targetIdx < rendered) return;
    const now = new Date();
    const frag = document.createDocumentFragment();
    for (let i = rendered; i <= targetIdx && i < state.filtered.length; i++) {
      frag.appendChild(_buildPlaceItem(state.filtered[i], now));
    }
    placeListEl.insertBefore(frag, sentinel);
  }

  // Perf-B: list virtualization via incremental rendering
  // - First chunk = 60 items (covers ~5 viewport heights on mobile)
  // - IntersectionObserver on bottom sentinel loads next chunks of 60
  // - This keeps initial DOM under ~60 nodes regardless of state.filtered.length
  const LIST_CHUNK_SIZE = 60;
  let _listObserver = null;
  let _listRenderToken = 0;

  function _buildPlaceItem(p, now) {
    const div = document.createElement("div");
    div.className = "place-item" + (p.id === state.selectedPlaceId ? " active" : "");
    div.dataset.placeId = p.id;
    const metaParts = [p.category, p.region, p.price_level].filter(Boolean);
    if (p._distance_m != null) {
      const mins = Math.max(1, Math.round(p._distance_m / WALK_METRES_PER_MIN));
      metaParts.push(`步行 ${mins} 分 (${Math.round(p._distance_m)}m)`);
    }
    const meta = metaParts.join(" · ");
    const tags = (p.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const bm = getBookmark(p.id);
    const bmIcon = bm ? `<span class="bookmark-icon">${BOOKMARK_ICON[bm]}</span>` : "";
    const openNow = isOpenAt(p, now);
    let openBadge = "";
    if (openNow === true) openBadge = '<span class="badge-open open">營業中</span>';
    else if (openNow === false) openBadge = '<span class="badge-open closed">休息</span>';
    const dayBadgeHtml = p.day_tag != null
      ? `<span class="badge-day">Day ${p.day_tag}</span>` : "";
    // Perf-C: unverified badge for lower-confidence entries
    const unverifiedBadge = (p.verified === false)
      ? '<span class="badge-unverified" title="未完全驗證坐標/資料">⚠</span>' : "";
    // Owner-only quick verify button (shown inline on unverified items)
    const quickVerifyBtn = (state.role === "owner" && p.verified === false)
      ? '<button type="button" class="quick-verify-btn" title="標記為已驗證" aria-label="快速驗證">✓</button>' : "";
    div.innerHTML = `
      <div class="name">${bmIcon}${escapeHtml(p.name)}${openBadge}${dayBadgeHtml}${unverifiedBadge}${quickVerifyBtn}</div>
      <div class="meta">${escapeHtml(meta)}</div>
      ${tags ? `<div class="tags">${tags}</div>` : ""}
    `;
    div.addEventListener("click", () => openPlaceDetail(p.id));
    div.addEventListener("mouseenter", () => highlightMarker(p.id, true));
    div.addEventListener("mouseleave", () => highlightMarker(p.id, false));
    // Owner-only quick-verify handler (stopPropagation so it doesn't open detail)
    const qvBtn = div.querySelector(".quick-verify-btn");
    if (qvBtn) {
      qvBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const missing = [];
        if (!p.opening_hours) missing.push("營業時間");
        if (!p.address) missing.push("地址");
        if (missing.length) {
          if (!confirm(p.name + " 仍缺：" + missing.join("、") + "\n\n確定標記為已驗證？")) return;
        }
        qvBtn.disabled = true;
        qvBtn.textContent = "⋯";
        const { error } = await sb.rpc("update_place_verified", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_place_id: p.id,
          p_verified: true,
        });
        if (error) {
          qvBtn.disabled = false;
          qvBtn.textContent = "✓";
          alert("更新失敗：" + error.message);
          return;
        }
        p.verified = true;
        // refresh facet chips (verified count may change) + re-render this card
        applyFilters();
      });
    }
    return div;
  }

  function renderList() {
    // Invalidate any in-flight chunked render
    _listRenderToken++;
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }

    if (placeListEl) placeListEl.setAttribute("aria-busy", "false");
    if (state.filtered.length === 0) {
      placeListEl.innerHTML = renderEmptyState();
      return;
    }

    placeListEl.innerHTML = "";
    const now = new Date();
    const total = state.filtered.length;
    const myToken = _listRenderToken;

    // Render first chunk
    const firstChunkEnd = Math.min(LIST_CHUNK_SIZE, total);
    const frag1 = document.createDocumentFragment();
    for (let i = 0; i < firstChunkEnd; i++) {
      frag1.appendChild(_buildPlaceItem(state.filtered[i], now));
    }
    placeListEl.appendChild(frag1);

    if (firstChunkEnd >= total) return;

    // Set up sentinel + IntersectionObserver for subsequent chunks
    const sentinel = document.createElement("div");
    sentinel.className = "list-sentinel";
    sentinel.style.cssText = "height:1px;";
    placeListEl.appendChild(sentinel);

    let nextIdx = firstChunkEnd;
    _listObserver = new IntersectionObserver((entries) => {
      if (myToken !== _listRenderToken) return; // stale render
      if (!entries[0].isIntersecting) return;
      const chunkEnd = Math.min(nextIdx + LIST_CHUNK_SIZE, total);
      const frag = document.createDocumentFragment();
      for (let i = nextIdx; i < chunkEnd; i++) {
        frag.appendChild(_buildPlaceItem(state.filtered[i], now));
      }
      placeListEl.insertBefore(frag, sentinel);
      nextIdx = chunkEnd;
      if (nextIdx >= total) {
        _listObserver.disconnect();
        _listObserver = null;
        sentinel.remove();
      }
    }, { root: placeListEl, rootMargin: "400px" });
    _listObserver.observe(sentinel);
  }

  // Perf-A: marker signature cache — only rebuild DivIcon if visual state changes
  // Key includes: bookmark state, day_tag, category emoji (anything that affects HTML)
  function _markerSignature(p) {
    const bm = getBookmark(p.id) || "";
    return `${p.category}|${bm}|${p.day_tag ?? ""}`;
  }

  function renderMarkers() {
    const newSet = new Set();
    const toAdd = [];
    for (const p of state.filtered) {
      if (p.lat == null || p.lng == null) continue;
      newSet.add(p.id);
      const sig = _markerSignature(p);
      const cached = state.markers.get(p.id);
      // Perf-A: reuse existing marker if signature unchanged
      if (cached && cached._sig === sig
          && cached.getLatLng().lat === p.lat
          && cached.getLatLng().lng === p.lng) {
        continue; // already in cluster, no rebuild needed
      }
      // Need to (re)build this marker
      if (cached) cluster.removeLayer(cached);

      const emoji = CATEGORY_EMOJI[p.category] || DEFAULT_EMOJI;
      const bm = getBookmark(p.id);
      const bmClass = bm ? ` bookmark-${bm}` : "";
      const wrapClass = bm === "favorite" ? " bookmark-favorite-wrap" : "";
      const statusBadge = bm
        ? `<span class="status-badge">${BOOKMARK_ICON[bm]}</span>`
        : "";
      const dayBadge = (p.day_tag != null)
        ? `<span class="day-badge">${p.day_tag}</span>`
        : "";
      const icon = L.divIcon({
        className: "emoji-marker" + wrapClass,
        html: `<div class="emoji-marker-inner${bmClass}"><span>${emoji}</span>${statusBadge}${dayBadge}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
      });
      const m = L.marker([p.lat, p.lng], { icon });
      m._sig = sig;
      m._placeId = p.id;
      m.bindTooltip(p.name);
      m.on("click", () => openPlaceDetail(p.id));
      m.on("mouseover", () => highlightListItem(p.id, true));
      m.on("mouseout",  () => highlightListItem(p.id, false));
      state.markers.set(p.id, m);
      toAdd.push(m);
    }

    // Perf-A: remove markers no longer in filtered set
    for (const [pid, m] of state.markers) {
      if (!newSet.has(pid)) {
        cluster.removeLayer(m);
        state.markers.delete(pid);
      }
    }

    // Perf-A: bulk addLayers (markercluster chunkedLoading kicks in)
    if (toAdd.length > 0) cluster.addLayers(toAdd);
  }

  // -----------------------------------------------------------
  // 步行圈 helpers
  // -----------------------------------------------------------
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000; // m
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng/2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // -----------------------------------------------------------
  // Anchor persistence (E1) — localStorage per trip area
  // -----------------------------------------------------------
  function anchorStorageKey(slug) {
    return `tfm:anchors:${slug || "default"}`;
  }
  function saveAnchorsToStorage() {
    if (!state.currentTripAreaSlug) return;
    // Persist only stable anchors: map / place / station. Skip geo (transient).
    const persist = state.walking.anchors
      .filter(a => a.mode !== "geo" && a.lat != null && a.lng != null)
      .map(a => ({
        mode: a.mode, lat: a.lat, lng: a.lng,
        label: a.label, color: a.color,
        placeId: a.placeId || null, stationId: a.stationId || null,
      }));
    try {
      const k = anchorStorageKey(state.currentTripAreaSlug);
      if (persist.length === 0) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify({ v: 1, anchors: persist, enabled: state.walking.enabled }));
    } catch (e) {
      // quota / privacy mode — ignore
    }
  }
  function loadAnchorsFromStorage(slug) {
    try {
      const raw = localStorage.getItem(anchorStorageKey(slug));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.anchors)) return null;
      return obj;
    } catch (e) { return null; }
  }
  function restoreAnchorsForCurrentArea() {
    const obj = loadAnchorsFromStorage(state.currentTripAreaSlug);
    if (!obj || obj.anchors.length === 0) return false;
    // Reset existing anchors, then re-hydrate with new ids
    state.walking.anchors = obj.anchors.map(a => ({
      id: nextAnchorId(),
      mode: a.mode,
      lat: a.lat, lng: a.lng,
      label: a.label,
      color: a.color,
      placeId: a.placeId || undefined,
      stationId: a.stationId || undefined,
    }));
    if (obj.enabled) {
      state.walking.enabled = true;
      $("walkingToggle").checked = true;
      $("walkingBody").classList.add("open");
    }
    return true;
  }

  // -----------------------------------------------------------
  // E3: Walking route TSP
  // -----------------------------------------------------------
  const OSRM_BASE = "https://router.project-osrm.org";
  const TSP_MAX_BRUTE = 8;   // brute force permutations (8! = 40320)
  const TSP_MAX_TOTAL = 12;  // hard cap for nearest-neighbour + 2-opt
  let routeLayer = null;     // L.layerGroup for the drawn route

  function ensureRouteLayer() {
    if (!routeLayer) {
      routeLayer = L.layerGroup().addTo(map);
    }
    return routeLayer;
  }
  function hideRoutePanel() {
    if (routeLayer) { routeLayer.clearLayers(); }
    const panel = $("routePanel");
    if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
  }

  // Brute force shortest open path through all points
  function tspBruteForce(points) {
    const n = points.length;
    if (n <= 1) return { order: points.map((_, i) => i), distance: 0 };
    const idxs = points.map((_, i) => i);
    let best = { order: idxs.slice(), distance: pathLen(idxs, points) };
    function permute(arr, k) {
      if (k === arr.length - 1) {
        const d = pathLen(arr, points);
        if (d < best.distance) best = { order: arr.slice(), distance: d };
        return;
      }
      for (let i = k; i < arr.length; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        permute(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    }
    permute(idxs.slice(), 0);
    return best;
  }
  function pathLen(order, points) {
    let d = 0;
    for (let i = 0; i < order.length - 1; i++) {
      const a = points[order[i]], b = points[order[i + 1]];
      d += haversine(a.lat, a.lng, b.lat, b.lng);
    }
    return d;
  }
  // Nearest neighbour + 2-opt for larger N
  function tspNN2opt(points) {
    const n = points.length;
    if (n <= 1) return { order: points.map((_, i) => i), distance: 0 };
    // NN from each start, keep best
    let best = null;
    for (let s = 0; s < n; s++) {
      const visited = new Array(n).fill(false);
      const order = [s]; visited[s] = true;
      while (order.length < n) {
        const cur = order[order.length - 1];
        let nearest = -1, nd = Infinity;
        for (let j = 0; j < n; j++) {
          if (visited[j]) continue;
          const d = haversine(points[cur].lat, points[cur].lng, points[j].lat, points[j].lng);
          if (d < nd) { nd = d; nearest = j; }
        }
        order.push(nearest); visited[nearest] = true;
      }
      const d = pathLen(order, points);
      if (!best || d < best.distance) best = { order, distance: d };
    }
    // 2-opt swaps
    let improved = true, iter = 0;
    while (improved && iter < 100) {
      improved = false; iter++;
      for (let i = 0; i < best.order.length - 1; i++) {
        for (let k = i + 1; k < best.order.length; k++) {
          const newOrder = best.order.slice(0, i).concat(
            best.order.slice(i, k + 1).reverse(),
            best.order.slice(k + 1)
          );
          const d = pathLen(newOrder, points);
          if (d < best.distance - 0.0001) {
            best = { order: newOrder, distance: d };
            improved = true;
          }
        }
      }
    }
    return best;
  }

  async function osrmRoute(points) {
    // points are in TSP order; OSRM /route/v1/foot expects lng,lat;lng,lat;...
    const coords = points.map(p => `${p.lng},${p.lat}`).join(";");
    const url = `${OSRM_BASE}/route/v1/foot/${coords}?overview=full&geometries=geojson`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error("osrm_http_" + r.status);
      const j = await r.json();
      if (!j.routes || j.routes.length === 0) throw new Error("osrm_no_route");
      const route = j.routes[0];
      // NOTE: 公共 OSRM demo (router.project-osrm.org) 只跑 car profile，
      // /route/v1/foot/ 雖然接受但 duration 係汽車速度。
      // 距離係真正路網距離，仍然可信；duration 我哋根據步行速度自己算。
      const distanceM = route.distance;
      const durationSec = distanceM / (WALK_METRES_PER_MIN / 60); // 56 m/min ÷ 60 = m/s
      return {
        distance: distanceM, // metres
        duration: durationSec, // seconds, recomputed at walking pace
        geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async function planWalkingRoute() {
    const w = state.walking;
    const valid = w.anchors.filter(a => a.lat != null && a.lng != null);
    if (valid.length < 2) return;
    if (valid.length > TSP_MAX_TOTAL) {
      alert(`最多 ${TSP_MAX_TOTAL} 個起點可規劃路線`);
      return;
    }

    const panel = $("routePanel");
    panel.style.display = "block";
    panel.innerHTML = `<div style="color:var(--muted);">計算中…</div>`;

    // 1. TSP order (open path, no return to start)
    const tsp = valid.length <= TSP_MAX_BRUTE ? tspBruteForce(valid) : tspNN2opt(valid);
    const ordered = tsp.order.map(i => valid[i]);

    // 2. OSRM for accurate distance / duration / geometry; fallback to Haversine + 80m/min
    let route, source;
    try {
      route = await osrmRoute(ordered);
      source = "osrm";
    } catch (e) {
      const dist = tsp.distance;
      route = {
        distance: dist,
        duration: dist / (WALK_METRES_PER_MIN / 60), // m/s
        geometry: ordered.map(a => [a.lat, a.lng]),
      };
      source = "haversine";
    }

    // 3. Draw polyline
    const layer = ensureRouteLayer();
    layer.clearLayers();
    L.polyline(route.geometry, {
      color: "#1976d2", weight: 5, opacity: 0.85, dashArray: "6,4",
    }).addTo(layer);
    // Numbered waypoint markers
    ordered.forEach((a, i) => {
      L.marker([a.lat, a.lng], {
        icon: L.divIcon({
          className: "route-waypoint",
          html: `<div style="background:#1976d2;color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${i + 1}</div>`,
          iconSize: [22, 22], iconAnchor: [11, 11],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 2000,
      }).addTo(layer);
    });

    // 4. Side panel
    const km = (route.distance / 1000).toFixed(2);
    const mins = Math.round(route.duration / 60);
    const sourceTxt = source === "osrm" ? "OSRM 路網距離" : "直線估算（OSRM 不可用）";
    // J3: build export deeplink (Google/Apple Maps multi-waypoint walking)
    const exportUrl = buildRouteExportUrl(ordered);
    const exportLabel = isIOS() ? "🗺️ Apple Maps 導航" : "🗺️ Google Maps 導航";
    const exportNote = isIOS() ? '<div style="font-size:10px;color:var(--muted);margin-top:2px;">Apple Maps 只支援起/終點，中途點需手動加。</div>' : "";
    const exportHtml = exportUrl
      ? `<a class="btn-sm" href="${escapeHtml(exportUrl)}" target="_blank" rel="noopener" style="display:block;margin-top:6px;padding:6px 8px;font-size:11px;text-align:center;background:#1976d2;color:#fff;text-decoration:none;border-radius:4px;">${exportLabel}</a>${exportNote}`
      : "";

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <b>規劃路線</b>
        <button class="btn-sm" id="hideRouteBtn" style="padding:2px 6px;font-size:10px;">關閉</button>
      </div>
      <div style="margin-bottom:4px;">全程 ${km} km・約 ${mins} 分鐘・<span style="color:var(--muted);">${sourceTxt}</span></div>
      <ol style="margin:0;padding-left:18px;">
        ${ordered.map(a => `<li style="margin:2px 0;"><span style="display:inline-block;width:10px;height:10px;background:${a.color};border-radius:50%;margin-right:4px;"></span>${a.label}</li>`).join("")}
      </ol>
      ${exportHtml}
    `;
    $("hideRouteBtn").addEventListener("click", hideRoutePanel);
  }

  function pickAnchorColor() {
    const used = new Set(state.walking.anchors.map(a => a.color));
    for (const c of ANCHOR_COLORS) if (!used.has(c)) return c;
    return ANCHOR_COLORS[state.walking.anchors.length % ANCHOR_COLORS.length];
  }

  function addAnchor(mode) {
    const w = state.walking;
    if (w.anchors.length >= MAX_ANCHORS) {
      w.lastError = `最多${MAX_ANCHORS}個起點`;
      updateWalkingUI();
      return;
    }
    w.lastError = null;

    // 一個 mode 只保留一個（多個 map / geo 重複沒意義；但 place 接受多個不同 place）
    if (mode === "map" || mode === "geo") {
      if (w.anchors.some(a => a.mode === mode)) {
        w.lastError = mode === "map" ? "已有地圖中心 anchor" : "已有位置 anchor";
        updateWalkingUI();
        return;
      }
    }

    const id = nextAnchorId();
    const color = pickAnchorColor();

    if (mode === "map") {
      const c = map.getCenter();
      w.anchors.push({ id, mode, lat: c.lat, lng: c.lng, label: "地圖中心", color });
      finalizeAnchorAdd();
    } else if (mode === "geo") {
      if (!navigator.geolocation) {
        w.lastError = "瀏覽器唔支援定位";
        updateWalkingUI();
        return;
      }
      // 插一個 pending anchor 顯示「取位置中⋯」
      w.anchors.push({ id, mode, lat: null, lng: null, label: "取位置中⋯", color });
      renderAnchorList();
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const a = w.anchors.find(x => x.id === id);
          if (!a) return;
          a.lat = pos.coords.latitude;
          a.lng = pos.coords.longitude;
          a.label = "我的位置";
          finalizeAnchorAdd();
        },
        (err) => {
          // 移除個 pending anchor
          state.walking.anchors = state.walking.anchors.filter(x => x.id !== id);
          state.walking.lastError = "取位置失敗：" + (err.message || err.code);
          renderAnchorList();
          updateWalkingUI();
          if (state.walking.enabled) applyFilters();
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    } else if (mode === "place") {
      // 選 selectedPlaceId、或第一個未被揀作 anchor 嘅 place
      const usedPlaceIds = new Set(w.anchors.filter(a => a.placeId).map(a => a.placeId));
      let p = state.places.find(x => x.id === state.selectedPlaceId && !usedPlaceIds.has(x.id) && x.lat != null);
      if (!p) p = state.places.find(x => !usedPlaceIds.has(x.id) && x.lat != null && x.lng != null);
      if (!p) {
        w.lastError = "未有適合嘅地點可揀";
        updateWalkingUI();
        return;
      }
      w.anchors.push({ id, mode, lat: p.lat, lng: p.lng, label: p.name, placeId: p.id, color });
      map.setView([p.lat, p.lng], 16);
      finalizeAnchorAdd();
    } else if (mode === "station") {
      // arg 為 station object; 如果未提供，揀第一個未用過嘅
      let s = arguments[1];
      const usedSids = new Set(w.anchors.filter(a => a.stationId).map(a => a.stationId));
      if (!s) {
        s = state.stations.find(x => !usedSids.has(x.id));
      } else if (usedSids.has(s.id)) {
        w.lastError = "該車站已作 anchor";
        updateWalkingUI();
        return;
      }
      if (!s) {
        w.lastError = "未載入車站或全部已被用";
        updateWalkingUI();
        return;
      }
      w.anchors.push({ id, mode, lat: s.lat, lng: s.lng, label: `🚉 ${s.name}`, stationId: s.id, color });
      map.setView([s.lat, s.lng], 15);
      finalizeAnchorAdd();
    }
  }

  function finalizeAnchorAdd() {
    renderAnchorList();
    updateWalkingUI();
    saveAnchorsToStorage();
    if (state.walking.enabled) applyFilters();
  }

  function removeAnchor(id) {
    state.walking.anchors = state.walking.anchors.filter(a => a.id !== id);
    state.walking.lastError = null;
    renderAnchorList();
    updateWalkingUI();
    saveAnchorsToStorage();
    applyFilters();
  }

  function clearAllAnchors() {
    state.walking.anchors = [];
    state.walking.lastError = null;
    hideRoutePanel();
    renderAnchorList();
    updateWalkingUI();
    saveAnchorsToStorage();
    applyFilters();
  }

  function renderAnchorList() {
    const w = state.walking;
    const listEl = $("anchorList");
    if (w.anchors.length === 0) {
      listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);font-style:italic;">點下面「+」加起點</div>';
    } else {
      listEl.innerHTML = w.anchors.map(a => {
        const icon = a.mode === "map" ? "🎯"
                   : a.mode === "geo" ? "📍"
                   : a.mode === "station" ? "🚉"
                   : "📌";
        // a.label 可能已含 emoji prefix (station)
        const labelText = a.mode === "station" ? a.label : `${icon} ${a.label}`;
        return `
          <div class="anchor-item" data-id="${a.id}">
            <span class="anchor-color" style="color:${a.color};"></span>
            <span class="anchor-label">${escapeHtml(labelText)}</span>
            <button class="anchor-remove" data-id="${a.id}" title="移除">×</button>
          </div>
        `;
      }).join("");
    }
    // 綁 remove
    listEl.querySelectorAll(".anchor-remove").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeAnchor(btn.dataset.id);
      });
    });

    // disable add 按鈕當達上限
    const full = w.anchors.length >= MAX_ANCHORS;
    $("addAnchorMap").disabled = full || w.anchors.some(a => a.mode === "map");
    $("addAnchorGeo").disabled = full || w.anchors.some(a => a.mode === "geo");
    $("addAnchorPlace").disabled = full;
    const stationBtn = $("addAnchorStation");
    if (stationBtn) stationBtn.disabled = full || state.stations.length === 0;
  }

  // -----------------------------------------------------------
  // Stations (preset JR + subway)
  // -----------------------------------------------------------
  const SYS_LABEL = {
    "jr-kyushu": "JR 九州",
    "jr-west":   "JR 西日本",
    "osaka-metro": "大阪メトロ",
    "fukuoka-subway": "福岡市地下鐵",
    "kobe-subway": "神戶地下鐵",
  };

  async function loadStations() {
    // SW caches static assets; do not pass cache:'force-cache' which can race
    // with the SW install. Plain fetch + default caching is fine.
    try {
      const res = await fetch("./data/stations.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.stations = data.stations || [];
      renderAnchorList(); // 重新 enable 車站 btn
      if (state.showStations) renderStationMarkers();
    } catch (err) {
      // Non-fatal: stations overlay simply becomes unavailable for this session.
      console.warn("loadStations skipped:", err && err.message ? err.message : err);
      state.stations = [];
    }
  }

  function renderStationMarkers() {
    // 清掉 layer
    stationLayer.clearLayers();
    stationMarkers.clear();
    if (!state.showStations || state.stations.length === 0) {
      if (map.hasLayer(stationLayer)) map.removeLayer(stationLayer);
      return;
    }
    if (!map.hasLayer(stationLayer)) map.addLayer(stationLayer);

    // 只 render 現在 trip_area 嘅車站（避免一次過 700+ markers）
    const area = state.currentTripAreaSlug; // 'kyushu' | 'osaka'
    const filtered = state.stations.filter(s => {
      if (!area) return true;
      if (area === "osaka") return s.area === "osaka";
      if (area === "kyushu") return s.area === "kyushu";
      return false;
    });

    for (const s of filtered) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="station-icon ${s.sys}"></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
      const m = L.marker([s.lat, s.lng], { icon, riseOnHover: true, keyboard: false });
      const sysLabel = SYS_LABEL[s.sys] || s.sys;
      m.bindTooltip(`<span class="station-tooltip">🚉 ${escapeHtml(s.name)} · ${escapeHtml(sysLabel)}${s.line ? " · " + escapeHtml(s.line) : ""}</span>`, { direction: "top", offset: [0, -4] });
      m.on("click", () => addAnchor("station", s));
      stationLayer.addLayer(m);
      stationMarkers.set(s.id, m);
    }
  }

  function handleStationSearchInput() {
    const q = $("stationSearchInput").value.trim().toLowerCase();
    const resEl = $("stationSearchResults");
    if (!q || state.stations.length === 0) {
      resEl.style.display = "none";
      return;
    }
    // 只 search 現 trip_area
    const area = state.currentTripAreaSlug;
    let pool = state.stations;
    if (area === "osaka") pool = pool.filter(s => s.area === "osaka");
    else if (area === "kyushu") pool = pool.filter(s => s.area === "kyushu");

    const matches = pool.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.name_en && s.name_en.toLowerCase().includes(q))
    ).slice(0, 20);

    if (matches.length === 0) {
      resEl.innerHTML = '<div class="result-item" style="cursor:default;color:var(--muted);">未找到車站</div>';
      resEl.style.display = "block";
      return;
    }

    resEl.innerHTML = matches.map(s => {
      const sysLabel = SYS_LABEL[s.sys] || s.sys;
      return `<div class="result-item" data-sid="${s.id}">
        <span>🚉 ${escapeHtml(s.name)}${s.name_en ? " ("+escapeHtml(s.name_en)+")" : ""}</span>
        <span class="sys">${escapeHtml(sysLabel)}</span>
      </div>`;
    }).join("");
    resEl.style.display = "block";
    resEl.querySelectorAll(".result-item[data-sid]").forEach(el => {
      el.addEventListener("mousedown", (e) => { // mousedown 先喺 blur
        e.preventDefault();
        const sid = parseInt(el.dataset.sid, 10);
        const s = state.stations.find(x => x.id === sid);
        if (!s) return;
        // 加入 anchor（自動 enable walking、auto pan）
        addAnchor("station", s);
        $("stationSearchInput").value = "";
        resEl.style.display = "none";
      });
    });
  }

  function updateWalkingUI() {
    const w = state.walking;
    const statusEl = $("walkingStatus");
    statusEl.classList.remove("error");

    // E1/E3: toggle button enabled state
    const validCount = w.anchors.filter(a => a.lat != null).length;
    const clearBtn = $("clearAnchorsBtn");
    const planBtn = $("planRouteBtn");
    if (clearBtn) clearBtn.disabled = w.anchors.length === 0;
    if (planBtn) planBtn.disabled = validCount < 2;

    if (w.lastError) {
      statusEl.textContent = w.lastError;
      statusEl.classList.add("error");
      return;
    }

    const radius = w.minutes * WALK_METRES_PER_MIN;
    const suffix = validCount === 0 ? "· 未有起點"
                : validCount === 1 ? "· 1 個起點"
                : `· ${validCount} 個起點（同時要係範圍內）`;
    statusEl.textContent = `${w.minutes} 分鐘 ≈ ${radius}m ${suffix}`;
  }

  function renderWalkingCircles() {
    walkingLayer.clearLayers();
    for (const m of anchorMarkers.values()) map.removeLayer(m);
    anchorMarkers.clear();

    const w = state.walking;
    if (!w.enabled) return;
    const valid = w.anchors.filter(a => a.lat != null && a.lng != null);
    if (valid.length === 0) return;

    if (!map.hasLayer(walkingLayer)) map.addLayer(walkingLayer);

    for (const a of valid) {
      // 3 同心圓（該 anchor 色）
      for (const m of WALK_MINUTES) {
        const r = m * WALK_METRES_PER_MIN;
        const isActive = (m === w.minutes);
        L.circle([a.lat, a.lng], {
          radius: r,
          color: a.color,
          weight: isActive ? 2 : 1,
          opacity: isActive ? 0.7 : 0.25,
          fillColor: a.color,
          fillOpacity: isActive ? 0.05 : 0.02,
          interactive: false,
        }).addTo(walkingLayer);
      }
      // anchor pin
      const pin = L.circleMarker([a.lat, a.lng], {
        radius: 7,
        color: a.color,
        weight: 3,
        fillColor: "#fff",
        fillOpacity: 1,
        interactive: false,
      }).addTo(map);
      anchorMarkers.set(a.id, pin);
    }
  }

  // -----------------------------------------------------------
  // J3: Maps deeplink helpers (Google Maps / Apple Maps / tel:)
  // -----------------------------------------------------------
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function gmapsOpen(p) {
    // Open place card on Google Maps. Prefer existing google_url, else search by name+coord.
    const direct = p.google_url || (p.links && p.links.maps);
    if (direct) return direct;
    if (p.lat != null && p.lng != null) {
      const q = encodeURIComponent(`${p.name} ${p.lat},${p.lng}`);
      return `https://www.google.com/maps/search/?api=1&query=${q}`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`;
  }
  function gmapsDir(p, mode) {
    // mode: "walking" | "transit" | "driving"
    if (p.lat == null || p.lng == null) return null;
    const dest = `${p.lat},${p.lng}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=${mode}`;
  }
  function applemapsOpen(p) {
    if (p.lat != null && p.lng != null) {
      return `https://maps.apple.com/?q=${encodeURIComponent(p.name)}&ll=${p.lat},${p.lng}`;
    }
    return `https://maps.apple.com/?q=${encodeURIComponent(p.name)}`;
  }
  function applemapsDir(p, mode) {
    // Apple Maps modes: w=walking, r=transit, d=driving
    const m = mode === "transit" ? "r" : (mode === "walking" ? "w" : "d");
    if (p.lat == null || p.lng == null) return null;
    return `https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=${m}`;
  }
  function extractPhone(p) {
    // Try links.phone first, then scan note for phone-looking pattern
    const lk = p.links || {};
    if (lk.phone) return String(lk.phone).trim();
    if (p.phone) return String(p.phone).trim();
    const haystack = `${p.note || ""} ${p.address || ""}`;
    // Japanese / Taiwan / HK phone patterns: 7-15 digits with optional dashes/spaces/parens, optional +country
    const m = haystack.match(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3,4}[\s-]?\d{3,4}/);
    if (m) {
      const cleaned = m[0].replace(/[\s()-]/g, "");
      // Must have at least 8 digits to be plausible
      if (cleaned.replace(/\D/g, "").length >= 8) return m[0].trim();
    }
    return null;
  }
  function telLink(phoneRaw) {
    if (!phoneRaw) return null;
    // strip spaces/dashes/parens but keep leading +
    const cleaned = phoneRaw.replace(/[\s()-]/g, "");
    return `tel:${cleaned}`;
  }
  function renderPlaceDeeplinks(p) {
    const wrap = document.getElementById("detailDeeplinks");
    if (!wrap) return;
    const useApple = isIOS();
    const btns = [];
    const mkBtn = (href, label, title) => {
      if (!href) return;
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      btns.push(`<a class="btn" href="${escapeHtml(href)}" target="_blank" rel="noopener" style="font-size:11px;padding:4px 8px;text-decoration:none;"${t}>${label}</a>`);
    };
    // Open in Maps
    if (useApple) {
      mkBtn(applemapsOpen(p), "🗺️ Apple Maps", "在 Apple Maps 開啟");
    } else {
      mkBtn(gmapsOpen(p), "🗺️ Google Maps", "在 Google Maps 開啟");
    }
    // Walking directions
    if (p.lat != null && p.lng != null) {
      mkBtn(useApple ? applemapsDir(p, "walking") : gmapsDir(p, "walking"), "🚶 步行", "步行導航");
      mkBtn(useApple ? applemapsDir(p, "transit") : gmapsDir(p, "transit"), "🚆 交通", "公交路線");
    }
    // Phone (tel:)
    const phone = extractPhone(p);
    if (phone) {
      const tel = telLink(phone);
      btns.push(`<a class="btn" href="${escapeHtml(tel)}" style="font-size:11px;padding:4px 8px;text-decoration:none;" title="${escapeHtml("訂位 / 電話 " + phone)}">📞 ${escapeHtml(phone)}</a>`);
    }
    wrap.innerHTML = btns.join("");
  }
  // TSP route export: build a Google/Apple Maps multi-waypoint walking URL
  function buildRouteExportUrl(points) {
    // points: [{lat, lng, label?}, ...] in TSP order
    if (!Array.isArray(points) || points.length < 2) return null;
    if (isIOS()) {
      // Apple Maps: only supports saddr + daddr (no multi-waypoint via web URL).
      // Use first as start, last as end — user manually adds intermediate stops.
      const s = points[0];
      const d = points[points.length - 1];
      return `https://maps.apple.com/?saddr=${s.lat},${s.lng}&daddr=${d.lat},${d.lng}&dirflg=w`;
    }
    // Google Maps: /maps/dir/?api=1&origin=...&destination=...&waypoints=A|B|C&travelmode=walking
    const origin = `${points[0].lat},${points[0].lng}`;
    const dest = `${points[points.length-1].lat},${points[points.length-1].lng}`;
    const mid = points.slice(1, -1).map(pt => `${pt.lat},${pt.lng}`).join("|");
    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}&travelmode=walking`;
    if (mid) url += `&waypoints=${encodeURIComponent(mid)}`;
    return url;
  }

  // -----------------------------------------------------------
  // Place detail + reviews
  // -----------------------------------------------------------
  function renderBookmarkButtons() {
    const bm = state.selectedPlaceId ? getBookmark(state.selectedPlaceId) : null;
    document.querySelectorAll(".bookmark-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.status === bm);
    });
  }

  async function openPlaceDetail(placeId) {
    state.selectedPlaceId = placeId;
    const p = state.places.find(x => x.id === placeId);
    if (!p) return;

    const emoji = CATEGORY_EMOJI[p.category] || DEFAULT_EMOJI;
    // Perf-C: unverified marker in detail name
    const unverifiedNameBadge = (p.verified === false)
      ? ' <span class="badge-unverified" title="未完全驗證坐標/資料">⚠ 未驗證</span>' : "";
    $("detailName").innerHTML = `${emoji} ${escapeHtml(p.name)}${unverifiedNameBadge}`;

    // I1: hero photo (real img if hero_photo_url present, else CSS gradient + big emoji)
    const heroEl = $("detailHero");
    if (heroEl) {
      const cgKey = p.cuisine_group || "other";
      heroEl.className = `detail-hero cg-${cgKey}`;
      if (p.hero_photo_url) {
        const safeUrl = String(p.hero_photo_url).replace(/"/g, "&quot;");
        heroEl.innerHTML = `<img src="${safeUrl}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('fallback');this.outerHTML='<span class=&quot;hero-emoji&quot;>${emoji}</span>';">`;
      } else {
        heroEl.innerHTML = `<span class="hero-emoji">${emoji}</span>`;
      }
    }
    const dayLabel = p.day_tag != null ? `Day ${p.day_tag}` : null;
    $("detailMeta").textContent = [
      p.category, p.region, p.price_level, dayLabel,
      p.google_rating ? `Google ${p.google_rating}` : null,
      p.tabelog_rating ? `Tabelog ${p.tabelog_rating}` : null
    ].filter(Boolean).join(" · ");

    // E2: owner-only inline day-tag editor
    const ownerDayEl = $("detailOwnerDay");
    if (ownerDayEl) {
      if (state.role === "owner") {
        ownerDayEl.style.display = "block";
        const sel = ownerDayEl.querySelector("select");
        sel.value = p.day_tag != null ? String(p.day_tag) : "";
        sel.onchange = async () => {
          const val = sel.value === "" ? null : parseInt(sel.value, 10);
          const { error } = await sb.rpc("update_place_day", {
            p_invite_code: state.inviteCode,
            p_display_name: state.displayName,
            p_place_id: p.id,
            p_day_tag: val,
          });
          if (error) { alert("更新失敗：" + error.message); return; }
          p.day_tag = val;
          applyFilters();
          openPlaceDetail(p.id);
        };
      } else {
        ownerDayEl.style.display = "none";
      }
    }

    // Owner-only: verified toggle (quick verify panel)
    const ownerVerEl = $("detailOwnerVerified");
    if (ownerVerEl) {
      if (state.role === "owner") {
        ownerVerEl.style.display = "block";
        const btn = $("detailOwnerVerifiedBtn");
        const hint = $("detailOwnerVerifiedHint");
        const isVer = p.verified !== false;
        btn.textContent = isVer ? "✓ 已驗證" : "⚠ 未驗證";
        btn.style.background = isVer ? "var(--accent)" : "";
        btn.style.color = isVer ? "#fff" : "";
        const missing = [];
        if (!p.opening_hours) missing.push("營業時間");
        if (!p.address) missing.push("地址");
        hint.textContent = missing.length ? "缺：" + missing.join("、") : "資料齊全";
        btn.onclick = async () => {
          const newVal = !isVer;
          if (newVal && missing.length) {
            if (!confirm("這個地點仍缺：" + missing.join("、") + "\n\n確定標記為已驗證？")) return;
          }
          btn.disabled = true;
          const { error } = await sb.rpc("update_place_verified", {
            p_invite_code: state.inviteCode,
            p_display_name: state.displayName,
            p_place_id: p.id,
            p_verified: newVal,
          });
          btn.disabled = false;
          if (error) { alert("更新失敗：" + error.message); return; }
          p.verified = newVal;
          applyFilters();
          openPlaceDetail(p.id);
        };
      } else {
        ownerVerEl.style.display = "none";
      }
    }

    // 營業時間
    const hoursEl = $("detailHours");
    if (p.opening_hours || (p.closed_days && p.closed_days.length)) {
      const openNow = isOpenAt(p, new Date());
      let statusBadge = "";
      if (openNow === true) statusBadge = '<span class="badge-open open">營業中</span>';
      else if (openNow === false) statusBadge = '<span class="badge-open closed">休息</span>';
      const closedDayNames = (p.closed_days || []).map(d => "日一二三四五六"[d]).join("／");
      const closedTxt = closedDayNames ? `休：${closedDayNames}` : "";
      hoursEl.innerHTML = `🕐 ${escapeHtml(p.opening_hours || "—")} ${closedTxt ? "· " + closedTxt : ""} ${statusBadge}`;
    } else {
      hoursEl.innerHTML = '<span style="color:var(--muted);">🕐 營業時間未提供</span>';
    }

    $("detailAddress").textContent = p.address ? `📍 ${p.address}` : "";
    $("detailNote").textContent = p.note || "";

    // links（兼容兩種 schema：舊 jsonb p.links + 新 individual columns）
    const links = [];
    const lk = p.links || {};
    const gUrl = p.google_url || lk.maps;
    const tUrl = p.tabelog_url || lk.tabelog;
    const igUrl = p.instagram_url || lk.ig;
    const fbUrl = p.facebook_url || lk.fb;
    const blogUrl = p.blog_url || lk.blog;
    if (gUrl)    links.push(`<a href="${escapeHtml(gUrl)}" target="_blank" rel="noopener">Google Maps</a>`);
    if (tUrl)    links.push(`<a href="${escapeHtml(tUrl)}" target="_blank" rel="noopener">Tabelog</a>`);
    if (igUrl)   links.push(`<a href="${escapeHtml(igUrl)}" target="_blank" rel="noopener">IG</a>`);
    if (fbUrl)   links.push(`<a href="${escapeHtml(fbUrl)}" target="_blank" rel="noopener">FB</a>`);
    if (blogUrl) links.push(`<a href="${escapeHtml(blogUrl)}" target="_blank" rel="noopener">Blog</a>`);
    // 永遠加一個 Google 搜尋 fallback（按名）
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(p.name)}`;
    if (!gUrl) links.push(`<a href="${searchUrl}" target="_blank" rel="noopener">Maps 搜尋</a>`);
    $("detailLinks").innerHTML = links.join("");

    // J3: Maps / transit / phone deeplinks
    renderPlaceDeeplinks(p);

    renderBookmarkButtons();

    // G3c: open half-sheet + fly map + marker bounce + auto-peek main sheet on mobile
    const panel = $("detailPanel");
    panel.classList.add("open");
    panel.classList.remove("expanded"); // always start at half on mobile
    // scroll detail body to top on each open
    const dbody = $("detailBody"); if (dbody) dbody.scrollTop = 0;

    // marker bounce + selected highlight
    try {
      // clear previous selection
      document.querySelectorAll(".emoji-marker.selected").forEach(el => el.classList.remove("selected"));
      const m = state.markers.get(p.id);
      if (m && m._icon) {
        // re-trigger animation
        m._icon.classList.remove("selected");
        // force reflow
        void m._icon.offsetWidth;
        m._icon.classList.add("selected");
      }
    } catch (e) {}

    // map fly: on mobile aim above the half-sheet (45dvh from top), so push the point upward visually
    if (p.lat != null && p.lng != null) {
      try {
        if (isMobile()) {
          // collapse main sidebar sheet to peek so detail sheet is dominant
          if (typeof window.__sheetSnapTo === "function") window.__sheetSnapTo("peek");
          // compute offset: half-sheet covers bottom 55% → shift center up by 27.5% of map height
          const mapEl = document.getElementById("map");
          const h = mapEl ? mapEl.clientHeight : window.innerHeight;
          const offsetY = Math.round(h * 0.275);
          const targetPoint = map.project([p.lat, p.lng], 16).subtract([0, -offsetY]);
          const targetLatLng = map.unproject(targetPoint, 16);
          map.flyTo(targetLatLng, 16, { duration: 0.6 });
        } else {
          map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 15), { duration: 0.5 });
        }
      } catch (e) {
        map.panTo([p.lat, p.lng]);
      }
    }
    renderList(); // refresh active state
    // H3: scroll the active item into view in the list
    try { scrollListItemIntoView(p.id); } catch (_) {}

    // suggestions + photos (parallel with reviews)
    loadAndRenderSuggestions(placeId).catch(() => {});
    loadAndRenderPlacePhotos(placeId).catch(() => {});

    // Load reviews
    const { data, error } = await sb
      .from("reviews")
      .select("*")
      .eq("place_id", placeId)
      .order("created_at", { ascending: false });
    const listEl = $("reviewList");
    if (error) { listEl.innerHTML = '<div class="list-empty">載入評論失敗</div>'; return; }
    if (!data || data.length === 0) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">未有評論</div>';
      return;
    }
    // fetch photos for these review ids
    const reviewIds = data.map(r => r.id);
    const photoMap = new Map();
    if (reviewIds.length) {
      const { data: pdata } = await sb
        .from("review_photos")
        .select("review_id, storage_path")
        .in("review_id", reviewIds);
      if (pdata) {
        for (const p of pdata) photoMap.set(p.review_id, p.storage_path);
      }
    }
    listEl.innerHTML = data.map(r => {
      const sp = photoMap.get(r.id);
      const photoHtml = sp ? `<img class="review-photo" src="${escapeHtml(photoUrl(sp))}" loading="lazy" data-url="${escapeHtml(photoUrl(sp))}" />` : "";
      return `
        <div class="review">
          <div class="head">
            <span>${escapeHtml(r.display_name)}${r.rating != null ? ` · ★${r.rating}` : ""}</span>
            <span>${r.visit_date || r.created_at.substring(0,10)}</span>
          </div>
          <div>${escapeHtml(r.comment)}</div>
          ${photoHtml}
        </div>
      `;
    }).join("");
    listEl.querySelectorAll(".review-photo").forEach(img => {
      img.addEventListener("click", () => openLightbox(img.dataset.url));
    });
  }

  // -----------------------------------------------------------
  // Invite code flow
  // -----------------------------------------------------------
  async function handleInviteConfirm() {
    const code = $("inviteInput").value.trim();
    const name = $("displayNameInput").value.trim();
    const errEl = $("inviteErr");
    errEl.textContent = "";

    if (!code) { errEl.textContent = "請輸入邀請碼"; return; }
    if (!name) { errEl.textContent = "請輸入顯示名"; return; }

    const { data, error } = await sb.rpc("verify_invite_code", { p_code: code });
    if (error) { errEl.textContent = "驗證失敗：" + error.message; return; }
    if (!data || !data.valid) {
      const reason = data ? data.reason : "unknown";
      errEl.textContent = "邀請碼無效（" + reason + "）";
      return;
    }

    state.inviteCode = code;
    state.displayName = name;
    state.role = (name === cfg.OWNER_DISPLAY_NAME) ? "owner" : "friend";
    updateRoleUI();
    closeModal("inviteModal");
  }

  function updateRoleUI() {
    if (state.role === "owner") {
      roleBadge.textContent = "維護者 " + state.displayName;
      roleBadge.className = "role-badge owner";
    } else if (state.role === "friend") {
      roleBadge.textContent = "朋友 " + state.displayName;
      roleBadge.className = "role-badge";
    } else {
      roleBadge.textContent = "訪客";
      roleBadge.className = "role-badge guest";
    }
    const canWrite = state.role !== "guest";
    addPlaceBtn.disabled = !canWrite;
    $("addReviewBtn").disabled = !canWrite;
    $("addSuggestionBtn").disabled = !canWrite;
    $("placePhotoBtn").disabled = !canWrite;
    inviteBtn.textContent = canWrite ? "切換身份" : "輸入邀請碼";
  }

  // -----------------------------------------------------------
  // Add place
  // -----------------------------------------------------------
  async function handleAddPlace() {
    const errEl = $("pmErr"); errEl.textContent = "";
    const name = $("pmName").value.trim();
    const lat = parseFloat($("pmLat").value);
    const lng = parseFloat($("pmLng").value);

    if (!name) { errEl.textContent = "請輸入名稱"; return; }
    if (isNaN(lat) || isNaN(lng)) { errEl.textContent = "請輸入有效嘅 lat / lng"; return; }

    const tagsRaw = $("pmTags").value.trim();
    const tags = tagsRaw
      ? tagsRaw.split(/[,，、]+/).map(s => s.trim()).filter(Boolean)
      : [];

    const dayTagRaw = $("pmDayTag").value;
    const place = {
      name,
      cuisine_group: $("pmCuisineGroup").value || "other",
      category: $("pmCategory").value || null,
      region: $("pmRegion").value.trim() || null,
      price_level: $("pmPrice").value || null,
      lat, lng,
      tags,
      note: $("pmNote").value.trim() || null,
      google_url: $("pmGoogleUrl").value.trim() || null,
      tabelog_url: $("pmTabelogUrl").value.trim() || null,
      day_tag: dayTagRaw === "" ? null : parseInt(dayTagRaw, 10),
    };

    const { error } = await sb.rpc("add_place", {
      p_invite_code: state.inviteCode,
      p_display_name: state.displayName,
      p_trip_area_slug: state.currentTripAreaSlug,
      p_place: place,
    });

    if (error) { errEl.textContent = "提交失敗：" + error.message; return; }

    closeModal("placeModal");
    clearPlaceModal();
    await loadPlacesForCurrentArea();
  }

  function clearPlaceModal() {
    ["pmName","pmRegion","pmLat","pmLng","pmTags","pmNote","pmGoogleUrl","pmTabelogUrl"]
      .forEach(id => $(id).value = "");
    $("pmCategory").value = "";
    $("pmPrice").value = "";
    $("pmDayTag").value = "";
  }

  // -----------------------------------------------------------
  // Add review
  // -----------------------------------------------------------
  async function handleAddReview() {
    const errEl = $("rmErr"); errEl.textContent = "";
    const comment = $("rmComment").value.trim();
    const ratingRaw = $("rmRating").value;
    const rating = ratingRaw === "" ? null : parseFloat(ratingRaw);
    const visitDate = $("rmVisitDate").value || null;

    if (!comment) { errEl.textContent = "請輸入評論"; return; }
    if (!state.selectedPlaceId) { errEl.textContent = "未選擇地點"; return; }

    const { error } = await sb.rpc("add_review", {
      p_invite_code: state.inviteCode,
      p_display_name: state.displayName,
      p_place_id: state.selectedPlaceId,
      p_rating: rating,
      p_comment: comment,
      p_visit_date: visitDate,
    });
    if (error) { errEl.textContent = "提交失敗：" + error.message; return; }

    // If photo was prepared, upload it via add_review_photo (need review id from add_review return)
    // add_review RPC returns void, so we look up the latest review we just created
    if (state.pendingReviewPhoto) {
      try {
        const { data: latest, error: lerr } = await sb
          .from("reviews")
          .select("id")
          .eq("place_id", state.selectedPlaceId)
          .eq("display_name", state.displayName)
          .order("created_at", { ascending: false })
          .limit(1);
        if (lerr) throw lerr;
        if (latest && latest.length) {
          const reviewId = latest[0].id;
          const fname = genPhotoFilename();
          const storagePath = `reviews/${reviewId}/${fname}`;
          await uploadBlobToStorage(state.pendingReviewPhoto, storagePath);
          const { error: perr } = await sb.rpc("add_review_photo", {
            p_invite_code: state.inviteCode,
            p_review_id: reviewId,
            p_storage_path: storagePath,
            p_display_name: state.displayName,
          });
          if (perr) throw perr;
        }
      } catch (e) {
        showToast("照片上傳失敗：" + (e.message || e));
      }
      state.pendingReviewPhoto = null;
    }

    closeModal("reviewModal");
    $("rmRating").value = ""; $("rmComment").value = ""; $("rmVisitDate").value = "";
    $("rmPhotoInput").value = ""; $("rmPhotoStatus").textContent = ""; $("rmPhotoPreview").innerHTML = "";
    await openPlaceDetail(state.selectedPlaceId);
  }

  // -----------------------------------------------------------
  // Suggestions: submit + load + render + review
  // -----------------------------------------------------------
  const SUG_TYPE_LABEL = { correction: "資料更正", recommend: "推薦", warning: "勸退" };

  async function handleSubmitSuggestion() {
    const errEl = $("sgErr"); errEl.textContent = "";
    const type = $("sgType").value;
    const ratingRaw = $("sgRating").value;
    const rating = ratingRaw === "" ? null : parseInt(ratingRaw, 10);
    const comment = $("sgComment").value.trim();

    if (!state.selectedPlaceId) { errEl.textContent = "未選擇地點"; return; }
    if (!comment) { errEl.textContent = "請輸入內容"; return; }
    if ((type === "recommend" || type === "warning") && rating == null) {
      errEl.textContent = "推薦／勸退需填 1–5 分"; return;
    }

    const { error } = await sb.rpc("submit_place_suggestion", {
      p_invite_code: state.inviteCode,
      p_display_name: state.displayName,
      p_place_id: state.selectedPlaceId,
      p_type: type,
      p_rating: rating,
      p_comment: comment,
    });
    if (error) {
      const msg = error.message || "提交失敗";
      errEl.textContent = msg.includes("rating_required") ? "推薦／勸退需填評分"
        : msg.includes("comment_required") ? "請輸入內容"
        : msg.includes("invite") ? "邀請碼無效或已用完"
        : "提交失敗：" + msg;
      return;
    }
    closeModal("suggestionModal");
    showToast("建議已提交，等 owner 審核");
    await loadAndRenderSuggestions(state.selectedPlaceId);
  }

  async function loadAndRenderSuggestions(placeId) {
    const listEl = $("suggestionList");
    const badgeEl = $("detailPendingBadge");
    listEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">載入中…</div>';
    badgeEl.style.display = "none";

    // anon RLS sees only approved. Owner sees all via _consume_invite RPC? No — RLS is fixed.
    // For pending visibility to owner we'd need a SECURITY DEFINER RPC; simpler: owner sees a separate RPC OR we relax RLS for owner-named header.
    // Current scope: anon sees approved only. Owner additionally sees pending by calling a dedicated RPC. For B2 minimal — we just show approved to everyone.
    // TODO: owner pending view via dedicated RPC. For now, owner sees same approved list and submits/reviews via direct UI in a later sub-pass.
    const { data: approved, error: e1 } = await sb
      .from("place_suggestions")
      .select("*")
      .eq("place_id", placeId)
      .eq("status", "approved")
      .order("created_at", { ascending: false });
    if (e1) { listEl.innerHTML = '<div class="list-empty">載入失敗</div>'; return; }

    let pending = [];
    if (state.role === "owner") {
      const { data: pData } = await sb.rpc("list_pending_suggestions", {
        p_invite_code: state.inviteCode,
        p_display_name: state.displayName,
        p_place_id: placeId,
      }).then(r => r, () => ({ data: [] }));
      pending = pData || [];
    }

    if (pending.length > 0) {
      badgeEl.textContent = `${pending.length} 待審`;
      badgeEl.style.display = "";
    }

    const all = [...pending, ...(approved || [])];
    if (all.length === 0) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:12px;">未有建議</div>';
      return;
    }

    listEl.innerHTML = all.map(s => {
      const typeLabel = SUG_TYPE_LABEL[s.type] || s.type;
      const rating = s.rating != null ? ` · ${"★".repeat(s.rating)}` : "";
      const statusBadge = s.status === "pending"
        ? '<span class="sug-badge pending">待審</span>' : "";
      const ownerActions = (state.role === "owner" && s.status === "pending")
        ? `<div class="sug-actions">
             <button class="btn primary" data-sg-id="${s.id}" data-act="approved">通過</button>
             <button class="btn" data-sg-id="${s.id}" data-act="rejected">拒絕</button>
           </div>`
        : "";
      return `
        <div class="suggestion">
          <div class="head">
            <span><span class="sug-badge ${s.type}">${typeLabel}</span>${rating} · ${escapeHtml(s.suggested_by_name)} ${statusBadge}</span>
            <span>${s.created_at.substring(0,10)}</span>
          </div>
          <div>${escapeHtml(s.comment)}</div>
          ${ownerActions}
        </div>
      `;
    }).join("");

    // wire owner buttons
    listEl.querySelectorAll("[data-sg-id]").forEach(btn => {
      btn.addEventListener("click", () => handleReviewSuggestion(btn.dataset.sgId, btn.dataset.act));
    });
  }

  async function handleReviewSuggestion(suggestionId, status) {
    if (state.role !== "owner") return;
    const { error } = await sb.rpc("review_place_suggestion", {
      p_invite_code: state.inviteCode,
      p_display_name: state.displayName,
      p_suggestion_id: suggestionId,
      p_status: status,
    });
    if (error) {
      showToast("審核失敗：" + error.message);
      return;
    }
    showToast(status === "approved" ? "已通過" : "已拒絕");
    await loadAndRenderSuggestions(state.selectedPlaceId);
  }

  // -----------------------------------------------------------
  // Photos
  // -----------------------------------------------------------
  const PHOTO_BUCKET = "food-map-photos";
  const PHOTO_PUBLIC_BASE = `${cfg.SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/`;
  state.pendingReviewPhoto = null; // {blob, contentType}

  // Resize image via canvas. maxDim 1600, JPEG quality 0.8. Returns Promise<Blob|null>.
  async function resizeImage(file, maxDim = 1600, quality = 0.8) {
    if (!file || !file.type || !file.type.startsWith("image/")) return null;
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = URL.createObjectURL(file);
    });
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const scale = Math.min(1, maxDim / Math.max(w0, h0));
    const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(img.src);
    return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  function photoUrl(storagePath) {
    return PHOTO_PUBLIC_BASE + storagePath;
  }

  async function uploadBlobToStorage(blob, storagePath) {
    const { error } = await sb.storage.from(PHOTO_BUCKET).upload(storagePath, blob, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (error) throw error;
    return storagePath;
  }

  function genPhotoFilename() {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}.jpg`;
  }

  async function handlePlacePhotoUpload(file) {
    if (state.role === "guest") { showToast("請先輸入邀請碼"); return; }
    if (!state.selectedPlaceId) return;
    const placeId = state.selectedPlaceId;
    const statusEl = $("placePhotoStatus");
    statusEl.textContent = "處理中…";
    try {
      const blob = await resizeImage(file);
      if (!blob) { statusEl.textContent = "格式不支援"; return; }
      if (blob.size > 2 * 1024 * 1024) {
        statusEl.textContent = `圖片太大 (${(blob.size/1024/1024).toFixed(2)}MB > 2MB)`;
        return;
      }
      statusEl.textContent = `上傳中… (${(blob.size/1024).toFixed(0)}KB)`;
      const fname = genPhotoFilename();
      const storagePath = `places/${placeId}/${fname}`;
      await uploadBlobToStorage(blob, storagePath);
      const { error } = await sb.rpc("add_place_photo", {
        p_invite_code: state.inviteCode,
        p_place_id: placeId,
        p_storage_path: storagePath,
        p_display_name: state.displayName,
      });
      if (error) throw new Error(error.message || error);
      statusEl.textContent = "已加入";
      setTimeout(() => statusEl.textContent = "", 2000);
      await loadAndRenderPlacePhotos(placeId);
    } catch (e) {
      statusEl.textContent = "上傳失敗：" + (e.message || e);
    }
  }

  async function loadAndRenderPlacePhotos(placeId) {
    const galleryEl = $("detailGallery");
    galleryEl.innerHTML = '<div class="gallery-empty">載入中…</div>';
    const { data, error } = await sb
      .from("place_photos")
      .select("id, storage_path, uploaded_by_name, created_at")
      .eq("place_id", placeId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) { galleryEl.innerHTML = '<div class="gallery-empty">載入失敗</div>'; return; }
    if (!data || data.length === 0) {
      galleryEl.innerHTML = '<div class="gallery-empty">未有照片</div>';
      return;
    }
    galleryEl.innerHTML = data.map(p => {
      const url = photoUrl(p.storage_path);
      const ownerDel = state.role === "owner" ? `<button class="photo-del" data-photo-id="${p.id}" title="刪除">×</button>` : "";
      return `<div class="photo" data-url="${escapeHtml(url)}"><img src="${escapeHtml(url)}" loading="lazy" /><div class="photo-meta">${escapeHtml(p.uploaded_by_name||"")}</div>${ownerDel}</div>`;
    }).join("");
    galleryEl.querySelectorAll(".photo").forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.classList.contains("photo-del")) return;
        openLightbox(el.dataset.url);
      });
    });
    galleryEl.querySelectorAll(".photo-del").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        if (!confirm("刪除呢張相？")) return;
        const { error } = await sb.rpc("delete_photo", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_photo_id: btn.dataset.photoId,
          p_kind: "place",
        });
        if (error) { showToast("刪除失敗：" + error.message); return; }
        showToast("已刪除");
        await loadAndRenderPlacePhotos(placeId);
      });
    });
  }

  function openLightbox(url) {
    $("photoLightboxImg").src = url;
    $("photoLightbox").classList.add("open");
  }

  // -----------------------------------------------------------
  // Modal helpers
  // -----------------------------------------------------------
  function openModal(id)  { $(id).classList.add("open"); }
  function closeModal(id) { $(id).classList.remove("open"); }

  // -----------------------------------------------------------
  // Utils
  // -----------------------------------------------------------
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  init();
})();
