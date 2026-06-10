// =============================================================
// Travel Food Map — Feature B (place submissions)
// 拆出 from app.js v1.0.67 (issue #11 sub-module split)
// 依賴 window.AppShared (由 app.js 設定)
// =============================================================
(function () {
  "use strict";
  if (!window.AppShared) { console.error("[feature-b] window.AppShared 未就緒，唔可以 load"); return; }
  // Only destructure what FeatureB doesn't already shadow internally.
  // FeatureB has its own relTime / urlSourceLabel / $$ — keep them inline.
  const { cfg, sb, state, escapeHtml, showToast, openModal, closeModal,
          appDialog } = window.AppShared;
  // map 係 const，要 lazy 取 via getter
  function _getMap() { return window.AppShared.map; }

    const RESOLVE_FN_URL = cfg.SUPABASE_URL + "/functions/v1/resolve-submission";
    let _submitRating = 0;            // 📨 submit modal 嘅 current rating selection
    let _currentResolve = null;       // { submission, resolvedData, notes, manualFill }
    let _lastSubmissionId = null;     // for debug pane
    let _debugObserver = null;
    let _pendingListCache = [];       // v1.0.64 Push 3: cache for 🔄 bulk resolve
    let _bulkResolveRunning = false;  // v1.0.64 Push 3: guard against double-click
    let _bulkAbortRequested = false;  // v1.0.65 #7: 中斷旗
    let _mySubmissionsCache = null;   // v1.0.65 #6: cache to avoid refetch every open
    let _mySubFilterStatus = "all";   // v1.0.65 #9: client-side status filter

    // ----- helpers -----
    function $$(id) { return document.getElementById(id); }
    function showMsg(el, txt, kind) {
      if (!el) return;
      el.textContent = txt;
      el.className = "onboarding-msg " + (kind || "");
      el.hidden = false;
    }
    function clearMsg(el) { if (el) { el.hidden = true; el.textContent = ""; } }
    function relTime(iso) {
      if (!iso) return "";
      const t = new Date(iso).getTime();
      const diff = Date.now() - t;
      const m = Math.floor(diff / 60000);
      if (m < 1) return "刚刚";
      if (m < 60) return m + " 分鐘前";
      const h = Math.floor(m / 60);
      if (h < 24) return h + " 小時前";
      const d = Math.floor(h / 24);
      if (d < 7) return d + " 日前";
      return new Date(iso).toLocaleDateString("zh-HK");
    }
    function urlSourceLabel(src) {
      if (src === "google_maps") return "Google Maps";
      if (src === "tabelog") return "Tabelog";
      if (src === "openrice") return "OpenRice";
      return src || "unknown";
    }

    // ============================================================
    // 📨 推薦地點 modal
    // ============================================================
    function openSubmitModal() {
      if (state.role === "guest") { showToast("請先輸入邀請碼"); return; }
      $$("submitUrl").value = "";
      $$("submitComment").value = "";
      _submitRating = 0;
      _refreshRatingButtons();
      clearMsg($$("submitMsg"));
      openModal("submitModal");
    }
    function _refreshRatingButtons() {
      const btns = document.querySelectorAll("#submitRatingRow .emoji-rating-btn");
      btns.forEach(b => {
        const r = parseInt(b.dataset.rating, 10);
        if (r === _submitRating) {
          b.style.background = "#ffd54f";
          b.style.borderColor = "#f9a825";
          b.style.fontWeight = "bold";
        } else {
          b.style.background = "transparent";
          b.style.borderColor = "var(--border, #ddd)";
          b.style.fontWeight = "normal";
        }
      });
    }
    async function _submitConfirm() {
      const url = $$("submitUrl").value.trim();
      const msgEl = $$("submitMsg");
      clearMsg(msgEl);
      if (!url) { showMsg(msgEl, "請貼上餐廳 link", "err"); return; }
      if (!/^https?:\/\//i.test(url)) { showMsg(msgEl, "link 格式不正確（需 http:// 或 https://）", "err"); return; }
      if (_submitRating < 1 || _submitRating > 5) { showMsg(msgEl, "請選一個評分", "err"); return; }
      const comment = $$("submitComment").value.trim() || null;
      const btn = $$("submitConfirm");
      btn.disabled = true; btn.textContent = "送出中…";
      try {
        const { data, error } = await sb.rpc("submit_place_submission", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_raw_url: url,
          p_recommendation: _submitRating,
          p_comment: comment
        });
        if (error) throw error;
        _lastSubmissionId = data;
        showToast("✓ 已送出，等 HM 審核");
        closeModal("submitModal");
        refreshDebugPane();
      } catch (e) {
        showMsg(msgEl, "送出失敗：" + (e.message || String(e)), "err");
      } finally {
        btn.disabled = false; btn.textContent = "送出";
      }
    }

    // ============================================================
    // 🆕 最近朋友推薦 modal
    // ============================================================
    async function openRecentFriendModal() {
      openModal("recentFriendModal");
      const listEl = $$("recentFriendList");
      listEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">載入中…</div>';
      try {
        // Find current trip_area_id from slug
        const ta = state.tripAreas.find(t => t.slug === state.currentTripAreaSlug);
        if (!ta) { listEl.innerHTML = '<div style="color:#c33;padding:12px;">trip_area 未載入</div>'; return; }
        // Direct REST query (no RPC needed; both tables anon-readable)
        const { data: places, error } = await sb
          .from("places")
          .select("id,name,region,trip_area_id,lat,lng,price_level,google_rating,tabelog_rating,source,created_by,created_at,tabelog_url,openrice_url,google_url,address")
          .eq("trip_area_id", ta.id)
          .like("source", "submission:%")
          .eq("is_archived", false)
          .eq("is_hidden", false)
          .order("created_at", { ascending: false })
          .limit(30);
        if (error) throw error;
        if (!places || places.length === 0) {
          listEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">什麼朋友都佛未推薦過這條 trip。</div>';
          return;
        }
        // Fetch reviews for these places (auto-created on approve)
        const placeIds = places.map(p => p.id);
        const { data: reviews } = await sb
          .from("reviews")
          .select("place_id,display_name,rating,comment,visit_date")
          .in("place_id", placeIds)
          .eq("is_hidden", false);
        const reviewByPlace = {};
        (reviews || []).forEach(r => {
          // prefer review matching created_by (the submission's auto-review)
          if (!reviewByPlace[r.place_id]) reviewByPlace[r.place_id] = r;
        });
        listEl.innerHTML = places.map(p => _renderRecentCard(p, reviewByPlace[p.id])).join("");
        // wire 「在地圖看」 buttons
        listEl.querySelectorAll("[data-flyto]").forEach(btn => {
          btn.addEventListener("click", (e) => {
            const pid = e.currentTarget.dataset.flyto;
            const p = places.find(x => x.id === pid);
            const m = _getMap();
            if (p && m && p.lat && p.lng) {
              closeModal("recentFriendModal");
              m.flyTo([p.lat, p.lng], Math.max(m.getZoom(), 15), { duration: 0.6 });
              state.selectedPlaceId = p.id;
            }
          });
        });
      } catch (e) {
        listEl.innerHTML = '<div style="color:#c33;padding:12px;">載入失敗：' + escapeHtml(e.message || String(e)) + '</div>';
      }
    }
    function _renderRecentCard(p, review) {
      const src = (p.source || "").replace("submission:", "");
      const srcLabel = urlSourceLabel(src);
      const rating = review && review.rating ? "⭐".repeat(review.rating) : "";
      const author = (review && review.display_name) || p.created_by || "朋友";
      const comment = (review && review.comment) ? '<div style="margin-top:4px;color:#444;font-size:13px;font-style:italic;">「' + escapeHtml(review.comment) + '」</div>' : "";
      const extLink = p.tabelog_url || p.openrice_url || p.google_url || "";
      const extBtn = extLink ? '<a href="' + escapeHtml(extLink) + '" target="_blank" rel="noopener" style="font-size:11px;color:#06c;text-decoration:none;margin-left:8px;">↗ ' + srcLabel + '</a>' : "";
      const priceStr = p.price_level ? ' · ' + escapeHtml(p.price_level) : "";
      const regionStr = p.region ? escapeHtml(p.region) : "";
      return `
        <div style="border:1px solid var(--border,#ddd);border-radius:8px;padding:10px;">
          <div style="font-weight:600;font-size:14px;">${escapeHtml(p.name)}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">${regionStr}${priceStr}</div>
          <div style="margin-top:6px;font-size:13px;">${rating} <strong>${escapeHtml(author)}</strong> <span style="color:#888;font-size:11px;">· ${relTime(p.created_at)}</span></div>
          ${comment}
          <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
            <button class="btn" data-flyto="${p.id}" style="font-size:12px;padding:4px 10px;">📍 在地圖看</button>
            ${extBtn}
          </div>
        </div>`;
    }

    // ============================================================
    // 🌟 待審核推薦 (pending list) modal — owner only
    // ============================================================
    async function openPendingListModal() {
      if (state.role !== "owner") { showToast("僅 owner 可見"); return; }
      openModal("pendingListModal");
      const bodyEl = $$("pendingListBody");
      bodyEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">載入中…</div>';
      try {
        const { data, error } = await sb.rpc("list_pending_submissions", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName
        });
        if (error) throw error;
        if (!data || data.length === 0) {
          _pendingListCache = [];
          bodyEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">未見到待審核 submission</div>';
          _updateBulkBarStatus();
          return;
        }
        _pendingListCache = data;
        bodyEl.innerHTML = data.map(s => _renderPendingRow(s)).join("");
        bodyEl.querySelectorAll("[data-pid]").forEach(row => {
          row.addEventListener("click", () => {
            const sid = row.dataset.pid;
            const s = _pendingListCache.find(x => x.id === sid);
            if (s) openResolveModal(s);
          });
        });
        // v1.0.64 Push 3: update bulk bar status with counts of resolvable rows
        _updateBulkBarStatus();
      } catch (e) {
        bodyEl.innerHTML = '<div style="color:#c33;padding:12px;">載入失敗：' + escapeHtml(e.message || String(e)) + '</div>';
      }
    }
    // v1.0.65 #4: 統一 status 色/label map (与 my-submissions 共用)
    const STATUS_META = {
      pending:         { color: "#888", label: "未解析"   },
      resolved:        { color: "#06c", label: "待審核"   },
      resolve_failed:  { color: "#c95", label: "解析失敗" },
      approved:        { color: "#0a0", label: "已批准"   },
      rejected:        { color: "#c33", label: "已拒絕"   }
    };
    function _statusBadge(status) {
      const sm = STATUS_META[status] || { color: "#888", label: status };
      return { color: sm.color, label: sm.label };
    }
    function _renderPendingRow(s) {
      const sm = _statusBadge(s.status);
      const errStr = s.resolver_error ? '<span style="color:#c33;font-size:11px;"> · ' + escapeHtml(s.resolver_error.slice(0, 50)) + '</span>' : "";
      const ratingStr = s.recommendation ? "⭐".repeat(s.recommendation) : "";
      return `
        <div data-pid="${s.id}" class="submission-row clickable">
          <div class="sub-row-flex">
            <div style="flex:1;min-width:0;">
              <div class="sub-meta">${urlSourceLabel(s.url_source)} · ${escapeHtml(s.submitted_by_name)} · ${relTime(s.created_at)}</div>
              <div class="sub-url">${escapeHtml(s.raw_url)}</div>
              <div class="sub-rating">${ratingStr}${s.comment ? ' 「' + escapeHtml(s.comment) + '」' : ''}</div>
            </div>
            <div class="sub-status" style="color:${sm.color};">${sm.label}${errStr}</div>
          </div>
        </div>`;
    }

    // ============================================================
    // Resolve / approve detail modal
    // ============================================================
    async function openResolveModal(submission) {
      _currentResolve = { submission, resolvedData: null, notes: [], manualFill: false };
      $$("resolveSubmissionHeader").innerHTML =
        '<div style="font-size:11px;color:#888;">' + urlSourceLabel(submission.url_source) + ' · ' + escapeHtml(submission.submitted_by_name) + ' · ' + relTime(submission.created_at) + '</div>' +
        '<div style="font-size:13px;margin-top:4px;overflow-wrap:anywhere;"><a href="' + escapeHtml(submission.raw_url) + '" target="_blank" rel="noopener" style="color:#06c;">' + escapeHtml(submission.raw_url) + '</a></div>' +
        (submission.comment ? '<div style="font-size:12px;margin-top:4px;color:#444;font-style:italic;">「' + escapeHtml(submission.comment) + '」</div>' : "") +
        (submission.recommendation ? '<div style="font-size:12px;margin-top:4px;">' + "⭐".repeat(submission.recommendation) + '</div>' : "");
      $$("resolveStatusRow").textContent = "status: " + submission.status + (submission.resolver_error ? " · error: " + submission.resolver_error : "");
      $$("resolveDataPreview").hidden = true;
      $$("resolveManualFill").hidden = true;
      $$("resolveApprovalSection").hidden = true;
      $$("resolveApproveBtn").disabled = true;
      clearMsg($$("resolveMsg"));
      openModal("resolveModal");

      // Always call Edge Function to resolve (lazy resolve)
      $$("resolveLoading").hidden = false;
      try {
        const r = await fetch(RESOLVE_FN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
            "apikey": cfg.SUPABASE_ANON_KEY
          },
          body: JSON.stringify({ submission_id: submission.id })
        });
        const result = await r.json();
        if (!r.ok) throw new Error(result.error || ("HTTP " + r.status));
        _currentResolve.resolvedData = result.resolved || {};
        _currentResolve.notes = result.notes || [];
        $$("resolveLoading").hidden = true;
        _renderResolvedPreview();
      } catch (e) {
        $$("resolveLoading").hidden = true;
        showMsg($$("resolveMsg"), "Edge Function 解析失敗：" + (e.message || String(e)), "err");
      }
    }
    function _renderResolvedPreview() {
      const d = _currentResolve.resolvedData || {};
      const notes = _currentResolve.notes || [];
      const manualNeeded = notes.includes("manual_fill_required");
      _currentResolve.manualFill = manualNeeded;

      const fields = [
        ["name", d.name],
        ["lat / lng", (d.lat != null && d.lng != null) ? (d.lat + ", " + d.lng) : null],
        ["address", d.address],
        ["region", d.region],
        ["price", d.price_level],
        ["cuisine_group", d.cuisine_group],
        ["google_rating", d.google_rating],
        ["tabelog_rating", d.tabelog_rating],
        ["openrice_poi_id", d.openrice_poi_id],
        ["phone", d.phone]
      ].filter(([k, v]) => v != null && v !== "");
      $$("resolveDataFields").innerHTML = fields.map(([k, v]) =>
        '<div><strong>' + k + ':</strong> ' + escapeHtml(String(v)) + '</div>'
      ).join("");
      $$("resolveDataPreview").hidden = false;
      if (notes.length > 0) {
        $$("resolveNotes").hidden = false;
        $$("resolveNotes").textContent = "notes: " + notes.join(", ");
      }

      // Show manual fill if OpenRice blocked
      if (manualNeeded) {
        $$("resolveManualFill").hidden = false;
        $$("resolveFillName").value = d.name || "";
        $$("resolveFillLat").value = d.lat || "";
        $$("resolveFillLng").value = d.lng || "";
        $$("resolveFillAddress").value = d.address || "";
        $$("resolveFillRegion").value = d.region || "";
      }

      // Populate trip_area dropdown
      const taSelect = $$("resolveTripArea");
      taSelect.innerHTML = state.tripAreas.map(ta =>
        '<option value="' + ta.slug + '">' + escapeHtml(ta.label_zh || ta.slug) + '</option>'
      ).join("");
      // Default trip_area: detected_trip_area_slug → current → first
      const detectSlug = _currentResolve.submission.detected_trip_area_slug;
      const defaultSlug = detectSlug || state.currentTripAreaSlug || (state.tripAreas[0] && state.tripAreas[0].slug);
      if (defaultSlug) taSelect.value = defaultSlug;

      // cuisine_group dropdown
      const cgSelect = $$("resolveCuisineGroup");
      const cuisineGroups = ["japanese","chinese","korean","southeast_asian","western","cafe_dessert","bar_drink","other"];
      cgSelect.innerHTML = cuisineGroups.map(cg => '<option value="' + cg + '">' + cg + '</option>').join("");
      cgSelect.value = d.cuisine_group || "other";

      $$("resolveApprovalSection").hidden = false;
      $$("resolveApproveBtn").disabled = false;
    }
    async function _resolveApprove() {
      if (!_currentResolve) return;
      const d = _currentResolve.resolvedData || {};
      const msgEl = $$("resolveMsg");
      clearMsg(msgEl);

      // Merge manual fill if applicable
      const resolved = Object.assign({}, d);
      if (_currentResolve.manualFill) {
        const fillName = $$("resolveFillName").value.trim();
        const fillLat = parseFloat($$("resolveFillLat").value);
        const fillLng = parseFloat($$("resolveFillLng").value);
        if (!fillName) { showMsg(msgEl, "請填名稱", "err"); return; }
        if (isNaN(fillLat) || isNaN(fillLng)) { showMsg(msgEl, "請填有效 lat/lng", "err"); return; }
        resolved.name = fillName;
        resolved.lat = fillLat;
        resolved.lng = fillLng;
        const fillAddr = $$("resolveFillAddress").value.trim();
        const fillRegion = $$("resolveFillRegion").value.trim();
        if (fillAddr) resolved.address = fillAddr;
        if (fillRegion) resolved.region = fillRegion;
      }

      // Owner override: trip_area + cuisine_group
      resolved.trip_area_slug = $$("resolveTripArea").value;
      resolved.cuisine_group = $$("resolveCuisineGroup").value;

      const btn = $$("resolveApproveBtn");
      btn.disabled = true; btn.textContent = "批准中…";
      try {
        const { data, error } = await sb.rpc("approve_submission", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_submission_id: _currentResolve.submission.id,
          p_resolved: resolved
        });
        if (error) throw error;
        showToast("✓ 已批准，新增 place: " + (data || ""));
        closeModal("resolveModal");
        // Refresh pending list
        openPendingListModal();
        // Reload main map places (force reload by calling whichever loader exists)
        if (typeof loadPlaces === "function") loadPlaces();
        else if (typeof reloadPlaces === "function") reloadPlaces();
      } catch (e) {
        showMsg(msgEl, "批准失敗：" + (e.message || String(e)), "err");
      } finally {
        btn.disabled = false; btn.textContent = "批准上地圖";
      }
    }
    async function _resolveReject() {
      if (!_currentResolve) return;
      // v1.0.65 #8: 拒絕原因 modal + preset chips
      const reason = await appDialog.prompt({
        title: "拒絕推薦",
        message: "可選填寫拒絕原因（會顯示給 submitter 看）。",
        defaultValue: "",
        placeholder: "例：重複地點 / 離地圖太遠 / 資料不全",
        multiline: true,
        presetChips: ["重複地點", "離地圖太遠", "資料不全", "不合適上地圖"],
        okText: "拒絕",
        danger: true
      });
      if (reason === null) return; // cancelled
      const msgEl = $$("resolveMsg");
      const btn = $$("resolveRejectBtn");
      btn.disabled = true; btn.textContent = "拒絕中…";
      try {
        const { error } = await sb.rpc("reject_submission", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_submission_id: _currentResolve.submission.id,
          p_reason: reason || null
        });
        if (error) throw error;
        showToast("✓ 已拒絕");
        closeModal("resolveModal");
        openPendingListModal();
      } catch (e) {
        showMsg(msgEl, "拒絕失敗：" + (e.message || String(e)), "err");
      } finally {
        btn.disabled = false; btn.textContent = "拒絕";
      }
    }

    // ============================================================
    // v1.0.64 Push 3: 🔄 全部 resolve (bulk lazy-resolve pending + resolve_failed)
    // ============================================================
    function _updateBulkBarStatus() {
      const span = $$("pendingListBulkStatus");
      const btn = $$("pendingListBulkResolveBtn");
      if (!span || !btn) return;
      const resolvable = _pendingListCache.filter(s =>
        s.status === "pending" || s.status === "resolve_failed"
      );
      const total = _pendingListCache.length;
      if (_bulkResolveRunning) {
        // running 時 button 變 abort
        return;
      }
      span.textContent = total === 0 ? "" : ("可 resolve: " + resolvable.length + " / " + total);
      btn.textContent = "🔄 全部 resolve";
      btn.disabled = (resolvable.length === 0);
    }
    async function _bulkResolve() {
      // v1.0.65 #7: 如果已經 running, click 就變 abort
      if (_bulkResolveRunning) {
        _bulkAbortRequested = true;
        const btn = $$("pendingListBulkResolveBtn");
        if (btn) { btn.disabled = true; btn.textContent = "⏹ 停止中…"; }
        return;
      }
      const targets = _pendingListCache.filter(s =>
        s.status === "pending" || s.status === "resolve_failed"
      );
      if (targets.length === 0) { showToast("沒有需要 resolve 嘅 submission"); return; }
      const ok0 = await appDialog.confirm({
        title: "全部 resolve",
        message: "將對 " + targets.length + " 條 submission 逐個呼叫 Edge Function，\n預計用 " + Math.round(targets.length * 1.5) + " 秒。\n\n進行中可以 click 同一個按鈕中斷。",
        okText: "開始",
        cancelText: "取消"
      });
      if (!ok0) return;

      _bulkResolveRunning = true;
      _bulkAbortRequested = false;
      const btn = $$("pendingListBulkResolveBtn");
      const span = $$("pendingListBulkStatus");
      if (btn) { btn.disabled = false; btn.textContent = "⏹ 停"; }
      let ok = 0, fail = 0, aborted = 0;
      for (let i = 0; i < targets.length; i++) {
        if (_bulkAbortRequested) {
          aborted = targets.length - i;
          break;
        }
        const s = targets[i];
        if (span) span.textContent = "正在解析 " + (i + 1) + " / " + targets.length + "…";
        try {
          const r = await fetch(RESOLVE_FN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
              "apikey": cfg.SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ submission_id: s.id })
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.error || ("HTTP " + r.status));
          }
          ok++;
        } catch (e) {
          fail++;
          console.warn("bulk resolve failed for", s.id, e);
        }
        // 1.5s gap between calls to be nice to Edge Function + 3rd-party APIs
        if (i < targets.length - 1 && !_bulkAbortRequested) {
          await new Promise(res => setTimeout(res, 1500));
        }
      }
      _bulkResolveRunning = false;
      _bulkAbortRequested = false;
      const summary = aborted > 0
        ? ("中斷：成功 " + ok + " · 失敗 " + fail + " · 未處理 " + aborted)
        : ("完成：成功 " + ok + " · 失敗 " + fail);
      if (span) span.textContent = summary;
      // Refresh pending list to reflect updated statuses
      try { await openPendingListModal(); } catch (e) { /* modal stays open */ }
      showToast("bulk resolve " + summary);
    }

    // ============================================================
    // v1.0.64 Push 3: 📋 我嘅推薦 modal (friend + owner) — self-query via list_my_submissions RPC
    // ============================================================
    async function openMySubmissionsModal(forceRefresh = false) {
      if (state.role === "guest") { showToast("請先輸入邀請碼"); return; }
      openModal("mySubmissionsModal");
      const bodyEl = $$("mySubmissionsBody");
      // v1.0.65 #6: use cache if available and not forced
      if (!forceRefresh && _mySubmissionsCache && Array.isArray(_mySubmissionsCache)) {
        _renderMySubmissionsFiltered();
        return;
      }
      bodyEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">載入中…</div>';
      try {
        const { data, error } = await sb.rpc("list_my_submissions", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName
        });
        if (error) throw error;
        _mySubmissionsCache = data || [];
        _renderMySubmissionsFiltered();
      } catch (e) {
        _mySubmissionsCache = null;
        bodyEl.innerHTML = '<div style="color:#c33;padding:12px;">載入失敗：' + escapeHtml(e.message || String(e)) + '</div>';
      }
    }
    // v1.0.65 #6/#9: render from cache with current filter applied
    function _renderMySubmissionsFiltered() {
      const bodyEl = $$("mySubmissionsBody");
      if (!bodyEl || !_mySubmissionsCache) return;
      const all = _mySubmissionsCache;
      const filtered = (_mySubFilterStatus === "all")
        ? all
        : all.filter(s => s.status === _mySubFilterStatus);
      if (filtered.length === 0) {
        const emptyMsg = (_mySubFilterStatus === "all")
          ? "你還未 submit 過任何推薦"
          : ("沒有「" + (STATUS_META[_mySubFilterStatus] ? STATUS_META[_mySubFilterStatus].label : _mySubFilterStatus) + "」狀態嘅推薦");
        bodyEl.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">' + escapeHtml(emptyMsg) + '</div>';
        return;
      }
      bodyEl.innerHTML = filtered.map(s => _renderMySubmissionRow(s)).join("");
      // Wire flyTo for approved place links
      bodyEl.querySelectorAll("[data-flyto-pid]").forEach(a => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const pid = a.dataset.flytoPid;
          const p = (state.places || []).find(x => x.id === pid);
          if (p && _getMap() && p.lat != null && p.lng != null) {
            closeModal("mySubmissionsModal");
            _getMap().flyTo([p.lat, p.lng], 17, { duration: 0.6 });
            if (typeof state !== "undefined") state.selectedPlaceId = p.id;
          } else {
            showToast("找不到 place 或地圖未初始化");
          }
        });
      });
    }
    function _renderMySubmissionRow(s) {
      // v1.0.65 #4/#5: 使用共用 STATUS_META + .submission-row utility class
      const sm = _statusBadge(s.status);
      const ratingStr = s.recommendation ? "⭐".repeat(s.recommendation) : "";
      const tripStr = s.detected_trip_area_slug ? ' · ' + escapeHtml(s.detected_trip_area_slug) : "";

      // Status-dependent extra row
      let extra = "";
      if (s.status === "approved" && s.approved_place_id) {
        const placeLabel = escapeHtml(s.approved_place_name || s.approved_place_id);
        const taStr = s.approved_place_trip_area_slug ? ' (' + escapeHtml(s.approved_place_trip_area_slug) + ')' : "";
        extra = '<div class="sub-extra"><a href="#" data-flyto-pid="' + escapeHtml(s.approved_place_id) + '" class="link-flyto">📍 ' + placeLabel + taStr + ' → 在地圖看</a></div>';
      } else if (s.status === "rejected" && s.rejected_reason) {
        extra = '<div class="sub-extra sub-extra-err">拒絕原因：' + escapeHtml(s.rejected_reason) + '</div>';
      } else if (s.status === "resolve_failed" && s.resolver_error) {
        extra = '<div class="sub-extra sub-extra-err sub-extra-mono">' + escapeHtml(s.resolver_error.slice(0, 200)) + '</div>';
      }

      const commentStr = s.comment ? '<div class="sub-comment">「' + escapeHtml(s.comment) + '」</div>' : "";

      return `
        <div class="submission-row">
          <div class="sub-row-flex">
            <div style="flex:1;min-width:0;">
              <div class="sub-meta">${urlSourceLabel(s.url_source)}${tripStr} · ${relTime(s.created_at)}</div>
              <div class="sub-url"><a href="${escapeHtml(s.raw_url)}" target="_blank" rel="noopener" class="link-src">${escapeHtml(s.raw_url)}</a></div>
              <div class="sub-rating">${ratingStr}</div>
              ${commentStr}
              ${extra}
            </div>
            <div class="sub-status" style="color:${sm.color};">${sm.label}</div>
          </div>
        </div>`;
    }

    // ============================================================
    // Debug pane (嵌入邀請碼 onboarding tab 底部) + MutationObserver
    // ============================================================
    function _ensureDebugPane() {
      const target = document.querySelector('.onboarding-pane[data-pane="invite"]');
      if (!target) return null;
      let pane = document.getElementById("submissionDebugPane");
      if (!pane) {
        const tpl = document.getElementById("submissionDebugTemplate");
        if (!tpl) return null;
        const clone = tpl.content.cloneNode(true);
        target.appendChild(clone);
        pane = document.getElementById("submissionDebugPane");
      }
      return pane;
    }
    function refreshDebugPane() {
      const pane = _ensureDebugPane();
      if (!pane) return;
      const body = document.getElementById("submissionDebugBody");
      if (!body) return;
      const code = state.inviteCode || "";
      const masked = code.length > 4 ? code.slice(0, 2) + "•".repeat(code.length - 4) + code.slice(-2) : (code ? "•".repeat(code.length) : "-");
      const modals = ["submitModal","recentFriendModal","pendingListModal","resolveModal","mySubmissionsModal"];
      const modalStates = modals.map(m => {
        const el = document.getElementById(m);
        return m + "=" + (el && el.classList.contains("open") ? "OPEN" : "closed");
      }).join(" \u00b7 ");
      body.innerHTML =
        '<div>state.role = ' + escapeHtml(state.role) + '</div>' +
        '<div>state.displayName = ' + escapeHtml(state.displayName || "-") + '</div>' +
        '<div>state.inviteCode (masked) = ' + escapeHtml(masked) + '</div>' +
        '<div>state.currentTripAreaSlug = ' + escapeHtml(state.currentTripAreaSlug || "-") + '</div>' +
        '<div>OWNER_DISPLAY_NAME = ' + escapeHtml(cfg.OWNER_DISPLAY_NAME) + '</div>' +
        '<div>lastSubmissionId = ' + escapeHtml(_lastSubmissionId || "-") + '</div>' +
        '<div>modals: ' + escapeHtml(modalStates) + '</div>' +
        '<div>resolve_fn_url = ' + escapeHtml(RESOLVE_FN_URL) + '</div>';
    }
    function _setupMutationObserver() {
      if (_debugObserver) return;
      const modals = ["submitModal","recentFriendModal","pendingListModal","resolveModal","mySubmissionsModal"];
      _debugObserver = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes" && m.attributeName === "class") {
            refreshDebugPane();
            break;
          }
        }
      });
      modals.forEach(id => {
        const el = document.getElementById(id);
        if (el) _debugObserver.observe(el, { attributes: true, attributeFilter: ["class"] });
      });
    }

    // ============================================================
    // init: wire all buttons + close handlers
    // ============================================================
    function init() {
      // Toolbar buttons
      const rfb = $$("recentFriendBtn");
      if (rfb) rfb.addEventListener("click", openRecentFriendModal);
      const sub = $$("submitPlaceBtn");
      if (sub) sub.addEventListener("click", openSubmitModal);
      const pen = $$("pendingListBtn");
      if (pen) pen.addEventListener("click", openPendingListModal);
      // v1.0.64 Push 3: 📋 我嘅推薦 (friend + owner)
      const mys = $$("mySubmissionsBtn");
      if (mys) mys.addEventListener("click", openMySubmissionsModal);

      // Submit modal
      const submitCancel = $$("submitCancel");
      if (submitCancel) submitCancel.addEventListener("click", () => closeModal("submitModal"));
      const submitConfirm = $$("submitConfirm");
      if (submitConfirm) submitConfirm.addEventListener("click", _submitConfirm);
      const submitBg = $$("submitModal");
      if (submitBg) submitBg.addEventListener("click", (e) => { if (e.target === submitBg) closeModal("submitModal"); });

      // Rating buttons
      document.querySelectorAll("#submitRatingRow .emoji-rating-btn").forEach(b => {
        b.addEventListener("click", () => {
          const r = parseInt(b.dataset.rating, 10);
          _submitRating = (_submitRating === r) ? 0 : r;
          _refreshRatingButtons();
        });
      });

      // Recent friend modal
      const rfClose = $$("recentFriendClose");
      if (rfClose) rfClose.addEventListener("click", () => closeModal("recentFriendModal"));
      const rfBg = $$("recentFriendModal");
      if (rfBg) rfBg.addEventListener("click", (e) => { if (e.target === rfBg) closeModal("recentFriendModal"); });

      // Pending list modal
      const plClose = $$("pendingListClose");
      if (plClose) plClose.addEventListener("click", () => closeModal("pendingListModal"));
      const plBg = $$("pendingListModal");
      if (plBg) plBg.addEventListener("click", (e) => { if (e.target === plBg) closeModal("pendingListModal"); });
      // v1.0.64 Push 3: 🔄 全部 resolve
      const plBulk = $$("pendingListBulkResolveBtn");
      if (plBulk) plBulk.addEventListener("click", _bulkResolve);

      // v1.0.64 Push 3: 📋 我嘅推薦 modal
      const mysClose = $$("mySubmissionsClose");
      if (mysClose) mysClose.addEventListener("click", () => closeModal("mySubmissionsModal"));
      const mysBg = $$("mySubmissionsModal");
      if (mysBg) mysBg.addEventListener("click", (e) => { if (e.target === mysBg) closeModal("mySubmissionsModal"); });
      // v1.0.65 #6: refresh button forces refetch
      const mysRefresh = $$("mySubmissionsRefresh");
      if (mysRefresh) mysRefresh.addEventListener("click", () => {
        _mySubmissionsCache = null;
        openMySubmissionsModal(true);
      });
      // v1.0.65 #9: status filter chips
      const mysFilter = $$("mySubmissionsFilter");
      if (mysFilter) {
        mysFilter.addEventListener("click", (e) => {
          const btn = e.target.closest(".chip");
          if (!btn) return;
          const status = btn.dataset.status || "all";
          _mySubFilterStatus = status;
          mysFilter.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === btn));
          if (_mySubmissionsCache) _renderMySubmissionsFiltered();
        });
      }

      // Resolve modal
      const rsCancel = $$("resolveCancel");
      if (rsCancel) rsCancel.addEventListener("click", () => closeModal("resolveModal"));
      const rsBg = $$("resolveModal");
      if (rsBg) rsBg.addEventListener("click", (e) => { if (e.target === rsBg) closeModal("resolveModal"); });
      const rsApprove = $$("resolveApproveBtn");
      if (rsApprove) rsApprove.addEventListener("click", _resolveApprove);
      const rsReject = $$("resolveRejectBtn");
      if (rsReject) rsReject.addEventListener("click", _resolveReject);

      _setupMutationObserver();
      refreshDebugPane();
    }


  // Expose as window.FeatureB (replaces former IIFE return)
  window.FeatureB = { init, refreshDebugPane };
})();
