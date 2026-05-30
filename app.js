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
  const CATEGORIES = [
    "拉麵","壽司","燒肉","燒鳥","天婦羅","居酒屋",
    "咖啡","甜品","博多料理","烏冬","丼飯","麵包",
    "住宿","景點","其他"
  ];

  // 分類 → emoji icon
  const CATEGORY_EMOJI = {
    "拉麵": "🍜", "壽司": "🍣", "燒肉": "🥩", "燒鳥": "🍗",
    "天婦羅": "🍤", "居酒屋": "🍶", "咖啡": "☕", "甜品": "🍰",
    "博多料理": "🍲", "烏冬": "🍜", "丼飯": "🍚", "麵包": "🥐",
    "住宿": "🏨", "景點": "📷", "其他": "🍽️"
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
  L.tileLayer(cfg.MAP_TILE_URL, { attribution: cfg.MAP_ATTRIBUTION, maxZoom: 19 }).addTo(map);
  const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 16, maxClusterRadius: 40 });
  map.addLayer(cluster);

  // Station layer (toggleable)
  const stationLayer = L.layerGroup();
  const stationMarkers = new Map(); // station_id -> marker

  // -----------------------------------------------------------
  // Init
  // -----------------------------------------------------------
  async function init() {
    populateCategorySelects();
    bindEvents();
    await loadTripAreas();
    // URL state 要喺 tripAreas load 完先 apply（要識 slug）
    restoreStateFromURL();
    await loadPlacesForCurrentArea();
    // restoreStateFromURL 已 set filter values，但要 applyFilters 一次
    applyFilters();
    // 背景 load 站點，唔阻主流程
    loadStations().catch(err => console.warn("loadStations failed", err));
    // PWA: register service worker
    registerServiceWorker().catch(err => console.warn("SW reg failed", err));
    setupOnlineStatus();
  }

  // -----------------------------------------------------------
  // PWA / offline
  // -----------------------------------------------------------
  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
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
    const cat = params.get("cat");  if (cat) categoryFilter.value = cat;
    const price = params.get("price"); if (price) priceFilter.value = price;
    const sort = params.get("sort");   if (sort) { $("sortBy").value = sort; state.sortBy = sort; }
    const open = params.get("open");   if (open) { $("openFilter").value = open; state.openFilter = open; }
    const bm = params.get("bm");       if (bm) { $("bookmarkFilter").value = bm; state.bookmarkFilter = bm; }
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
    for (const c of CATEGORIES) {
      const o1 = new Option(c, c); categoryFilter.appendChild(o1);
      const o2 = new Option(c, c); $("pmCategory").appendChild(o2);
    }
  }

  function bindEvents() {
    tripAreaSelect.addEventListener("change", async () => {
      state.currentTripAreaSlug = tripAreaSelect.value;
      await loadPlacesForCurrentArea();
      if (state.showStations) renderStationMarkers();
    });
    searchInput.addEventListener("input", applyFilters);
    categoryFilter.addEventListener("change", applyFilters);
    priceFilter.addEventListener("change", applyFilters);

    $("openFilter").addEventListener("change", (e) => {
      state.openFilter = e.target.value;
      applyFilters();
    });
    $("bookmarkFilter").addEventListener("change", (e) => {
      state.bookmarkFilter = e.target.value;
      applyFilters();
    });
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

    // 地圖中心模式 anchor：拖動地圖要重新計
    map.on("moveend", () => {
      if (!state.walking.enabled) return;
      const mapAnchors = state.walking.anchors.filter(a => a.mode === "map");
      if (mapAnchors.length === 0) return;
      const c = map.getCenter();
      for (const a of mapAnchors) { a.lat = c.lat; a.lng = c.lng; }
      renderAnchorList();
      updateWalkingUI();
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

    $("detailClose").addEventListener("click", () => $("detailPanel").classList.remove("open"));
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
  async function loadPlacesForCurrentArea() {
    centerMapOnCurrentArea();
    const ta = state.tripAreas.find(t => t.slug === state.currentTripAreaSlug);
    if (!ta) { state.places = []; applyFilters(); return; }

    const { data, error } = await sb
      .from("places")
      .select("*")
      .eq("trip_area_id", ta.id)
      .eq("is_archived", false)
      .order("created_at", { ascending: false });
    if (error) { console.error(error); return; }
    state.places = data || [];
    applyFilters();
  }

  function applyFilters() {
    const q = searchInput.value.trim().toLowerCase();
    const cat = categoryFilter.value;
    const price = priceFilter.value;

    // 步行圈：AND filter、取 max distance 作為「最差頂 anchor」
    const w = state.walking;
    const validAnchors = w.enabled
      ? w.anchors.filter(a => a.lat != null && a.lng != null)
      : [];
    const radiusM = validAnchors.length > 0 ? w.minutes * WALK_METRES_PER_MIN : null;

    state.filtered = state.places.filter(p => {
      if (cat && p.category !== cat) return false;
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

    // Sorting
    applySort(radiusM != null);

    renderList();
    renderMarkers();
    renderWalkingCircles();
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

  function renderList() {
    if (state.filtered.length === 0) {
      const msg = state.walking.enabled
        ? "呢個步行圈內未有地點"
        : "未有地點，可以由你開始新增";
      placeListEl.innerHTML = `<div class="list-empty">${msg}</div>`;
      return;
    }
    placeListEl.innerHTML = "";
    const now = new Date();
    for (const p of state.filtered) {
      const div = document.createElement("div");
      div.className = "place-item" + (p.id === state.selectedPlaceId ? " active" : "");
      const metaParts = [p.category, p.region, p.price_level].filter(Boolean);
      if (p._distance_m != null) {
        const mins = Math.max(1, Math.round(p._distance_m / WALK_METRES_PER_MIN));
        metaParts.push(`步行 ${mins} 分 (${Math.round(p._distance_m)}m)`);
      }
      const meta = metaParts.join(" · ");
      const tags = (p.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      const bm = getBookmark(p.id);
      const bmIcon = bm ? `<span class="bookmark-icon">${BOOKMARK_ICON[bm]}</span>` : "";
      // 營業狀態 badge
      const openNow = isOpenAt(p, now);
      let openBadge = "";
      if (openNow === true) openBadge = '<span class="badge-open open">營業中</span>';
      else if (openNow === false) openBadge = '<span class="badge-open closed">休息</span>';
      div.innerHTML = `
        <div class="name">${bmIcon}${escapeHtml(p.name)}${openBadge}</div>
        <div class="meta">${escapeHtml(meta)}</div>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      `;
      div.addEventListener("click", () => openPlaceDetail(p.id));
      placeListEl.appendChild(div);
    }
  }

  function renderMarkers() {
    cluster.clearLayers();
    state.markers.clear();
    for (const p of state.filtered) {
      if (p.lat == null || p.lng == null) continue;
      const emoji = CATEGORY_EMOJI[p.category] || DEFAULT_EMOJI;
      const bm = getBookmark(p.id);
      const bmClass = bm ? ` bookmark-${bm}` : "";
      const icon = L.divIcon({
        className: "emoji-marker",
        html: `<div class="emoji-marker-inner${bmClass}"><span>${emoji}</span></div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -32],
      });
      const m = L.marker([p.lat, p.lng], { icon });
      m.bindTooltip(p.name);
      m.on("click", () => openPlaceDetail(p.id));
      state.markers.set(p.id, m);
      cluster.addLayer(m);
    }
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
    if (state.walking.enabled) applyFilters();
  }

  function removeAnchor(id) {
    state.walking.anchors = state.walking.anchors.filter(a => a.id !== id);
    state.walking.lastError = null;
    renderAnchorList();
    updateWalkingUI();
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
    try {
      const res = await fetch("./data/stations.json", { cache: "force-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.stations = data.stations || [];
      renderAnchorList(); // 重新 enable 車站 btn
      if (state.showStations) renderStationMarkers();
    } catch (err) {
      console.warn("loadStations error:", err);
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

    if (w.lastError) {
      statusEl.textContent = w.lastError;
      statusEl.classList.add("error");
      return;
    }

    const radius = w.minutes * WALK_METRES_PER_MIN;
    const n = w.anchors.filter(a => a.lat != null).length;
    const suffix = n === 0 ? "· 未有起點"
                : n === 1 ? "· 1 個起點"
                : `· ${n} 個起點（同時要係範圍內）`;
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
    $("detailName").innerHTML = `${emoji} ${escapeHtml(p.name)}`;
    $("detailMeta").textContent = [
      p.category, p.region, p.price_level,
      p.google_rating ? `Google ${p.google_rating}` : null,
      p.tabelog_rating ? `Tabelog ${p.tabelog_rating}` : null
    ].filter(Boolean).join(" · ");

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

    renderBookmarkButtons();

    $("detailPanel").classList.add("open");
    if (p.lat && p.lng) map.panTo([p.lat, p.lng]);
    renderList(); // refresh active state

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

    const place = {
      name,
      category: $("pmCategory").value || null,
      region: $("pmRegion").value.trim() || null,
      price_level: $("pmPrice").value || null,
      lat, lng,
      tags,
      note: $("pmNote").value.trim() || null,
      google_url: $("pmGoogleUrl").value.trim() || null,
      tabelog_url: $("pmTabelogUrl").value.trim() || null,
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
