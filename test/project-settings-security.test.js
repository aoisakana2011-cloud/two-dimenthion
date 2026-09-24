const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('project settings API rejects a setting.txt hard link to an external file', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-setting-link-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const project = path.join(parent, 'project');
  const outside = path.join(parent, 'external-setting.txt');
  await fs.mkdir(project);
  const original = 'scenario_dir = senario\nasset_dir = asset\nstart_file = main.tds\ntitle = External setting\n';
  await fs.writeFile(outside, original);
  const settingFile = path.join(project, 'setting.txt');
  await fs.writeFile(settingFile, original);

  const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', project], {
    env: { ...process.env, PORT: '0', HOME: parent, USERPROFILE: parent },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server timeout: ${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
  });

  await fs.unlink(settingFile);
  await fs.link(outside, settingFile);

  const response = await fetch(`${base}/api/project/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Changed from editor' }),
  });
  assert.equal(response.status, 400, 'the editor must reject a setting file outside its project root');
  assert.equal(await fs.readFile(outside, 'utf8'), original, 'the external setting file must remain unchanged');
});
