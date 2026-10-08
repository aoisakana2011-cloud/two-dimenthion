const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { seedEmptyProject } = require('../tools/project-layout');

function getRawPath(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('malformed percent-encoded asset paths return a client error without a server error', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-path-encoding-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  seedEmptyProject(project);
  const child = spawn(process.execPath, [path.resolve(__dirname, '../Edit/server.js'), '--project', project], {
    env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await done;
    }
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`server startup timed out: ${stderr}`)), 10000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${stderr}`)); });
  });

  for (const pathname of ['/asset/%ZZ', '/asset/%E0%A4%A']) {
    const response = await getRawPath(port, pathname);
    assert.equal(response.status, 400, `${pathname} should be a malformed client path: ${response.body}`);
    assert.match(response.body, /asset pathのpercent-encoding/);
    assert.doesNotMatch(response.body, /URIError|Internal Server Error/);
  }
  assert.equal(stderr, '', 'malformed client paths should not be logged as server errors');
});
