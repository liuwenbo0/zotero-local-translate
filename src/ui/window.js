/* global Zotero, TaskView */
var plugin;

function $(id) {
  return document.getElementById(id);
}

function message(text, error = false) {
  const output = $("message");
  output.textContent = text;
  output.className = error ? "error" : "";
  output.hidden = !text;
  output.setAttribute("role", error ? "alert" : "status");
}

window.renderTasks = () => TaskView.render();
window.addEventListener("load", () => {
  plugin = Zotero.LocalTranslate;
  plugin.windows.add(window);
  Zotero.UIProperties.registerRoot(document.documentElement);
  $("version").textContent = "v" + plugin.version;
  $("open-settings").onclick = () => plugin.openSettings();

  $("clear-queue").onclick = () => { message(""); plugin.clearQueue().catch(error => message(error.message, true)); };
  $("pause").onclick = async () => {
    try {
      if (plugin.paused) {
        for (const job of plugin.jobs) {
          if (job.status === "interrupted") {
            job.status = "queued";
            job.progress = 0;
          }
        }
        plugin.paused = false;
        await plugin.persist();
        void plugin.runQueue();
      } else {
        plugin.paused = true;
      }
      plugin.changed();
    } catch (error) {
      message(error.message, true);
    }
  };
  TaskView.render();
}, { once: true });

window.addEventListener("unload", () => plugin?.windows.delete(window));
