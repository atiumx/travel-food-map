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
  };

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
    await loadPlacesForCurrentArea();
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
      return true;
    });

    renderList();
    renderMarkers();
  }

  function renderList() {
    if (state.filtered.length === 0) {
      placeListEl.innerHTML = '<div class="list-empty">未有地點，可以由你開始新增</div>';
      return;
    }
    placeListEl.innerHTML = "";
    for (const p of state.filtered) {
      const div = document.createElement("div");
      div.className = "place-item" + (p.id === state.selectedPlaceId ? " active" : "");
      const meta = [p.category, p.region, p.price_level].filter(Boolean).join(" · ");
      const tags = (p.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
      div.innerHTML = `
        <div class="name">${escapeHtml(p.name)}</div>
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
      const m = L.marker([p.lat, p.lng]);
      m.bindTooltip(p.name);
      m.on("click", () => openPlaceDetail(p.id));
      state.markers.set(p.id, m);
      cluster.addLayer(m);
    }
  }

  // -----------------------------------------------------------
  // Place detail + reviews
  // -----------------------------------------------------------
  async function openPlaceDetail(placeId) {
    state.selectedPlaceId = placeId;
    const p = state.places.find(x => x.id === placeId);
    if (!p) return;

    $("detailName").textContent = p.name;
    $("detailMeta").textContent = [
      p.category, p.region, p.price_level,
      p.google_rating ? `Google ${p.google_rating}` : null,
      p.tabelog_rating ? `Tabelog ${p.tabelog_rating}` : null
    ].filter(Boolean).join(" · ");
    $("detailNote").textContent = p.note || "";

    const links = [];
    if (p.google_url)    links.push(`<a href="${p.google_url}" target="_blank" rel="noopener">Google</a>`);
    if (p.tabelog_url)   links.push(`<a href="${p.tabelog_url}" target="_blank" rel="noopener">Tabelog</a>`);
    if (p.instagram_url) links.push(`<a href="${p.instagram_url}" target="_blank" rel="noopener">IG</a>`);
    if (p.facebook_url)  links.push(`<a href="${p.facebook_url}" target="_blank" rel="noopener">FB</a>`);
    if (p.blog_url)      links.push(`<a href="${p.blog_url}" target="_blank" rel="noopener">Blog</a>`);
    $("detailLinks").innerHTML = links.join("");

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
