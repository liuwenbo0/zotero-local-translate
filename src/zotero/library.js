/* global LocalTranslate, Zotero, Services, IOUtils, PathUtils, ChromeUtils */
// Library scope discovery, translation recognition and child attachment import.
Object.assign(LocalTranslate, {
  async enqueueScope(scope, confirm = true) {
    const pane = Zotero.getActiveZoteroPane();
    let items;
    if (scope === "selected") items = pane.getSelectedItems();
    else {
      const search = new Zotero.Search();
      search.libraryID = pane.getSelectedLibraryID();
      if (scope === "collection") {
        const collection = pane.getSelectedCollection();
        if (!collection) throw new Error("请先选中一个分类");
        search.addCondition("collectionID", "is", collection.id);
        if (this.settings.includeSubcollections) search.addCondition("recursive", "true");
      }
      search.addCondition("noChildren", "true");
      items = await Zotero.Items.getAsync(await search.search());
    }
    return this.enqueueItems(items, confirm);
  },

  isTranslation(item) {
    const tags = item.getTags().map(t => t.tag.toLowerCase());
    return tags.includes("local-pdf-translate") || tags.includes("babeldoc_translated")
      || /[._-](?:(?:zh(?:-cn|-hans)?)[._-])?(?:mono|dual|translation|translated)\.pdf$/i.test(item.attachmentFilename || "");
  },

  async isTranslatedPDF(item) {
    if (this.isTranslation(item)) return true;
    if (!(await item.fileExists())) return false;
    const path = await item.getFilePathAsync();
    const stat = await IOUtils.stat(path);
    const signature = `${path}:${stat.size}:${stat.lastModified}`;
    const saved = this.pdfMetadata.get(item.id);
    if (saved?.signature === signature) return saved.translated;
    // Zotero's PDF parser handles compressed and encoded Producer metadata.
    const { metadata } = await Zotero.PDFWorker.getRecognizerData(item.id);
    const producer = metadata?.Producer || "";
    const translated = producer.includes("BabelDOC") && producer.includes("Translation_generated_by_AI,please_carefully_discern");
    this.pdfMetadata.set(item.id, { signature, translated });
    return translated;
  },

  async sourceSkipReason(source, cfg) {
    if (!source.isPDFAttachment()) return "不是 PDF 附件";
    const parent = source.parentItemID ? await Zotero.Items.getAsync(source.parentItemID) : null;
    if (!parent || parent.deleted || !["journalArticle", "conferencePaper", "preprint", "thesis"].includes(parent.itemType)) return "不是论文条目下的 PDF";
    // Match explicit language metadata only. Unknown or multilingual values stay eligible.
    const normalize = value => {
      const name = String(value || "").trim().toLowerCase().replace(/_/g, "-");
      const aliases = {
        eng: "en", english: "en", 英语: "en", 英文: "en",
        zho: "zh", chi: "zh", chinese: "zh", 中文: "zh", 汉语: "zh",
        "zh-cn": "zh-hans", "zh-sg": "zh-hans", "simplified chinese": "zh-hans", 简体中文: "zh-hans",
        "zh-tw": "zh-hant", "zh-hk": "zh-hant", "traditional chinese": "zh-hant", 繁體中文: "zh-hant", 繁体中文: "zh-hant",
        jpn: "ja", japanese: "ja", 日语: "ja", 日文: "ja", 日本語: "ja",
        deu: "de", ger: "de", german: "de", fra: "fr", fre: "fr", french: "fr",
        kor: "ko", korean: "ko", rus: "ru", russian: "ru", spa: "es", spanish: "es",
        por: "pt", portuguese: "pt", ara: "ar", arabic: "ar",
      };
      return aliases[name] || (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(name) ? name : "");
    };
    const language = normalize(parent.getField("language")), target = normalize(cfg.langOut === "zh" ? "zh-Hans" : cfg.langOut);
    if (!language || !target || language.split("-")[0] !== target.split("-")[0]) return "";
    // Keep explicit Simplified/Traditional Chinese conversions possible.
    if (language === "zh" && target === "zh-hant") return "";
    if (language.startsWith("zh-") && target.startsWith("zh-") && language !== target) return "";
    return "条目语言已是目标语言";
  },

  async candidatesFor(items, report) {
    const cfg = this.settings;
    const sources = await this.sourcesFor(items, cfg);
    const activeSources = new Set(this.jobs.filter(j => ["queued", "running", "importing", "interrupted"].includes(j.status)).map(j => j.sourceID));
    const candidates = [], errors = [], parents = new Map();
    for (const [index, source] of sources.entries()) {
      if (this.stopping || this.clearing) return { candidates: [], errors, cancelled: true };
      report?.(index + 1, sources.length);
      if (activeSources.has(source.id)) continue;
      try {
        if (await this.isTranslatedPDF(source)) continue;
        if (cfg.skipExisting && source.parentItemID) {
          if (!parents.has(source.parentItemID)) {
            const parent = await Zotero.Items.getAsync(source.parentItemID);
            let translated = false;
            for (const child of await Zotero.Items.getAsync(parent.getAttachments())) {
              if (!child.deleted && child.isPDFAttachment() && await this.isTranslatedPDF(child)) { translated = true; break; }
            }
            parents.set(source.parentItemID, translated);
          }
          if (parents.get(source.parentItemID)) continue;
        }
        candidates.push(source);
      } catch (error) { errors.push(`${source.attachmentFilename}: ${this.safeError(error)}`); }
    }
    return { candidates, errors };
  },

  async sourcesFor(items, cfg = this.settings) {
    const sources = new Map();
    for (const item of items) {
      if (!item || item.deleted || !Zotero.Libraries.get(item.libraryID)?.editable) continue;
      let attachments = item.isPDFAttachment() ? [item] : item.isRegularItem() ? await Zotero.Items.getAsync(item.getAttachments()) : [];
      for (const a of attachments) {
        if (a.isPDFAttachment() && !a.deleted && !this.isTranslation(a) && !await this.sourceSkipReason(a, cfg) && await a.fileExists()) sources.set(a.id, a);
      }
    }
    return [...sources.values()];
  },

  async outputsFor(source, language = this.settings.langOut) {
    if (!source.parentItemID) return {};
    const parent = await Zotero.Items.getAsync(source.parentItemID);
    const output = {};
    const stem = (source.attachmentFilename || "").replace(/\.pdf$/i, "");
    for (const child of await Zotero.Items.getAsync(parent.getAttachments())) {
      const tags = child.getTags().map(t => t.tag);
      for (const variant of ["mono", "dual"]) {
        const own = tags.includes("local-translate:source:" + source.key) && tags.includes("local-translate:variant:" + variant)
          && tags.includes("local-translate:lang:" + language);
        const legacy = child.attachmentFilename === `${stem}.${language}.${variant}.pdf`
          || (language === "zh" && child.attachmentFilename === `${stem}_${variant === "mono" ? "translation" : "dual"}.pdf`);
        if ((own || legacy) && await child.fileExists()) output[variant] = child;
      }
    }
    return output;
  },

  async attachOutputs(source, job, cfg = this.settings) {
    if (source.deleted) throw new Error("原附件已删除，不添加译文");
    if (!source.parentItemID) {
      await Zotero.DB.executeTransaction(async () => {
        const parent = new Zotero.Item("document"); parent.libraryID = source.libraryID;
        parent.setField("title", source.getField("title") || source.attachmentFilename);
        parent.setCollections(source.getCollections());
        await parent.save(); source.parentID = parent.id; await source.save();
      });
    }
    job.parentID = source.parentItemID;
    const parent = await Zotero.Items.getAsync(job.parentID);
    if (!parent || parent.deleted) throw new Error("父条目已删除");
    const existing = await this.outputsFor(source, job.language);
    this.importing++;
    try {
      for (const variant of ["mono", "dual"]) {
        if (cfg.skipExisting && existing[variant]) continue;
        const file = job.outputs[variant];
        if (!file || !(await IOUtils.exists(file))) throw new Error(`缺少 ${variant} PDF，未标记为完成`);
        let attachment = job[variant + "ID"] ? await Zotero.Items.getAsync(job[variant + "ID"]) : null;
        if (!attachment || attachment.deleted || attachment.parentItemID !== parent.id || !(await attachment.fileExists())) {
          // importFromFile owns its transaction; nesting it deadlocks in Zotero 10.
          attachment = await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id,
            title: variant === "mono" ? `译文 (${job.language})` : `双语 (${job.language})`,
            contentType: "application/pdf" });
          job[variant + "ID"] = attachment.id;
          await this.persist();
        }
        attachment.addTag("local-pdf-translate");
        attachment.addTag("local-translate:source:" + source.key);
        attachment.addTag("local-translate:variant:" + variant);
        attachment.addTag("local-translate:lang:" + job.language);
        await attachment.saveTx();
        await this.persist();
      }
    } finally { this.importing--; }
  },
});
