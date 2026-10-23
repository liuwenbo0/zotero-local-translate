/* global Zotero */
var SettingsView = {
  category: "general", searching: false,
  categories: ["general", "service", "quality", "pdf", "advanced"],
  fields: ["baseURL", "model", "langIn", "langOut", "qps", "timeout", "thinking", "thinkingProtocol", "reasoningEffort",
    "maxWorkers", "minTextLength", "customPrompt", "fontFamily", "dualMode", "watermark", "ocrMode",
    "shortLineSplitFactor", "maxPagesPerPart", "formulaFontPattern", "formulaCharPattern", "figureTableProtectionThreshold"],
  numbers: new Set(["qps", "timeout", "maxWorkers", "minTextLength", "shortLineSplitFactor", "maxPagesPerPart", "figureTableProtectionThreshold"]),
  checks: ["askOnNew", "includeSubcollections", "skipExisting", "autoExtractGlossary", "ignoreCache",
    "dualTranslateFirst", "enhanceCompatibility", "preserveRichText", "splitShortLines", "skipScannedDetection"],

  $(id) { return this.root.querySelector("#local-translate-" + id); },

  init(root) {
    this.root = root;
    root.closest(".pane-container").classList.add("local-translate-preferences");
    this.plugin = Zotero.LocalTranslate;
    this.plugin.preferences.add(this);
    void this.plugin.loadPreferenceKey(this);
    const settings = this.plugin.settings;
    for (const id of this.fields) this.$(id).value = settings[id];
    for (const id of this.checks) this.$(id).checked = settings[id];
    this.setupNumberControls();
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
    this.$("settings-form").onsubmit = event => {
      event.preventDefault();
      this.save();
    };
    for (const [id, action] of [["probe", "probe"], ["test-api", "test_api"]]) this.$(id).onclick = () => this.testEngine(action);
    root.addEventListener("showing", () => this.renderSearch());
    this.renderEngine();
  },

  destroy() { this.plugin.preferences.delete(this); },

  setupNumberControls() {
    for (const id of this.numbers) {
      const input = this.$(id);
      if (!input || input.parentElement.classList.contains("number-control")) continue;
      const wrapper = input.ownerDocument.createElement("span");
      wrapper.className = "number-control";
      input.parentElement.insertBefore(wrapper, input);
      wrapper.append(input);
      const buttons = input.ownerDocument.createElement("span");
      buttons.className = "number-control-buttons";
      for (const [direction, label] of [["up", "增加"], ["down", "减少"]]) {
        const button = input.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "number-control-button number-control-button-" + direction;
        button.textContent = direction === "up" ? "▲" : "▼";
        button.setAttribute("aria-label", label + (input.getAttribute("aria-label") || input.id));
        button.title = label;
        button.onclick = () => {
          input[direction === "up" ? "stepUp" : "stepDown"]();
          input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
          input.dispatchEvent(new input.ownerDocument.defaultView.Event("change", { bubbles: true }));
        };
        buttons.append(button);
      }
      wrapper.append(buttons);
    }
  },

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
    const busy = translating || engineBusy;
    this.$("probe").disabled = busy;
    this.$("test-api").disabled = busy;
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
      for (const name of this.categories) this.$("settings-" + name).hidden = !this.$("settings-" + name).textContent.toLocaleLowerCase().includes(term);
    } else if (this.searching) {
      this.searching = false;
      this.showCategory(this.category);
    }
  },

  showCategory(category, focus = false) {
    this.category = category;
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

  save() { return this.plugin.savePreferences(this.values(), this.$("apiKey").value || undefined); },

  testEngine(action) {
    if (this.plugin.running || this.plugin.workerTask || this.plugin.engineStatus?.busy) {
      this.renderEngine();
      return;
    }
    this.message("");
    const settings = action === "probe" ? undefined : this.values();
    const key = action === "probe" ? undefined : this.$("apiKey").value || undefined;
    // No long-lived promise callbacks in a preference sandbox that Zotero may destroy.
    this.plugin.checkEngine(action, settings, key);
  },
};
