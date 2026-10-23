/* global SettingsView */
// Zotero loads pane scripts before inserting the XHTML fragment.
function onPreferencesLoad(event) {
  if (event.target.id !== "local-translate-settings") return;
  document.removeEventListener("load", onPreferencesLoad, true);
  SettingsView.init(event.target);
  event.target.addEventListener("unload", () => SettingsView.destroy(), { once: true });
}
document.addEventListener("load", onPreferencesLoad, true);
