'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const root = path.resolve(__dirname, '..');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-api-origin-'));
  const first = seedEmptyProject(path.join(temporary, 'first'));
  const second = seedEmptyProject(path.join(temporary, 'second'));
  const server = spawn(process.execPath, [path.join(root, 'Edit/server.js'), '--project', first.projectRoot], {
    cwd: root,
    env: { ...process.env, PORT: '0', NOVEL_EDITOR_RECENT_FILE: path.join(temporary, 'recent.json') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });
  const attacker = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Untrusted origin</title>'); });
  let browser;
  try {
    const target = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`editor server start timeout: ${output}`)), 15000);
      const poll = () => {
        const match = output.match(/Novel Script Editor:\s*(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
        else if (server.exitCode !== null) { clearTimeout(timer); reject(Error(`editor server exited: ${output}`)); }
        else setTimeout(poll, 20);
      };
      poll();
    });
    const attackerOrigin = await new Promise((resolve, reject) => {
      attacker.once('error', reject);
      attacker.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${attacker.address().port}`));
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    await page.goto(attackerOrigin);
    const fetchResult = await page.evaluate(async ({ target, projectRoot }) => {
      try {
        const response = await fetch(`${target}/api/project/open`, {
          method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ path: projectRoot }),
        });
        return { completed: true, type: response.type };
      } catch (error) { return { completed: false, error: String(error) }; }
    }, { target, projectRoot: second.projectRoot });
    assert.equal(fetchResult.completed, true, 'the browser sent the simple cross-origin request');
    const current = await (await fetch(`${target}/api/project`)).json();
    assert.equal(current.projectRoot, first.projectRoot, 'cross-origin POST cannot switch the Editor project');
    const denied = await fetch(`${target}/api/project`, { headers: { Origin: attackerOrigin } });
    assert.equal(denied.status, 403, 'cross-origin read endpoints are rejected consistently');
    const spoofedHostStatus = await new Promise((resolve, reject) => {
      const request = http.request(new URL('/api/project', target), { headers: { Host: 'attacker.example' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject); request.end();
    });
    assert.equal(spoofedHostStatus, 403, 'DNS-rebinding style non-loopback Host headers are rejected');
    const sameSiteRequestStatus = await new Promise((resolve, reject) => {
      const request = http.request(new URL('/api/project', target), { headers: { 'Sec-Fetch-Site': 'same-site' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject); request.end();
    });
    assert.equal(sameSiteRequestStatus, 403, 'same-site but cross-origin browser fetches are rejected even when Origin is omitted');
    assert.equal((await (await fetch(`${target}/api/project`)).json()).projectRoot, first.projectRoot, 'requests without Origin remain available to local Editor/Native clients');
    console.log('PASS API origin boundary: cross-origin simple POST cannot switch projects; local requests remain available');
  } finally {
    await browser?.close();
    attacker.close();
    if (server.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true });
      else server.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
