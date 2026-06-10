// =============================================================
// Travel Food Map — Feature C (invite code management, owner-only)
// 拆出 from app.js v1.0.67 (issue #11 sub-module split)
// =============================================================
(function () {
  "use strict";
  if (!window.AppShared) { console.error("[feature-c] window.AppShared 未就緒，唔可以 load"); return; }
  const { sb, state, escapeHtml, showToast, openModal, closeModal,
          appDialog } = window.AppShared;

    let _codesCache = null;
    let _selectedRole = "friend";
    let _selectedExpiresPreset = "never";

    function $$(id) { return document.getElementById(id); }
    // Local relTime (FeatureB._relTime is IIFE-private, so duplicate trivial impl here)
    function _relTime(iso) {
      if (!iso) return "";
      const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
      if (m < 1) return "剛剛"; if (m < 60) return m + " 分鐘前";
      const h = Math.floor(m / 60); if (h < 24) return h + " 小時前";
      const d = Math.floor(h / 24); if (d < 7) return d + " 日前";
      return new Date(iso).toLocaleDateString("zh-HK");
    }

    // ---------- list / render ----------
    async function refreshList() {
      const body = $$("onboardingOwnerCodesBody");
      if (!body) return;
      if (state.role !== "owner") {
        body.innerHTML = '<p class="onboarding-hint" style="margin:0">仅 owner 可見。</p>';
        return;
      }
      body.innerHTML = '<p class="onboarding-hint" style="margin:0">載入中⋯</p>';
      try {
        const { data, error } = await sb.rpc("list_owner_invite_codes", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName
        });
        if (error) throw error;
        _codesCache = data || [];
        _renderList();
      } catch (e) {
        _codesCache = null;
        body.innerHTML = '<div style="color:#c33;padding:8px;">載入失敗：' + escapeHtml(e.message || String(e)) + '</div>';
      }
    }

    function _renderList() {
      const body = $$("onboardingOwnerCodesBody");
      if (!body || !_codesCache) return;
      if (_codesCache.length === 0) {
        body.innerHTML = '<p class="onboarding-hint" style="margin:0">未有邀請碼。</p>';
        return;
      }
      const activeCount = _codesCache.filter(c => c.active).length;
      const header = '<div style="font-size:11px;color:var(--muted,#888);margin-bottom:6px;">合計 ' + _codesCache.length + ' 條 · active ' + activeCount + '</div>';
      body.innerHTML = header + _codesCache.map(c => _renderRow(c)).join("");
      // Wire toggle buttons
      body.querySelectorAll("[data-toggle-id]").forEach(btn => {
        btn.addEventListener("click", () => _onToggle(btn.dataset.toggleId, btn.dataset.toggleTo === "true"));
      });
      // Wire ⋯ admin popover buttons
      body.querySelectorAll("[data-more-id]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          _onMoreClick(btn.dataset.moreId, btn);
        });
      });
    }

    function _renderRow(c) {
      const roleColor = c.role === "owner" ? "#a40" : "#06c";
      const roleBadge = '<span style="background:' + roleColor + ';color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;font-weight:600;">' + escapeHtml(c.role) + '</span>';
      const statusColor = c.active ? "#0a0" : "#888";
      const statusLabel = c.active ? "active" : "inactive";
      const usesStr = c.max_uses != null
        ? (c.use_count + " / " + c.max_uses)
        : (c.use_count + " 次");
      const expStr = c.expires_at
        ? (" · 過期 " + new Date(c.expires_at).toLocaleDateString())
        : "";
      const createdStr = _relTime(c.created_at);
      const toggleLabel = c.active ? "停用" : "啟用";
      const toggleStyle = c.active
        ? "background:#fff;color:#c33;border:1px solid #c33;"
        : "background:#0a0;color:#fff;border:1px solid #0a0;";
      // v1.0.67-rc9: ⋯ admin menu (Migration 0028)
      const moreBtn = '<button type="button" data-more-id="' + escapeHtml(c.id) + '" aria-label="更多操作" title="更多" style="font-size:14px;padding:2px 8px;border-radius:3px;cursor:pointer;background:transparent;border:1px solid var(--border,#ddd);color:var(--text,#333);line-height:1;">⋯</button>';
      return `
        <div style="border:1px solid var(--border,#ddd);border-radius:6px;padding:8px;margin-bottom:6px;position:relative;" data-row-id="${escapeHtml(c.id)}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                ${roleBadge}
                <span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.label)}</span>
              </div>
              <div style="font-size:11px;color:var(--muted,#888);margin-top:4px;">
                ${usesStr}${expStr} · 建於 ${createdStr}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
              <span style="font-size:10px;color:${statusColor};font-weight:600;text-transform:uppercase;">${statusLabel}</span>
              <div style="display:flex;gap:4px;">
                <button type="button" data-toggle-id="${escapeHtml(c.id)}" data-toggle-to="${(!c.active).toString()}" style="font-size:11px;padding:3px 8px;border-radius:3px;cursor:pointer;${toggleStyle}">${toggleLabel}</button>
                ${moreBtn}
              </div>
            </div>
          </div>
        </div>`;
    }

    // ---------- popover menu (v1.0.67-rc9 / Migration 0028) ----------
    let _openPopoverId = null;

    function _closePopover() {
      const existing = document.getElementById("inviteAdminPopover");
      if (existing) existing.remove();
      _openPopoverId = null;
      document.removeEventListener("click", _onDocClickClose, true);
    }

    function _onDocClickClose(e) {
      const pop = document.getElementById("inviteAdminPopover");
      if (!pop) { _closePopover(); return; }
      if (pop.contains(e.target)) return;
      // Click on ⋯ button 本身 — already handled in _onMoreClick (toggle)
      if (e.target.closest && e.target.closest("[data-more-id]")) return;
      _closePopover();
    }

    function _openPopover(id, anchorBtn) {
      _closePopover();
      _openPopoverId = id;
      const target = _codesCache.find(c => c.id === id);
      if (!target) return;
      const pop = document.createElement("div");
      pop.id = "inviteAdminPopover";
      pop.setAttribute("role", "menu");
      pop.style.cssText =
        "position:absolute;z-index:10001;background:var(--panel,#fff);" +
        "border:1px solid var(--border,#ccc);border-radius:6px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,0.2);padding:4px 0;" +
        "min-width:170px;font-size:13px;";
      const newRole = target.role === "owner" ? "friend" : "owner";
      const roleLabel = target.role === "owner" ? "改為 friend" : "改為 owner";
      pop.innerHTML = [
        '<button type="button" data-act="label" style="display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:0;cursor:pointer;font-size:13px;color:var(--text,#222);">✏️ 改 label</button>',
        '<button type="button" data-act="role" style="display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:0;cursor:pointer;font-size:13px;color:var(--text,#222);">🔄 ' + roleLabel + '</button>',
        '<button type="button" data-act="reset" style="display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:0;cursor:pointer;font-size:13px;color:var(--text,#222);">↺ Reset 計數</button>',
        '<div style="border-top:1px solid var(--border,#eee);margin:4px 0;"></div>',
        '<button type="button" data-act="delete" style="display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:0;cursor:pointer;font-size:13px;color:#c33;">🗑️ 刪除</button>'
      ].join("");
      // Position relative to viewport (use button rect)
      const rect = anchorBtn.getBoundingClientRect();
      pop.style.position = "fixed";
      pop.style.top = (rect.bottom + 4) + "px";
      // anchor right edge of pop to right edge of button (and clamp to viewport)
      const popWidth = 180;
      let leftPos = rect.right - popWidth;
      if (leftPos < 8) leftPos = 8;
      pop.style.left = leftPos + "px";
      document.body.appendChild(pop);
      // Wire actions
      pop.querySelectorAll("[data-act]").forEach(b => {
        b.addEventListener("click", () => {
          const act = b.dataset.act;
          _closePopover();
          if (act === "label") _onEditLabel(target);
          else if (act === "role") _onChangeRole(target);
          else if (act === "reset") _onResetUseCount(target);
          else if (act === "delete") _onDelete(target);
        });
      });
      // Outside click 關
      setTimeout(() => document.addEventListener("click", _onDocClickClose, true), 0);
    }

    function _onMoreClick(id, btn) {
      if (_openPopoverId === id) { _closePopover(); return; }
      _openPopover(id, btn);
    }

    // ---------- 4 admin handlers ----------
    async function _onEditLabel(target) {
      const cur = target.label || "";
      const next = await appDialog.prompt({
        title: "改 label",
        message: "輸入新 label (興 1-64 字元):",
        defaultValue: cur,
        okText: "保存",
        cancelText: "取消"
      });
      if (next == null) return;
      const clean = String(next).trim();
      if (!clean) { showToast("label 不可空"); return; }
      if (clean === cur) return;
      try {
        const { error } = await sb.rpc("admin_update_invite_label", {
          p_invite_code: state.inviteCode,
          p_target_invite_id: target.id,
          p_new_label: clean
        });
        if (error) throw error;
        showToast("label 已更新");
        await refreshList();
      } catch (e) {
        const msg = (e.message || String(e));
        if (msg.indexOf("invalid_label") >= 0) showToast("label 要 1-64 字元");
        else if (msg.indexOf("not_owner") >= 0) showToast("仅 owner 可修改");
        else showToast("失敗：" + msg);
      }
    }

    async function _onChangeRole(target) {
      const newRole = target.role === "owner" ? "friend" : "owner";
      const ok = await appDialog.confirm({
        title: "改 role",
        message: "將「" + (target.label || "") + "」 role 由 " + target.role + " 改為 " + newRole + " ？",
        okText: "確認",
        cancelText: "取消",
        danger: (newRole === "owner")
      });
      if (!ok) return;
      try {
        const { error } = await sb.rpc("admin_update_invite_role", {
          p_invite_code: state.inviteCode,
          p_target_invite_id: target.id,
          p_new_role: newRole
        });
        if (error) throw error;
        showToast("role 已改為 " + newRole);
        await refreshList();
      } catch (e) {
        const msg = (e.message || String(e));
        if (msg.indexOf("last_active_owner") >= 0) appDialog.alert({ title: "不能修改", message: "這係唯一的 active owner，不可變成 friend。先新增另一個 active owner 再試。" });
        else if (msg.indexOf("cannot_demote_self") >= 0) appDialog.alert({ title: "不能修改", message: "不能修改你使用中的 owner code 為 friend。" });
        else showToast("失敗：" + msg);
      }
    }

    async function _onResetUseCount(target) {
      const ok = await appDialog.confirm({
        title: "Reset 使用計數",
        message: "將「" + (target.label || "") + "」 使用計數由 " + target.use_count + " 重設為 0 ？",
        okText: "Reset",
        cancelText: "取消",
        danger: true
      });
      if (!ok) return;
      try {
        const { error } = await sb.rpc("admin_reset_invite_use_count", {
          p_invite_code: state.inviteCode,
          p_target_invite_id: target.id
        });
        if (error) throw error;
        showToast("計數已 reset");
        await refreshList();
      } catch (e) {
        showToast("失敗：" + (e.message || String(e)));
      }
    }

    async function _onDelete(target) {
      // double-confirm: 要 type "DELETE"
      const typed = await appDialog.prompt({
        title: "刪除邀請碼",
        message: "這是不可逆操作。如要刪除「" + (target.label || "") + "」，請輸入 DELETE 確認：",
        defaultValue: "",
        okText: "刪除",
        cancelText: "取消",
        danger: true
      });
      if (typed == null) return;
      if (String(typed).trim() !== "DELETE") { showToast("未輸入 DELETE，已取消"); return; }
      try {
        const { error } = await sb.rpc("admin_delete_invite_code", {
          p_invite_code: state.inviteCode,
          p_target_invite_id: target.id
        });
        if (error) throw error;
        showToast("已刪除：" + (target.label || ""));
        await refreshList();
      } catch (e) {
        const msg = (e.message || String(e));
        if (msg.indexOf("cannot_delete_self") >= 0) appDialog.alert({ title: "不能刪除", message: "不能刪除你使用中的邀請碼。" });
        else if (msg.indexOf("last_active_owner") >= 0) appDialog.alert({ title: "不能刪除", message: "這係唯一的 active owner，不可刪除。先新增另一個 active owner 再試。" });
        else showToast("失敗：" + msg);
      }
    }

    async function _onToggle(id, newActive) {
      const target = _codesCache.find(c => c.id === id);
      if (!target) return;
      const action = newActive ? "啟用" : "停用";
      const ok = await appDialog.confirm({
        title: action + "邀請碼",
        message: "確認要" + action + "「" + target.label + "」\uff1f",
        okText: action,
        cancelText: "取消",
        danger: !newActive
      });
      if (!ok) return;
      try {
        const { error } = await sb.rpc("toggle_invite_code_active", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_target_invite_id: id,
          p_active: newActive
        });
        if (error) throw error;
        showToast(action + "成功：" + target.label);
        await refreshList();
      } catch (e) {
        const msg = (e.message || String(e));
        if (msg.indexOf("cannot_deactivate_self") >= 0) {
          appDialog.alert({ title: "不能停用", message: "你不能停用你現在在用緊嘅邀請碼。" });
        } else {
          showToast(action + "失敗：" + msg);
        }
      }
    }

    // ---------- create modal ----------
    function _openCreateModal() {
      // reset form
      $$("cicLabel").value = "";
      $$("cicMaxUses").value = "";
      $$("cicExpiresAt").value = "";
      $$("cicExpiresAt").hidden = true;
      _selectedRole = "friend";
      _selectedExpiresPreset = "never";
      const cicMsg = $$("cicMsg"); if (cicMsg) cicMsg.hidden = true;
      // role chips reset
      $$("cicRoleRow").querySelectorAll(".chip").forEach(c => {
        c.classList.toggle("active", c.dataset.role === "friend");
      });
      // expires chips reset
      $$("cicExpiresRow").querySelectorAll(".chip").forEach(c => {
        c.classList.toggle("active", c.dataset.expires === "never");
      });
      openModal("createInviteCodeModal");
      setTimeout(() => { try { $$("cicLabel").focus(); } catch (e) {} }, 50);
    }

    function _computeExpiresAt() {
      const now = new Date();
      if (_selectedExpiresPreset === "never") return null;
      if (_selectedExpiresPreset === "1m") {
        const d = new Date(now); d.setMonth(d.getMonth() + 1); return d.toISOString();
      }
      if (_selectedExpiresPreset === "6m") {
        const d = new Date(now); d.setMonth(d.getMonth() + 6); return d.toISOString();
      }
      if (_selectedExpiresPreset === "1y") {
        const d = new Date(now); d.setFullYear(d.getFullYear() + 1); return d.toISOString();
      }
      if (_selectedExpiresPreset === "custom") {
        const v = $$("cicExpiresAt").value;
        if (!v) return null;
        return new Date(v).toISOString();
      }
      return null;
    }

    async function _onCreateConfirm() {
      const label = ($$("cicLabel").value || "").trim();
      const maxUsesRaw = ($$("cicMaxUses").value || "").trim();
      const maxUses = maxUsesRaw ? parseInt(maxUsesRaw, 10) : null;
      const expiresAt = _computeExpiresAt();
      const cicMsg = $$("cicMsg");
      function showErr(t) { if (cicMsg) { cicMsg.textContent = t; cicMsg.hidden = false; cicMsg.style.color = "#c33"; } }

      if (!label) { showErr("請輸入標籤"); return; }
      if (maxUsesRaw && (isNaN(maxUses) || maxUses < 1)) { showErr("最大使用次數必須 ≥ 1"); return; }
      if (_selectedExpiresPreset === "custom" && !$$("cicExpiresAt").value) { showErr("請選自訂過期時間"); return; }
      if (expiresAt && new Date(expiresAt) <= new Date()) { showErr("過期時間不能在過去"); return; }

      const btn = $$("cicConfirm");
      if (btn) { btn.disabled = true; btn.textContent = "建立中⋯"; }
      try {
        const { data, error } = await sb.rpc("create_invite_code", {
          p_invite_code: state.inviteCode,
          p_display_name: state.displayName,
          p_label: label,
          p_role: _selectedRole,
          p_max_uses: maxUses,
          p_expires_at: expiresAt
        });
        if (error) throw error;
        closeModal("createInviteCodeModal");
        _showCreatedCode(data);
        await refreshList();
      } catch (e) {
        const msg = (e.message || String(e));
        let friendly = msg;
        if (msg.indexOf("label_duplicate") >= 0) friendly = "標籤重複，請換個名";
        else if (msg.indexOf("label_required") >= 0) friendly = "請輸入標籤";
        else if (msg.indexOf("invalid_role") >= 0) friendly = "角色必須係 friend 或 owner";
        else if (msg.indexOf("invalid_max_uses") >= 0) friendly = "max_uses 必須 ≥ 1";
        else if (msg.indexOf("expires_at_in_past") >= 0) friendly = "過期時間不能在過去";
        else if (msg.indexOf("not_owner") >= 0) friendly = "仅 owner 可建立邀請碼";
        showErr(friendly);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "建立"; }
      }
    }

    function _showCreatedCode(result) {
      const codeEl = $$("iccCodePlaintext");
      const metaEl = $$("iccMetaRow");
      if (codeEl) codeEl.textContent = result.code_plaintext;
      if (metaEl) {
        metaEl.innerHTML =
          '<div>label: ' + escapeHtml(result.label) + '</div>' +
          '<div>role: ' + escapeHtml(result.role) + '</div>';
      }
      openModal("inviteCodeCreatedModal");
    }

    function _wireCopyBtn() {
      const btn = $$("iccCopyBtn");
      if (!btn) return;
      btn.addEventListener("click", async () => {
        const code = ($$("iccCodePlaintext").textContent || "").trim();
        if (!code || code === "—") return;
        try {
          await navigator.clipboard.writeText(code);
          showToast("已 copy: " + code);
        } catch (e) {
          showToast("Copy 失敗，請長按 code 手動選取");
        }
      });
    }

    // ---------- init ----------
    function init() {
      // 「+ 新增邀請碼」 button
      const newBtn = $$("ownerCodesNewBtn");
      if (newBtn) newBtn.addEventListener("click", _openCreateModal);
      // refresh button
      const refBtn = $$("ownerCodesRefreshBtn");
      if (refBtn) refBtn.addEventListener("click", refreshList);

      // Create modal: cancel / bg / confirm
      const cancelBtn = $$("cicCancel");
      if (cancelBtn) cancelBtn.addEventListener("click", () => closeModal("createInviteCodeModal"));
      const bg = $$("createInviteCodeModal");
      if (bg) bg.addEventListener("click", (e) => { if (e.target === bg) closeModal("createInviteCodeModal"); });
      const okBtn = $$("cicConfirm");
      if (okBtn) okBtn.addEventListener("click", _onCreateConfirm);

      // Role chips
      const roleRow = $$("cicRoleRow");
      if (roleRow) roleRow.addEventListener("click", (e) => {
        const btn = e.target.closest(".chip"); if (!btn) return;
        _selectedRole = btn.dataset.role || "friend";
        roleRow.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === btn));
      });
      // Expires chips
      const expRow = $$("cicExpiresRow");
      if (expRow) expRow.addEventListener("click", (e) => {
        const btn = e.target.closest(".chip"); if (!btn) return;
        _selectedExpiresPreset = btn.dataset.expires || "never";
        expRow.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === btn));
        const dt = $$("cicExpiresAt");
        if (dt) dt.hidden = (_selectedExpiresPreset !== "custom");
      });

      // Created modal: close + copy
      const iccClose = $$("iccCloseBtn");
      if (iccClose) iccClose.addEventListener("click", () => closeModal("inviteCodeCreatedModal"));
      const iccBg = $$("inviteCodeCreatedModal");
      if (iccBg) iccBg.addEventListener("click", (e) => { if (e.target === iccBg) closeModal("inviteCodeCreatedModal"); });
      _wireCopyBtn();
    }


  // Expose as window.FeatureC
  window.FeatureC = { init, refreshList };
})();
