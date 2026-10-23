/* global plugin, $, message, Zotero */
// Selection and focus are separate, so progress updates never rebuild rows or move focus.
var TaskView = {
  rows: new Map(), selectedIDs: new Set(), selectedID: null, anchorID: null, actionState: "",
  labels: { queued: "等待", running: "翻译中", importing: "保存附件", completed: "已完成", skipped: "已跳过", failed: "失败", cancelled: "已取消", interrupted: "待恢复" },

  render() {
    const jobs = [...plugin.jobs].reverse();
    const counts = {};
    for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    const pending = (counts.queued || 0) + (counts.interrupted || 0);
    const active = (counts.running || 0) + (counts.importing || 0);
    $("summary").textContent = `${jobs.length} 个任务 · ${active} 进行中 · ${pending} 等待 · ${counts.completed || 0} 已完成${counts.skipped ? ` · ${counts.skipped} 已跳过` : ""}${counts.failed ? ` · ${counts.failed} 失败` : ""}`;
    $("queue-state").textContent = plugin.clearing ? "正在清空队列" : plugin.scanStatus || (plugin.paused ? (active ? "当前任务完成后暂停" : "队列已暂停") : active ? "正在处理" : "");
    $("pause").textContent = plugin.paused ? "继续队列" : "暂停队列";
    $("pause").disabled = !!plugin.clearing || (!active && !pending);
    $("pause").title = plugin.paused ? "继续未完成的任务" : "当前任务继续运行，暂停后续任务";
    $("clear-queue").disabled = !!plugin.clearing || (!jobs.length && !plugin.scanning);
    $("tasks").classList.toggle("is-empty", !jobs.length);
    $("tasks").classList.toggle("is-scanning", !!plugin.scanning);
    $("empty").hidden = !!jobs.length;
    $("empty").firstElementChild.textContent = plugin.scanning ? "正在检查待译 PDF" : "尚无翻译任务";
    $("empty").lastElementChild.textContent = plugin.scanning ? "跳过已有译文后，确认实际需要翻译的数量" : "从 Zotero 工具栏选择要翻译的文献或 PDF";
    $("empty").nextElementSibling.hidden = !jobs.length;
    const ids = new Set(jobs.map(job => job.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
    for (const id of this.selectedIDs) if (!ids.has(id)) this.selectedIDs.delete(id);
    if (!ids.has(this.selectedID)) {
      this.selectedID = [...this.selectedIDs][0] || (jobs.find(j => ["running", "importing"].includes(j.status)) || jobs[0])?.id || null;
      if (this.selectedID) this.selectedIDs.add(this.selectedID);
      this.anchorID = this.selectedID;
    }
    const list = $("job-list");
    jobs.forEach((job, index) => {
      let row = this.rows.get(job.id);
      if (!row) { row = this.createRow(job); this.rows.set(job.id, row); }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      row.dataset.status = job.status;
      row.setAttribute("aria-selected", String(this.selectedIDs.has(job.id)));
      row.parts.check.checked = this.selectedIDs.has(job.id);
      row.parts.check.setAttribute("aria-label", "选择 " + job.title);
      row.parts.title.textContent = job.title; row.parts.title.title = job.title;
      row.parts.language.textContent = job.language || "—";
      row.parts.status.textContent = job.status === "running" && job.preparing ? "准备引擎" : this.labels[job.status] + (["running", "importing"].includes(job.status) ? ` · ${this.percent(job)}%` : "");
    });
    const all = $("select-all");
    all.checked = !!jobs.length && this.selectedIDs.size === jobs.length;
    all.indeterminate = this.selectedIDs.size > 0 && this.selectedIDs.size < jobs.length;
    all.onchange = () => this.selectAll(all.checked);
    if (this.selectedID) $("task-table").setAttribute("aria-activedescendant", this.rows.get(this.selectedID).id);
    else $("task-table").removeAttribute("aria-activedescendant");
    $("task-table").onkeydown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") { event.preventDefault(); this.selectAll(); return; }
      if (event.key === " " && event.target.type !== "checkbox" && this.selectedID) { event.preventDefault(); this.toggle(this.selectedID); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !jobs.length) return;
      event.preventDefault();
      const index = jobs.findIndex(j => j.id === this.selectedID);
      const next = event.key === "Home" ? 0 : event.key === "End" ? jobs.length - 1 : Math.max(0, Math.min(jobs.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      if (event.shiftKey) this.range(jobs[next].id);
      else this.select(jobs[next].id);
      this.rows.get(jobs[next].id).scrollIntoView({ block: "nearest" });
    };
    this.renderDetail(jobs.filter(j => this.selectedIDs.has(j.id)));
  },

  percent(job) { return Math.round(Math.max(0, Math.min(100, job.progress || 0))); },
  stageLabel(stage) {
    const text = String(stage || "");
    if (/term|glossary|extract/i.test(text)) return "术语提取";
    if (/translat|paragraph|sentence/i.test(text)) return "翻译正文";
    if (/layout|parse|formula|table|font|save|typeset|pdf/i.test(text)) return text;
    return text;
  },
  select(id) { this.selectedID = id; this.anchorID = id; this.selectedIDs = new Set([id]); this.render(); },
  toggle(id) {
    if (this.selectedIDs.has(id)) this.selectedIDs.delete(id); else this.selectedIDs.add(id);
    this.selectedID = id; this.anchorID = id; this.render();
  },
  selectAll(selected = true) { this.selectedIDs = new Set(selected ? plugin.jobs.map(j => j.id) : []); this.render(); },
  range(id) {
    const ids = [...plugin.jobs].reverse().map(j => j.id);
    let anchor = ids.indexOf(this.anchorID); if (anchor < 0) anchor = ids.indexOf(this.selectedID);
    const end = ids.indexOf(id);
    this.selectedIDs = new Set(ids.slice(Math.min(anchor, end), Math.max(anchor, end) + 1));
    this.selectedID = id; this.render();
  },

  createRow(job) {
    const make = tag => document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    const row = make("tr"); row.dataset.jobId = job.id; row.id = "local-translate-job-" + job.id;
    const selection = make("td"), check = make("input"), title = make("td"), language = make("td"), status = make("td");
    selection.className = "selection-column"; check.type = "checkbox"; selection.append(check);
    row.append(selection, title, language, status); row.parts = { check, title, language, status };
    check.onclick = event => { event.stopPropagation(); if (event.shiftKey) this.range(job.id); else this.toggle(job.id); };
    row.onclick = event => {
      if (event.shiftKey) this.range(job.id);
      else if (event.metaKey || event.ctrlKey) this.toggle(job.id);
      else this.select(job.id);
      $("task-table").focus();
    };
    return row;
  },

  renderDetail(selected) {
    const job = selected.length === 1 ? selected[0] : null;
    $("task-detail").hidden = !selected.length;
    $("selection-hint").textContent = selected.length ? `已选择 ${selected.length} / ${plugin.jobs.length} 个任务` : "选择任务可查看详情";
    const active = job && ["running", "importing"].includes(job.status);
    $("detail-progress").parentElement.hidden = !active;
    $("detail-error").hidden = !job?.error;
    if (job) {
      $("detail-title").textContent = job.title; $("detail-title").title = job.title;
      $("detail-status").textContent = job.status === "running" && job.preparing ? "准备引擎" : this.labels[job.status];
      const value = job.preparing ? job.preparationProgress : this.percent(job), known = Number.isFinite(value);
      $("detail-percent").textContent = active && known ? `${Math.round(value)}%` : "";
      if (known) $("detail-progress").value = value; else $("detail-progress").removeAttribute("value");
      const stageCount = Number.isFinite(job.stageCurrent) && Number.isFinite(job.stageTotal) && job.stageTotal > 0 ? ` · ${job.stageCurrent}/${job.stageTotal}` : "";
      const stagePercent = Number.isFinite(job.stageProgress) ? ` · 阶段 ${Math.round(Math.max(0, Math.min(100, job.stageProgress)))}%` : "";
      const partCount = Number.isFinite(job.partIndex) && Number.isFinite(job.totalParts) && job.totalParts > 1 ? ` · 第 ${job.partIndex}/${job.totalParts} 部分` : "";
      $("detail-stage").textContent = job.status === "completed" ? "单语与双语 PDF 已保存为子附件" : job.status === "queued" ? "等待前序任务" : this.stageLabel(job.stage) + stagePercent + stageCount + partCount;
      $("detail-error-text").textContent = job.error || "";
    } else if (selected.length) {
      $("detail-title").textContent = `已选择 ${selected.length} 个任务`; $("detail-title").title = ""; $("detail-status").textContent = "";
      const counts = {};
      for (const task of selected) counts[task.status] = (counts[task.status] || 0) + 1;
      $("detail-stage").textContent = Object.entries(counts).map(([status, count]) => `${count} ${this.labels[status]}`).join(" · ");
    }
    const state = selected.map(j => `${j.id}:${j.status}`).join("|") + ":" + !!plugin.clearing;
    if (this.actionState === state) return;
    this.actionState = state; $("task-actions").replaceChildren(); $("detail-error").open = false;
    const button = (label, action) => {
      const node = document.createElementNS("http://www.w3.org/1999/xhtml", "button"); node.textContent = label; node.disabled = !!plugin.clearing;
      node.onclick = () => { message(""); Promise.resolve().then(action).catch(error => message(error.message, true)); }; $("task-actions").append(node);
    };
    const retry = selected.filter(j => ["failed", "cancelled", "interrupted"].includes(j.status)).map(j => j.id);
    const cancel = selected.filter(j => ["queued", "running", "interrupted"].includes(j.status)).map(j => j.id);
    const remove = selected.filter(j => !["running", "importing"].includes(j.status)).map(j => j.id);
    if (retry.length) button(job ? "重试" : `重试 ${retry.length} 项`, () => plugin.retryJobs(retry));
    if (cancel.length) button(job ? "取消任务" : `取消 ${cancel.length} 项`, () => plugin.cancelJobs(cancel));
    if (job?.parentID) button("定位条目", () => Zotero.getActiveZoteroPane().selectItem(job.parentID));
    if (remove.length) button(job ? "移除记录" : `移除 ${remove.length} 项记录`, () => plugin.removeJobs(remove));
  },
};
