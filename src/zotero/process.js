/* global LocalTranslate, Zotero, Services, IOUtils, PathUtils, ChromeUtils */
// One Python subprocess at a time; credentials travel over standard input.
Object.assign(LocalTranslate, {
  checkEngine(action, settings, key) {
    settings = settings && JSON.parse(JSON.stringify(settings));
    // Reserve the worker before saving or installing; callbacks stay in the plugin scope.
    return this.runWorker({ action }, undefined, settings ? () => this.saveSettings(settings, key) : undefined).catch(() => {});
  },

  runWorker(payload, onEvent, prepare) {
    if (this.process || this.workerTask || this.stopping) return Promise.reject(new Error("本地引擎正在运行或停止，请等待当前任务结束"));
    this.workerTask = Promise.resolve().then(async () => {
      const receive = event => {
        if (event.type === "engine_progress") {
          this.setEngineStatus({ stage: event.stage, progress: Number.isFinite(event.progress) ? Math.max(0, Math.min(100, event.progress)) : null, busy: true });
        } else if (event.type === "progress" && this.engineStatus?.busy) {
          this.setEngineStatus({ stage: "引擎已就绪，正在翻译", ready: true });
        }
        onEvent?.(event);
      };
      try {
        this.setEngineStatus({ stage: payload.action === "test_api" ? "正在检查 API 连接" : "正在准备本地引擎", busy: true });
        if (prepare) await prepare();
        const cfg = { ...this.settings, ...await this.ensureEngine(receive, payload.action === "probe") };
        const apiKey = payload.action === "probe" ? "" : await this.getKey();
        const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        const process = await Subprocess.call({
          command: cfg.python, arguments: ["-u", this.workerPath], workdir: cfg.engineRoot,
          environment: { PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false", PYTHONNOUSERSITE: "1", PYTHONPATH: "" }, environmentAppend: true, stderr: "pipe",
        });
        this.process = process;
        let result = null, failure = "";
        const readErrors = (async () => { while (await process.stderr.readString()) { /* Drain without logging credentials. */ } })().catch(() => {});
        try {
          if (this.stopping || this.currentJob?.cancelRequested) throw new Error("翻译已取消");
          await process.stdin.write(JSON.stringify({ ...payload, config: cfg, apiKey }) + "\n");
          await process.stdin.close();
          let buffer = "";
          for (;;) {
            const chunk = await process.stdout.readString();
            if (!chunk) break;
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              let event; try { event = JSON.parse(line); } catch { continue; }
              if (event.type === "result") result = event;
              if (event.type === "error") failure = event.message;
              receive(event);
            }
          }
          const { exitCode } = await process.wait();
          await readErrors;
          if (exitCode || !result) throw new Error(failure || `本地引擎退出 (${exitCode})。请检查网络后重试“检查本地引擎”。`);
          this.setEngineStatus({ stage: payload.action === "test_api" ? `API 连接成功：${result.message}` : payload.action === "probe" ? `引擎已就绪 · PDFMathTranslate ${result.version}` : "引擎已就绪", ready: true });
          return result;
        } catch (error) {
          process.kill(1000);
          await process.wait().catch(() => {});
          throw error;
        } finally {
          await readErrors;
          if (this.process === process) this.process = null;
        }
      } catch (error) {
        this.setEngineStatus({ stage: this.safeError(error), error: true });
        throw error;
      } finally { this.workerTask = null; this.changed(); }
    });
    return this.workerTask;
  },

  safeError(error) { return String(error?.message || error).replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]"); },
});
