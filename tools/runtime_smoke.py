#!/usr/bin/env python3
"""Launch the installed Zotero in an isolated profile and verify the actual XPI."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--app", default="/Applications/Zotero.app/Contents/MacOS/zotero")
parser.add_argument("--keep-open", action="store_true")
parser.add_argument(
    "--fresh-bootstrap",
    action="store_true",
    help="Download uv and install a new venv, reusing only isolated Python and download caches",
)
parser.add_argument(
    "--runtime-profile",
    help="Reuse only runtime and assets from an earlier isolated profile",
)
parser.add_argument(
    "--real-translation",
    action="store_true",
    help="Use the configured paid API for the fixture",
)
args = parser.parse_args()
work = Path(tempfile.mkdtemp(prefix="localtranslate-smoke-"))
profile, data = work / "profile", work / "data"
(profile / "extensions").mkdir(parents=True)
data.mkdir()
version = json.loads((ROOT / "addon/manifest.json").read_text())["version"]
xpi = ROOT / f"dist/zotero-local-translate-{version}.xpi"
preferences = {
    "extensions.zotero.dataDir": str(data),
    "extensions.zotero.useDataDir": True,
    "extensions.zotero.firstRun": False,
    "extensions.zotero.firstRun2": False,
    "extensions.zotero.lastVersion": "10.0.6",
    "extensions.zotero.httpServer.port": 23129,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "app.update.auto": False,
    "extensions.localpdftranslate.settings": json.dumps(
        {"askOnNew": False, "thinking": "disabled"}
    ),
}
(profile / "prefs.js").write_text(
    "\n".join(
        f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in preferences.items()
    )
)

if args.runtime_profile:
    plugin_dir = profile / "local-pdf-translate"
    plugin_dir.mkdir()
    for name in ("assets",) if args.fresh_bootstrap else ("runtime", "assets"):
        source = Path(args.runtime_profile) / "local-pdf-translate" / name
        if source.exists():
            (plugin_dir / name).symlink_to(source, target_is_directory=True)

    if args.fresh_bootstrap:
        runtime = plugin_dir / "runtime"
        runtime.mkdir()
        for name in ("python", "cache"):
            source = Path(args.runtime_profile) / "local-pdf-translate/runtime" / name
            if source.exists():
                (runtime / name).symlink_to(source, target_is_directory=True)

if args.real_translation:
    from pdf2zh_next.config.main import ConfigManager
    from pdf2zh_next.config.cli_env_model import CLIEnvSettingsModel

    manager = ConfigManager()
    raw = manager._read_toml_file(Path.home() / ".config/pdf2zh/config.v3.toml")
    configured = manager._build_model_from_args(
        CLIEnvSettingsModel, raw
    ).to_settings_model()
    configured.validate_settings()
    detail = configured.translate_engine_settings
    private = work / "api.json"
    private.touch(mode=0o600)
    private.write_text(
        json.dumps(
            {
                "baseURL": detail.openai_base_url,
                "model": detail.openai_model,
                "key": detail.openai_api_key,
            }
        )
    )

# A minimal valid PDF used only in this isolated library (no paid API call).
try:
    import pymupdf
except ImportError:
    raise SystemExit("Run with the PDFMathTranslate virtual environment's Python")
with pymupdf.open() as doc:
    page = doc.new_page()
    page.insert_text((72, 72), "Local PDF Translate integration fixture.")
    doc.save(work / "fixture.pdf")
    doc.set_metadata(
        {
            "producer": "BabelDOC0.6.2_Translation_generated_by_AI,please_carefully_discern"
        }
    )
    doc.save(work / "unrelated-name.pdf", deflate=True, use_objstms=1)

harness = (
    r"""
async function runSmoke() {
  if (Zotero.localTranslateSmokeStarted) return;
  Zotero.localTranslateSmokeStarted = true;
  const report = { checks: [], ok: false };
  const check = (name, condition) => { if (!condition) throw new Error(name); report.checks.push(name); };
  try {
    for (let n = 0; !Zotero.LocalTranslate && n < 120; n++) await Zotero.Promise.delay(250);
    const p = Zotero.LocalTranslate;
    check("plugin startup", !!p);
    check("three registered menu targets", p.menus.length === 3);
    check("preferences pane registered", Zotero.PreferencePanes.pluginPanes.some(x => x.id === "local-pdf-translate-settings"));
    const mainWindow = Zotero.getMainWindow();
    const toolbar = mainWindow.document.getElementById("local-translate-toolbar");
    check("toolbar icon is in the middle item toolbar", toolbar?.parentElement.id === "zotero-items-toolbar");
    check("toolbar icon is visible", toolbar.getBoundingClientRect().width > 0 && toolbar.getBoundingClientRect().height > 0);
    check("toolbar menu has five user actions", toolbar.querySelectorAll("menuitem").length === 5);
    check("toolbar stylesheet resolves the SVG", mainWindow.getComputedStyle(toolbar).listStyleImage.includes("translate.svg"));
    const icon = await Zotero.Plugins.getIconURI(p.id, 48);
    check("add-on manager icon is registered", icon.includes("translate.svg"));
    onMainWindowUnload({window:mainWindow});
    check("window unload removes toolbar icon", !mainWindow.document.getElementById("local-translate-toolbar"));
    onMainWindowLoad({window:mainWindow}); onMainWindowLoad({window:mainWindow});
    check("window load creates exactly one toolbar icon", mainWindow.document.querySelectorAll("#local-translate-toolbar").length === 1);
    const waitPane = async plugin => {
      const prefWindow = plugin.openSettings();
      for (let n=0; n<150; n++) {
        const view = prefWindow.Zotero_Preferences?.getScope("local-pdf-translate-settings")?.SettingsView;
        if (view?.root?.isConnected) return {prefWindow,view};
        await Zotero.Promise.delay(100);
      }
      throw new Error("Native preferences failed to initialize");
    };
    let {prefWindow,view:settingsView} = await waitPane(p);
    let field = id => settingsView.$(id);
    check("full settings load in Zotero native preferences", prefWindow.document.documentElement.getAttribute("windowtype") === "zotero:pref" && field("langIn").value === p.settings.langIn);
    check("native settings are separate from task windows", !p.windows.has(prefWindow));
    const win = p.openWindow();
    for (let n=0; !win.TaskView?.rows && n<100; n++) await Zotero.Promise.delay(100);
    check("empty task view hides the table and disables pause", !win.document.getElementById("empty").hidden && win.document.getElementById("empty").nextElementSibling.hidden && win.document.getElementById("pause").disabled);
    check("task window shows the current plugin version", win.document.getElementById("version").textContent === "v" + p.version);
    check("task window has a native settings entry without duplicate forms", !!win.document.getElementById("open-settings") && !win.document.getElementById("langIn"));
    const configuredFields = ["langIn","langOut","maxWorkers","minTextLength","customPrompt","fontFamily","dualMode","watermark","ocrMode","maxPagesPerPart","formulaFontPattern","figureTableProtectionThreshold"];
    check("practical engine settings are initialized", configuredFields.every(id => field(id)?.value !== undefined));
    check("settings expose five focused categories", settingsView.root.querySelectorAll('.settings-nav [role="tab"]').length === 5);
    check("only the general settings page is initially visible", !field("settings-general").hidden && settingsView.categories.filter(name=>!field("settings-"+name).hidden).length === 1);
    field("langIn").value = "ja";
    settingsView.showCategory("service"); settingsView.showCategory("general");
    check("switching settings pages preserves unsaved input", field("langIn").value === "ja"); field("langIn").value = p.settings.langIn;
    check("removed configuration options stay absent", !field("useGlobalConfig") && !field("glossaries") && !field("python") && !field("engineRoot"));
    field("settings-tab-general").dispatchEvent(new prefWindow.KeyboardEvent("keydown", {key:"ArrowRight",bubbles:true}));
    check("settings categories support arrow-key navigation", field("settings-tab-service").getAttribute("aria-selected") === "true" && prefWindow.document.activeElement === field("settings-tab-service"));
    const installEvents = [], downloadFractions = [];
    const originalStatus = p.setEngineStatus;
    p.setEngineStatus = state => {installEvents.push(state.stage); if (state.stage.includes("下载运行环境管理器") && Number.isFinite(state.progress)) downloadFractions.push(state.progress); originalStatus.call(p,state);};
    field("apiKey").value="unsaved-probe-fixture";
    field("probe").click();
    check("preparing the engine preserves an unsaved API key", field("apiKey").value === "unsaved-probe-fixture");
    const preparing = p.workerTask;
    for (let n=0; !p.engineStatus?.busy && n<100; n++) await Zotero.Promise.delay(10);
    check("unknown preparation progress has no fabricated percentage", !field("engine-progress").hasAttribute("value") && field("engine-percent").textContent === "");
    check("unknown progress uses a moving segment", prefWindow.getComputedStyle(field("engine-progress")).animationName === "local-translate-wait" && prefWindow.getComputedStyle(field("engine-progress")).backgroundSize.startsWith("30%"));
    check("engine progress has one shared location", settingsView.root.querySelectorAll("progress").length === 1 && field("settings-notice").textContent === "设置在下一项任务开始时生效");
    prefWindow.close();
    await Zotero.Promise.delay(50);
    check("closing preferences detaches its view while preparation continues", p.preferences.size === 0 && !!p.workerTask);
    ({prefWindow,view:settingsView} = await waitPane(p));
    check("reopening preferences restores live preparation status", field("engine-status").textContent === p.engineStatus.stage && !field("engine-state").hidden && field("probe").disabled);
    check("reopening does not start a duplicate preparation", p.preferences.size === 1 && !!p.workerTask);
    const probe = await preparing;
    p.setEngineStatus = originalStatus;
    check("preparation completion updates reopened preferences", p.engineStatus.ready && field("engine-progress").hidden && !field("probe").disabled && field("engine-status").textContent.includes("2.9.0"));
    check("managed engine exposes preparation progress", installEvents.some(stage=>stage.includes("模型与字体")));
    const installed = await p.ensureEngine();
    check("engine installed inside isolated Zotero profile", installed.python.startsWith(p.dir) && await IOUtils.exists(installed.python));
    check("managed runtime marker exists", await IOUtils.exists(PathUtils.join(installed.engineRoot,"ready.json")));
    check("engine can be reused without downloading", (await p.ensureEngine()).python === installed.python);
    check("real Python subprocess protocol", probe.version === "2.9.0");
    if (FRESH_BOOTSTRAP) {
      check("real bootstrap download emits byte percentages", downloadFractions.length > 1 && downloadFractions.some(value=>value>0 && value<100) && downloadFractions.at(-1) === 100);
      report.bootstrapDownload = {events:downloadFractions.length,first:downloadFractions[0],last:downloadFractions.at(-1)};
    }
    // View state follows backend state across every category and re-open, including errors.
    p.setEngineStatus({stage:"Download fixture",busy:true,progress:42});
    check("known preparation progress displays its actual fraction", field("engine-progress").value === 42 && field("engine-percent").textContent === "42%");
    p.setEngineStatus({stage:"Install fixture",busy:true,progress:null});
    check("next unknown phase resets the previous percentage", !field("engine-progress").hasAttribute("value") && field("engine-percent").textContent === "");
    p.setEngineStatus({stage:"Network fixture failure",error:true});
    prefWindow.close(); await Zotero.Promise.delay(50);
    ({prefWindow,view:settingsView} = await waitPane(p));
    check("reopening also restores an engine failure", field("engine-status").textContent === "Network fixture failure" && field("engine-status").classList.contains("error") && field("engine-progress").hidden);
    p.setEngineStatus({stage:"引擎已就绪",ready:true});
    field("qps").value="0"; field("apiKey").value="preserve-on-error";
    field("test-api").click();
    await p.workerTask.catch(()=>{});
    check("invalid API settings preserve the entered key and expose the error", field("apiKey").value === "preserve-on-error" && p.engineStatus.error && field("engine-status").textContent.includes("QPS") && field("engine-progress").hidden);
    field("qps").value=4; field("apiKey").value="";
    p.setEngineStatus({stage:"引擎已就绪",ready:true});
    const originalSettings = p.settings;
    await p.saveSettings({ ...originalSettings, baseURL: "https://example.invalid/v1", model: "test-model" }, "isolated-test-key");
    check("custom key stored in login manager", (await p.getKey()) === "isolated-test-key");
    check("settings do not contain API key", !Zotero.Prefs.get("extensions.localpdftranslate.settings", true).includes("isolated-test-key"));
    await p.saveSettings(originalSettings);
    prefWindow.close(); await Zotero.Promise.delay(50);
    ({prefWindow,view:settingsView} = await waitPane(p));
    for(let n=0; !field("apiKey").value && n<50; n++) await Zotero.Promise.delay(10);
    check("stored API key is restored into a masked password field", field("apiKey").type === "password" && field("apiKey").value === "isolated-test-key");
    field("apiKey").value="updated-isolated-key"; await settingsView.save();
    check("saving an API key keeps its masked value visible", field("apiKey").value === "updated-isolated-key" && await p.getKey() === "updated-isolated-key");
    await p.saveSettings(originalSettings,"isolated-test-key"); field("apiKey").value="isolated-test-key";
    const customized = {...originalSettings,langIn:"ja",langOut:"zh-TW",maxWorkers:6,minTextLength:2,
      dualMode:"alternating",watermark:"no_watermark",ocrMode:"auto",fontFamily:"sans-serif",customPrompt:"Use scientific terminology"};
    await p.saveSettings(customized);
    check("advanced settings survive storage", p.settings.dualMode === "alternating" && p.settings.langOut === "zh-TW" && p.settings.maxWorkers === 6);
    await p.saveSettings(originalSettings);
    if (REAL_TRANSLATION) {
      const api = await IOUtils.readJSON(TEST_ROOT + "/api.json");
      await IOUtils.remove(TEST_ROOT + "/api.json");
      await p.saveSettings({...originalSettings,baseURL:api.baseURL,model:api.model},api.key);
    }
    if (REAL_TRANSLATION) await p.saveSettings({ ...p.settings,
      dualMode:"alternating",dualTranslateFirst:true,watermark:"no_watermark",
      autoExtractGlossary:false,fontFamily:"sans-serif" });
    if (REAL_TRANSLATION) {
      for (const id of settingsView.fields) field(id).value=p.settings[id];
      for (const id of settingsView.checks) field(id).checked=p.settings[id];
      field("apiKey").value=await p.getKey();
      field("test-api").click();
      const apiTask=p.workerTask;
      prefWindow.close(); await Zotero.Promise.delay(50);
      ({prefWindow,view:settingsView} = await waitPane(p));
      const result=await apiTask;
      check("native API test survives closing and reopening its page", !!result.message && p.engineStatus.ready && field("engine-status").textContent.includes("API 连接成功") && !field("test-api").disabled);
    }
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "Local Translate · Isolated Integration Test");
    await parent.saveTx();
    const source = await Zotero.Attachments.importFromFile({ file: TEST_ROOT + "/fixture.pdf", parentItemID: parent.id });
    check("source PDF imported in isolated library", await source.fileExists());
    check("progress page has no duplicated translation entry buttons", !win.document.getElementById("selected") && !win.document.getElementById("collection") && !win.document.getElementById("library"));
    const oldParent = new Zotero.Item("journalArticle"); oldParent.libraryID=parent.libraryID;
    oldParent.setField("title","Previously translated fixture"); await oldParent.saveTx();
    const oldOriginal=await Zotero.Attachments.importFromFile({file:TEST_ROOT+"/fixture.pdf",parentItemID:oldParent.id});
    const oldTranslation=await Zotero.Attachments.importFromFile({file:TEST_ROOT+"/unrelated-name.pdf",parentItemID:oldParent.id,title:"Renamed external translation"});
    check("Zotero metadata parser detects an untagged, renamed and compressed BabelDOC PDF", !p.isTranslation(oldTranslation) && await p.isTranslatedPDF(oldTranslation));
    check("one external translation skips the whole parent", (await p.candidatesFor([oldParent])).candidates.length===0);
    const defensive=await p.runWorker({action:"translate",input:TEST_ROOT+"/unrelated-name.pdf",output:TEST_ROOT+"/must-not-be-created"});
    check("legacy queued translated input is safely skipped by the real worker", defensive.skipped===true && !(await IOUtils.exists(TEST_ROOT+"/must-not-be-created")));
    const actualWorker = p.runWorker.bind(p);
    const fakeWorker = async (payload, progress) => {
      progress?.({ type: "progress", progress: 50, stage: "Integration test" });
      return { outputs: { mono: TEST_ROOT + "/fixture.pdf", dual: TEST_ROOT + "/fixture.pdf" } };
    };
    if (!REAL_TRANSLATION) p.runWorker = fakeWorker;
    await p.enqueueItems([parent], false);
    for (let n = 0; p.running && n < 1200; n++) await Zotero.Promise.delay(100);
    check("queue completed", p.jobs[0]?.status === "completed");
    const outputs = await p.outputsFor(source);
    check("mono is a real child attachment", outputs.mono?.parentItemID === parent.id && await outputs.mono.fileExists());
    check("dual is a real child attachment", outputs.dual?.parentItemID === parent.id && await outputs.dual.fileExists());
    check("new attachment titles omit plugin branding", outputs.mono.getField("title") === "译文 (zh)" && outputs.dual.getField("title") === "双语 (zh)");
    check("rerun creates no duplicate job", await p.enqueueItems([parent], false) === 0);
    check("exactly original plus two translated PDFs", parent.getAttachments().length === 3);
    check("progress window renders tasks", win.document.getElementById("job-list").children.length === 1);
    await p.persist();
    const saved = await IOUtils.readJSON(p.statePath);
    check("queue checkpoint persisted", saved.jobs[0].status === "completed");
    check("checkpoint contains no API credentials", !JSON.stringify(saved).includes("apiKey"));
    p.runWorker = fakeWorker;
    // Exercise the actual search paths for one collection, its descendants, and the whole library.
    const collection = new Zotero.Collection(); collection.libraryID = Zotero.Libraries.userLibraryID;
    collection.name = "Translation Test Collection"; await collection.saveTx();
    const subcollection = new Zotero.Collection(); subcollection.libraryID = collection.libraryID;
    subcollection.name = "Child Collection"; subcollection.parentID = collection.id; await subcollection.saveTx();
    const item2 = new Zotero.Item("journalArticle"); item2.libraryID = parent.libraryID;
    item2.setField("title", "Collection scope fixture"); item2.setCollections([subcollection.id]); await item2.saveTx();
    await Zotero.Attachments.importFromFile({ file: TEST_ROOT + "/fixture.pdf", parentItemID: item2.id });
    const filtered=await p.candidatesFor([parent,oldParent,item2]);
    check("mixed batch counts only PDFs that actually need translation", filtered.candidates.length===1 && filtered.candidates[0].parentItemID===item2.id);
    const realPane = Zotero.getActiveZoteroPane;
    Zotero.getActiveZoteroPane = () => ({ getSelectedLibraryID: () => parent.libraryID, getSelectedCollection: () => collection,
      getSelectedItems: () => [parent] });
    try {
      check("selected scope skips completed outputs", await p.enqueueScope("selected", false) === 0);
      check("collection scope includes subcollections", await p.enqueueScope("collection", false) === 1);
      for (let n = 0; p.running && n < 300; n++) await Zotero.Promise.delay(100);
      check("collection task completes", p.jobs[1]?.status === "completed");
      check("whole-library scope skips existing translations", await p.enqueueScope("library", false) === 0);
    } finally { Zotero.getActiveZoteroPane = realPane; p.runWorker = actualWorker; }
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID(p.id);
    await addon.disable();
    await lifecycle;
    check("disabling plugin removes toolbar and closes its window", !mainWindow.document.getElementById("local-translate-toolbar") && win.closed);
    check("disabling a plugin keeps Zotero native preferences open", !prefWindow.closed);
    await addon.enable();
    for (let n=0; !Zotero.LocalTranslate?.ready && n<100;n++) await Zotero.Promise.delay(100);
    const enabled = Zotero.LocalTranslate;
    check("re-enabling restores one toolbar icon", !!enabled && mainWindow.document.querySelectorAll("#local-translate-toolbar").length === 1);
    check("re-enabling restores queue history", enabled.jobs.length === 2 && enabled.jobs.every(j=>j.status === "completed"));
    await addon.disable(); await addon.enable();
    for (let n=0; (!Zotero.LocalTranslate?.ready || Zotero.LocalTranslate === enabled) && n<100;n++) await Zotero.Promise.delay(100);
    check("rapid disable-enable keeps a single usable toolbar", !!Zotero.LocalTranslate?.ready && Zotero.LocalTranslate !== enabled && mainWindow.document.querySelectorAll("#local-translate-toolbar").length === 1);
    const review = Zotero.LocalTranslate;
    const reviewWin = review.openWindow("tasks");
    for (let n=0; !reviewWin.TaskView?.rows && n<100;n++) await Zotero.Promise.delay(100);
    ({prefWindow,view:settingsView} = await waitPane(review));
    const originalJobs = review.jobs;
    review.jobs = [...originalJobs,
      {id:"visual-queued",title:"Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",language:"zh",status:"queued",progress:0,stage:"等待翻译"},
      {id:"visual-failed",title:"A document that needs attention",language:"zh",status:"failed",progress:0,error:"API request failed: the configured service rejected the request. Check the model and API settings, then retry.",stage:"失败"},
      {id:"visual-active",title:"Attention Is All You Need — A long document title to verify wrapping and progress updates",language:"zh",status:"running",progress:37,stage:"翻译段落"}];
    review.paused = true;
    review.changed();
    const doc = reviewWin.document;
    const activeRow = doc.querySelector('[data-job-id="visual-active"]');
    reviewWin.TaskView.select("visual-active");
    const cancel = doc.querySelector("#task-actions button"); cancel.focus();
    review.jobs.at(-1).progress = 38; review.changed();
    check("progress updates preserve row and focused action", doc.querySelector('[data-job-id="visual-active"]') === activeRow && doc.activeElement === cancel);
    check("actions are shared beneath the task list", !activeRow.querySelector("button") && !!doc.querySelector("#task-actions button"));
    check("active task appears exactly once", doc.querySelectorAll('[data-job-id="visual-active"]').length === 1);
    check("selected progress matches the bar", doc.getElementById("detail-percent").textContent === "38%" && doc.getElementById("detail-progress").value === 38);
    reviewWin.TaskView.select("visual-failed"); const errorDetails = doc.getElementById("detail-error"); errorDetails.open = true; review.changed();
    check("progress updates preserve expanded error details", errorDetails.open);
    check("paused queue offers one resume control", doc.getElementById("pause").textContent === "继续队列" && !doc.getElementById("resume"));
    check("completed tasks hide the loading bar", (()=>{reviewWin.TaskView.select(originalJobs[0].id);return doc.getElementById("detail-progress").parentElement.hidden;})());
    check("native Zotero theme tokens are available", !!reviewWin.getComputedStyle(doc.documentElement).getPropertyValue("--color-background").trim());
    reviewWin.resizeTo(680,540); await Zotero.Promise.delay(100);
    check("compact task window has no horizontal overflow", doc.documentElement.scrollWidth <= doc.documentElement.clientWidth);
    review.jobs.at(-1).preparing = true; review.jobs.at(-1).preparationProgress = null;
    reviewWin.TaskView.select("visual-active");
    check("preparing a task never appears as a full translation bar", !doc.getElementById("detail-progress").hasAttribute("value") && doc.getElementById("detail-percent").textContent === "" && doc.getElementById("detail-status").textContent === "准备引擎");
    review.jobs.at(-1).preparationProgress = 56; review.changed();
    check("task preparation displays download fraction separately", doc.getElementById("detail-progress").value === 56 && review.jobs.at(-1).progress === 38);
    review.jobs.at(-1).preparing = false; review.changed();
    check("translation resumes its own percentage after preparation", doc.getElementById("detail-progress").value === 38);
    const table=doc.getElementById("task-table"), all=doc.getElementById("select-all");
    reviewWin.TaskView.selectAll(false);
    table.dispatchEvent(new reviewWin.KeyboardEvent("keydown",{key:"a",metaKey:true,bubbles:true}));
    check("Command-A selects all tasks and checks the header", reviewWin.TaskView.selectedIDs.size===review.jobs.length && all.checked && !all.indeterminate);
    const selection=Array.from(reviewWin.TaskView.selectedIDs).join(); review.changed();
    check("progress updates preserve a multiple selection", Array.from(reviewWin.TaskView.selectedIDs).join()===selection);
    all.click();
    check("header checkbox can deselect every task", reviewWin.TaskView.selectedIDs.size===0 && !all.checked);
    reviewWin.TaskView.select("visual-active");
    reviewWin.TaskView.rows.get("visual-failed").parts.check.click();
    check("row checkboxes support additive selection and mixed header state", reviewWin.TaskView.selectedIDs.size===2 && all.indeterminate && doc.getElementById("detail-title").textContent==="已选择 2 个任务");
    reviewWin.TaskView.select("visual-active");
    reviewWin.TaskView.rows.get("visual-queued").dispatchEvent(new reviewWin.MouseEvent("click",{shiftKey:true,bubbles:true}));
    check("Shift-click selects the contiguous task range", reviewWin.TaskView.selectedIDs.size===3);
    reviewWin.TaskView.rows.get("visual-failed").dispatchEvent(new reviewWin.MouseEvent("click",{ctrlKey:true,bubbles:true}));
    check("Control-click toggles a task without discarding the selection", reviewWin.TaskView.selectedIDs.size===2 && !reviewWin.TaskView.selectedIDs.has("visual-failed"));
    reviewWin.TaskView.selectAll();
    check("bulk actions show counts for eligible tasks only", doc.getElementById("task-actions").textContent.includes("重试 1 项") && doc.getElementById("task-actions").textContent.includes("取消 2 项") && doc.getElementById("task-actions").textContent.includes("移除 4 项记录"));
    reviewWin.TaskView.select("visual-active");
    let categoriesFit = true;
    prefWindow.resizeTo(800,700); await Zotero.Promise.delay(100);
    for (const category of settingsView.categories) {
      settingsView.showCategory(category);
      categoriesFit &&= field("settings-form").scrollWidth <= field("settings-form").clientWidth;
    }
    check("all five native settings pages fit without horizontal overflow", categoriesFit);
    settingsView.showCategory("general");
    check("checkboxes align with the input column in native preferences", Math.abs(field("askOnNew").getBoundingClientRect().left - field("langIn").getBoundingClientRect().left) < 2);
    settingsView.showCategory("service");
    const thinking = field("thinking"); thinking.value="enabled"; thinking.dispatchEvent(new prefWindow.Event("change"));
    field("thinkingProtocol").value="enable_thinking"; field("thinkingProtocol").dispatchEvent(new prefWindow.Event("change"));
    check("generic thinking settings hide irrelevant effort control", field("reasoning-effort-row").hidden && !field("thinkingProtocol").disabled);
    thinking.value="default"; thinking.dispatchEvent(new prefWindow.Event("change"));
    check("API default mode does not require a protocol", field("thinkingProtocol").disabled);
    settingsView.showCategory("general");
    field("langIn").value="ja"; await settingsView.save();
    check("saving from native preferences persists values", review.settings.langIn === "ja" && field("settings-notice").textContent.includes("已保存"));
    await review.saveSettings({...review.settings,langIn:"en"}); field("langIn").value="en";
    const originalGetKey=review.getKey;
    let releaseKey;
    review.getKey=()=>new Promise(resolve=>{releaseKey=resolve;});
    field("langIn").value="de"; field("apiKey").value="";
    field("settings-form").dispatchEvent(new prefWindow.Event("submit",{bubbles:true,cancelable:true}));
    prefWindow.close(); await Zotero.Promise.delay(50);
    releaseKey("isolated-test-key");
    await Zotero.Promise.delay(100);
    review.getKey=originalGetKey;
    ({prefWindow,view:settingsView} = await waitPane(review));
    check("saving survives destruction of its preference sandbox", review.settings.langIn === "de" && field("langIn").value === "de");
    await review.saveSettings({...review.settings,langIn:"en"}); field("langIn").value="en";
    const saveButton = settingsView.root.querySelector('.save-row button');
    check("native save action is visible", saveButton.getBoundingClientRect().top >= 0 && saveButton.getBoundingClientRect().bottom <= prefWindow.innerHeight);
    await prefWindow.Zotero_Preferences.navigateToPane("zotero-prefpane-general");
    check("native built-in preferences remain usable", !prefWindow.Zotero_Preferences.panes.get("zotero-prefpane-general").container.hidden);
    review.openSettings(); await Zotero.Promise.delay(100);
    check("settings entry returns to the existing plugin pane", settingsView.root.closest(".pane-container").hidden === false && review.preferences.size === 1);
    settingsView.showCategory("general");
    prefWindow.Zotero_Preferences.searchField.value="超时";
    await prefWindow.Zotero_Preferences._search("超时");
    check("native search finds settings in a hidden category", !field("settings-service").hidden && !settingsView.root.closest(".pane-container").classList.contains("hidden-by-search"));
    prefWindow.Zotero_Preferences.searchField.value="";
    await prefWindow.Zotero_Preferences._search("");
    review.openSettings(); await Zotero.Promise.delay(100);
    check("leaving native search restores category navigation", !settingsView.root.querySelector(".settings-nav").hidden && !field("settings-general").hidden && field("settings-service").hidden);
    report.layout=[];
    for (const width of [800,1100]) {
      prefWindow.resizeTo(width,700); await Zotero.Promise.delay(150);
      const pane=settingsView.root.closest(".pane-container");
      const host=prefWindow.Zotero_Preferences.content;
      const rect=pane.getBoundingClientRect(), outer=host.getBoundingClientRect();
      const offset=Math.abs((rect.left+rect.width/2)-(outer.left+host.clientLeft+host.clientWidth/2));
      check(width+"px preferences column is horizontally centered", offset < 2 && rect.width <= 744);
      check(width+"px preferences have symmetric inner margins", settingsView.root.getBoundingClientRect().left-rect.left >= 24 && rect.right-settingsView.root.getBoundingClientRect().right >= 24);
      for(const category of settingsView.categories) {
        settingsView.showCategory(category);
        const form=field("settings-form"), actions=settingsView.root.querySelector(".settings-actions");
        check(width+"px "+category+" scrolls without overlapping the save row", form.clientHeight>80 && form.getBoundingClientRect().bottom <= actions.getBoundingClientRect().top+1 && form.scrollWidth<=form.clientWidth);
      }
      settingsView.showCategory("advanced");
      field("settings-form").scrollTop=field("settings-form").scrollHeight;
      check(width+"px final controls remain reachable above the footer", field("skipScannedDetection").getBoundingClientRect().bottom <= field("settings-form").getBoundingClientRect().bottom);
      report.layout.push({width:prefWindow.innerWidth,paneWidth:rect.width,centerOffset:offset,formHeight:field("settings-form").clientHeight});
    }
    prefWindow.resizeTo(800,700); await Zotero.Promise.delay(100);
    reviewWin.resizeTo(940,650);
    if (KEEP_OPEN) {
      const capture = async (window,name) => {
        const canvas = window.document.createElementNS("http://www.w3.org/1999/xhtml","canvas");
        canvas.width=window.innerWidth; canvas.height=window.innerHeight;
        canvas.getContext("2d").drawWindow(window,0,0,canvas.width,canvas.height,"rgb(255,255,255)");
        const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0));
        await IOUtils.write(TEST_ROOT+"/"+name+".png",bytes);
      };
      for (const [theme,dark] of [["light",0],["dark",1]]) {
        Services.prefs.setIntPref("ui.systemUsesDarkTheme",dark);
        await Zotero.Promise.delay(200);
        check(theme+" native theme follows system override", prefWindow.matchMedia("(prefers-color-scheme: dark)").matches === !!dark);
        for (const category of settingsView.categories) {
          settingsView.showCategory(category); await Zotero.Promise.delay(100);
          const button=settingsView.root.querySelector('.save-row button');
          check(theme+" "+category+" keeps save visible", button.getBoundingClientRect().bottom <= prefWindow.innerHeight);
          await capture(prefWindow,"settings-"+category+"-"+theme);
        }
        settingsView.showCategory("advanced");
        review.setEngineStatus({stage:"下载 / 校验本地模型与字体",busy:true,progress:null});
        await Zotero.Promise.delay(100);
        await capture(prefWindow,"engine-wait-"+theme);
        review.setEngineStatus({stage:"下载运行环境管理器",busy:true,progress:42});
        await Zotero.Promise.delay(100);
        await capture(prefWindow,"engine-download-"+theme);
        review.setEngineStatus({stage:"引擎已就绪",ready:true});
        await capture(reviewWin,"tasks-"+theme);
        check(theme+" progress detail sits directly above the task list", doc.getElementById("task-detail").getBoundingClientRect().bottom+16 <= doc.querySelector(".table-wrap").getBoundingClientRect().top);
        const visibleJobs=review.jobs;
        review.jobs=[]; review.changed();
        await capture(reviewWin,"tasks-empty-"+theme);
        const empty=doc.getElementById("empty"), title=empty.firstElementChild;
        const emptyRect=empty.getBoundingClientRect(), titleRect=title.getBoundingClientRect();
        const lastRect=empty.lastElementChild.getBoundingClientRect();
        check(theme+" empty task message is centered in the available space", Math.abs((titleRect.left+titleRect.width/2)-(emptyRect.left+emptyRect.width/2))<2 && Math.abs((titleRect.top+lastRect.bottom)/2-(emptyRect.top+emptyRect.height/2))<2);
        review.jobs=visibleJobs; review.changed();
        check(theme+" task canvas is explicitly painted", reviewWin.getComputedStyle(doc.querySelector(".translate-window")).backgroundColor !== "rgba(0, 0, 0, 0)");
      }
      Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
      settingsView.showCategory("general");
    }
    await review.clearQueue(false);
    check("clearing the queue removes every row and restores the empty view", review.jobs.length===0 && !doc.getElementById("empty").hidden && doc.getElementById("job-list").children.length===0);
    check("clearing records preserves existing Zotero child PDFs", await outputs.mono.fileExists() && await outputs.dual.fileExists() && parent.getAttachments().length===3);
    report.ok = true;
  } catch (error) {
    report.error = String(error) + "\n" + error.stack;
  }
  await IOUtils.writeJSON(TEST_ROOT + "/report.json", report);
  if (!KEEP_OPEN) Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}
""".replace("TEST_ROOT", json.dumps(str(work)))
    .replace("KEEP_OPEN", "true" if args.keep_open else "false")
    .replace("REAL_TRANSLATION", "true" if args.real_translation else "false")
    .replace("FRESH_BOOTSTRAP", "true" if args.fresh_bootstrap else "false")
)
with (
    ZipFile(xpi) as original,
    ZipFile(
        profile / "extensions/local-pdf-translate@liuwenbo0.github.io.xpi", "w"
    ) as instrumented,
):
    for name in original.namelist():
        content = original.read(name)
        if name == "bootstrap.js":
            code = content.decode().replace(
                "await LocalTranslate.startup({ id, version, rootURI });",
                "await LocalTranslate.startup({ id, version, rootURI });\n  Zotero.Promise.delay(1000).then(runSmoke);",
            )
            content = (code + "\n" + harness).encode()
        instrumented.writestr(name, content)
log = (work / "zotero.log").open("w")
process = subprocess.Popen(
    [args.app, "-no-remote", "-profile", str(profile), "-ZoteroDebugText"],
    stdout=log,
    stderr=subprocess.STDOUT,
)
print("Isolated test directory:", work, flush=True)
print("Isolated Zotero PID:", process.pid, flush=True)
report_path = work / "report.json"
for _ in range(1200):
    if report_path.exists() or process.poll() is not None:
        break
    time.sleep(1)
if not report_path.exists():
    process.terminate()
    process.wait(timeout=30)
    print("No runtime report; inspect", work / "zotero.log")
    raise SystemExit(1)
report = json.loads(report_path.read_text())
print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
if not args.keep_open or not report["ok"]:
    if args.keep_open and not report["ok"]:
        process.terminate()
    process.wait(timeout=30)
elif report["ok"]:
    print(
        "Window remains open for visual review; terminate this test PID when finished.",
        flush=True,
    )
    process.wait()
raise SystemExit(0 if report["ok"] else 1)
