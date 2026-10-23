/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils, Cc, Ci */
var LocalTranslate = {
  jobs: [], windows: new Set(), menus: [], running: false, paused: false,
  process: null, importing: 0, pendingNew: new Set(), promptSeen: new Set(), waitingFiles: new Map(),
  toolbarWindows: new Set(), preferences: new Set(), pdfMetadata: new Map(),

  async startup({ id, version, rootURI }) {
    Object.assign(this, { id, version, rootURI });
    this.dir = PathUtils.join(Zotero.Profile.dir, "local-pdf-translate");
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true, permissions: 0o700 });
    this.statePath = PathUtils.join(this.dir, "queue.json");
    this.workerPath = PathUtils.join(this.dir, "worker.py");
    await IOUtils.writeUTF8(this.workerPath, await Zotero.File.getResourceAsync(rootURI + "worker/worker.py"));
    this.runtimeManifest = JSON.parse(await Zotero.File.getResourceAsync(rootURI + "worker/runtime.json"));
    if (await IOUtils.exists(this.statePath)) {
      const saved = await IOUtils.readJSON(this.statePath);
      this.jobs = saved.jobs || [];
      this.promptSeen = new Set(saved.promptSeen || []);
      for (const job of this.jobs) {
        if (["running", "importing"].includes(job.status)) job.status = "interrupted";
      }
      this.paused = this.jobs.some(j => ["queued", "interrupted"].includes(j.status));
    }
    this.observer = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => this.onNotify(event, type, ids),
    }, ["item"], "local-pdf-translate", 100);
    this.registerMenus();
    for (const window of Zotero.getMainWindows()) this.addToolbar(window);
    await Zotero.PreferencePanes.register({
      pluginID: id, id: "local-pdf-translate-settings", label: "本地 PDF 翻译",
      src: "content/ui/preferences.xhtml", scripts: ["content/ui/settings.js", "content/ui/preferences.js"],
      stylesheets: ["content/ui/settings.css", "content/ui/progress.css"],
    });
    this.ready = true;
  },

  changed() {
    this.updateToolbar();
    for (const win of this.windows) if (!win.closed) { win.renderTasks?.(); }
    for (const view of this.preferences) {
      try {
        if (view.root.isConnected) view.renderEngine();
        else this.preferences.delete(view);
      } catch { this.preferences.delete(view); } // Zotero can destroy a pane sandbox during notification.
    }
  },

  setEngineStatus(state) { this.engineStatus = state; this.changed(); },

  async shutdown() {
    this.stopping = true;
    this.ready = false;
    this.paused = true;
    Zotero.Notifier.unregisterObserver(this.observer);
    if (this.newTimer) Zotero.getMainWindow()?.clearTimeout(this.newTimer);
    this.downloadRequest?.abort();
    this.process?.kill(15000);
    await this.enqueueTask?.catch(() => {});
    await this.queueTask?.catch(() => {});
    await this.workerTask?.catch(() => {});
    for (const menu of this.menus) Zotero.MenuManager.unregisterMenu(menu);
    for (const window of [...this.toolbarWindows]) this.removeToolbar(window);
    for (const win of this.windows) if (!win.closed) win.close();
    await this.persist();
  },

};
