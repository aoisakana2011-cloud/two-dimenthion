const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn,spawnSync} = require('node:child_process');
const {projectLayout,layoutForInput,entryFile} = require('../tools/project-layout');

test('arbitrary title: editor CRUD, assets, project build and CLI use the same project',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'novel-作品 空白-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const layout=projectLayout(dir);
  await fs.mkdir(path.join(layout.scenesRoot,'chapter'),{recursive:true});await fs.mkdir(layout.assetsRoot);
  await fs.copyFile(path.resolve(__dirname,'../native/engine_data/ui/dialogue_box.png'),path.join(layout.assetsRoot,'pixel.png'));
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
  assert.equal((await api('/api/scene','PUT',{name:'senario/new.tds',source:'say "saved"'})).status,200);
  assert.equal(await fs.readFile(path.join(layout.scenesRoot,'new.tds'),'utf8'),'say "saved"');
  assert.equal((await api('/api/compile','POST',{name:'main.tds',source})).data.ok,true);
  const build=(await api('/api/project-build','POST',{name:'main.tds'})).data;assert.equal(build.ok,true,build.error);
  assert.equal(build.path,'.novel/build/main.nsp.json');
  await fs.access(path.join(layout.buildRoot,'asset/pixel.png'));
  await fs.access(path.join(layout.dataRoot,'assets.schema.json'));
  assert.equal((await api('/api/file','DELETE',{path:'senario/new.tds'})).data.ok,true);
  await assert.rejects(fs.access(path.join(layout.scenesRoot,'new.tds')));
  for(const name of ['scenes','assets','Edit'])await assert.rejects(fs.access(path.join(dir,name)));
  const cli=spawnSync(process.execPath,[path.resolve(__dirname,'../tools/pack.js'),'--project',dir],{encoding:'utf8',timeout:10000});assert.equal(cli.status,0,cli.stderr);
  assert.equal(entryFile(layout),path.join(layout.scenesRoot,'main.tds'));
  if(process.env.NOVEL_NATIVE_EXE){const result=spawnSync(process.env.NOVEL_NATIVE_EXE,[path.join(layout.buildRoot,'main.nsp.json'),'--smoke'],{encoding:'utf8',timeout:10000,env:{...process.env,SDL_VIDEODRIVER:'dummy',SDL_AUDIODRIVER:'dummy'}});assert.equal(result.status,0,result.stderr);}
});
