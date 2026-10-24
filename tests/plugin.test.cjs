const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadPlugin(context) {
  const content = path.join(__dirname, '../src');
  for (const script of ['main.js', ...fs.readdirSync(path.join(content, 'zotero')).filter(n => n.endsWith('.js')).map(n => 'zotero/' + n)]) {
    vm.runInContext(fs.readFileSync(path.join(content, script), 'utf8'), context, {filename:script});
  }
}

function fixture() {
  const items = new Map(); let nextID = 100, prompts = 0;
  const settings = new Map();
  const services = { dirsvc: { get: () => ({ path: '/home/test' }) },
    prompt: { alert() {}, confirm() { prompts++; return true; } } };
  const zotero = {
    Prefs: { get: k => settings.get(k), set: (k, v) => settings.set(k, v) },
    Libraries: { get: () => ({ editable: true, filesEditable: true }) },
    Items: { getAsync: async ids => Array.isArray(ids) ? ids.map(id => items.get(id)).filter(Boolean) : items.get(ids) },
    getMainWindow: () => ({ setTimeout, clearTimeout }),
    Utilities: { randomString: () => 'job' + nextID++ },
    DB: { executeTransaction: async fn => fn() },
    Attachments: { importFromFile: async options => {
      const a = attachment(nextID++, 'OUT' + nextID, options.parentItemID, options.file);
      items.set(a.id, a); items.get(options.parentItemID).children.push(a.id); return a;
    } },
    PDFWorker: { getRecognizerData: async id => ({metadata:{Producer:items.get(id)?.producer || ""}}) },
    debug() {},
    Notifier: { unregisterObserver() {} }, MenuManager: { unregisterMenu() {} },
  };
  function attachment(id, key, parent, filename = 'paper.pdf', tags = []) {
    return { id, key, libraryID: 1, parentItemID: parent, attachmentFilename: filename, itemType: 'attachment',
      isPDFAttachment: () => true, isRegularItem: () => false, getTags: () => tags.map(tag => ({ tag })),
      fileExists: async () => true, getFilePathAsync: async () => '/pdf/' + filename,
      getField: () => filename, addTag: tag => { if (!tags.includes(tag)) tags.push(tag); }, save: async () => {}, saveTx: async () => {},
    };
  }
  function parent(id = 1, children = [], itemType = 'journalArticle', language = 'en') {
    return { id, key: 'PARENT01', libraryID: 1, children, itemType, isPDFAttachment: () => false,
      isRegularItem: () => true, getAttachments: () => children, getField: field => field === 'language' ? language : 'Test paper' };
  }
  const context = vm.createContext({ Zotero: zotero, Services: services,
    PathUtils: { join: (...p) => p.join('/') }, Ci: {}, IOUtils: { exists: async () => true, stat: async()=>({size:100,lastModified:1}) },
    console, URL, setTimeout, clearTimeout });
  loadPlugin(context);
  const plugin = context.LocalTranslate;
  plugin.getKey = async () => "test-key";
  plugin.ensureEngine = async () => { if (!(await context.IOUtils.exists("/engine/python"))) throw new Error("找不到 Python"); return {python:"/engine/python",engineRoot:"/engine"}; };
  plugin.persist = async () => {};
  plugin.openWindow = () => {};
  return { plugin, items, parent, attachment, settings, zotero, context, prompts: () => prompts };
}

function captureWorkerRequests(f, result = {outputs:{}}) {
  const requests = [];
  f.context.ChromeUtils = {importESModule: () => ({Subprocess: {call: async () => {
    let read = false;
    return {
      stdin: {write: async text => requests.push(JSON.parse(text)), close: async () => {}},
      stdout: {readString: async () => read ? '' : (read = true, JSON.stringify({type:'result',...result})+'\n')},
      stderr: {readString: async () => ''}, wait: async () => ({exitCode: 0}), kill() {},
    };
  }}})};
  return requests;
}

test('task list pins active work above FIFO queued jobs and newest history', () => {
  const jobs = [
    {id:'old',status:'completed'}, {id:'first',status:'queued'}, {id:'failed',status:'failed'},
    {id:'second',status:'queued'}, {id:'active',status:'running'},
  ];
  const context = vm.createContext({ plugin: { jobs }, $() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/tasks.js'), 'utf8'), context);
  assert.deepEqual(Array.from(context.TaskView.orderedJobs(), job => job.id), ['active', 'first', 'second', 'failed', 'old']);
});

test('translation recognition excludes outputs without excluding papers about machine translation', () => {
  const f = fixture();
  assert.equal(f.plugin.isTranslation(f.attachment(1, 'SOURCE01', 1, 'Machine Translation.pdf')), false);
  for (const filename of ['paper.zh.mono.pdf', 'paper.zh.dual.pdf', 'paper_dual.pdf', 'paper_translation.pdf'])
    assert.equal(f.plugin.isTranslation(f.attachment(1, 'SOURCE01', 1, filename)), true);
  assert.equal(f.plugin.isTranslation(f.attachment(1, 'SOURCE01', 1, 'renamed.pdf', ['local-pdf-translate'])), true);
});

test('concurrent enqueue requests cannot add the same source twice', async () => {
  const f = fixture(); const p = f.parent(1, [2]);
  f.items.set(1, p); f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.plugin.runQueue = async () => {};
  const added = await Promise.all([f.plugin.enqueueItems([p], false), f.plugin.enqueueItems([p], false)]);
  assert.equal(added.reduce((a, b) => a + b, 0), 1);
  assert.equal(f.plugin.jobs.length, 1);
});

test('enqueue and retry respect a paused queue', async () => {
  const f = fixture(); const p = f.parent(1, [2]); let runs = 0;
  f.items.set(1, p); f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.plugin.paused = true; f.plugin.runQueue = async () => { runs++; };
  await f.plugin.enqueueItems([p], false);
  f.plugin.jobs[0].status = 'failed'; await f.plugin.retry(f.plugin.jobs[0].id);
  assert.equal(f.plugin.paused, true); assert.equal(runs, 0);
});

test('settings validate real engine limits before saving', async () => {
  const f=fixture(); const settings=f.plugin.settings;
  await assert.rejects(f.plugin.saveSettings({...settings,rpm:0}), /RPM/);
  await assert.rejects(f.plugin.saveSettings({...settings,rpm:6001}), /RPM/);
  await assert.rejects(f.plugin.saveSettings({...settings,rpm:1.5}), /RPM/);
  await assert.rejects(f.plugin.saveSettings({...settings,maxPagesPerPart:49}), /至少 50/);
  await assert.rejects(f.plugin.saveSettings({...settings,shortLineSplitFactor:0.05}), /0.1/);
  await assert.rejects(f.plugin.saveSettings({...settings,fontFamily:'missing-font'}), /无效选项/);
  await f.plugin.saveSettings({...settings,maxPagesPerPart:50,shortLineSplitFactor:0.1,figureTableProtectionThreshold:0});
  assert.equal(f.plugin.settings.maxPagesPerPart,50);
});

test('saved QPS limits migrate to RPM while explicit RPM takes precedence', () => {
  const f=fixture();
  f.settings.set('extensions.localpdftranslate.settings', JSON.stringify({qps:3}));
  assert.equal(f.plugin.settings.rpm,180);
  assert.ok(!('qps' in f.plugin.settings));
  f.settings.set('extensions.localpdftranslate.settings', JSON.stringify({qps:3,rpm:30}));
  assert.equal(f.plugin.settings.rpm,30);
});

test('retrying an earlier failed job while another runs is picked up by the same queue', async () => {
  const f = fixture(); f.context.IOUtils.makeDirectory = async () => {}; f.plugin.dir = '/jobs';
  f.items.set(1, f.parent(1, [2, 3]));
  f.items.set(2, f.attachment(2, 'SOURCE01', 1, 'first.pdf'));
  f.items.set(3, f.attachment(3, 'SOURCE02', 1, 'later.pdf'));
  f.plugin.jobs = [{id:'first',sourceID:2,sourceKey:'SOURCE01',language:'zh',status:'failed'},
    {id:'later',sourceID:3,sourceKey:'SOURCE02',language:'zh',status:'queued'}];
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const inputs = [];
  f.plugin.runWorker = async payload => { inputs.push(payload.input); if (inputs.length === 1) {entered(); await waiting;} return {outputs:{}}; };
  f.plugin.attachOutputs = async () => {};
  const queue = f.plugin.runQueue(); await started;
  await f.plugin.retry('first'); release(); await queue;
  assert.deepEqual(inputs, ['/pdf/later.pdf','/pdf/first.pdf']);
  assert.ok(f.plugin.jobs.every(j => j.status === 'completed'));
});

test('shutdown waits for a running worker and preserves it as interrupted', async () => {
  const f = fixture(); f.context.IOUtils.makeDirectory = async () => {}; f.plugin.dir = '/jobs';
  f.items.set(1, f.parent(1, [2]));
  f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.plugin.jobs = [{id:'active',sourceID:2,sourceKey:'SOURCE01',language:'zh',status:'queued'}];
  let started, stop;
  const entered = new Promise(resolve => { started = resolve; });
  f.plugin.runWorker = async () => { started(); await new Promise((_, reject) => { stop = reject; }); };
  f.plugin.process = { kill: () => stop(new Error('terminated')) };
  const queue = f.plugin.runQueue(); await entered; await f.plugin.shutdown(); await queue;
  assert.equal(f.plugin.running, false); assert.equal(f.plugin.jobs[0].status, 'interrupted');
});

test('cancelling while a worker is being spawned prevents writing its API request', async () => {
  const f = fixture(); let release, started, writes = 0, killed = false;
  const entered = new Promise(resolve => { started = resolve; });
  const process = { stdin:{write:async()=>{writes++;}}, stderr:{readString:async()=>''},
    kill:()=>{killed=true;}, wait:async()=>({exitCode:130}) };
  f.context.ChromeUtils = { importESModule: () => ({ Subprocess: { call: async () => {
    started(); return await new Promise(resolve => { release = () => resolve(process); });
  } } }) };
  const job = {id:'active',status:'running'}; f.plugin.jobs = [job]; f.plugin.currentJob = job;
  const running = f.plugin.runWorker({action:'translate'}); await entered;
  await f.plugin.cancel('active'); release();
  await assert.rejects(running, /取消/);
  assert.equal(writes, 0); assert.equal(killed, true); assert.equal(f.plugin.process, null);
});

test('removing a task record preserves Zotero attachments and refuses an active job', async () => {
  const f = fixture(); f.items.set(2, f.attachment(2,'SOURCE01',1));
  f.plugin.jobs = [{id:'done',status:'completed'}, {id:'active',status:'running'}];
  await f.plugin.removeJob('done'); await f.plugin.removeJob('active');
  assert.equal(f.plugin.jobs.length, 1); assert.equal(f.plugin.jobs[0].id,'active');
  assert.equal(f.items.size,1);
});

test('a worker reserves its slot before asynchronous prerequisites and releases it after failure', async () => {
  const f = fixture(); let release, checks = 0, entered;
  const started = new Promise(resolve => {entered = resolve;});
  f.context.IOUtils.exists = () => { checks++; entered(); return new Promise(resolve => { release = resolve; }); };
  const first = f.plugin.runWorker({action:'probe'});
  await assert.rejects(f.plugin.runWorker({action:'probe'}), /正在运行/);
  await started;
  assert.equal(checks, 1);
  release(false); await assert.rejects(first, /找不到 Python/);
  assert.equal(f.plugin.workerTask, null);
  f.context.IOUtils.exists = async () => false;
  await assert.rejects(f.plugin.runWorker({action:'probe'}), /找不到 Python/);
});

test('shutdown waits for an engine probe still spawning and sends no API request', async () => {
  const f = fixture(); let release, started, writes = 0, killed = false;
  const entered = new Promise(resolve => { started = resolve; });
  const process = { stdin:{write:async()=>{writes++;}}, stderr:{readString:async()=>''},
    kill:()=>{killed=true;}, wait:async()=>({exitCode:130}) };
  f.context.ChromeUtils = { importESModule: () => ({ Subprocess: { call: async () => {
    started(); return new Promise(resolve => { release = () => resolve(process); });
  } } }) };
  const running = f.plugin.runWorker({action:'probe'}); await entered;
  let stopped = false;
  const shutdown = f.plugin.shutdown().then(() => {stopped = true;});
  await Promise.resolve(); assert.equal(stopped, false);
  const rejected = assert.rejects(running, /取消/);
  release(); await rejected; await shutdown;
  assert.equal(writes, 0); assert.equal(killed, true); assert.equal(f.plugin.workerTask, null);
});

test('partial import retry does not duplicate mono when skip-existing is disabled', async () => {
  const f = fixture(); const p = f.parent(1,[2]); const source=f.attachment(2,'SOURCE01',1);
  f.items.set(1,p); f.items.set(2,source);
  f.settings.set('extensions.localpdftranslate.settings',JSON.stringify({skipExisting:false}));
  const importFile=f.zotero.Attachments.importFromFile; let calls=0;
  f.zotero.Attachments.importFromFile=async options=>{if (++calls===2) throw new Error('dual import failed'); return importFile(options);};
  const job={language:'zh',outputs:{mono:'/mono.pdf',dual:'/dual.pdf'}};
  await assert.rejects(f.plugin.attachOutputs(source,job), /dual import failed/);
  const mono=job.monoID; await f.plugin.attachOutputs(source,job);
  assert.equal(job.monoID,mono); assert.equal(p.children.length,3);
});

test('source selection deduplicates parent and attachment, skips unavailable and translated PDFs', async () => {
  const f = fixture();
  const p = f.parent(1, [2, 3]); const original = f.attachment(2, 'SOURCE01', 1);
  f.items.set(1, p); f.items.set(2, original); f.items.set(3, f.attachment(3, 'OUTPUT01', 1, 'paper.zh.dual.pdf'));
  const sources = await f.plugin.sourcesFor([p, original]);
  assert.equal(sources.length, 1); assert.equal(sources[0].id, 2);
  original.fileExists = async () => false;
  assert.equal((await f.plugin.sourcesFor([p])).length, 0);
});

test('paper screening applies to parents, directly selected attachments and standalone PDFs', async () => {
  const f = fixture();
  for (const [i, type] of ['journalArticle','conferencePaper','preprint','thesis','report','book','webpage','document'].entries()) {
    const id=10+i*2, p=f.parent(id,[id+1],type), pdf=f.attachment(id+1,'SOURCE'+id,id);
    f.items.set(id,p); f.items.set(id+1,pdf);
    const expected=i<4 ? 1 : 0;
    assert.equal((await f.plugin.sourcesFor([p])).length,expected,type);
    assert.equal((await f.plugin.sourcesFor([pdf])).length,expected,'direct '+type);
  }
  assert.equal((await f.plugin.sourcesFor([f.attachment(99,'LONEPDF',null)])).length,0);
  const html=f.attachment(100,'HTMLFILE',10,'paper.html'); html.isPDFAttachment=()=>false;
  f.items.set(100,html); f.items.get(10).children.push(100);
  assert.equal((await f.plugin.sourcesFor([html])).length,0);
  assert.equal((await f.plugin.sourcesFor([f.items.get(10)])).length,1);
  f.items.get(10).deleted=true;
  assert.equal((await f.plugin.sourcesFor([f.items.get(11)])).length,0);
});

test('target-language screening matches aliases and regions without guessing unknown or mixed languages', async () => {
  const f=fixture(), pdf=f.attachment(2,'SOURCE01',1); f.items.set(2,pdf);
  for (const [language,target,skip] of [
    ['zh','zh',true],['Chinese','zh-CN',true],['中文','zh',true],['zh_CN','zh-Hans',true],
    ['eng','en-US',true],['English','en',true],['en-GB','en-US',true],['日本語','ja',true],
    ['zh-TW','zh-CN',false],['zh-TW','zh',false],['zh','zh-TW',false],['zh-CN','zh-TW',false],['en','zh',false],['','zh',false],['en; zh','zh',false],
  ]) {
    f.items.set(1,f.parent(1,[2],'journalArticle',language));
    f.settings.set('extensions.localpdftranslate.settings',JSON.stringify({langOut:target}));
    assert.equal((await f.plugin.candidatesFor([pdf])).candidates.length,skip ? 0 : 1,language+' → '+target);
  }
});

test('legacy queued jobs are screened again using the target language at task start', async () => {
  const f=fixture();
  f.items.set(1,f.parent(1,[2],'journalArticle','en')); f.items.set(2,f.attachment(2,'SOURCE01',1));
  f.items.set(3,f.parent(3,[4],'book','de')); f.items.set(4,f.attachment(4,'SOURCE02',3));
  f.settings.set('extensions.localpdftranslate.settings',JSON.stringify({langOut:'en'}));
  f.plugin.jobs=[2,4].map((id,i)=>({id:'old'+id,sourceID:id,sourceKey:'SOURCE0'+(i+1),status:'queued',language:'zh'}));
  f.plugin.runWorker=async()=>{throw new Error('must not invoke engine');};
  await f.plugin.runQueue();
  assert.ok(f.plugin.jobs.every(job=>job.status==='skipped'));
  assert.match(f.plugin.jobs[0].stage,/目标语言/);
  assert.match(f.plugin.jobs[1].stage,/不是论文/);
  assert.equal(f.plugin.jobs[0].language,'en');
});

test('completed outputs are found using source, variant and target-language tags after renaming', async () => {
  const f = fixture(); const p = f.parent(1, [2, 3, 4]); const source = f.attachment(2, 'SOURCE01', 1);
  f.items.set(1, p); f.items.set(2, source);
  for (const [id, variant] of [[3, 'mono'], [4, 'dual']]) f.items.set(id, f.attachment(id, 'OUTPUT0' + id, 1, 'renamed.pdf',
    ['local-pdf-translate', 'local-translate:source:SOURCE01', 'local-translate:variant:' + variant, 'local-translate:lang:zh']));
  const outputs = await f.plugin.outputsFor(source);
  assert.equal(outputs.mono.id, 3); assert.equal(outputs.dual.id, 4);
  assert.equal(await f.plugin.enqueueItems([p], false), 0);
});

test('a queue deduplicates repeated requests and does not auto-import generated files', async () => {
  const f = fixture(); const p = f.parent(1, [2]); f.items.set(1, p); f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.zotero.getMainWindow=()=>({setTimeout:()=>1,clearTimeout(){}});
  f.plugin.runQueue = async () => {};
  assert.equal(await f.plugin.enqueueItems([p], false), 1);
  assert.equal(await f.plugin.enqueueItems([p], false), 0);
  f.plugin.importing = 1;
  f.items.set(50,f.attachment(50,'OUTPUT50',1,'generated.pdf',['local-pdf-translate']));
  await f.plugin.onNotify('add', 'item', [50]);
  assert.equal(f.plugin.pendingNew.size, 1);
  await f.plugin.promptNew();
  f.plugin.importing = 0;
  await f.plugin.promptNew();
  assert.equal(f.plugin.pendingNew.size, 0);
  assert.equal(f.prompts(),0);
});

test('attachment import assigns both variants to the original parent and can resume after one succeeds', async () => {
  const f = fixture(); const p = f.parent(1, [2]); const source = f.attachment(2, 'SOURCE01', 1);
  f.items.set(1, p); f.items.set(2, source);
  const job = { language: 'zh', outputs: { mono: '/mono.pdf', dual: '/dual.pdf' } };
  await f.plugin.attachOutputs(source, job);
  assert.equal(p.children.length, 3);
  for (const variant of ['mono', 'dual']) {
    const item = f.items.get(job[variant + 'ID']);
    assert.equal(item.parentItemID, 1);
    assert.ok(item.getTags().some(t => t.tag === 'local-translate:variant:' + variant));
  }
  await f.plugin.attachOutputs(source, job);
  assert.equal(p.children.length, 3);
});

test('new PDF prompts once and ignores generated outputs', async () => {
  const f = fixture(); const p = f.parent(1, [2]); f.items.set(1, p); f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.plugin.enqueueItems = async () => 1;
  f.plugin.pendingNew.add(2); await f.plugin.promptNew();
  f.plugin.pendingNew.add(2); await f.plugin.promptNew();
  assert.equal(f.prompts(), 1);
});

test('new arrivals during a slow PDF scan are drained after its debounce fired', async () => {
  const f = fixture(), timers = new Map(); let nextTimer = 0, release, entered;
  f.zotero.getMainWindow = () => ({setTimeout: callback => {timers.set(++nextTimer, callback); return nextTimer;}, clearTimeout: id => timers.delete(id)});
  const started = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.items.set(3, f.attachment(3, 'SOURCE02', 1));
  const scanned = [];
  f.plugin.candidatesFor = async items => {
    scanned.push(Array.from(items, item => item.id));
    if (scanned.length === 1) {entered(); await gate;}
    return {candidates: [], errors: []};
  };
  f.plugin.pendingNew.add(2);
  const first = f.plugin.promptNew(); await started;
  await f.plugin.onNotify('add', 'item', [3]);
  const early = [...timers.values()][0]; timers.clear(); await early();
  release(); await first;
  assert.equal(timers.size, 1);
  const next = [...timers.values()][0]; timers.clear(); await next();
  assert.deepEqual(scanned, [[2], [3]]);
  assert.equal(f.plugin.pendingNew.size, 0);
});

test('saving a blank API key removes the old credential and key loading blocks premature saves', async () => {
  const f = fixture(); let stored = true, saved = 0, release;
  f.context.Services.logins = {findLogins: () => stored ? [{password: 'old-key'}] : [], removeLogin: () => {stored = false;}};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/settings.js'), 'utf8'), f.context);
  const input = {value: '', disabled: true};
  const view = {plugin: f.plugin, keyLoading: true, root: {isConnected: true}, values: () => f.plugin.settings, $: () => input, renderEngine() {}, message() {}};
  f.plugin.preferences.add(view);
  f.plugin.getKey = () => new Promise(resolve => {release = resolve;});
  const loading = f.plugin.loadPreferenceKey(view);
  const save = f.plugin.savePreferences;
  f.plugin.savePreferences = (...args) => {saved++; return save.apply(f.plugin, args);};
  await f.context.SettingsView.save.call(view);
  assert.equal(saved, 0);
  release('old-key'); await loading;
  assert.equal(input.value, 'old-key');
  assert.equal(input.disabled, false);
  input.value = '';
  await f.context.SettingsView.save.call(view);
  assert.equal(saved, 1);
  assert.equal(stored, false);
});

test('new PDFs arriving during output import wait until tags are saved without being lost', async () => {
  const f=fixture(),timers=new Map(); let next=0, scanned=0;
  f.zotero.getMainWindow=()=>({setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
  f.items.set(1,f.parent(1,[2])); f.items.set(2,f.attachment(2,'SOURCE01',1));
  f.plugin.candidatesFor=async items=>{scanned++;return {candidates:items,errors:[]};};
  f.plugin.enqueueItems=async()=>1;
  f.plugin.importing=1;
  await f.plugin.onNotify('add','item',[2]);
  const first=[...timers.values()][0];timers.clear();await first();
  assert.equal(scanned,0);
  assert.equal(f.plugin.pendingNew.size,1);
  f.plugin.importing=0;
  const later=[...timers.values()][0];timers.clear();await later();
  assert.equal(scanned,1);
  assert.equal(f.prompts(),1);
  assert.equal(f.plugin.pendingNew.size,0);
});

test('failed translation is not marked complete and a later queued job still runs', async () => {
  const f = fixture(); f.plugin.dir = '/jobs';
  f.items.set(1, f.parent(1, [2])); f.items.set(2, f.attachment(2, 'SOURCE01', 1));
  f.items.set(3, f.attachment(3, 'SOURCE02', 1));
  f.plugin.jobs = [{ id: 'a', sourceID: 2, sourceKey: 'SOURCE01', language: 'zh', status: 'queued' },
    { id: 'b', sourceID: 3, sourceKey: 'SOURCE02', language: 'zh', status: 'queued' }];
  let calls = 0;
  f.plugin.runWorker = async () => { if (!calls++) throw new Error('network failed'); return {outputs:{mono:'/mono.pdf',dual:'/dual.pdf'}}; };
  // makeDirectory is a real prerequisite, unlike the translation result.
  const context = vm.createContext({ Zotero: f.zotero, Services: {dirsvc:{get:()=>({path:'/home'})}},
    PathUtils:{join:(...s)=>s.join('/')}, Ci:{}, IOUtils:{makeDirectory:async()=>{}}, console });
  loadPlugin(context);
  const plugin = context.LocalTranslate;
  plugin.getKey = async () => '';
  plugin.dir = '/jobs'; plugin.jobs = f.plugin.jobs; plugin.persist = async()=>{};
  plugin.runWorker = f.plugin.runWorker;
  plugin.attachOutputs = async () => {};
  await plugin.runQueue();
  assert.equal(plugin.jobs[0].status, 'failed');
  assert.match(plugin.jobs[0].error, /network failed/);
  assert.equal(plugin.jobs[1].status, 'completed');
  assert.equal(plugin.running, false);
});

test('PDF downloaded after its add event triggers a prompt once the local file is ready', async () => {
  const f = fixture(); const source = f.attachment(2, 'SOURCE01', 1);
  f.items.set(1, f.parent(1,[2])); f.items.set(2, source);
  let available = false; source.fileExists = async () => available;
  f.zotero.getMainWindow = () => ({ setTimeout: () => 1, clearTimeout() {} });
  f.plugin.enqueueItems = async () => 1;
  f.plugin.pendingNew.add(2); await f.plugin.promptNew();
  assert.equal(f.prompts(), 0);
  assert.equal(f.plugin.waitingFiles.has(2), true);
  available = true;
  await f.plugin.onNotify('refresh', 'item', [2]);
  await f.plugin.promptNew();
  assert.equal(f.prompts(), 1);
  assert.equal(f.plugin.waitingFiles.has(2), false);
});

test('cancel queued and running jobs preserves explicit cancellation state', async () => {
  const f = fixture(); let killed = false;
  f.plugin.jobs = [{ id:'queued',status:'queued' }, {id:'running',status:'running'}];
  f.plugin.process = {kill: () => {killed = true;}};
  await f.plugin.cancel('queued'); await f.plugin.cancel('running');
  assert.equal(f.plugin.jobs[0].status, 'cancelled');
  assert.equal(f.plugin.jobs[1].cancelRequested, true);
  assert.equal(killed, true);
});

test('managed runtime reuses its own Python and never a saved workspace path', async () => {
  const f = fixture(); f.context.Services.appinfo = {OS:'Darwin',XPCOMABI:'aarch64-gcc3'};
  f.plugin.runtimeManifest = {id:'pinned',platforms:{'aarch64-apple-darwin':'hash'}};
  f.plugin.dir = '/profile/local-translate'; f.plugin.settings.python = '/wrong/python';
  // Use the production implementation, without the process fixture's engine override.
  delete f.plugin.ensureEngine;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/zotero/runtime.js'),'utf8'),f.context);
  const engine = await f.plugin.ensureEngine();
  assert.equal(engine.python,'/profile/local-translate/runtime/pinned/.venv/bin/python');
  assert.equal(engine.assetsRoot,'/profile/local-translate/assets');
});

test('unsupported runtime platform and cancelled preparation fail before a download', async () => {
  const f = fixture(); f.context.Services.appinfo = {OS:'Darwin',XPCOMABI:'aarch64-gcc3'};
  f.plugin.runtimeManifest = {id:'pinned',platforms:{}}; f.plugin.dir='/profile';
  delete f.plugin.ensureEngine;
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/zotero/runtime.js'),'utf8'),f.context);
  await assert.rejects(f.plugin.ensureEngine(), /不支持/);
  f.plugin.runtimeManifest.platforms['aarch64-apple-darwin']='hash'; f.plugin.stopping=true;
  await assert.rejects(f.plugin.ensureEngine(), /取消/);
});

test('cancelling engine download aborts the request as well as any subprocess', async () => {
  const f=fixture(); let aborted=false;
  f.plugin.jobs=[{id:'installing',status:'running'}];
  f.plugin.downloadRequest={abort:()=>{aborted=true;}};
  await f.plugin.cancel('installing');
  assert.ok(aborted); assert.ok(f.plugin.jobs[0].cancelRequested);
});

test('removed global-service, CSV and machine-path preferences cannot remain active invisibly', () => {
  const f=fixture();
  f.settings.set('extensions.localpdftranslate.settings', JSON.stringify({useGlobalConfig:true,glossaries:'/old.csv',python:'/old/python',engineRoot:'/old',langOut:'ja'}));
  assert.equal(f.plugin.settings.langOut,'ja');
  for (const key of ['useGlobalConfig','glossaries','python','engineRoot']) assert.ok(!(key in f.plugin.settings));
});

test('preparation fraction never advances the PDF translation percentage', async () => {
  const f=fixture(), p=f.parent(1,[2]); f.items.set(1,p); f.items.set(2,f.attachment(2,'SOURCE01',1));
  f.context.IOUtils.makeDirectory=async()=>{};
  f.plugin.dir='/profile'; f.plugin.jobs=[{id:'phases',sourceID:2,sourceKey:'SOURCE01',status:'queued',language:'zh',progress:0}];
  f.plugin.attachOutputs=async()=>{};
  f.plugin.runWorker=async (_payload,receive)=>{
    receive({type:'engine_progress',stage:'Download',progress:100});
    assert.equal(f.plugin.jobs[0].progress,0);
    assert.equal(f.plugin.jobs[0].preparing,true);
    assert.equal(f.plugin.jobs[0].preparationProgress,100);
    receive({type:'engine_progress',stage:'Install',progress:null});
    assert.equal(f.plugin.jobs[0].preparationProgress,null);
    receive({type:'progress',stage:'Translate',progress:20});
    assert.equal(f.plugin.jobs[0].preparing,false);
    assert.equal(f.plugin.jobs[0].progress,19.4);
    receive({type:'progress',stage:'Translate',progress:null,stageProgress:50});
    assert.equal(f.plugin.jobs[0].progress,48.5);
    receive({type:'progress',stage:'Translate',progress:25});
    assert.equal(f.plugin.jobs[0].progress,48.5);
    receive({type:'progress',stage:'Layout',progress:null,stageProgress:100});
    assert.equal(f.plugin.jobs[0].progress,97);
    return {outputs:{}};
  };
  await f.plugin.runQueue(); assert.equal(f.plugin.jobs[0].status,'completed');
});

test('API tests reserve the worker and do not save draft settings even when preparation fails', async () => {
  const f=fixture(); let release, saved = false;
  f.plugin.saveSettings=async()=>{saved = true;};
  f.plugin.ensureEngine=()=>new Promise((_, reject)=>{release=()=>reject(new Error('preparation failed'));});
  const task=f.plugin.checkEngine('test_api',{...f.plugin.settings, model:'draft-model'},'private-key');
  await assert.rejects(f.plugin.runWorker({action:'probe'}),/正在运行/);
  release(); await task;
  assert.equal(saved,false);
  assert.equal(f.plugin.settings.model,'deepseek-flash');
  assert.equal(f.plugin.workerTask,null);
  assert.equal(f.plugin.engineStatus.error,true);
  assert.ok(!f.plugin.engineStatus.stage.includes('private-key'));
});

test('each task keeps its starting endpoint, credential, language and import settings', async () => {
  const f = fixture(); let entered, release, key = 'provider-a-key', preparations = 0;
  const started = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  f.plugin.getKey = async () => key;
  f.plugin.ensureEngine = async () => {
    if (!preparations++) {entered(); await gate;}
    return {python:'/python',engineRoot:'/engine'};
  };
  f.settings.set('extensions.localpdftranslate.settings', JSON.stringify({baseURL:'https://a.invalid/v1',langOut:'ja',skipExisting:false}));
  f.items.set(1, f.parent(1, [2, 3]));
  f.items.set(2, f.attachment(2,'SOURCE01',1)); f.items.set(3, f.attachment(3,'SOURCE02',1));
  f.plugin.jobs = [2, 3].map(id => ({id:'task'+id,sourceID:id,sourceKey:'SOURCE0'+(id-1),status:'queued',language:'zh',outputs:{},monoID:99}));
  f.context.IOUtils.makeDirectory = async () => {};
  f.plugin.dir='/profile';
  const imports=[];
  f.plugin.attachOutputs=async (_source, job, cfg)=>imports.push({language:job.language,skipExisting:cfg.skipExisting,monoID:job.monoID});
  const requests = captureWorkerRequests(f);
  const running = f.plugin.runQueue(); await started;
  await f.plugin.saveSettings({...f.plugin.settings,baseURL:'https://b.invalid/v1',langOut:'zh',skipExisting:true});
  key='provider-b-key'; release(); await running;
  assert.deepEqual(requests.map(r=>[r.config.baseURL,r.apiKey,r.config.langOut]), [
    ['https://a.invalid/v1','provider-a-key','ja'], ['https://b.invalid/v1','provider-b-key','zh']]);
  assert.deepEqual(imports.map(i=>[i.language,i.skipExisting]), [['ja',false],['zh',true]]);
  assert.equal(imports[0].monoID, undefined);
  assert.ok(f.plugin.jobs.every(job=>job.status==='completed'));
});

test('configuration snapshots wait for an in-flight credential save before reading the pair', async () => {
  const f = fixture(); let release, entered, stored;
  const started = new Promise(resolve=>{entered=resolve;});
  f.context.Cc={'@mozilla.org/login-manager/loginInfo;1': {createInstance:()=>({init(_a,_b,_c,_d,password){this.password=password;}})}};
  f.context.Services.logins={findLogins:()=>[], addLoginAsync:login=>new Promise(resolve=>{
    entered(); release=()=>{stored=login.password;resolve();};
  })};
  f.plugin.getKey=async()=>stored;
  const saving=f.plugin.saveSettings({...f.plugin.settings,baseURL:'https://b.invalid/v1'},'provider-b-key');
  await started;
  const snapshot=f.plugin.captureConfiguration();
  release(); await saving;
  const result=await snapshot;
  assert.equal(result.config.baseURL,'https://b.invalid/v1');
  assert.equal(result.apiKey,'provider-b-key');
});

test('preview runs an isolated draft with the same URL normalization as saved tasks', async () => {
  const f=fixture(), sample=[{label:'正文',request:{body:{model:'draft-model'}}}]; let rendered;
  const requests=captureWorkerRequests(f,{requests:sample});
  const view={previewRevision:3,root:{isConnected:true},renderEngine(){},finishRequestPreview(...args){rendered=args;}};
  f.plugin.preferences.add(view);
  const draft={...f.plugin.settings,baseURL:'https://a.invalid/v1/chat/completions',model:'draft-model'};
  const task=f.plugin.previewRequest(view,draft,'');
  draft.model='later-change';
  await task;
  assert.equal(requests[0].action,'preview');
  assert.equal(requests[0].apiKey,'');
  assert.equal(requests[0].config.baseURL,'https://a.invalid/v1');
  assert.equal(requests[0].config.model,'draft-model');
  assert.equal(f.plugin.settings.model,'deepseek-flash');
  assert.deepEqual(JSON.parse(JSON.stringify(rendered)),[sample,3,null]);
  assert.equal(f.plugin.engineStatus.ready,true);
});

test('request preview displays engine output and discards it if the draft changes during generation', () => {
  const f=fixture();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/ui/settings.js'),'utf8'),f.context);
  const view=Object.create(f.context.SettingsView), fields=new Map(); let invoked;
  for (const name of [...view.fields,...view.checks,'apiKey','request-preview','copy-request','request-kind','refresh-preview']) {
    fields.set(name,{value:'',handlers:{},disabled:false,textContent:'',
      addEventListener(event,fn){this.handlers[event]=fn;}, replaceChildren(){this.options=[];},append(option){this.options.push(option);}});
  }
  view.$=id=>fields.get(id);
  view.root={ownerDocument:{createElementNS:()=>({})}};
  view.plugin={previewRequest:(_view,settings,key)=>{invoked={settings,key};}};
  view.values=()=>({...f.plugin.settings,model:'draft-model'});
  view.renderEngine=()=>{};
  view.setupPreviewPanel();
  assert.equal(fields.get('copy-request').disabled,true);
  fields.get('refresh-preview').onclick();
  const revision=view.previewRevision;
  assert.equal(invoked.key,''); assert.equal(invoked.settings.model,'draft-model');
  const result=[{label:'正文',request:{method:'POST',body:{model:'draft-model',thinking:{type:'disabled'}}}}];
  view.finishRequestPreview(result,revision);
  assert.deepEqual(JSON.parse(fields.get('request-preview').textContent),result[0].request);
  assert.equal(fields.get('copy-request').disabled,false);
  assert.equal(fields.get('request-kind').options[0].textContent,'正文');
  fields.get('refresh-preview').onclick();
  fields.get('model').handlers.input();
  view.finishRequestPreview(result,revision);
  assert.equal(view.previewBusy,false);
  assert.equal(fields.get('copy-request').disabled,true);
  assert.match(fields.get('request-preview').textContent,/配置已更改/);
});

test('destroyed preference sandboxes cannot stop background status updates', () => {
  const f=fixture(); let updates=0;
  f.plugin.preferences.add(new Proxy({}, {get(){throw new Error('dead object');}}));
  const detached={root:{isConnected:false}}, live={root:{isConnected:true},renderEngine:()=>{updates++;}};
  f.plugin.preferences.add(detached); f.plugin.preferences.add(live);
  f.plugin.setEngineStatus({stage:'Download',progress:42,busy:true});
  assert.equal(updates,1); assert.equal(f.plugin.preferences.size,1);
  assert.equal(f.plugin.engineStatus.progress,42);
});

test('runtime download reports actual byte fraction and resets for installation', async () => {
  const f=fixture(), events=[]; let observer;
  f.context.Services.appinfo={OS:'Darwin',XPCOMABI:'aarch64-gcc3'};
  f.plugin.runtimeManifest={id:'pinned',uv:'0.13.5',python:'3.13.13',platforms:{'aarch64-apple-darwin':'00'}};
  f.plugin.dir='/profile'; f.plugin.rootURI='chrome://plugin/';
  Object.assign(f.context.IOUtils,{exists:async p=>p.endsWith('/python'), makeDirectory:async()=>{},writeUTF8:async()=>{},write:async()=>{},remove:async()=>{},move:async()=>{},setPermissions:async()=>{},writeJSON:async()=>{}});
  f.zotero.File={getResourceAsync:async()=>''};
  f.zotero.HTTP={request:async(_method,_url,options)=>{
    options.requestObserver({addEventListener:(_name,listener)=>{observer=listener;}});
    observer({lengthComputable:false,loaded:5,total:0});
    observer({lengthComputable:true,loaded:25,total:100});
    observer({lengthComputable:true,loaded:100,total:100});
    return {response:new ArrayBuffer(1)};
  }};
  f.context.Cc={'@mozilla.org/security/hash;1':{createInstance:()=>({init(){},update(){},finish:()=>String.fromCharCode(0)})}};
  f.context.Ci.nsICryptoHash={};
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/zotero/runtime.js'),'utf8'),f.context);
  f.plugin.runtimeCommand=async()=>{};
  await f.plugin.ensureEngine(e=>events.push(e));
  assert.deepEqual(events.filter(e=>Number.isFinite(e.progress)).map(e=>e.progress),[25,100]);
  assert.ok(events.every(e=>e.type==='engine_progress'));
  assert.equal(events.at(-1).progress,null);
  assert.equal(f.plugin.downloadRequest,null);
  let sent=false; f.plugin.currentJob={cancelRequested:false};
  f.zotero.HTTP.request=async(_method,_url,options)=>{
    f.plugin.currentJob.cancelRequested=true;
    options.requestObserver({addEventListener(){}});
    sent=true;
  };
  await assert.rejects(f.plugin.ensureEngine(),/取消/);
  assert.equal(sent,false);
});

test('renamed BabelDOC attachments skip the entire parent even when only one translation exists', async () => {
  const f=fixture(), p=f.parent(1,[2,3]), original=f.attachment(2,'SOURCE01',1), translated=f.attachment(3,'OUTPUT01',1,'renamed-paper.pdf');
  translated.producer='BabelDOC0.6.2_Translation_generated_by_AI,please_carefully_discern';
  f.items.set(1,p);f.items.set(2,original);f.items.set(3,translated);
  assert.equal((await f.plugin.candidatesFor([p])).candidates.length,0);
  f.settings.set('extensions.localpdftranslate.settings',JSON.stringify({skipExisting:false}));
  const scan=await f.plugin.candidatesFor([p]);
  assert.deepEqual(Array.from(scan.candidates,x=>x.id),[2]);
  assert.equal(scan.errors.length,0);
});

test('metadata cache is invalidated when the PDF changes, and a producer name alone is insufficient', async () => {
  const f=fixture(), a=f.attachment(2,'SOURCE01',1);f.items.set(2,a);
  let revision=1, reads=0;
  f.context.IOUtils.stat=async()=>({size:100,lastModified:revision});
  f.zotero.PDFWorker.getRecognizerData=async()=>{reads++;return {metadata:{Producer:a.producer}};};
  a.producer='BabelDOC typesetting';
  assert.equal(await f.plugin.isTranslatedPDF(a),false);
  assert.equal(await f.plugin.isTranslatedPDF(a),false);assert.equal(reads,1);
  a.producer='BabelDOC_Translation_generated_by_AI,please_carefully_discern';revision++;
  assert.equal(await f.plugin.isTranslatedPDF(a),true);assert.equal(reads,2);
});

test('batch confirmation counts only eligible PDFs after translated, queued and unavailable sources are removed', async () => {
  const f=fixture();
  const old=f.parent(1,[2,3]), fresh=f.parent(4,[5]), pending=f.parent(6,[7]), offline=f.parent(8,[9]);
  for(const p of [old,fresh,pending,offline]) f.items.set(p.id,p);
  for(const [id,key,parent] of [[2,'ORIGINAL',1],[3,'OUTPUT01',1],[5,'FRESH001',4],[7,'QUEUED01',6],[9,'OFFLINE1',8]]) f.items.set(id,f.attachment(id,key,parent));
  f.items.get(3).producer='BabelDOC_Translation_generated_by_AI,please_carefully_discern';
  f.items.get(9).fileExists=async()=>false;
  f.plugin.jobs=[{id:'pending',sourceID:7,status:'queued'}];f.plugin.paused=true;
  let text='';f.context.Services.prompt.confirm=(_win,_title,message)=>{text=message;return true;};
  assert.equal(await f.plugin.enqueueItems([old,fresh,pending,offline]),1);
  assert.match(text,/将翻译 1 个 PDF（1 条文献）/);
  assert.equal(f.plugin.jobs.at(-1).sourceID,5);
});

test('a previously queued translated input is skipped without attaching outputs or failing the queue', async () => {
  const f=fixture();const p=f.parent(1,[2]);f.items.set(1,p);f.items.set(2,f.attachment(2,'SOURCE01',1));
  f.context.IOUtils.makeDirectory=async()=>{};f.plugin.dir='/profile';
  f.plugin.jobs=[{id:'legacy',sourceID:2,sourceKey:'SOURCE01',language:'zh',status:'queued'}];
  f.plugin.runWorker=async()=>({skipped:true});f.plugin.attachOutputs=async()=>{throw new Error('must not import');};
  await f.plugin.runQueue();assert.equal(f.plugin.jobs[0].status,'skipped');assert.equal(f.plugin.jobs[0].error,'');
});

test('bulk actions respect each task status and preserve attachments', async () => {
  const f=fixture(); f.plugin.paused=true;let killed=0;
  f.plugin.process={kill(){killed++;}};
  f.plugin.jobs=[{id:'a',status:'queued'},{id:'b',status:'running'},{id:'c',status:'completed'},{id:'d',status:'failed'}];
  await f.plugin.cancelJobs(['a','b','c']);
  assert.equal(f.plugin.jobs[0].status,'cancelled');assert.equal(f.plugin.jobs[1].cancelRequested,true);assert.equal(killed,1);
  await f.plugin.retryJobs(['a','d','c']);
  assert.equal(f.plugin.jobs[0].status,'queued');assert.equal(f.plugin.jobs[3].status,'queued');assert.equal(f.plugin.jobs[2].status,'completed');
  await f.plugin.removeJobs(['a','b','c']);
  assert.deepEqual(f.plugin.jobs.map(j=>j.id),['b','d']);
});

test('clearing a running queue waits for cancellation and leaves existing attachments intact', async () => {
  const f=fixture(); f.items.set(1,f.parent(1,[2]));f.items.set(2,f.attachment(2,'SOURCE01',1));
  f.context.IOUtils.makeDirectory=async()=>{};f.plugin.dir='/profile';
  f.plugin.jobs=[{id:'active',status:'queued',sourceID:2,sourceKey:'SOURCE01',language:'zh'},{id:'next',status:'queued'}];
  let entered, rejectWorker;const started=new Promise(resolve=>{entered=resolve;});
  f.plugin.runWorker=async()=>{entered();return new Promise((_resolve,reject)=>{rejectWorker=reject;});};
  f.plugin.process={kill(){rejectWorker(new Error('cancelled'));}};
  const running=f.plugin.runQueue();await started;
  await f.plugin.clearQueue(false);await running;
  assert.equal(f.plugin.jobs.length,0);assert.equal(f.plugin.running,false);assert.equal(f.plugin.paused,false);assert.equal(f.items.size,2);
});

test('clearing during metadata scanning prevents late enqueue and rejects new enqueue until finished', async () => {
  const f=fixture(), p=f.parent(1,[2]); f.items.set(1,p);f.items.set(2,f.attachment(2,'SOURCE01',1));
  let entered, release;
  const started=new Promise(resolve=>{entered=resolve;});
  f.zotero.PDFWorker.getRecognizerData=async()=>{entered();return new Promise(resolve=>{release=()=>resolve({metadata:{}});});};
  const enqueue=f.plugin.enqueueItems([p],false);await started;
  const clear=f.plugin.clearQueue(false);
  await assert.rejects(f.plugin.enqueueItems([p],false),/清空/);
  release();assert.equal(await enqueue,0);await clear;
  assert.equal(f.plugin.jobs.length,0);assert.equal(f.plugin.clearing,false);
});
