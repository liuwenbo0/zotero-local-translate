/* global LocalTranslate, Zotero, Services, PathUtils, Cc, Ci */
// User preferences, engine defaults and the Zotero login manager.
Object.defineProperties(LocalTranslate, Object.getOwnPropertyDescriptors({
  get settings() {
    const defaults = {
      baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash",
      langIn: "en", langOut: "zh", rpm: 240, timeout: 180, thinking: "default", thinkingProtocol: "auto", reasoningEffort: "medium",
      askOnNew: true, includeSubcollections: true, skipExisting: true,
      maxWorkers: 0, minTextLength: 5, autoExtractGlossary: true,
      customPrompt: "", fontFamily: "auto", ignoreCache: false,
      dualMode: "side_by_side", dualTranslateFirst: false, watermark: "watermarked",
      ocrMode: "off", enhanceCompatibility: false, preserveRichText: true,
      splitShortLines: false, shortLineSplitFactor: 0.8, maxPagesPerPart: 0,
      skipScannedDetection: false, formulaFontPattern: "", formulaCharPattern: "",
      figureTableProtectionThreshold: 0.9,
    };
    const saved = JSON.parse(Zotero.Prefs.get("extensions.localpdftranslate.settings", true) || "{}");
    // Preserve the saved request rate when upgrading from QPS to RPM.
    if (saved.rpm == null && Number.isInteger(saved.qps)) saved.rpm = saved.qps * 60;
    // Removed options and old machine-specific paths must not reach the engine.
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, saved[key] ?? value]));
  },

  async getKey() {
    const logins = Services.logins.findLogins("chrome://localtranslate", null, "API key");
    return logins[0]?.password || "";
  },

  captureConfiguration(includeKey = true) {
    // Read settings and credentials in the same serialized operation as saves.
    const task = (this.settingsTask || Promise.resolve()).catch(() => {}).then(async () => {
      const config = this.settings;
      const apiKey = includeKey ? await this.getKey() : "";
      return { config, apiKey };
    });
    this.settingsTask = task;
    return task;
  },

  async loadPreferenceKey(view) {
    try {
      const key = await this.getKey();
      if (this.preferences.has(view) && view.root.isConnected && !view.$("apiKey").value) view.$("apiKey").value = key;
    } catch (error) {
      if (this.preferences.has(view)) {
        try { view.keyLoadError = true; view.message("无法读取 API 密钥：" + this.safeError(error), true); }
        catch { this.preferences.delete(view); }
      }
    } finally {
      if (this.preferences.has(view)) {
        try {
          view.keyLoading = false;
          view.$("apiKey").disabled = false;
          view.renderEngine();
        } catch { this.preferences.delete(view); }
      }
    }
  },

  async savePreferences(settings, key) {
    try {
      await this.saveSettings(settings, key);
      for (const view of this.preferences) view.message("配置已保存");
    } catch (error) {
      for (const view of this.preferences) view.message(this.safeError(error), true);
    }
  },

  normalizeSettings(settings) {
    settings = JSON.parse(JSON.stringify(settings));
    if (!Number.isInteger(settings.rpm) || settings.rpm < 1 || settings.rpm > 6000) throw new Error("RPM 应为 1–6000 的整数");
    if (!Number.isInteger(settings.timeout) || settings.timeout < 1) throw new Error("超时时间必须为正整数");
    for (const [name, label] of [["maxWorkers", "并行线程"], ["minTextLength", "最短文本长度"], ["maxPagesPerPart", "分块页数"]]) {
      if (!Number.isInteger(settings[name]) || settings[name] < 0) throw new Error(label + "须为非负整数");
    }
    if (!Number.isFinite(settings.shortLineSplitFactor) || settings.shortLineSplitFactor < 0.1 || settings.shortLineSplitFactor > 1) throw new Error("短行分段阈值须在 0.1–1 之间");
    if (!Number.isFinite(settings.figureTableProtectionThreshold) || settings.figureTableProtectionThreshold < 0 || settings.figureTableProtectionThreshold > 1) throw new Error("图表保护阈值须在 0–1 之间");
    if (settings.maxPagesPerPart > 0 && settings.maxPagesPerPart < 50) throw new Error("引擎分块页数须为 0 或至少 50 页");
    for (const [name, choices] of Object.entries({
      fontFamily: ["auto", "serif", "sans-serif", "script"], dualMode: ["side_by_side", "alternating"],
      watermark: ["watermarked", "no_watermark"], ocrMode: ["off", "auto", "force"],
      thinking: ["default", "enabled", "disabled"],
      thinkingProtocol: ["auto", "thinking", "enable_thinking", "reasoning_effort"],
      reasoningEffort: ["low", "medium", "high"],
    })) if (!choices.includes(settings[name])) throw new Error("无效选项：" + name);
    if (!settings.langOut || !settings.langIn) throw new Error("请填写源语言和目标语言");
    const url = new URL(settings.baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("API 地址须为 HTTP(S) base URL");
    if (!settings.model.trim()) throw new Error("请填写模型");
    settings.baseURL = settings.baseURL.trim().replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
    return settings;
  },

  saveSettings(settings, key) {
    // The caller's preference sandbox may disappear while the login manager is saving.
    settings = JSON.parse(JSON.stringify(settings));
    const task = (this.settingsTask || Promise.resolve()).catch(() => {}).then(async () => {
      settings = this.normalizeSettings(settings);
      if (key !== undefined) {
        const old = Services.logins.findLogins("chrome://localtranslate", null, "API key");
        if (key) {
          const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
          login.init("chrome://localtranslate", null, "API key", "api", key, "", "");
          if (old.length) Services.logins.modifyLogin(old[0], login);
          else await Services.logins.addLoginAsync(login);
        } else for (const login of old) Services.logins.removeLogin(login);
      }
      Zotero.Prefs.set("extensions.localpdftranslate.settings", JSON.stringify(settings), true);
      this.changed();
    });
    this.settingsTask = task;
    return task;
  },
}));
