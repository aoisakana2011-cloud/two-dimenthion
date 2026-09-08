const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, compile, analyzeScript } = require('../dist');
const { Runtime } = require('../Edit/runtime');
const { pack } = require('../tools/pack');
const cases = require('./fixtures/audit-cases.json');

const invalid = {
  dictionary_mixed: /辞書.*型/, const_unset: /const/, const_branch: /const/,
  recursion_say: /再帰/, finite_while_return: /値を返/, struct_return: /struct.*初期値/,
};
const expected = {
  loop: {x:3,hits:1}, condition_effect:{x:1,result:1}, argument_effect:{x:1,result:1},
  dictionary_alias:{a:{x:1},b:{x:2},result:1}, dictionary_parameter:{a:{x:1},result:1},
  dictionary_empty:{a:{}}, dictionary_side_effect:{d:{x:1,y:9}},
  const_alias:{a:{x:1},b:{x:2}}, reachable_return:{result:2},
  newline_character:{hero:{name:'Hero'}}, newline_struct:{}, say_expression:{message:'hello'},
  const_shadow:{x:1,result:2}, include_global:{x:1}, include_order:{x:1,result:1},
};
const normalized = value => JSON.parse(JSON.stringify(value, (_,v) => typeof v === 'bigint' ? Number(v) : v));
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'novel-audit-regression-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  return dir;
}
async function native(t, data) {
  const exe=process.env.NOVEL_NATIVE_EXE;
  if (!exe) return null;
  const dir=await temporary(t), file=path.join(dir,'game.nsp.json');
  await fs.writeFile(file,JSON.stringify(data));
  return spawnSync(exe,[file,'--headless'],{encoding:'utf8',timeout:10000});
}
for (const [id, item] of Object.entries(cases)) test(`audit: ${id}`,async t => {
  if (invalid[id]) { assert.throws(()=>compile(parse(item.source)),invalid[id]); return; }
  let data;
  if (item.files) {
    const dir=await temporary(t), scenesRoot=path.join(dir,'scenes'),assetsRoot=path.join(dir,'assets');
    await fs.mkdir(scenesRoot);await fs.mkdir(assetsRoot);
    for(const [file,source] of Object.entries(item.files))await fs.writeFile(path.join(scenesRoot,file),source);
    const build=()=>pack(path.join(scenesRoot,'main.tds'),path.join(dir,'game.nsp.json'),{scenesRoot,assetsRoot});
    if(['init_call','init_after_goto','external_const'].includes(id)) {
      await assert.rejects(build(),id==='external_const'?/const/:/初期化前.*x/);return;
    }
    data=await build();
  } else {
    data={format:'novel-script-package',version:1,program:JSON.parse(JSON.stringify(compile(parse(item.source))))};
    if(id==='goto_hyphen')data.files={'chapter-1.tds':JSON.parse(JSON.stringify(compile(parse('int result = 7'))))};
  }
  const commands=[];
  const rt=new Runtime({command:async(name,args)=>commands.push({name,args}),choice:async()=>0,load:async name=>data.files[name]});
  if(id==='conversion')await assert.rejects(rt.run(data.program),/変換/);
  else {
    await rt.run(data.program);
    assert.deepEqual(normalized(rt.globals),id==='goto_hyphen'?{result:7}:expected[id]);
    if(id==='say_expression')assert.equal(commands[0].args[1],'hello!');
  }
  const child=await native(t,data);
  if(child) {
    if(id==='conversion') { assert.equal(child.status,1);assert.match(child.stderr,/conversion/); }
    else { assert.equal(child.status,0,child.stderr||child.error?.message);assert.deepEqual(JSON.parse(child.stdout).globals,normalized(rt.globals)); }
  }
});

test('audit: loop conditions remain dynamic and finite loops preserve following code',async()=>{
  const source='int hits = 0\nfn f() -> int {\nint x = 0\nfor i from 0 to 2 {\nif x == 0 { set hits = hits + 1 }\nset x = x + 1\n}\nwhile x < 4 { set x = x + 1 }\nreturn x\n}\nint result = f()';
  const diagnostics=analyzeScript(parse(source));
  assert.equal(diagnostics.some(d=>d.code==='infinite-loop'||d.code==='unreachable-code'),false);
  const rt=new Runtime();await rt.run(compile(parse(source)));
  assert.equal(rt.get('hits'),1n);assert.equal(rt.get('result'),4n);
});

test('audit: recursion in unset keys is rejected',()=>{
  assert.throws(()=>compile(parse('dict[int] d = {"x":1}\nfn f() -> str { unset d[f()]\nreturn "x" }')),/再帰/);
});

test('audit: empty and mixed dictionaries are checked in assignments, arguments and returns',()=>{
  assert.doesNotThrow(()=>compile(parse('dict[str] d = {}\nset d = {}\nfn f(x: dict[str]) -> dict[str] { return {} }\nset d = f({})')));
  assert.throws(()=>compile(parse('fn f(x: dict[str]) -> none {}\nf({"x":1,"y":"s"})')),/辞書.*型/);
});

test('audit: alternative block brace placement remains accepted',()=>{
  assert.doesNotThrow(()=>compile(parse('character hero\n{\nname = "Hero"\n}\nstruct Person\n{\nname: str\n}\nchoice "choose"\n{\n"ok" { say\n{\n"hello"\n} }\n}')));
  assert.doesNotThrow(()=>compile(parse('character hero { name = "Hero" }\nsay hero\n{\n"hello"\n}\nsay hero ("hello")')));
});

test('audit: includes retain functions on external transfers and initialize dependencies first',async t=>{
  const dir=await temporary(t), scenesRoot=path.join(dir,'scenes'),assetsRoot=path.join(dir,'assets');
  await fs.mkdir(scenesRoot);await fs.mkdir(assetsRoot);
  const files={
    'main.tds':'goto next.tds',
    'next.tds':'include common.tds\nint result = read_value()',
    'common.tds':'int value = 8\nfn read_value() -> int { return value }',
  };
  for(const [name,source] of Object.entries(files))await fs.writeFile(path.join(scenesRoot,name),source);
  const data=await pack(path.join(scenesRoot,'main.tds'),path.join(dir,'game.nsp.json'),{scenesRoot,assetsRoot});
  const rt=new Runtime({load:async name=>data.files[name]});await rt.run(data.program);assert.equal(rt.get('result'),8n);
  const child=await native(t,data);if(child){assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).globals.result,8);}
});

test('audit: flow skips dead loops and short-circuited reads but rejects live function reads',async t=>{
  const dir=await temporary(t), scenesRoot=path.join(dir,'scenes'),assetsRoot=path.join(dir,'assets');
  await fs.mkdir(scenesRoot);await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot,'later.tds'),'int later = 1');
  await fs.writeFile(path.join(scenesRoot,'main.tds'),'while 1 == 2 { say narrator str(later) }\nif 1 == 2 and later == 1 { wait 1 }');
  await pack(path.join(scenesRoot,'main.tds'),path.join(dir,'game.nsp.json'),{scenesRoot,assetsRoot});
  await fs.writeFile(path.join(scenesRoot,'main.tds'),'fn read_later() -> int { return later }\nint result = read_later()');
  await assert.rejects(pack(path.join(scenesRoot,'main.tds'),path.join(dir,'game.nsp.json'),{scenesRoot,assetsRoot}),/初期化前.*later/);
  await fs.writeFile(path.join(scenesRoot,'main.tds'),'fn f() -> int {\nfor i from 1 to 2 { int value = i }\nreturn value\n}\nint result = f()');
  const data = await pack(path.join(scenesRoot,'main.tds'),path.join(dir,'game.nsp.json'),{scenesRoot,assetsRoot});
  const rt = new Runtime(); await rt.run(data.program); assert.equal(rt.get('result'),2n);
});
