(() => {
  const ROOT_ID = "cliproxy-model-switcher-root";
  const SELECTED_MODEL_KEY = "cliproxy:selected-model";
  installModelInterceptor();
  const style = document.createElement("style");
  style.textContent = `
    #${ROOT_ID} { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f4f4f5; }
    #${ROOT_ID} .cpa-bubble { min-width: 54px; height: 42px; border: 1px solid rgba(255,255,255,.16); border-radius: 999px; background: rgba(22,22,26,.88); box-shadow: 0 12px 35px rgba(0,0,0,.36); backdrop-filter: blur(14px); display: flex; align-items: center; gap: 8px; padding: 0 13px; cursor: pointer; user-select: none; }
    #${ROOT_ID} .cpa-bubble:hover { background: rgba(35,35,42,.94); border-color: rgba(118,167,255,.55); }
    #${ROOT_ID} .cpa-dot { width: 9px; height: 9px; border-radius: 999px; background: #8bffb0; box-shadow: 0 0 10px rgba(139,255,176,.75); flex: none; }
    #${ROOT_ID} .cpa-label { max-width: 172px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; font-weight: 650; letter-spacing: .01em; }
    #${ROOT_ID} .cpa-panel { position: absolute; right: 0; bottom: 52px; width: 318px; max-height: min(520px, calc(100vh - 96px)); overflow: hidden; border: 1px solid rgba(255,255,255,.15); border-radius: 18px; background: rgba(18,18,22,.96); box-shadow: 0 24px 70px rgba(0,0,0,.46); backdrop-filter: blur(18px); display: none; }
    #${ROOT_ID}[data-open="true"] .cpa-panel { display: block; }
    #${ROOT_ID} .cpa-head { padding: 14px 14px 10px; border-bottom: 1px solid rgba(255,255,255,.09); }
    #${ROOT_ID} .cpa-title { font-size: 13px; font-weight: 760; margin-bottom: 4px; }
    #${ROOT_ID} .cpa-subtitle { font-size: 11px; color: rgba(244,244,245,.66); line-height: 1.35; }
    #${ROOT_ID} .cpa-body { max-height: 365px; overflow: auto; padding: 8px; }
    #${ROOT_ID} .cpa-model { width: 100%; border: 0; border-radius: 12px; background: transparent; color: #f4f4f5; text-align: left; padding: 10px 11px; cursor: pointer; display: flex; gap: 8px; align-items: center; font: inherit; }
    #${ROOT_ID} .cpa-model:hover { background: rgba(255,255,255,.08); }
    #${ROOT_ID} .cpa-model[data-current="true"] { background: rgba(72,128,255,.18); outline: 1px solid rgba(114,163,255,.36); }
    #${ROOT_ID} .cpa-model-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    #${ROOT_ID} .cpa-current { font-size: 10px; color: #9bc2ff; }
    #${ROOT_ID} .cpa-footer { padding: 9px 12px 12px; border-top: 1px solid rgba(255,255,255,.09); color: rgba(244,244,245,.62); font-size: 10.5px; line-height: 1.35; }
    #${ROOT_ID} .cpa-status { color: #fbbf24; }
    #${ROOT_ID} .cpa-error { color: #fb7185; }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="cpa-panel" role="dialog" aria-label="CLIProxyAPI model switcher">
      <div class="cpa-head">
        <div class="cpa-title">CLIProxy Models</div>
        <div class="cpa-subtitle">CLIProxyAPI에 등록된 모델을 Codex App 런타임 요청에 바로 적용합니다.</div>
      </div>
      <div class="cpa-body"><div class="cpa-status">모델 목록 불러오는 중…</div></div>
      <div class="cpa-footer">선택값은 ~/.codex/config.toml과 브라우저 로컬 상태에 저장되고, 새 요청 payload의 model 필드를 선택 모델로 치환합니다.</div>
    </div>
    <div class="cpa-bubble" title="CLIProxy 모델 선택" role="button" tabindex="0">
      <span class="cpa-dot"></span><span class="cpa-label">CLIProxy</span>
    </div>
  `;

  function mount() {
    if (!document.body) return void setTimeout(mount, 50);
    if (!document.getElementById(ROOT_ID)) document.body.appendChild(root);
    startCustomModelControlObserver();
    refresh();
  }

  const label = () => root.querySelector(".cpa-label");
  const body = () => root.querySelector(".cpa-body");

  async function refresh() {
    try {
      const response = await fetch("/__cliproxy/models", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const current = data.current_model || localStorage.getItem(SELECTED_MODEL_KEY) || "";
      if (current) localStorage.setItem(SELECTED_MODEL_KEY, current);
      render(data.models || [], current);
      applyCustomModelControlLabel();
    } catch (error) {
      body().innerHTML = `<div class="cpa-error">CLIProxy 모델을 불러오지 못했습니다: ${escapeHtml(error.message || String(error))}</div>`;
    }
  }

  function render(models, current) {
    label().textContent = current || "CLIProxy";
    if (!models.length) {
      body().innerHTML = `<div class="cpa-status">등록된 CLIProxy 모델이 없습니다.</div>`;
      return;
    }
    body().innerHTML = models.map((model) => `
      <button class="cpa-model" data-model="${escapeAttr(model)}" data-current="${String(model === current)}">
        <span class="cpa-model-name">${escapeHtml(model)}</span>
        ${model === current ? '<span class="cpa-current">ACTIVE</span>' : ''}
      </button>
    `).join("");
  }

  async function selectModel(model) {
    label().textContent = "Saving…";
    const response = await fetch("/__cliproxy/select-model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    label().textContent = data.current_model || model;
    localStorage.setItem(SELECTED_MODEL_KEY, data.current_model || model);
    await refresh();
    applyCustomModelControlLabel();
  }

  root.addEventListener("click", async (event) => {
    const bubble = event.target.closest(".cpa-bubble");
    if (bubble) {
      root.dataset.open = root.dataset.open === "true" ? "false" : "true";
      if (root.dataset.open === "true") refresh();
      return;
    }
    const button = event.target.closest(".cpa-model");
    if (!button) return;
    try {
      await selectModel(button.dataset.model || "");
    } catch (error) {
      body().insertAdjacentHTML("afterbegin", `<div class="cpa-error">저장 실패: ${escapeHtml(error.message || String(error))}</div>`);
    }
  });

  root.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.closest(".cpa-bubble")) {
      event.preventDefault();
      root.querySelector(".cpa-bubble").click();
    }
    if (event.key === "Escape") root.dataset.open = "false";
  });

  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) root.dataset.open = "false";
  });





  function applyCustomModelControlLabel() {
    const selected = currentSelectedModel();
    const buttons = document.querySelectorAll('button[data-codex-intelligence-trigger="true"]');
    for (const button of buttons) {
      const main = button.querySelector('span.truncate');
      if (main && main.textContent !== 'Custom') main.textContent = 'Custom';
      const sub = button.querySelector('[class*="labelSm"], .text-token-description-foreground');
      const modelLabel = selected || 'CLIProxy';
      if (sub && sub.textContent !== modelLabel) sub.textContent = modelLabel;
      button.setAttribute('title', selected ? `Custom CLIProxy model: ${selected}` : 'Custom CLIProxy model');
      button.setAttribute('aria-label', selected ? `Custom CLIProxy model ${selected}` : 'Custom CLIProxy model');
    }
  }

  function startCustomModelControlObserver() {
    applyCustomModelControlLabel();
    const observer = new MutationObserver(() => applyCustomModelControlLabel());
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function currentSelectedModel() {
    return localStorage.getItem(SELECTED_MODEL_KEY) || "";
  }

  function shouldReplaceModel(value, selected) {
    return typeof value === "string" && value.length > 0 && selected && value !== selected;
  }

  function rewriteInstructions(value, selected) {
    if (typeof value !== "string" || !selected) return value;
    const replacement = `You are Codex, a coding agent currently routed through CLIProxy model ${selected}.`;
    return value
      .replace("You are Codex, a coding agent based on GPT-5.", replacement)
      .replace("I'm GPT-5, and I'm Codex", `I'm ${selected}, routed through CLIProxy, and I'm Codex`);
  }

  function rewriteModelPayload(value, selected = currentSelectedModel()) {
    if (!selected || value == null) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const rewritten = rewriteModelPayload(item, selected);
        changed ||= rewritten !== item;
        return rewritten;
      });
      return changed ? next : value;
    }
    if (typeof value !== "object") return value;
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "model" && shouldReplaceModel(item, selected)) {
        next[key] = selected;
        changed = true;
        continue;
      }
      if ((key === "instructions" || key === "system") && typeof item === "string") {
        const rewritten = rewriteInstructions(item, selected);
        next[key] = rewritten;
        changed ||= rewritten !== item;
        continue;
      }
      const rewritten = rewriteModelPayload(item, selected);
      next[key] = rewritten;
      changed ||= rewritten !== item;
    }
    return changed ? next : value;
  }

  function rewriteJSONText(text) {
    if (typeof text !== "string" || (!text.includes('"model"') && !text.includes('"instructions"') && !text.includes('"system"'))) return text;
    try {
      const parsed = JSON.parse(text);
      const rewritten = rewriteModelPayload(parsed);
      return rewritten === parsed ? text : JSON.stringify(rewritten);
    } catch {
      return text;
    }
  }

  function installModelInterceptor() {
    if (window.__cliproxyModelInterceptorInstalled) return;
    window.__cliproxyModelInterceptorInstalled = true;

    const originalFetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      const isSwitcherAPI = url.includes("/__cliproxy/");
      if (!isSwitcherAPI && init && typeof init.body === "string") {
        const body = rewriteJSONText(init.body);
        if (body !== init.body) init = { ...init, body };
      }
      return originalFetch.call(this, input, init);
    };

    const originalWebSocketSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedWebSocketSend(data) {
      if (typeof data === "string") data = rewriteJSONText(data);
      return originalWebSocketSend.call(this, data);
    };

    const originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function patchedXHRSend(body) {
      if (typeof body === "string") body = rewriteJSONText(body);
      return originalXHRSend.call(this, body);
    };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }
  function escapeAttr(value) { return escapeHtml(value); }

  mount();
})();
