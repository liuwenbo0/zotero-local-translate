var chromeHandle;
var LocalTranslate;
var lifecycle = Promise.resolve();

function startup({ id, version, rootURI }) {
  lifecycle = lifecycle.catch(() => {}).then(async () => {
    const aom = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
    chromeHandle = aom.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
      ["content", "localtranslate", rootURI + "content/"],
    ]);
    for (const script of ["main", "zotero/settings", "zotero/library", "zotero/queue", "zotero/runtime", "zotero/process", "zotero/integration"]) {
      Services.scriptloader.loadSubScript(rootURI + "content/" + script + ".js", globalThis);
    }
    Zotero.LocalTranslate = LocalTranslate;
    await LocalTranslate.startup({ id, version, rootURI });
  });
  return lifecycle;
}

function shutdown() {
  lifecycle = lifecycle.catch(() => {}).then(async () => {
    const plugin = LocalTranslate;
    const handle = chromeHandle;
    if (plugin) await plugin.shutdown();
    if (Zotero.LocalTranslate === plugin) delete Zotero.LocalTranslate;
    handle?.destruct();
  });
  return lifecycle;
}

function onMainWindowLoad({ window }) {
  LocalTranslate?.addToolbar(window);
}

function onMainWindowUnload({ window }) {
  LocalTranslate?.removeToolbar(window);
}

function install() {}
function uninstall() {}
