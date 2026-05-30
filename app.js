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
      anchors: [],           // [{ id, mode:"map"|"geo"|"place", lat, lng, label, placeId?, color }]
      lastError: null,
    },
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
        const icon = a.mode === "map" ? "🎯" : a.mode === "geo" ? "📍" : "📌";
        return `
          <div class="anchor-item" data-id="${a.id}">
            <span class="anchor-color" style="color:${a.color};"></span>
            <span class="anchor-label">${icon} ${escapeHtml(a.label)}</span>
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
    } else {
      listEl.innerHTML = data.map(r => `
        <div class="review">
          <div class="head">
            <span>${escapeHtml(r.display_name)}${r.rating != null ? ` · ★${r.rating}` : ""}</span>
            <span>${r.visit_date || r.created_at.substring(0,10)}</span>
          </div>
          <div>${escapeHtml(r.comment)}</div>
        </div>
      `).join("");
    }
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

    closeModal("reviewModal");
    $("rmRating").value = ""; $("rmComment").value = ""; $("rmVisitDate").value = "";
    await openPlaceDetail(state.selectedPlaceId);
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
