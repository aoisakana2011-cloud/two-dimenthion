const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn,spawnSync} = require('node:child_process');
const {projectLayout,layoutForInput,entryFile,parseSettings,seedEmptyProject} = require('../tools/project-layout');
const {pack} = require('../tools/pack');
const {resolveProjectScript, sceneFile} = require('../tools/project');
const {checkTypes} = require('../dist');

test('project includes expose struct declarations to the including scene', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-include-struct-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const layout = projectLayout(dir);
  await fs.mkdir(layout.scenesRoot, {recursive: true});
  await fs.writeFile(path.join(layout.scenesRoot, 'common.tds'), `
    struct User {
      name: str
      age: int
    }
  `);
  const source = `
    include common.tds
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
    /Include path cannot contain spaces/,
  );
});

test('project scene paths reject empty directory components', () => {
  assert.throws(() => sceneFile('chapter//next.tds'), /Invalid scene path/);
  assert.throws(() => sceneFile('con.tds'), /Invalid scene path/);
  assert.throws(() => sceneFile('chapter/next.'), /Invalid scene path/);
});

test('setting.txt fixes layout and entry file at the project root',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'novel-settings-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'setting.txt'),'scenario_dir = story/scripts\nasset_dir = media\nstart_file = opening/intro.txt\ntitle = Configured title\n');
  const layout=projectLayout(dir);
  assert.equal(layout.scenesRoot,path.join(dir,'story','scripts'));
  assert.equal(layout.assetsRoot,path.join(dir,'media'));
  assert.equal(layout.title,'Configured title');
  assert.equal(entryFile(layout),path.join(dir,'story','scripts','opening','intro.txt'));
  await fs.mkdir(path.dirname(entryFile(layout)),{recursive:true});
  await fs.writeFile(entryFile(layout),'say "start"');
  assert.equal(layoutForInput(entryFile(layout)).projectRoot,dir);
  assert.throws(()=>require('../tools/project-layout').parseSettings('scenario_dir = ../outside'),/scenario_dir/);
  assert.throws(()=>require('../tools/project-layout').parseSettings('unknown = value'),/未対応/);
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
  const layout=projectLayout(project);
  await fs.mkdir(layout.scenesRoot,{recursive:true});
  await fs.mkdir(layout.assetsRoot,{recursive:true});
  await fs.mkdir(outside,{recursive:true});
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'say narrator "inside"');
  await fs.writeFile(path.join(outside,'variables.json'),JSON.stringify({staticVariables:[]}));
  await fs.symlink(outside,layout.dataRoot,'junction');
  await assert.rejects(pack(path.join(layout.scenesRoot,'main.tds'),path.join(layout.buildRoot,'main.nsp.json'),{projectRoot:project}),/\.novel/);
  await assert.rejects(fs.access(path.join(outside,'build','main.nsp.json')));
});

test('CLI packaging rejects linked scene inputs and linked asset output folders',async t=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'novel-pack-link-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const project=path.join(parent,'project'),outside=path.join(parent,'outside');
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
  await assert.rejects(pack(path.join(layout.scenesRoot,'main.tds'),path.join(layout.buildRoot,'main.nsp.json'),{projectRoot:project}),/Package output escaped|作品フォルダー外/);
  await assert.rejects(fs.access(path.join(outside,'pixel.png')));
});

test('arbitrary title: editor CRUD, assets, project build and CLI use the same project',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'novel-作品 空白-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const layout=projectLayout(dir);
  await fs.mkdir(path.join(layout.scenesRoot,'chapter'),{recursive:true});await fs.mkdir(layout.assetsRoot);
  await fs.copyFile(path.resolve(__dirname,'../native/engine_data/ui/dialogue_box.png'),path.join(layout.assetsRoot,'pixel.png'));
  await fs.copyFile(path.join(layout.assetsRoot,'pixel.png'),path.join(layout.assetsRoot,'video-placeholder.mp4'));
  const source='asset image logo = "asset/pixel.png"\nshow image logo center\ngoto chapter/next.tds';
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
  const listing=(await api('/api/files')).data;
  assert.equal(listing.title,path.basename(dir));
  assert.deepEqual(listing.files.filter(f=>!f.path.includes('/')).map(f=>f.path).sort(),['asset','senario']);
  assert.equal(listing.files.some(f=>f.path==='server.js'||f.path.startsWith('.novel')),false);
  assert.equal((await fetch(base+'/asset/pixel.png')).status,200);
  assert.equal((await api('/api/scene?name=main.tds')).data.source,source);
  const revisioned = (await api('/api/scene?name=main.tds')).data;
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),'say narrator "changed outside"');
  const conflict = await api('/api/scene','PUT',{name:'main.tds',source:'say narrator "stale editor"',expectedRevision:revisioned.revision});
  assert.equal(conflict.status,409);
  assert.equal(conflict.data.code,'SCENE_CONFLICT');
  assert.equal(await fs.readFile(path.join(layout.scenesRoot,'main.tds'),'utf8'),'say narrator "changed outside"');
  await fs.writeFile(path.join(layout.scenesRoot,'main.tds'),source);
  assert.equal((await api('/api/scene','PUT',{name:'senario/new.tds',source:'say "saved"'})).status,200);
  assert.equal(await fs.readFile(path.join(layout.scenesRoot,'new.tds'),'utf8'),'say "saved"');
  assert.equal((await api('/api/compile','POST',{name:'main.tds',source})).data.ok,true);
  const build=(await api('/api/project-build','POST',{name:'main.tds'})).data;assert.equal(build.ok,true,build.error);
  assert.equal(build.path,'.novel/build/main.nsp.json');
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
  await fs.rename(layout.scenesRoot,savedSceneRoot);
  await fs.symlink(externalDataRoot,layout.scenesRoot,'junction');
  try {
    const externalScenes=await api('/api/scenes');
    assert.equal(externalScenes.status,403,'scene enumeration must reject a scenario root junction outside the project');
    assert.equal(await fs.readFile(path.join(externalDataRoot,'external.tds'),'utf8'),'say narrator "must not be listed"');
  } finally {
    await fs.unlink(layout.scenesRoot);
    await fs.rename(savedSceneRoot,layout.scenesRoot);
  }
});
