/* global LocalTranslate, Zotero, Services, IOUtils, PathUtils, ChromeUtils */
// Native Zotero menus, toolbar buttons and the task window.
Object.assign(LocalTranslate, {
  addToolbar(window) {
    if (this.stopping) return;
    const doc = window.document;
    const toolbar = doc.getElementById("zotero-items-toolbar");
    if (!toolbar || doc.getElementById("local-translate-toolbar")) return;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    style.id = "local-translate-toolbar-style";
    style.rel = "stylesheet";
    style.href = "chrome://localtranslate/content/ui/toolbar.css";
    doc.documentElement.append(style);
    const button = doc.createXULElement("toolbarbutton");
    button.id = "local-translate-toolbar";
    button.className = "zotero-tb-button";
    button.setAttribute("type", "menu");
    button.setAttribute("wantdropmarker", "true");
    button.setAttribute("label", "本地 PDF 翻译");
    button.setAttribute("aria-label", "本地 PDF 翻译");
    button.setAttribute("image", "chrome://localtranslate/content/ui/icons/translate.svg");
    const popup = doc.createXULElement("menupopup");
    for (const [label, action] of [
      ["翻译选中条目 / PDF…", () => this.enqueueScope("selected")],
      ["翻译当前分类…", () => this.enqueueScope("collection")],
      ["翻译当前整个文库…", () => this.enqueueScope("library")],
      ["任务与进度…", () => this.openWindow("tasks")],
      ["配置…", () => this.openSettings()],
    ]) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", () => Promise.resolve().then(action).catch(e => this.alert(this.safeError(e))));
      popup.append(item);
    }
    button.append(popup);
    toolbar.insertBefore(button, toolbar.querySelector("spacer") || doc.getElementById("zotero-tb-search"));
    this.toolbarWindows.add(window);
    this.updateToolbar();
  },

  removeToolbar(window) {
    window.document.getElementById("local-translate-toolbar")?.remove();
    window.document.getElementById("local-translate-toolbar-style")?.remove();
    this.toolbarWindows.delete(window);
  },

  updateToolbar() {
    const active = this.jobs.find(j => ["running", "importing"].includes(j.status));
    const pending = this.jobs.filter(j => ["queued", "interrupted"].includes(j.status)).length;
    const failed = this.jobs.filter(j => j.status === "failed").length;
    for (const window of this.toolbarWindows) {
      const button = window.document.getElementById("local-translate-toolbar");
      if (!button) continue;
      button.setAttribute("data-status", active || this.engineStatus?.busy ? "running" : failed ? "failed" : "idle");
      button.setAttribute("tooltiptext", `本地 PDF 翻译${active ? ` · ${active.preparing ? "准备引擎" : Math.round(active.progress || 0) + "%"} · ${active.stage}` : this.engineStatus?.busy ? " · " + this.engineStatus.stage : ""} · ${pending} 待处理${this.paused ? "（已暂停）" : ""}${failed ? ` · ${failed} 失败` : ""}`);
    }
  },

  registerMenus() {
    const menu = (label, action) => ({
      menuType: "menuitem", onShowing: (_event, context) => { context.menuElem.label = label; },
      onCommand: () => Promise.resolve(action()).catch(e => this.alert(e.message)),
    });
    const actions = [
      menu("翻译选中条目 / PDF…", () => this.enqueueScope("selected")),
      menu("翻译当前分类…", () => this.enqueueScope("collection")),
      menu("翻译当前整个文库…", () => this.enqueueScope("library")),
      { menuType: "separator" },
      menu("任务与进度…", () => this.openWindow()),
    ];
    for (const target of ["main/menubar/tools", "main/library/item", "main/library/collection"]) {
      this.menus.push(Zotero.MenuManager.registerMenu({
        menuID: "local-pdf-translate-" + target.replaceAll("/", "-"), pluginID: this.id,
        target, menus: [{ menuType: "submenu", onShowing: (_event, ctx) => { ctx.menuElem.label = "本地 PDF 翻译"; }, menus: actions }],
      }));
    }
  },

  alert(message) { Services.prompt.alert(Zotero.getMainWindow(), "本地 PDF 翻译", message); },

  openSettings() { return Zotero.Utilities.Internal.openPreferences("local-pdf-translate-settings"); },

  openWindow(tab = "tasks") {
    if (tab === "settings") return this.openSettings();
    for (const win of this.windows) if (!win.closed) { win.focus(); return win; }
    const win = Zotero.getMainWindow().openDialog("chrome://localtranslate/content/ui/window.xhtml", "local-pdf-translate", "chrome,centerscreen,resizable,width=940,height=650");
    this.windows.add(win);
    return win;
  },
});
