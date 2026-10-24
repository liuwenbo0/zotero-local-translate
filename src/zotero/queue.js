/* global LocalTranslate, Zotero, Services, IOUtils, PathUtils, ChromeUtils */
// Serial task execution, checkpoints, user actions and new-PDF notifications.
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "importing", "interrupted"]);
const RETRYABLE_JOB_STATUSES = new Set(["failed", "cancelled", "interrupted"]);
const CANCELLABLE_JOB_STATUSES = new Set(["queued", "running", "interrupted"]);
const PROTECTED_JOB_STATUSES = new Set(["running", "importing"]);

Object.assign(LocalTranslate, {
  enqueueItems(items, confirm = true) {
    if (this.clearing || this.stopping) return Promise.reject(new Error("队列正在清空或停止，请稍后再添加"));
    // Serialize scans and confirmations so each prompt describes the jobs actually added.
    const task = (this.enqueueTask || Promise.resolve()).catch(() => {}).then(() => this.enqueueBatch(items, confirm));
    this.enqueueTask = task;
    task.finally(() => { if (this.enqueueTask === task) this.enqueueTask = null; }).catch(() => {});
    return task;
  },

  async enqueueBatch(items, confirm) {
    if ((this.process || this.workerTask) && !this.running) throw new Error("请等待引擎检查完成后再加入翻译任务");
    if (this.stopping || this.clearing) return 0;
    if (confirm) this.openWindow();
    let scan;
    this.scanning = true;
    try {
      scan = await this.candidatesFor(items, (done, total) => { this.scanStatus = `检查 PDF · ${done} / ${total}`; this.changed(); });
    } finally { this.scanning = false; this.scanStatus = ""; this.changed(); }
    if (scan.cancelled || this.stopping || this.clearing) return 0;
    const { candidates, errors } = scan;
    const unreadable = errors.length ? `\n${errors.length} 个 PDF 无法检查，已跳过：\n${errors.slice(0, 3).join("\n")}` : "";
    if (!candidates.length) { if (confirm) this.alert("没有需要翻译的论文 PDF；非论文、非 PDF、目标语言条目、已有译文、队列中的文件和不可用附件已跳过。" + unreadable); return 0; }
    if (confirm) {
      const count = new Set(candidates.map(s => s.parentItemID || s.id)).size;
      const answer = Services.prompt.confirm(Zotero.getMainWindow(), "确认翻译", `将翻译 ${candidates.length} 个 PDF（${count} 条文献），生成 mono 和 dual 子附件。\n正文会发送到你配置的 API，并产生对应 API 用量。${unreadable}`);
      if (!answer) return 0;
    }
    let added = 0;
    const activeSources = new Set(this.jobs.filter(job => ACTIVE_JOB_STATUSES.has(job.status)).map(job => job.sourceID));
    for (const source of candidates) {
      const parent = source.parentItemID ? await Zotero.Items.getAsync(source.parentItemID) : source;
      if (activeSources.has(source.id)) continue;
      this.jobs.push({ id: Zotero.Utilities.randomString(12), sourceID: source.id, sourceKey: source.key,
        libraryID: source.libraryID, parentID: source.parentItemID || null,
        title: parent.getField("title") || source.attachmentFilename, status: "queued", progress: 0,
        stage: "等待翻译", error: "", outputs: {}, created: new Date().toISOString(), language: this.settings.langOut });
      activeSources.add(source.id);
      added++;
    }
    await this.persist();
    this.openWindow();
    this.changed();
    if (!this.paused) void this.runQueue();
    return added;
  },

  async persist() {
    const snapshot = { jobs: this.jobs, promptSeen: [...this.promptSeen].slice(-3000) };
    // Serialize saves so an older snapshot cannot overwrite a later state.
    this.saving = (this.saving || Promise.resolve()).catch(() => {}).then(() => IOUtils.writeJSON(this.statePath, snapshot, { tmpPath: this.statePath + ".tmp" }));
    await this.saving;
  },

  runQueue() {
    if (this.running) return this.queueTask;
    if (this.stopping || this.paused || this.clearing) return Promise.resolve();
    this.running = true;
    this.queueTask = (async () => {
      try {
        while (!this.paused && !this.stopping) {
          const job = this.jobs.find(j => j.status === "queued");
          if (!job) break;
          this.currentJob = job;
          try {
            const configuration = await this.captureConfiguration();
            const cfg = configuration.config;
            if (job.language !== cfg.langOut) {
              job.outputs = {}; delete job.monoID; delete job.dualID;
            }
            job.language = cfg.langOut;
            const source = await Zotero.Items.getAsync(job.sourceID);
            if (!source || source.deleted || source.key !== job.sourceKey) throw new Error("原附件不存在或已删除");
            const skipReason = await this.sourceSkipReason(source, cfg);
            if (skipReason) { job.status = "skipped"; job.preparing = false; job.stage = skipReason + "，已跳过"; continue; }
            if (!Zotero.Libraries.get(source.libraryID).filesEditable) throw new Error("当前文库不允许添加文件");
            const path = await source.getFilePathAsync();
            if (!path || !(await source.fileExists())) throw new Error("原 PDF 尚未下载到本地");
            const dir = PathUtils.join(this.dir, "jobs", job.id);
            await IOUtils.makeDirectory(dir, { ignoreExisting: true });
            job.preparing = true; job.preparationProgress = null;
            job.status = "running"; job.stage = "启动本地引擎"; job.error = "";
            this.changed(); await this.persist();
            if (job.cancelRequested || this.stopping) {
              job.status = this.stopping ? "interrupted" : "cancelled";
              continue;
            }
            const result = await this.runWorker({ action: "translate", input: path, output: dir }, event => {
              if (event.type === "engine_progress") {
                job.preparing = true; job.preparationProgress = event.progress;
                job.stage = event.stage; this.changed();
              } else if (event.type === "progress") {
                job.preparing = false;
                // Worker progress and stage estimates both use percentages (0–100).
                let overallProgress = event.progress;
                if (overallProgress == null && event.stage) {
                  // Stage-based progress estimation when overall_progress is not available
                  const stage = String(event.stage || "").toLowerCase();
                  const stageProgress = Number.isFinite(event.stageProgress) ? event.stageProgress : 0;
                  // Stage weight allocation: term extraction ~15%, translation ~70%, layout/save ~15%
                  if (/term|glossary|extract/i.test(stage)) {
                    overallProgress = 0.15 * stageProgress;
                  } else if (/translat|paragraph|sentence/i.test(stage)) {
                    overallProgress = 15 + 0.70 * stageProgress;
                  } else if (/layout|parse|formula|table|font|save|typeset|pdf/i.test(stage)) {
                    overallProgress = 85 + 0.15 * stageProgress;
                  } else {
                    overallProgress = stageProgress;
                  }
                }
                if (Number.isFinite(overallProgress)) {
                  job.progress = Math.max(job.progress || 0, Math.min(97, overallProgress * .97));
                }
                job.stage = event.stage || "翻译中";
                job.stageProgress = event.stageProgress;
                job.stageCurrent = event.stageCurrent;
                job.stageTotal = event.stageTotal;
                job.partIndex = event.partIndex;
                job.totalParts = event.totalParts;
                this.changed();
              }
            }, configuration);
            if (job.cancelRequested || this.stopping) { job.status = this.stopping ? "interrupted" : "cancelled"; continue; }
            if (result.skipped) { job.status = "skipped"; job.preparing = false; job.stage = "原文件已是译文，已跳过"; continue; }
            job.outputs = result.outputs;
            job.preparing = false;
            job.status = "importing"; job.stage = "添加 mono / dual 子附件"; job.progress = 98;
            this.changed(); await this.persist();
            await this.attachOutputs(source, job, cfg);
            job.status = "completed"; job.stage = "完成"; job.progress = 100;
          } catch (error) {
            job.status = this.stopping ? "interrupted" : job.cancelRequested ? "cancelled" : "failed";
            job.error = this.safeError(error); job.stage = job.status === "interrupted" ? "待恢复" : job.status === "cancelled" ? "已取消" : "失败";
            Zotero.debug("Local PDF Translate: " + job.error);
          } finally { this.currentJob = null; await this.persist(); this.changed(); }
        }
      } finally { this.running = false; this.changed(); }
    })();
    return this.queueTask;
  },

  retry(id) { return this.retryJobs([id]); },

  async retryJobs(ids) {
    if (this.clearing) return;
    const selected = new Set(ids);
    for (const job of this.jobs) if (selected.has(job.id) && RETRYABLE_JOB_STATUSES.has(job.status)) {
      job.status = "queued"; job.cancelRequested = false; job.progress = 0; job.error = "";
    }
    await this.persist(); this.changed();
    if (!this.paused) void this.runQueue();
  },

  removeJob(id) { return this.removeJobs([id]); },

  async removeJobs(ids) {
    const selected = new Set(ids);
    this.jobs = this.jobs.filter(j => !selected.has(j.id) || PROTECTED_JOB_STATUSES.has(j.status));
    await this.persist(); this.changed();
  },

  cancel(id) { return this.cancelJobs([id]); },

  async cancelJobs(ids) {
    const selected = new Set(ids);
    for (const job of this.jobs) if (selected.has(job.id) && CANCELLABLE_JOB_STATUSES.has(job.status)) {
      job.cancelRequested = true;
      if (job.status === "running") { this.downloadRequest?.abort(); this.process?.kill(15000); }
      else { job.status = "cancelled"; job.stage = "已取消"; }
    }
    await this.persist(); this.changed();
  },

  async clearQueue(confirm = true) {
    if (this.clearing) return;
    if (confirm && !Services.prompt.confirm(Zotero.getMainWindow(), "清空任务队列", "清空所有任务记录？正在翻译的任务会取消，已有 PDF 和 Zotero 附件会保留。")) return;
    const wasPaused = this.paused;
    this.clearing = true; this.paused = true; this.changed();
    try {
      if (this.currentJob?.status === "running") await this.cancel(this.currentJob.id);
      await this.enqueueTask?.catch(() => {});
      await this.queueTask?.catch(() => {});
      this.jobs = []; await this.persist();
    } finally { this.clearing = false; this.paused = wasPaused; this.changed(); }
  },

  async onNotify(event, type, ids) {
    if (type !== "item" || this.stopping || !this.settings.askOnNew) return;
    if (event !== "add" && !["modify", "refresh"].includes(event)) return;
    for (const id of ids) if (event === "add" || this.waitingFiles.has(id)) this.pendingNew.add(id);
    if (!this.pendingNew.size) return;
    if (this.newTimer) Zotero.getMainWindow()?.clearTimeout(this.newTimer);
    this.newTimer = Zotero.getMainWindow()?.setTimeout(() => this.promptNew().catch(e => Zotero.debug(this.safeError(e))), 2500);
  },

  async promptNew() {
    if (this.stopping || this.prompting || !this.settings.askOnNew) return;
    // Defer during attachment import, but retain unrelated PDFs added at that time.
    if (this.importing) {
      if (this.newTimer) Zotero.getMainWindow()?.clearTimeout(this.newTimer);
      this.newTimer = Zotero.getMainWindow()?.setTimeout(() => this.promptNew().catch(e => Zotero.debug(this.safeError(e))), 2500);
      return;
    }
    this.prompting = true;
    try {
      const ids = [...this.pendingNew]; this.pendingNew.clear();
      const items = await Zotero.Items.getAsync(ids);
      for (const item of items) {
        if (item.isPDFAttachment() && !item.deleted && !this.isTranslation(item) && !await this.sourceSkipReason(item, this.settings) && !(await item.fileExists())) {
          if (!this.waitingFiles.has(item.id)) this.waitingFiles.set(item.id, Date.now());
        } else this.waitingFiles.delete(item.id);
      }
      const { candidates } = await this.candidatesFor(items);
      const sources = candidates.filter(s => !this.promptSeen.has(s.libraryID + ":" + s.key));
      if (!sources.length) return;
      for (const s of sources) this.promptSeen.add(s.libraryID + ":" + s.key);
      await this.persist();
      if (Services.prompt.confirm(Zotero.getMainWindow(), "发现新 PDF", `发现 ${sources.length} 个新增的本地 PDF，是否使用你的 API 翻译，并添加 mono 和 dual 版本？`)) await this.enqueueItems(sources, false);
    } finally {
      this.prompting = false;
      const waiting = [...this.waitingFiles].filter(([, added]) => Date.now() - added < 120000).map(([id]) => id);
      // A debounce timer may have fired while the previous scan was awaiting PDF data.
      // Always drain those new arrivals after that scan, even without pending downloads.
      if ((this.pendingNew.size || waiting.length) && !this.stopping && this.settings.askOnNew) {
        if (this.newTimer) Zotero.getMainWindow()?.clearTimeout(this.newTimer);
        this.newTimer = Zotero.getMainWindow()?.setTimeout(() => {
          for (const id of waiting) this.pendingNew.add(id);
          return this.promptNew().catch(e => Zotero.debug(this.safeError(e)));
        }, this.pendingNew.size ? 2500 : 5000);
      }
    }
  },
});
