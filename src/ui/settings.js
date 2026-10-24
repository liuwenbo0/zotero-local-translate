/* global Zotero */
var SettingsView = {
  category: "general", searching: false,
  categories: ["general", "service", "quality", "pdf", "advanced"],
  fields: ["baseURL", "model", "langIn", "langOut", "rpm", "timeout", "thinking", "thinkingProtocol", "reasoningEffort",
    "maxWorkers", "minTextLength", "customPrompt", "fontFamily", "dualMode", "watermark", "ocrMode",
    "shortLineSplitFactor", "maxPagesPerPart", "formulaFontPattern", "formulaCharPattern", "figureTableProtectionThreshold"],
  numbers: new Set(["rpm", "timeout", "maxWorkers", "minTextLength", "shortLineSplitFactor", "maxPagesPerPart", "figureTableProtectionThreshold"]),
  checks: ["askOnNew", "includeSubcollections", "skipExisting", "autoExtractGlossary", "ignoreCache",
    "dualTranslateFirst", "enhanceCompatibility", "preserveRichText", "splitShortLines", "skipScannedDetection"],

  $(id) { return this.root.querySelector("#local-translate-" + id); },

  init(root) {
    this.root = root;
    root.closest(".pane-container").classList.add("local-translate-preferences");
    this.plugin = Zotero.LocalTranslate;
    this.plugin.preferences.add(this);
    this.keyLoading = true;
    this.$("apiKey").disabled = true;
    void this.plugin.loadPreferenceKey(this);
    const settings = this.plugin.settings;
    for (const id of this.fields) this.$(id).value = settings[id];
    for (const id of this.checks) this.$(id).checked = settings[id];
    this.setupPreviewPanel();
    const updateCompatibility = () => {
      this.$("preserveRichText").disabled = this.$("enhanceCompatibility").checked;
      this.$("skipScannedDetection").disabled = this.$("ocrMode").value === "auto";
      if (this.$("ocrMode").value === "auto") this.$("skipScannedDetection").checked = false;
      let effort = this.$("thinkingProtocol").value === "reasoning_effort";
      if (this.$("thinkingProtocol").value === "auto") {
        try { effort = new URL(this.$("baseURL").value).hostname === "api.openai.com"; } catch { /* Keep hidden while editing an incomplete URL. */ }
      }
      this.$("reasoning-effort-row").hidden = this.$("thinking").value !== "enabled" || !effort;
    };
    for (const id of ["enhanceCompatibility", "ocrMode", "thinking", "thinkingProtocol"]) this.$(id).onchange = updateCompatibility;
    this.$("baseURL").oninput = updateCompatibility;
    updateCompatibility();
    for (const [index, category] of this.categories.entries()) {
      const button = this.$("settings-tab-" + category);
      button.onclick = () => this.showCategory(category);
      button.onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? this.categories.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + this.categories.length) % this.categories.length;
        this.showCategory(this.categories[next], true);
      };
    }
    this.showCategory(this.category);
    this.$("settings-form").onsubmit = event => {
      event.preventDefault();
      this.save();
    };
    for (const [id, action] of [["probe", "probe"], ["test-api", "test_api"]]) this.$(id).onclick = () => this.testEngine(action);
    root.addEventListener("showing", () => this.renderSearch());
    this.renderEngine();
  },

  destroy() { this.plugin.preferences.delete(this); },

  message(text, error = false) {
    if (!this.root.isConnected) return;
    const output = this.$("settings-notice");
    output.textContent = text || "设置在下一项任务开始时生效";
    output.className = error ? "error" : "secondary";
    output.setAttribute("role", error ? "alert" : "status");
  },

  renderEngine() {
    const state = this.plugin.engineStatus;
    this.$("engine-state").hidden = !state;
    this.$("engine-status").textContent = state?.stage || "";
    this.$("engine-status").className = state?.error ? "error" : "";
    const progress = this.$("engine-progress");
    progress.hidden = !state?.busy;
    const known = state?.busy && Number.isFinite(state.progress);
    if (known) progress.value = state.progress;
    else progress.removeAttribute("value");
    this.$("engine-percent").textContent = known ? Math.round(state.progress) + "%" : "";
    const translating = !!this.plugin.running;
    const engineBusy = !!this.plugin.workerTask || !!state?.busy;
    const busy = translating || engineBusy || this.keyLoading || this.keyLoadError;
    this.root.querySelector('[type="submit"]').disabled = !!(this.keyLoading || this.keyLoadError);
    this.$("probe").disabled = busy;
    this.$("test-api").disabled = busy;
    this.$("refresh-preview").disabled = !!(busy || this.previewBusy);
    const hint = this.$("test-api-hint");
    const reason = translating ? "翻译任务正在进行，测试 API 暂不可用。请等待任务结束。" :
      state?.busy ? (state.stage || "本地引擎正在工作，测试 API 暂不可用。") :
      this.plugin.workerTask ? "本地引擎正在准备，请稍候。" : "";
    hint.textContent = reason;
    hint.hidden = !reason;
    this.$("test-api").title = reason || "测试当前 API 配置";
    this.$("probe").title = translating ? "翻译任务正在进行，暂不能准备引擎" : engineBusy ? "本地引擎正在工作，请稍候" : "检查或准备本地引擎";
    this.$("test-api").setAttribute("aria-disabled", String(busy));
    this.root.setAttribute("aria-busy", String(!!state?.busy));
  },

  renderSearch() {
    const term = this.root.ownerDocument.getElementById("prefs-search").value.trim().toLocaleLowerCase();
    this.root.closest(".pane-container").dataset.searching = String(!!term);
    this.root.querySelector(".settings-nav").hidden = !!term;
    if (term) {
      this.searching = true;
      const preview = this.root.querySelector(".settings-preview");
      if (preview) preview.hidden = true;
      for (const name of this.categories) this.$("settings-" + name).hidden = !this.$("settings-" + name).textContent.toLocaleLowerCase().includes(term);
    } else if (this.searching) {
      this.searching = false;
      this.showCategory(this.category);
    }
  },

  showCategory(category, focus = false) {
    this.category = category;
    const preview = this.root.querySelector(".settings-preview");
    const showPreview = category === "service" && !this.searching;
    if (preview) preview.hidden = !showPreview;
    for (const name of this.categories) {
      const selected = category === name;
      this.$("settings-" + name).hidden = !selected;
      this.$("settings-tab-" + name).setAttribute("aria-selected", String(selected));
      this.$("settings-tab-" + name).tabIndex = selected ? 0 : -1;
    }
    this.$("settings-form").scrollTop = 0;
    this.root.ownerDocument.getElementById("prefs-content").scrollTop = 0;
    if (focus) this.$("settings-tab-" + category).focus();
  },

  values() {
    const settings = { ...this.plugin.settings };
    for (const id of this.fields) settings[id] = this.numbers.has(id) ? Number(this.$(id).value) : this.$(id).value.trim();
    for (const id of this.checks) settings[id] = this.$(id).checked;
    return settings;
  },

  save() {
    if (this.keyLoading || this.keyLoadError) return;
    return this.plugin.savePreferences(this.values(), this.$("apiKey").value.trim());
  },

  testEngine(action) {
    if (this.keyLoading || this.keyLoadError || this.plugin.running || this.plugin.workerTask || this.plugin.engineStatus?.busy) {
      this.renderEngine();
      return;
    }
    this.message("");
    const settings = action === "probe" ? undefined : this.values();
    const key = action === "probe" ? undefined : this.$("apiKey").value.trim();
    // No long-lived promise callbacks in a preference sandbox that Zotero may destroy.
    this.plugin.checkEngine(action, settings, key);
  },

  setupPreviewPanel() {
    this.previewRevision = 0;
    const invalidate = () => {
      this.previewRevision++;
      this.previewRequests = null;
      this.$("request-preview").textContent = "配置已更改，请重新生成预览。";
      this.$("request-kind").disabled = true;
      this.$("copy-request").disabled = true;
    };
    for (const id of [...this.fields, "apiKey"]) {
      this.$(id).addEventListener("input", invalidate);
      this.$(id).addEventListener("change", invalidate);
    }
    for (const id of this.checks) this.$(id).addEventListener("change", invalidate);
    this.$("refresh-preview").onclick = () => {
      if (this.$("refresh-preview").disabled) return;
      this.previewBusy = true;
      this.previewRequests = null;
      this.$("request-preview").textContent = "正在生成实际请求…";
      this.$("copy-request").disabled = true;
      this.$("request-kind").disabled = true;
      this.renderEngine();
      this.plugin.previewRequest(this, this.values(), this.$("apiKey").value.trim());
    };
    this.$("request-kind").onchange = () => this.showRequestPreview();
    this.$("copy-request").onclick = () => {
      if (!this.previewRequests) return;
      const text = this.$("request-preview").textContent;
      navigator.clipboard.writeText(text).then(() => {
        this.message("已复制到剪贴板");
      }).catch(() => {
        this.message("复制失败", true);
      });
    };
    invalidate();
    this.$("request-preview").textContent = "点击“生成预览”查看引擎实际生成的示例请求。";
  },

  finishRequestPreview(requests, revision, error) {
    this.previewBusy = false;
    if (revision === this.previewRevision) {
      if (error) {
        this.$("request-preview").textContent = "无法生成预览：" + error;
      } else {
        this.previewRequests = requests;
        const select = this.$("request-kind");
        select.replaceChildren();
        for (const [index, entry] of requests.entries()) {
          const option = this.root.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "option");
          option.value = String(index); option.textContent = entry.label;
          select.append(option);
        }
        select.value = "0"; select.disabled = false;
        this.showRequestPreview();
      }
    }
    this.renderEngine();
  },

  showRequestPreview() {
    const request = this.previewRequests?.[Number(this.$("request-kind").value)]?.request;
    this.$("request-preview").textContent = request ? JSON.stringify(request, null, 2) : "没有可预览的请求";
    this.$("copy-request").disabled = !request;
  },
};
