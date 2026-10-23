#!/usr/bin/env python3
"""Build a local UI preview using real view files and synthetic tasks; no API calls."""

import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
ui = ROOT / "addon/content/ui"
output = ROOT / ".local/ui-preview.html"
with ZipFile("/Applications/Zotero.app/Contents/Resources/app/omni.ja") as archive:
    native_css = archive.read("chrome/skin/default/zotero/preferences.css").decode()
themes = [
    block
    for block in re.findall(r":root\{([^{}]+)\}", native_css)
    if "--color-background:" in block
][:2]
assert len(themes) == 2, "Expected Zotero light and dark theme tokens"

# Read defaults from the actual settings module in an isolated context.
settings = json.loads(
    subprocess.check_output(
        [
            "node",
            "-e",
            """
const fs = require('node:fs'), vm = require('node:vm');
const context = vm.createContext({LocalTranslate:{},
  Services:{dirsvc:{get:()=>({path:'/Users/example'})}},
  PathUtils:{join:(...parts)=>parts.join('/')},Ci:{},Zotero:{Prefs:{get:()=>''}}});
vm.runInContext(fs.readFileSync('src/zotero/settings.js','utf8'),context);
process.stdout.write(JSON.stringify(context.LocalTranslate.settings));
""",
        ],
        cwd=ROOT,
    )
)
root = ET.parse(ui / "window.xhtml").getroot()
main = root.find("{http://www.w3.org/1999/xhtml}main")
for node in main.iter():
    node.tag = node.tag.split("}")[-1]
body = ET.tostring(main, encoding="unicode", method="html")
prefs = ET.parse(ui / "preferences.xhtml").getroot()
for node in prefs.iter():
    node.tag = node.tag.split("}")[-1]
settings_body = ET.tostring(prefs, encoding="unicode", method="html")

mock = (
    """
const demo = { version:PLUGIN_VERSION, settings:DEFAULT_SETTINGS, paused:true, windows:new Set(), preferences:new Set(),
  jobs:[
    {id:'done',title:'A survey of retrieval-augmented generation',language:'zh',status:'completed',progress:100},
    {id:'queued',title:'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',language:'zh',status:'queued'},
    {id:'failed',title:'A document that needs attention',language:'zh',status:'failed',error:'API request failed: the configured service rejected the request. Check the model and API settings, then retry.'},
    {id:'active',title:'Attention Is All You Need — A long document title to verify wrapping and progress updates',language:'zh',status:'running',progress:38,stage:'翻译段落'}],
  changed(){window.renderTasks?.(); for(const view of this.preferences) view.renderEngine();}, persist:async()=>{}, runQueue:async()=>{},
  saveSettings:async function(settings){this.settings=settings;},
  loadPreferenceKey:async()=>{},
  clearQueue:async function(){this.jobs=[];this.changed();},
  cancelJobs:async function(ids){for(const id of ids) await this.cancel(id);},
  retryJobs:async function(ids){for(const id of ids) await this.retry(id);},
  removeJobs:async function(ids){for(const id of ids) await this.removeJob(id);},
  savePreferences:async function(settings){this.settings=settings;SettingsView.message('配置已保存');},
  openSettings(){location.search="?settings";},
  safeError:error=>error.message,
  checkEngine(){this.engineStatus={stage:"下载 / 校验模型与字体",busy:true,progress:null};this.changed();},
  enqueueScope:async()=>message('预览模式：不会加入实际任务。'),
  cancel:async function(id){this.jobs.find(j=>j.id===id).status='cancelled';this.changed();},
  removeJob:async function(id){this.jobs=this.jobs.filter(j=>j.id!==id);this.changed();},
  retry:async function(id){this.jobs.find(j=>j.id===id).status='queued';this.changed();},
  runWorker:async()=>({version:'2.9.0',model:'preview',message:'预览模式'})};
if(new URLSearchParams(location.search).has("empty")) demo.jobs=[];
var Zotero = {LocalTranslate:demo,UIProperties:{registerRoot(){}},
  getActiveZoteroPane:()=>({selectItem:()=>message('预览模式：不会操作 Zotero。')})};
function previewTheme(dark){
  document.documentElement.style.colorScheme=dark?'dark':'light';
  document.getElementById('preview-theme').textContent=':root{'+THEMES[dark?1:0]+'color-scheme:'+(dark?'dark':'light')+'}';
}
previewTheme(false);
""".replace("DEFAULT_SETTINGS", json.dumps(settings, ensure_ascii=False))
    .replace("THEMES", json.dumps(themes))
    .replace(
        "PLUGIN_VERSION",
        json.dumps(json.loads((ROOT / "addon/manifest.json").read_text())["version"]),
    )
)
scripts = "\n".join(
    (ROOT / "src/ui" / name).read_text()
    for name in ("tasks.js", "settings.js", "window.js")
)
preview_css = """
html,body{margin:0;font:13px/1.4 system-ui;color:var(--fill-primary);background:var(--color-sidepane)}
.preview-controls{display:flex;gap:8px;align-items:center;padding:14px 20px}
.preview-controls span{margin-right:auto;color:var(--fill-secondary)}
#preview-prefs{max-width:600px;padding:24px;margin:auto;background:var(--color-background)}\n.translate-window{width:min(940px,100vw - 40px);height:650px;margin:0 auto 20px;background:var(--color-background);border:1px solid var(--color-border)}
"""
style_files = re.findall(
    r'chrome://localtranslate/content/ui/([^" ]+\.css)',
    (ui / "window.xhtml").read_text(),
)
styles = "\n".join((ui / name).read_text() for name in style_files)
styles += "\n" + (ui / "settings.css").read_text()
assert "#local-translate-settings-form" in styles and "#task-detail" in styles
body = (
    '<input id="prefs-search" hidden><div id="preview-tasks">'
    + body
    + '</div><div id="prefs-content"><div id="preview-prefs" class="pane-container"><h1>本地 PDF 翻译</h1>'
    + settings_body
    + "</div></div>"
)
scripts += """
window.addEventListener('load',()=>{
  const settings = new URLSearchParams(location.search).has('settings');
  document.getElementById('preview-tasks').hidden=settings;
  document.getElementById('preview-prefs').hidden=!settings;
  SettingsView.init(document.getElementById('local-translate-settings'));
});
"""
output.parent.mkdir(exist_ok=True)
output.write_text(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>翻译窗口预览</title>'
    f'<style id="preview-theme">:root{{{themes[0]}color-scheme:light}}</style>'
    f"<style>{styles}\n{preview_css}</style>"
    '<div class="preview-controls"><span>界面预览 · 使用示例任务，不连接 API</span>'
    '<a href="?settings">设置</a><a href="?tasks">任务</a><button onclick="previewTheme(false)">浅色</button><button onclick="previewTheme(true)">深色</button></div>'
    f"{body}<script>{mock}\n{scripts}</script></html>"
)
print(output)
