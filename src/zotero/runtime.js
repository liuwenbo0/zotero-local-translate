/* global LocalTranslate, Zotero, Services, IOUtils, PathUtils, ChromeUtils, Cc, Ci */
// Private, pinned runtime. No system Python, shell installer or user PATH changes.
Object.assign(LocalTranslate, {
  runtimePlatform() {
    if (Services.appinfo.OS === "Darwin" && Number.parseInt(Services.sysinfo?.getProperty("version"), 10) < 22) throw new Error("自动引擎需要 macOS 13 或更新版本");
    const os = { Darwin: "apple-darwin", WINNT: "pc-windows-msvc", Linux: "unknown-linux-gnu" }[Services.appinfo.OS];
    const arch = Services.appinfo.XPCOMABI.split("-")[0];
    const platform = `${arch}-${os}`;
    if (!this.runtimeManifest.platforms[platform]) throw new Error(`暂不支持此平台：${platform}`);
    return platform;
  },

  runtimeCancelled() {
    if (this.stopping || this.currentJob?.cancelRequested) throw new Error("引擎准备已取消");
  },

  async ensureEngine(onEvent, repair = false) {
    const manifest = this.runtimeManifest;
    const platform = this.runtimePlatform();
    const windows = Services.appinfo.OS === "WINNT";
    const root = PathUtils.join(this.dir, "runtime", manifest.id);
    const python = PathUtils.join(root, ".venv", windows ? "Scripts" : "bin", windows ? "python.exe" : "python");
    const result = { python, engineRoot: root, assetsRoot: PathUtils.join(this.dir, "assets") };
    const marker = PathUtils.join(root, "ready.json");
    this.runtimeCancelled();
    if (!repair && await IOUtils.exists(marker) && await IOUtils.exists(python)) return result;
    const report = (stage, progress = null) => {
      this.setEngineStatus({ stage, progress, busy: true });
      onEvent?.({ type: "engine_progress", progress, stage });
    };
    try {
      await IOUtils.makeDirectory(root, { ignoreExisting: true, permissions: 0o700 });
      for (const name of ["pyproject.toml", "uv.lock"]) {
        await IOUtils.writeUTF8(PathUtils.join(root, name), await Zotero.File.getResourceAsync(this.rootURI + "worker/" + name));
      }
      const bin = PathUtils.join(this.dir, "runtime", "uv-" + manifest.uv);
      await IOUtils.makeDirectory(bin, { ignoreExisting: true, permissions: 0o700 });
      const uv = PathUtils.join(bin, windows ? "uv.exe" : "uv");
      if (!(await IOUtils.exists(uv))) {
        report("下载运行环境管理器（首次准备）");
        const archive = PathUtils.join(bin, "download" + (windows ? ".zip" : ".tar.gz"));
        const url = `https://github.com/astral-sh/uv/releases/download/${manifest.uv}/uv-${platform}${windows ? ".zip" : ".tar.gz"}`;
        const response = await Zotero.HTTP.request("GET", url, {
          responseType: "arraybuffer", timeout: 180000,
          requestObserver: request => {
            this.runtimeCancelled();
            this.downloadRequest = request;
            request.addEventListener("progress", event => {
              if (event.lengthComputable && event.total > 0) {
                report("下载运行环境管理器（首次准备）", Math.min(100, event.loaded / event.total * 100));
              }
            });
          },
        });
        this.downloadRequest = null;
        this.runtimeCancelled();
        const data = new Uint8Array(response.response);
        const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
        hash.init(hash.SHA256); hash.update(data, data.length);
        const digest = [...hash.finish(false)].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
        if (digest !== manifest.platforms[platform]) throw new Error("运行环境下载校验失败，请重试");
        await IOUtils.write(archive, data);
        report("解压运行环境");
        await IOUtils.remove(uv + ".tmp", { ignoreAbsent: true });
        if (windows) {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); file.initWithPath(archive);
          const target = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); target.initWithPath(uv + ".tmp");
          const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
          try { zip.open(file); zip.extract("uv.exe", target); } finally { zip.close(); }
        } else {
          const member = `uv-${platform}/uv`;
          const tar = await IOUtils.exists("/usr/bin/tar") ? "/usr/bin/tar" : "/bin/tar";
          await this.runtimeCommand(tar, ["-xzf", archive, "-C", bin, member], root, {}, report);
          await IOUtils.move(PathUtils.join(bin, "uv-" + platform, "uv"), uv + ".tmp");
          await IOUtils.setPermissions(uv + ".tmp", 0o700);
          await IOUtils.remove(PathUtils.join(bin, "uv-" + platform), { recursive: true });
        }
        this.runtimeCancelled();
        await IOUtils.move(uv + ".tmp", uv);
        await IOUtils.remove(archive);
      }
      report("安装 Python 与 PDFMathTranslate 依赖（首次准备需要几分钟）");
      await this.runtimeCommand(uv, [
        "sync", "--project", root, "--locked", "--no-dev", "--no-install-project", "--no-config",
        "--managed-python", "--python", manifest.python, "--no-progress", "--no-build",
        "--default-index", "https://pypi.org/simple",
      ], root, {
        UV_PYTHON_INSTALL_DIR: PathUtils.join(this.dir, "runtime", "python"),
        UV_CACHE_DIR: PathUtils.join(this.dir, "runtime", "cache"),
        UV_PYTHON_DOWNLOADS: "automatic",
        UV_PROJECT_ENVIRONMENT: PathUtils.join(root, ".venv"),
        PYTHONPATH: "", PYTHONNOUSERSITE: "1",
      }, report);
      this.runtimeCancelled();
      if (!(await IOUtils.exists(python))) throw new Error("自动安装未生成 Python，请重试");
      await IOUtils.writeJSON(marker, { id: manifest.id }, { tmpPath: marker + ".tmp" });
      report("运行环境已安装，正在加载引擎");
      return result;
    } catch (error) {
      this.setEngineStatus({ stage: this.safeError(error), error: true });
      throw error;
    } finally { this.downloadRequest = null; }
  },

  async runtimeCommand(command, args, workdir, environment, report) {
    this.runtimeCancelled();
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const process = await Subprocess.call({ command, arguments: args, workdir, environment, environmentAppend: true, stderr: "stdout" });
    this.process = process;
    let tail = "";
    try {
      this.runtimeCancelled();
      for (;;) {
        const chunk = await process.stdout.readString();
        if (!chunk) break;
        tail = (tail + chunk).slice(-1800);
        const line = tail.trim().split(/[\r\n]+/).at(-1);
        if (line && report) report("准备运行环境 · " + this.safeError(line).slice(0, 180));
      }
      const { exitCode } = await process.wait();
      this.runtimeCancelled();
      if (exitCode) throw new Error(`自动准备失败 (${exitCode})：${this.safeError(tail).trim()}\n请检查网络后重试。`);
    } catch (error) {
      process.kill(1000); await process.wait().catch(() => {}); throw error;
    } finally { if (this.process === process) this.process = null; }
  },
});
