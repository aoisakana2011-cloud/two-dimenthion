const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn,spawnSync} = require('node:child_process');
const projectFileLock = require('@bybrave/proper-lockfile2');
const {createProjectLockFs} = require('../Edit/project-lock-fs');
const {projectLayout,layoutForInput,entryFile,parseSettings,seedEmptyProject} = require('../tools/project-layout');
const {pack} = require('../tools/pack');
const {resolveProjectScript, sceneFile} = require('../tools/project');
const {checkTypes} = require('../dist');

test('new projects seed the Start screen and defer the optional player UI theme', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-seed-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const layout = seedEmptyProject(dir);
  const screens = JSON.parse(await fs.readFile(path.join(layout.settingsRoot, 'game-screens.json'), 'utf8'));
  assert.equal(screens.version, 1);
  assert.equal(screens.initial, 'title');
  assert.equal(screens.screens.title.items[0].action, 'start');
  await assert.rejects(fs.access(path.join(layout.settingsRoot, 'player-ui.json')), {code: 'ENOENT'});
});

test('setting values preserve escaped hash characters before inline comments', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-#1-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const layout = seedEmptyProject(dir);
  assert.equal(layout.title, path.basename(dir));
  const settings = parseSettings('scenario_dir = story\\#draft # comment\nasset_dir = media\\#raw\nstart_file = main.tds\ntitle = Novel \\#1 # title note');
  assert.equal(settings.scenario_dir, 'story#draft');
  assert.equal(settings.asset_dir, 'media#raw');
  assert.equal(settings.title, 'Novel #1');
});

test('project includes expose struct declarations to the including scene', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-include-struct-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  seedEmptyProject(dir);
  const layout = projectLayout(dir);
  await fs.mkdir(layout.scenesRoot, {recursive: true});
  await fs.writeFile(path.join(layout.scenesRoot, 'common.tds'), `
    struct User {
      name: str
      age: int
    }
  `);
  const source = `
    include common.tds as common
    User player = { "name": "Yui", "age": 17 }
    fn copy(value: User) -> User { return value }
    scene main { say narrator player.name }
  `;
  const script = await resolveProjectScript(source, layout.scenesRoot, new Set(), 'main.tds');
  assert.deepEqual(script.structs.map(struct => struct.name), ['User']);
  assert.equal(script.functions[0].params[0].type.name, 'User');
  assert.equal(script.functions[0].returnType.name, 'User');
  assert.doesNotThrow(() => checkTypes(script, 'main.tds'));
  await assert.rejects(
    resolveProjectScript('include common / route.tds', layout.scenesRoot, new Set(), 'main.tds'),
    /includeパスに空白は使用できません/,
  );
});

test('project scene paths reject empty directory components', () => {
  assert.throws(() => sceneFile('chapter//next.tds'), /シナリオのパスが不正です/);
  assert.throws(() => sceneFile('con.tds'), /シナリオのパスが不正です/);
  assert.throws(() => sceneFile('chapter/next.'), /シナリオのパスが不正です/);
  assert.throws(() => sceneFile('chapter/next.txt'), /\.tds/);
});

test('setting.txt fixes layout and entry file at the project root',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'novel-settings-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'setting.txt'),'scenario_dir = story/scripts\nasset_dir = media\nstart_file = opening/intro.tds\ntitle = Configured title\n');
  const layout=projectLayout(dir);
  assert.equal(layout.scenesRoot,path.join(dir,'story','scripts'));
  assert.equal(layout.assetsRoot,path.join(dir,'media'));
  assert.equal(layout.title,'Configured title');
  assert.equal(entryFile(layout),path.join(dir,'story','scripts','opening','intro.tds'));
  await fs.mkdir(path.dirname(entryFile(layout)),{recursive:true});
  await fs.writeFile(entryFile(layout),'say "start"');
  assert.equal(layoutForInput(entryFile(layout)).projectRoot,dir);
  assert.throws(()=>require('../tools/project-layout').parseSettings('scenario_dir = ../outside'),/scenario_dir/);
  assert.throws(()=>require('../tools/project-layout').parseSettings('unknown = value'),/未対応/);
  assert.throws(() => parseSettings('scenario_dir = first\nscenario_dir = second\nasset_dir = media\nstart_file = main.tds'), /scenario_dir.*重複/);
});

test('nested project settings take precedence over a legacy root setting.txt', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-settings-precedence-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await fs.mkdir(path.join(dir, 'setting'), {recursive: true});
  await fs.writeFile(path.join(dir, 'setting.txt'), 'scenario_dir = old-scenes\nasset_dir = old-assets\nstart_file = old.tds\ntitle = Legacy\n');
  await fs.writeFile(path.join(dir, 'setting', 'setting.txt'), 'scenario_dir = scenes\nasset_dir = assets\nstart_file = main.tds\ntitle = Current\n');

  const layout = projectLayout(dir);
  assert.equal(layout.legacySettings, false);
  assert.equal(layout.settingsRoot, path.join(dir, 'setting'));
  assert.equal(layout.scenesRoot, path.join(dir, 'scenes'));
  assert.equal(layout.assetsRoot, path.join(dir, 'assets'));
  assert.equal(layout.settings.title, 'Current');
  assert.equal(entryFile(layout), path.join(dir, 'scenes', 'main.tds'));
});

test('a dangling nested setting link is treated as absent and preserves legacy fallback', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dangling-setting-link-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'setting'), { recursive: true });
  await fs.writeFile(path.join(dir, 'setting.txt'), 'scenario_dir = story\nasset_dir = asset\nstart_file = main.tds\ntitle = Legacy\n');
  fsSync.symlinkSync(path.join(dir, 'missing', 'setting.txt'), path.join(dir, 'setting', 'setting.txt'), 'junction');
  assert.equal(fsSync.existsSync(path.join(dir, 'setting', 'setting.txt')), false, 'a dangling link does not count as an existing nested settings file');

  const layout = projectLayout(dir);
  assert.equal(layout.legacySettings, true);
  assert.equal(layout.settingFile, path.join(dir, 'setting.txt'));
  assert.equal(layout.settings.title, 'Legacy');
});

test('setting paths reject Windows alternate streams, invalid characters, and device names', () => {
  const parse = require('../tools/project-layout').parseSettings;
  const base = 'scenario_dir = story\nasset_dir = asset\nstart_file = main.tds';
  for (const [key, value] of [
    ['start_file', 'main.tds:secret.tds'],
    ['scenario_dir', 'story:metadata'],
    ['asset_dir', 'media?backup'],
    ['scenario_dir', 'CON'],
    ['scenario_dir', 'COM1.txt'],
    ['asset_dir', 'media.'],
    ['asset_dir', 'media /images'],
    ['asset_dir', 'media\u0001images'],
  ]) {
    const source = base.replace(new RegExp(`^${key} = .*`, 'm'), `${key} = ${value}`);
    assert.throws(() => parse(source), new RegExp(key));
  }
});

test('project paths reject Windows absolutes and symlinked directories outside the project',async t=>{
  assert.throws(()=>parseSettings('scenario_dir = C:/outside'),/scenario_dir/);
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'novel-project-symlink-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const project=path.join(parent,'project'),outside=path.join(parent,'outside');
  await fs.mkdir(project,{recursive:true});await fs.mkdir(outside);
  await fs.writeFile(path.join(project,'setting.txt'),'scenario_dir = escape\nasset_dir = asset\nstart_file = main.tds\n');
  await fs.symlink(outside,path.join(project,'escape'),'junction');
  assert.throws(()=>seedEmptyProject(project),/作品フォルダー外/);
  await assert.rejects(fs.access(path.join(outside,'main.tds')));
});

test('pack keeps scenario keys relative when the configured scenario root is an in-project junction', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-pack-scenario-junction-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, 'project');
  seedEmptyProject(project);
  await fs.writeFile(path.join(project, 'setting', 'setting.txt'), 'scenario_dir = scenes-link\nasset_dir = asset\nstart_file = main.tds\ntitle = Junction test\n');
  const layout = projectLayout(project);
  const physicalScenes = path.join(project, 'scenes-real');
  await fs.mkdir(physicalScenes);
  await fs.rm(layout.scenesRoot, { recursive: true, force: true });
  await fs.symlink(physicalScenes, layout.scenesRoot, 'junction');
  await fs.mkdir(layout.assetsRoot, { recursive: true });
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'scene main { goto "chapter.tds" }');
  await fs.writeFile(path.join(layout.scenesRoot, 'chapter.tds'), 'scene chapter { wait 1 }');

  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), path.join(layout.buildRoot, 'main.nsp.json'), { projectRoot: project });
  assert.deepEqual(Object.keys(packaged.files).sort(), ['chapter.tds', 'main.tds']);
  assert.equal(packaged.source, 'main.tds');
  assert.equal(packaged.program.scenes[0].instructions[0].scene, 'chapter.tds');
});

test('pack stores unreferenced scenario files in files alongside the selected entry program', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-pack-unreferenced-scenes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenesRoot = path.join(root, 'scenes');
  const assetsRoot = path.join(root, 'assets');
  await fs.mkdir(scenesRoot);
  await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'scene main { wait 1 }');
  await fs.writeFile(path.join(scenesRoot, 'unused.tds'), 'scene unused { wait 2 }');

  const packaged = await pack(path.join(scenesRoot, 'main.tds'), path.join(root, 'out', 'main.nsp.json'), { scenesRoot, assetsRoot });

  assert.equal(packaged.source, 'main.tds');
  assert.deepEqual(Object.keys(packaged.files).sort(), ['main.tds', 'unused.tds']);
  assert.deepEqual(packaged.files['unused.tds'].scenes.map(scene => scene.name), ['unused']);
});

test('pack canonicalizes case-insensitive external goto paths', async t => {
  if (process.platform !== 'win32') return t.skip('Case-insensitive path resolution is Windows-specific');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-goto-case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenesRoot = path.join(root, 'scenes'), assetsRoot = path.join(root, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'scene main { goto "chapter.tds" }');
  await fs.writeFile(path.join(scenesRoot, 'Chapter.tds'), 'scene chapter { wait 1 }');
  const destination = path.join(root, 'out', 'game.json');
  const packaged = await pack(path.join(scenesRoot, 'main.tds'), destination, { scenesRoot, assetsRoot });
  assert.deepEqual(Object.keys(packaged.files).sort(), ['Chapter.tds', 'main.tds']);
  assert.equal(packaged.program.scenes[0].instructions[0].scene, 'Chapter.tds');
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [destination, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Native player is not built; package path assertions still ran');
  }
});

test('Native package loading preserves uppercase .TDS extensions on external goto paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-goto-extension-case-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const scenesRoot = path.join(root, 'scenes'), assetsRoot = path.join(root, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'scene main { goto "chapter.TDS" }');
  await fs.writeFile(path.join(scenesRoot, 'chapter.TDS'), 'scene chapter { say narrator "loaded uppercase extension" }');
  const destination = path.join(root, 'out', 'game.nsp.json');
  const packaged = await pack(path.join(scenesRoot, 'main.tds'), destination, { scenesRoot, assetsRoot });
  assert.ok(packaged.files['chapter.TDS']);
  assert.equal(packaged.program.scenes[0].instructions[0].scene, 'chapter.TDS');
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [destination, '--headless'], {
      encoding: 'utf8', timeout: 10000,
      env: {...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy'},
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Native player is not built; package path assertions still ran');
  }
});

test('project layout rejects a setting.txt hard link to an external file',async t=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'novel-setting-hardlink-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const project=path.join(parent,'project'),outside=path.join(parent,'external-setting.txt');
  await fs.mkdir(project);
  await fs.writeFile(outside,'scenario_dir = senario\nasset_dir = asset\nstart_file = main.tds\n');
  await fs.link(outside,path.join(project,'setting.txt'));
  assert.throws(()=>projectLayout(project),/setting\.txt/);
});

test('project seeding rejects an externally linked main scene without changing it',async t=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'novel-main-hardlink-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const project=path.join(parent,'project'),outside=path.join(parent,'external.tds');
  await fs.mkdir(path.join(project,'senario'),{recursive:true});
  await fs.writeFile(path.join(project,'setting.txt'),'scenario_dir = senario\nasset_dir = asset\nstart_file = main.tds\n');
  const original='say narrator "outside"';
  await fs.writeFile(outside,original);
  await fs.link(outside,path.join(project,'senario','main.tds'));
  assert.throws(()=>seedEmptyProject(project),/main\.tds/);
  assert.equal(await fs.readFile(outside,'utf8'),original);
});

test('CLI packaging rejects an external .novel junction',async t=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'novel-pack-data-link-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const project=path.join(parent,'project'),outside=path.join(parent,'outside-data');
  seedEmptyProject(project);
  const layout=projectLayout(project);
  await fs.rm(layout.dataRoot,{recursive:true,force:true});
  await fs.mkdir(layout.scenesRoot,{recursive:true});
  await fs.mkdir(layout.assetsRoot,{recursive:true});
  await fs.mkdir(outside,{recursive:true});
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'say narrator "inside"');
  await fs.writeFile(path.join(outside,'variables.json'),JSON.stringify({staticVariables:[]}));
  await fs.symlink(outside,layout.dataRoot,'junction');
  await assert.rejects(pack(path.join(layout.scenesRoot,'main.tds'),path.join(layout.buildRoot,'main.nsp.json'),{projectRoot:project}),/\.novel/);
  await assert.rejects(fs.access(path.join(outside,'build','main.nsp.json')));
});

test('pack refuses to overwrite the static variable source used by compilation', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-pack-variable-overwrite-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, 'project');
  seedEmptyProject(project);
  const layout = projectLayout(project);
  await fs.mkdir(layout.scenesRoot, { recursive: true });
  await fs.mkdir(layout.dataRoot, { recursive: true });
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "inside"');
  const variablesPath = path.join(layout.dataRoot, 'variables.json');
  const original = '{"staticVariables":[]}\n';
  await fs.writeFile(variablesPath, original);

  await assert.rejects(
    pack(path.join(layout.scenesRoot, 'main.tds'), variablesPath, { projectRoot: project }),
/Package output cannot overwrite a source file\./,
  );
  assert.equal(await fs.readFile(variablesPath, 'utf8'), original, 'the input configuration must remain intact');
});

test('CLI packaging rejects linked scene inputs and linked asset output folders',async t=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'novel-pack-link-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const project=path.join(parent,'project'),outside=path.join(parent,'outside');
  seedEmptyProject(project);
  const layout=projectLayout(project);
  await fs.mkdir(layout.scenesRoot,{recursive:true});
  await fs.mkdir(layout.assetsRoot,{recursive:true});
  await fs.mkdir(outside,{recursive:true});
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'say narrator "inside"');
  const externalScene=path.join(outside,'external.tds');
  await fs.writeFile(externalScene,'say narrator "outside"');
  await fs.link(externalScene,path.join(layout.scenesRoot,'linked.tds'));
  await assert.rejects(pack(path.join(layout.scenesRoot,'main.tds'),path.join(layout.buildRoot,'main.nsp.json'),{projectRoot:project}),/usual|regular|単独|通常/i);
  await fs.unlink(path.join(layout.scenesRoot,'linked.tds'));
  await fs.writeFile(path.join(layout.assetsRoot,'pixel.png'),'pixel');
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'asset image logo = "asset/pixel.png"\nshow image logo center');
  await fs.mkdir(layout.buildRoot,{recursive:true});
  await fs.symlink(outside,path.join(layout.buildRoot,'asset'),'junction');
  await assert.rejects(pack(path.join(layout.scenesRoot,'main.tds'),path.join(layout.buildRoot,'main.nsp.json'),{projectRoot:project}),/Package output must be inside the selected directory\.|作品フォルダー外/);
  await assert.rejects(fs.access(path.join(outside,'pixel.png')));
});

test('project open requires a boolean create flag before creating a project', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-open-flag-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  seedEmptyProject(parent);
  const project = path.join(parent, 'new-project');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', parent], {
    env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await done;
    }
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('server timeout: ' + stderr)), 10000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(Error('server exited ' + code + ': ' + stderr)); });
  });
  const open = async create => {
    const response = await fetch(base + '/api/project/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: project, create }),
    });
    return { status: response.status, data: await response.json() };
  };
  const malformed = await open('false');
  assert.equal(malformed.status, 400);
  assert.equal(await fs.access(project).then(() => true, () => false), false, 'a string false must not create or open a project');
  const repoAlias = path.join(parent, 'editor-repository-alias');
  await fs.symlink(path.resolve(__dirname, '..'), repoAlias, 'junction');
  const editorTree = await fetch(base + '/api/project/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: repoAlias, create: false }),
  });
  assert.equal(editorTree.status, 400, 'a symlink alias to the editor repository must be rejected as the editor tree');
  assert.equal((await editorTree.json()).needsCreate, undefined);
  await fs.mkdir(project);
  const confirmation = await open(false);
  assert.equal(confirmation.status, 409);
  assert.equal(confirmation.data.needsCreate, true);
  assert.deepEqual(await fs.readdir(project), [], 'a false flag must leave an empty directory untouched');
  assert.equal((await open(true)).status, 200);
  assert.equal(await fs.access(path.join(project, 'setting', 'setting.txt')).then(() => true, () => false), true);
});

test('arbitrary title: editor CRUD, assets, project build and CLI use the same project',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'novel-作品 空白-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  seedEmptyProject(dir);
  const layout=projectLayout(dir);
  await fs.mkdir(path.join(layout.scenesRoot,'chapter'),{recursive:true});await fs.mkdir(layout.assetsRoot,{recursive:true});
  await fs.copyFile(path.resolve(__dirname,'../native/engine_data/ui/dialogue_box.png'),path.join(layout.assetsRoot,'pixel.png'));
  await fs.copyFile(path.join(layout.assetsRoot,'pixel.png'),path.join(layout.assetsRoot,'video-placeholder.mp4'));
  const source='asset image logo = "asset/pixel.png"\nshow image logo center\ngoto "chapter/next.tds"';
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),source);
  await fs.writeFile(path.join(layout.scenesRoot,'chapter/next.tds'),'int result = 7');
  assert.equal(layoutForInput(path.join(layout.scenesRoot,'chapter/next.tds')).projectRoot,dir);
  const child=spawn(process.execPath,[path.resolve(__dirname,'../Edit/server.js'),'--project',dir],{env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  t.after(async()=>{if(child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}});
  const base=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('server timeout: '+stderr)),10000);let output='';
    child.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('server exited '+code+': '+stderr));});
  });
  const api=async(endpoint,method='GET',body)=>{const response=await fetch(base+endpoint,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
  const malformedJson = await fetch(base+'/api/scene', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{ invalid json' });
  assert.equal(malformedJson.status, 400, 'malformed request JSON is a client error, not an internal server error');
  assert.match((await malformedJson.json()).error, /JSONの形式が正しくありません/);
  const nullPayload = await fetch(base+'/api/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(nullPayload.status, 400, 'valid JSON with the wrong top-level shape is a client error, not an uncaught route exception');
  assert.match((await nullPayload.json()).error, /JSON本文はオブジェクトで指定してください/);
  const arrayPayload = await fetch(base+'/api/scene', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  assert.equal(arrayPayload.status, 400, 'scene write API accepts an object payload, not a top-level array');
  assert.match((await arrayPayload.json()).error, /JSON本文はオブジェクトで指定してください/);
  const wrappedNullPayload = await fetch(base+'/api/player-ui', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(wrappedNullPayload.status, 400, 'routes that catch body parsing preserve the client error status');
  const oversizedJson = await fetch(base+'/api/player-ui', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(oversizedJson.status, 413, 'a JSON request over the documented body limit is rejected with Payload Too Large even when a route wraps JSON parsing');
  const listing=(await api('/api/files')).data;
  assert.equal(listing.title,path.basename(dir));
  assert.deepEqual(listing.files.filter(f=>!f.path.includes('/')).map(f=>f.path).sort(),['asset','senario','setting']);
  assert.equal(listing.files.some(f=>f.path==='server.js'||f.path.startsWith('.novel')),false);
  const projectSettings = await api('/api/setting-file?name=setting.txt');
  const settingTextPath = path.join(layout.settingsRoot,'setting.txt');
  const staleLayoutSource = projectSettings.data.source.replace(/^scenario_dir\s*=.*$/m,'scenario_dir = stale-scenario');
  await fs.writeFile(settingTextPath,`${projectSettings.data.source}# external revision\n`);
  const staleLayoutSave = await api('/api/setting-file','PUT',{name:'setting.txt',source:staleLayoutSource,expectedRevision:projectSettings.data.revision});
  assert.equal(staleLayoutSave.status,409,'a stale project-layout save is rejected before creating directories from its old payload');
  assert.equal(await fs.access(path.join(dir,'stale-scenario')).then(()=>true,()=>false),false,'a rejected layout save must not create its proposed scenario folder');
  await fs.writeFile(settingTextPath,projectSettings.data.source);
  const missingDocumentConflict = await api('/api/setting-file','PUT',{name:'drafts/stale.md',source:'# Must not create parent\n',expectedRevision:'stale-revision'});
  assert.equal(missingDocumentConflict.status,409,'a stale save to a missing nested setting document is a revision conflict');
  assert.equal(await fs.access(path.join(layout.settingsRoot,'drafts')).then(()=>true,()=>false),false,'a rejected nested setting save must not create parent directories');
  const conventionFile = await api('/api/setting-file?name=asset-folders.txt');
  assert.equal(conventionFile.status,200);
  const settingSave = await api('/api/setting-file','PUT',{name:'story-adaptation.md',source:'# Story rules\n'});
  assert.equal(settingSave.status,200);
  assert.equal(await fs.readFile(path.join(dir,'setting','story-adaptation.md'),'utf8'),'# Story rules\n');
  assert.equal((await api('/api/setting-file','PUT',{name:'story-adaptation.md',source:'# Invalid revision\n',expectedRevision:null})).status,400);
  assert.equal((await api('/api/setting-file','PUT',{name:'missing.md'})).status,400);
  assert.equal(await fs.access(path.join(dir,'setting','missing.md')).then(()=>true,()=>false),false);
  for (const name of ['folder/evil:stream.md','CON.json','bad?.md','trailing./draft.md']) {
    assert.equal((await api('/api/setting-file','PUT',{name,source:'must not write'})).status,400,`unsafe Windows setting path ${name} is rejected`);
  }
  assert.equal(await fs.access(path.join(dir,'setting','folder')).then(()=>true,()=>false),false,'unsafe setting paths do not create parent folders');
  const settingRevision = await api('/api/setting-file?name=story-adaptation.md');
  await fs.writeFile(path.join(dir,'setting','story-adaptation.md'),'# Changed externally\n');
  const settingConflict = await api('/api/setting-file','PUT',{name:'story-adaptation.md',source:'# Stale editor\n',expectedRevision:settingRevision.data.revision});
  assert.equal(settingConflict.status,409);
  assert.equal(settingConflict.data.code,'SETTING_CONFLICT');
  assert.equal(await fs.readFile(path.join(dir,'setting','story-adaptation.md'),'utf8'),'# Changed externally\n');
  const settingRaceRevision = await api('/api/setting-file?name=story-adaptation.md');
  const settingRaceSources = ['# Concurrent editor A\n', '# Concurrent editor B\n'];
  const settingRace = await Promise.all(settingRaceSources.map(source => api('/api/setting-file','PUT',{name:'story-adaptation.md',source,expectedRevision:settingRaceRevision.data.revision})));
  assert.deepEqual(settingRace.map(result => result.status).sort(),[200,409],'only one concurrent setting save from the same revision may succeed');
  assert.ok(settingRaceSources.includes(await fs.readFile(path.join(dir,'setting','story-adaptation.md'),'utf8')),'the saved setting must be the body from the successful request');
  assert.equal((await api('/api/setting-file','PUT',{name:'player-ui.json',source:'{ invalid json'})).status,400);
  assert.equal((await fetch(base+'/asset/pixel.png')).status,200);
  assert.equal((await api('/api/asset-info?path=asset%2Fpixel.png%3Asecret')).status,403,'asset paths must reject Windows alternate data streams');
  assert.equal((await api('/api/scene?name=main.tds')).data.source,source);
  const revisioned = (await api('/api/scene?name=main.tds')).data;
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'say narrator "changed outside"');
  const conflict = await api('/api/scene','PUT',{name:'main.tds',source:'say narrator "stale editor"',expectedRevision:revisioned.revision});
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.code,'SCENE_CONFLICT');
  assert.equal(await fs.readFile(path.join(layout.scenesRoot,'main.tds'),'utf8'),'say narrator "changed outside"');
  const sceneRaceRevision = await api('/api/scene?name=main.tds');
  const sceneRaceSources = ['scene main { wait 11 }\n', 'scene main { wait 22 }\n'];
  const sceneRace = await Promise.all(sceneRaceSources.map((source,index) => api('/api/scene','PUT',{name:index ? 'MAIN.TDS' : 'main.tds',source,expectedRevision:sceneRaceRevision.data.revision})));
  assert.deepEqual(sceneRace.map(result => result.status).sort(),[200,409],'only one concurrent scene save from the same revision may succeed, including case variants on Windows');
  assert.ok(sceneRaceSources.includes(await fs.readFile(path.join(layout.scenesRoot,'main.tds'),'utf8')),'the saved scene must be the body from the successful request');
  assert.equal((await api('/api/scene','PUT',{name:'main.tds',source})).status,200,'restore the fixture through the editor save route');
  assert.equal((await api('/api/scene','PUT',{name:'senario/new.tds',source:'say "saved"'})).status,200);
  assert.equal(await fs.readFile(path.join(layout.scenesRoot,'new.tds'),'utf8'),'say "saved"');
  assert.equal((await api('/api/compile','POST',{name:'main.tds',source})).data.ok,true);
  const build=(await api('/api/project-build','POST',{name:'main.tds'})).data;assert.equal(build.ok,true,build.error);
  assert.equal(build.path,'.novel/build/main.nsp.json');
  assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data,{built:true,changedFiles:[],reason:'up-to-date'});
  const packagePath=path.join(layout.buildRoot,'main.nsp.json');
  const buildStatePath=path.join(layout.buildRoot,'main.build-state.json');
  const goodPackage=await fs.readFile(packagePath);
  const goodPackagedAsset=await fs.readFile(path.join(layout.buildRoot,'asset','pixel.png'));
  const screenSettingsPath=path.join(layout.settingsRoot,'game-screens.json');
  const originalScreenSettings=await fs.readFile(screenSettingsPath,'utf8');
  const sourceAssetPath=path.join(layout.assetsRoot,'pixel.png');
  const originalSourceAsset=await fs.readFile(sourceAssetPath);
  try {
    const brokenScreens=JSON.parse(originalScreenSettings);
    brokenScreens.screens.title.background='asset/missing-after-rebuild.png';
    await fs.writeFile(screenSettingsPath,JSON.stringify(brokenScreens),'utf8');
    await fs.writeFile(sourceAssetPath,'changed asset before failed rebuild');
    assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data,{built:true,changedFiles:[],reason:'up-to-date'},'build status intentionally snapshots scenario sources only before a build attempt');
    const failedRebuild=(await api('/api/project-build','POST',{name:'main.tds'})).data;
    assert.equal(failedRebuild.ok,false,'a missing screen image fails the real project build');
    assert.equal(await fs.readFile(packagePath).then(bytes=>bytes.equals(goodPackage)),true,'failed rebuild preserves the last complete package');
    assert.equal(await fs.readFile(path.join(layout.buildRoot,'asset','pixel.png')).then(bytes=>bytes.equals(goodPackagedAsset)),true,'failed rebuild rolls back asset files already staged');
    await assert.rejects(fs.access(buildStatePath),{code:'ENOENT'},'failed rebuild must invalidate the previous successful build state');
    assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data,{built:false,changedFiles:[],reason:'not-built'});
  } finally {
    await fs.writeFile(screenSettingsPath,originalScreenSettings,'utf8');
    await fs.writeFile(sourceAssetPath,originalSourceAsset);
  }
  const recoveredBuild=(await api('/api/project-build','POST',{name:'main.tds'})).data;
  assert.equal(recoveredBuild.ok,true,recoveredBuild.error);
  assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data,{built:true,changedFiles:[],reason:'up-to-date'});
  await fs.writeFile(path.join(layout.scenesRoot,'shared.tds'),'asset image missing_from_module = "asset/not-installed.png"');
  const includedAssetValidation=(await api('/api/validate','POST',{name:'main.tds',source:'include shared.tds as shared\nscene main { wait 1 }'})).data;
  assert.equal(includedAssetValidation.ok,false,'missing assets in included modules must fail live validation');
  assert.ok(includedAssetValidation.diagnostics.some(item=>item.code==='project-error'&&item.file==='shared.tds'&&item.line===1),JSON.stringify(includedAssetValidation.diagnostics));
  await fs.rm(path.join(layout.scenesRoot,'shared.tds'));
  await fs.writeFile(path.join(layout.scenesRoot,'chapter/next.tds'),`${await fs.readFile(path.join(layout.scenesRoot,'chapter/next.tds'),'utf8')}\n# changed`);
  assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data.changedFiles,['chapter/next.tds']);
  await fs.writeFile(path.join(layout.scenesRoot,'chapter/next.tds'),'int result = 7');
  await fs.writeFile(path.join(layout.scenesRoot,'added.tds'),'say narrator "added"');
  assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data.changedFiles,['added.tds']);
  await fs.rm(path.join(layout.scenesRoot,'added.tds'));
  await fs.rm(path.join(layout.scenesRoot,'chapter/next.tds'));
  assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data.changedFiles,['chapter/next.tds']);
  await fs.writeFile(path.join(layout.scenesRoot,'chapter/next.tds'),'int result = 7');
  assert.deepEqual((await api('/api/project-build-status','POST',{name:'main.tds'})).data,{built:true,changedFiles:[],reason:'up-to-date'});
  const originalNextSource=await fs.readFile(path.join(layout.scenesRoot,'chapter/next.tds'),'utf8');
  try {
    await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'asset image first = "asset/missing-first.png"\nasset image second = "asset/missing-second.png"');
    await fs.writeFile(path.join(layout.scenesRoot,'chapter/next.tds'),'say narrator missing_value');
    const failedBuild=(await api('/api/project-build','POST',{name:'main.tds'})).data;
    assert.equal(failedBuild.ok,false);
    assert.deepEqual(failedBuild.diagnostics.map(item=>[item.file,item.code,item.line]),[
      ['chapter/next.tds','type-error',1],
      ['main.tds','project-error',1],
      ['main.tds','project-error',2],
    ]);
    assert.equal(new Set(failedBuild.diagnostics.map(item=>JSON.stringify(item))).size,failedBuild.diagnostics.length);
  } finally {
    await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),source);
    await fs.writeFile(path.join(layout.scenesRoot,'chapter/next.tds'),originalNextSource);
  }
  const constraintVariablesFile=path.join(layout.dataRoot,'variables.json');
  const originalConstraintVariables=await fs.readFile(constraintVariablesFile,'utf8');
  try {
    await fs.writeFile(constraintVariablesFile,JSON.stringify({staticVariables:[
      {name:'difficulty',type:'int',value:2,min:1,max:3},
      {name:'ending',type:'str',value:'common',possibleValues:['common','true_end']},
    ]}));
    const constrainedValidation=(await api('/api/validate','POST',{name:'main.tds',source:'if difficulty > 5 { wait 1 }'})).data;
    assert.equal(constrainedValidation.ok,true,constrainedValidation.error);
    assert.ok(constrainedValidation.diagnostics.some(item=>item.code==='constant-condition'&&item.severity==='warning'));
    const possibleValuesValidation=(await api('/api/validate','POST',{name:'main.tds',source:'if ending == "missing" { wait 1 }'})).data;
    assert.equal(possibleValuesValidation.ok,true,possibleValuesValidation.error);
    assert.ok(possibleValuesValidation.diagnostics.some(item=>item.code==='constant-condition'&&item.severity==='warning'));
    const outOfRangeValidation=(await api('/api/validate','POST',{name:'main.tds',source:'set difficulty = 9'})).data;
    assert.equal(outOfRangeValidation.ok,false);
    assert.ok(outOfRangeValidation.diagnostics.some(item=>item.code==='variable-constraint'&&item.severity==='error'));
    const placementValidation=(await api('/api/validate','POST',{name:'main.tds',source:'character hero {\nname = "Hero"\npose normal = "asset/pixel.png"\n}\ncharacter friend {\nname = "Friend"\npose normal = "asset/pixel.png"\n}\nscene main {\nshow hero.normal left\nshow friend.normal left\n}'})).data;
    assert.equal(placementValidation.ok,true,placementValidation.error);
    assert.ok(placementValidation.diagnostics.some(item=>item.code==='character-slot-conflict'&&item.severity==='warning'));
    const imagePlacementValidation=(await api('/api/validate','POST',{name:'main.tds',source:'asset image first = "asset/pixel.png"\nasset image second = "asset/pixel.png"\nscene main {\nshow image first center\nshow image second center\n}'})).data;
    assert.equal(imagePlacementValidation.ok,true,imagePlacementValidation.error);
    assert.ok(imagePlacementValidation.diagnostics.some(item=>item.code==='image-slot-conflict'&&item.severity==='warning'));
    const backgroundValidation=(await api('/api/validate','POST',{name:'main.tds',source:'int route = 0\nasset bg first = "asset/pixel.png"\nscene main {\nclear bg\nif route == 1 {\nbg first\n} else {\nwait 1\n}\nclear bg\n}'})).data;
    assert.equal(backgroundValidation.ok,true,backgroundValidation.error);
    const backgroundWarning=backgroundValidation.diagnostics.find(item=>item.code==='background-clear-path-dependent');
    assert.ok(backgroundWarning);
    assert.equal(backgroundWarning.severity,'warning');
    assert.equal(backgroundWarning.line,10);
    assert.equal(backgroundWarning.column,1);
    assert.equal(backgroundWarning.endColumn,9);
  } finally {
    await fs.writeFile(constraintVariablesFile,originalConstraintVariables);
  }
  const videoValidation=(await api('/api/validate','POST',{name:'main.tds',source:'asset video first = "asset/video-placeholder.mp4"\nasset video second = "asset/video-placeholder.mp4"\nscene main {\nplay video first async\nplay video second async\n}'})).data;
  assert.equal(videoValidation.ok,true,videoValidation.error);
  assert.ok(videoValidation.diagnostics.some(item=>item.code==='video-layer-replaced'&&item.severity==='warning'));
  await fs.access(path.join(layout.buildRoot,'asset/pixel.png'));
  await fs.access(path.join(layout.dataRoot,'assets.schema.json'));
  assert.equal((await api('/api/file','DELETE',{path:'senario/new.tds'})).data.ok,true);
  await assert.rejects(fs.access(path.join(layout.scenesRoot,'new.tds')));
  const outside = path.join(dir,'outside-project');
  await fs.mkdir(outside,{recursive:true});
  await fs.writeFile(path.join(outside,'external.tds'),'say narrator "original"');
  await fs.writeFile(path.join(outside,'external.png'),'outside asset');
  await fs.symlink(outside,path.join(layout.scenesRoot,'escape'),'junction');
  await fs.symlink(outside,path.join(layout.assetsRoot,'escape'),'junction');
  const escapedRead=await api('/api/scene?name=escape/external.tds');
  assert.equal(escapedRead.status,400,'scenario reads must stay inside the selected project');
  const escapedWrite=await api('/api/scene','PUT',{name:'escape/external.tds',source:'say narrator "changed"'});
  assert.equal(escapedWrite.status,400,'scenario writes must stay inside the selected project');
  assert.equal(await fs.readFile(path.join(outside,'external.tds'),'utf8'),'say narrator "original"');
  const escapedDelete=await api('/api/file','DELETE',{path:'senario/escape/external.tds'});
  assert.equal(escapedDelete.status,400,'file deletion must reject paths whose parent escapes through a symlink');
  assert.equal(await fs.readFile(path.join(outside,'external.tds'),'utf8'),'say narrator "original"');
  const escapedAsset=await fetch(base+'/asset/escape/external.png');
  assert.equal(escapedAsset.status,403,'asset serving must stay inside the selected project');
  for(const name of ['scenes','assets','Edit'])await assert.rejects(fs.access(path.join(dir,name)));
  const defaultTheme=await api('/api/player-ui');
  assert.equal(defaultTheme.status,200,'new projects must return a default player theme');
  const themeDocument=await api('/api/setting-file','PUT',{name:'player-ui.json',source:JSON.stringify(defaultTheme.data.theme)});
  assert.equal(themeDocument.status,200,JSON.stringify(themeDocument.data));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(layout.settingsRoot,'player-ui.json'),'utf8')),defaultTheme.data.theme);
  assert.equal((await api('/api/project/settings','PUT',{native_ui_theme:'ui/player-ui.json'})).status,200);
  assert.equal((await api('/api/player-ui','PUT',{theme:defaultTheme.data.theme})).status,200);
  const cli=spawnSync(process.execPath,[path.resolve(__dirname,'../tools/pack.js'),'--project',dir],{encoding:'utf8',timeout:10000});assert.equal(cli.status,0,cli.stderr);
  assert.equal(entryFile(layout),path.join(layout.scenesRoot,'main.tds'));
  if(process.env.NOVEL_NATIVE_EXE){const result=spawnSync(process.env.NOVEL_NATIVE_EXE,[path.join(layout.buildRoot,'main.nsp.json'),'--smoke'],{encoding:'utf8',timeout:10000,env:{...process.env,SDL_VIDEODRIVER:'dummy',SDL_AUDIODRIVER:'dummy'}});assert.equal(result.status,0,result.stderr);}
  const externalDataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'novel-external-data-'));
  t.after(()=>fs.rm(externalDataRoot,{recursive:true,force:true}));
  await fs.writeFile(path.join(externalDataRoot,'variables.json'),JSON.stringify({staticVariables:[{name:'outside_secret',type:'str',value:'must stay private'}]}));
  await fs.writeFile(path.join(externalDataRoot,'main.nsp.json'),'must stay private');
  await fs.writeFile(path.join(externalDataRoot,'external.tds'),'say narrator "must not be listed"');
  const savedDataRoot=path.join(dir,'.novel-original');
  await fs.rename(layout.dataRoot,savedDataRoot);
  await fs.symlink(externalDataRoot,layout.dataRoot,'junction');
  try {
    const externalMetadata=await api('/api/variables');
    assert.equal(externalMetadata.status,400,'project metadata reads must reject a .novel junction outside the project');
    assert.equal(JSON.parse(await fs.readFile(path.join(externalDataRoot,'variables.json'),'utf8')).staticVariables[0].value,'must stay private');
  } finally {
    await fs.unlink(layout.dataRoot);
    await fs.rename(savedDataRoot,layout.dataRoot);
  }
  const variablesFile=path.join(layout.dataRoot,'variables.json');
  const validVariables=await fs.readFile(variablesFile,'utf8');
  await fs.writeFile(variablesFile,'{ invalid json');
  try {
    const corruptMetadata=await api('/api/variables');
    assert.equal(corruptMetadata.status,400,'corrupted project metadata must be reported instead of silently hidden');
  } finally {
    await fs.writeFile(variablesFile,validVariables);
  }
  const assetsFile=path.join(layout.dataRoot,'assets.json');
  const validAssets=await fs.readFile(assetsFile,'utf8');
  await fs.writeFile(assetsFile,'{ invalid json');
  try {
    const corruptMetadata=await api('/api/assets');
    assert.equal(corruptMetadata.status,400,'corrupted asset metadata must be reported instead of silently hidden');
  } finally {
    await fs.writeFile(assetsFile,validAssets);
  }
  const savedBuildRoot=path.join(layout.dataRoot,'build-original');
  await fs.rename(layout.buildRoot,savedBuildRoot);
  await fs.symlink(externalDataRoot,layout.buildRoot,'junction');
  try {
    const externalPackage=await fetch(`${base}/api/native-package?name=main.nsp.json`);
    assert.equal(externalPackage.status,403,'native package reads must reject a build junction outside the project');
    assert.equal(await fs.readFile(path.join(externalDataRoot,'main.nsp.json'),'utf8'),'must stay private');
  } finally {
    await fs.unlink(layout.buildRoot);
    await fs.rename(savedBuildRoot,layout.buildRoot);
  }
  const savedSceneRoot=path.join(dir,'senario-original');
  const changeBaseline=(await api('/api/project/changes')).data;
  assert.equal(changeBaseline.reset,true);
  const linkedScene=path.join(layout.scenesRoot,'linked-external.tds');
  await fs.link(path.join(outside,'external.tds'),linkedScene);
  try {
    const hardlinkedChangeScan=await api(`/api/project/changes?since=${encodeURIComponent(changeBaseline.token)}`);
    assert.equal(hardlinkedChangeScan.status,403,'project change notifications must reject hard-linked files');
  } finally { await fs.unlink(linkedScene); }
  await fs.rename(layout.scenesRoot,savedSceneRoot);
  await fs.symlink(externalDataRoot,layout.scenesRoot,'junction');
  try {
    const escapedChangeScan=await api(`/api/project/changes?since=${encodeURIComponent(changeBaseline.token)}`);
    assert.equal(escapedChangeScan.status,403,'project change notifications must reject a scenario root junction outside the project');
    const escapedFileListing=await api('/api/files');
    assert.equal(escapedFileListing.status,403,'the Explorer file listing must reject a scenario root junction outside the project');
    const externalScenes=await api('/api/scenes');
    assert.equal(externalScenes.status,403,'scene enumeration must reject a scenario root junction outside the project');
    assert.equal(await fs.readFile(path.join(externalDataRoot,'external.tds'),'utf8'),'say narrator "must not be listed"');
  } finally {
    await fs.unlink(layout.scenesRoot);
    await fs.rename(savedSceneRoot,layout.scenesRoot);
  }
});

test('separate editor server processes serialize scene saves against the same revision', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-cross-process-save-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const layout = seedEmptyProject(dir);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'scene main { wait 1 }\n');

  const startServer = async (projectRoot = dir) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', projectRoot], {
      env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { stderr += data; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await done;
      }
    });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`server startup timed out: ${stderr}`)), 15000);
      const poll = () => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
        else if (child.exitCode !== null) { clearTimeout(timer); reject(Error(`server exited ${child.exitCode}: ${stderr}`)); }
        else setTimeout(poll, 20);
      };
      poll();
    });
    return base;
  };
  const projectAlias = path.join(path.dirname(dir), `${path.basename(dir)}-junction`);
  await fs.symlink(dir, projectAlias, 'junction');
  const [firstServer, secondServer] = await Promise.all([startServer(), startServer(projectAlias)]);
  const canonicalRoot = await fs.realpath(dir);
  const lockId = crypto.createHash('sha256').update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot, 'utf8').digest('hex');
  const staleLockPath = path.join(os.tmpdir(), 'novel-editor-write-locks', `${lockId}.lock`);
  await fs.mkdir(staleLockPath, {recursive: true});
  const staleTime = new Date(Date.now() - 180_000);
  await fs.utimes(staleLockPath, staleTime, staleTime);
  const load = async base => {
    const response = await fetch(`${base}/api/scene?name=main.tds`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const [firstRevision, secondRevision] = await Promise.all([load(firstServer), load(secondServer)]);
  assert.equal(firstRevision.revision, secondRevision.revision, 'both processes start from the same source revision');
  const saves = await Promise.all([
    fetch(`${firstServer}/api/scene`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'main.tds', source: 'scene main { wait 11 }\n', expectedRevision: firstRevision.revision})}),
    fetch(`${secondServer}/api/scene`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'main.tds', source: 'scene main { wait 22 }\n', expectedRevision: secondRevision.revision})}),
  ]);
  const results = await Promise.all(saves.map(async response => ({status: response.status, body: await response.json()})));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409], 'the cross-process lock allows only one save from a shared revision');
  assert.ok(results.some(result => result.body.code === 'SCENE_CONFLICT'), 'the losing process receives the standard scene conflict');
  const saved = await fs.readFile(path.join(layout.scenesRoot, 'main.tds'), 'utf8');
  assert.ok(['scene main { wait 11 }\n', 'scene main { wait 22 }\n'].includes(saved), 'the final content is exactly the accepted save');
});

test('project build waits for a project-scoped lock held by another process', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-cross-process-build-lock-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const layout = seedEmptyProject(dir);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'start()\nscene main { wait 1 }\n');

  const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', dir], {
    env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await done;
    }
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`server startup timed out: ${stderr}`)), 15000);
    const poll = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
      else if (child.exitCode !== null) { clearTimeout(timer); reject(Error(`server exited ${child.exitCode}: ${stderr}`)); }
      else setTimeout(poll, 20);
    };
    poll();
  });

  const canonicalRoot = await fs.realpath(dir);
  const lockKey = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
  const lockId = crypto.createHash('sha256').update(lockKey, 'utf8').digest('hex');
  const ownerToken = crypto.randomUUID();
  const release = await projectFileLock.lock(canonicalRoot, {
    realpath: false,
    lockfilePath: path.join(os.tmpdir(), 'novel-editor-write-locks', `${lockId}.lock`),
    fs: createProjectLockFs(fsSync, ownerToken),
    stale: 120_000,
    update: 30_000,
  });
  try {
    let settled = false;
    const buildPromise = fetch(`${base}/api/project-build`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'main.tds'}),
    }).then(async response => { settled = true; return {status: response.status, body: await response.json()}; });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(settled, false, 'build must wait while another process owns the project write lock');
    await release();
    const result = await buildPromise;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true, JSON.stringify(result.body));
    await fs.access(path.join(layout.buildRoot, 'main.nsp.json'));
  } finally {
    await release().catch(() => {});
  }
});

test('opening another project cannot redirect a save already waiting on the current project lock', async t => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-switch-first-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-switch-second-'));
  t.after(() => Promise.all([fs.rm(firstRoot, {recursive: true, force: true}), fs.rm(secondRoot, {recursive: true, force: true})]));
  const firstLayout = seedEmptyProject(firstRoot);
  const secondLayout = seedEmptyProject(secondRoot);
  const original = 'scene main { wait 1 }\n';
  await fs.writeFile(path.join(firstLayout.scenesRoot, 'main.tds'), original);
  await fs.writeFile(path.join(secondLayout.scenesRoot, 'main.tds'), original);

  const canonicalRoot = await fs.realpath(firstRoot);
  const lockKey = process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot;
  const lockId = crypto.createHash('sha256').update(lockKey, 'utf8').digest('hex');
  const lockPath = path.join(os.tmpdir(), 'novel-editor-write-locks', `${lockId}.lock`);
  await fs.mkdir(lockPath, {recursive: true});
  t.after(() => fs.rm(lockPath, {recursive: true, force: true}));

  const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', firstRoot], {
    env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await done;
    }
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`server startup timed out: ${stderr}`)), 15000);
    const poll = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
      else if (child.exitCode !== null) { clearTimeout(timer); reject(Error(`server exited ${child.exitCode}: ${stderr}`)); }
      else setTimeout(poll, 20);
    };
    poll();
  });
  const loaded = await (await fetch(`${base}/api/scene?name=main.tds`)).json();
  const savePromise = fetch(`${base}/api/scene`, {
    method: 'PUT', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'main.tds', source: 'scene main { wait 99 }\n', expectedRevision: loaded.revision}),
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  let openSettled = false;
  const openPromise = fetch(`${base}/api/project/open`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({path: secondRoot}),
  }).then(response => { openSettled = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(openSettled, false, 'project switching waits for the in-flight request using the current project context');
  await fs.rm(lockPath, {recursive: true, force: true});
  const saved = await savePromise;
  assert.equal(saved.status, 200);
  const opened = await openPromise;
  assert.equal(opened.status, 200);
  assert.equal(await fs.readFile(path.join(firstLayout.scenesRoot, 'main.tds'), 'utf8'), 'scene main { wait 99 }\n');
  assert.equal(await fs.readFile(path.join(secondLayout.scenesRoot, 'main.tds'), 'utf8'), original,
    'the save remains bound to the project whose revision was read before the switch');
});
