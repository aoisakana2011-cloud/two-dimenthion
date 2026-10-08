'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inflateSync } = require('node:zlib');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

function decodeRgbPng(buffer) {
  let width = 0, height = 0, channels = 0; const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); channels = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') chunks.push(data); if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source++], row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0, above = y ? pixels[row - stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[row - stride + x - channels] : 0, value = raw[source++];
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[row + x] = (value + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel native save-load 日本語 - '));
  const isolatedSaveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel native save root 日本語 - '));
  const defaultSaveId = `audit_${process.pid}_${Date.now()}`;
  let defaultSaveDirectory = '';
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    const unrelatedWorkingDirectory = path.join(tempRoot, 'unrelated working directory');
    await fs.mkdir(unrelatedWorkingDirectory);
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
      'include "helper.tds" as helper',
      'global int counter = 0',
      'global float restored_bgm_volume = runtime.state.audio.volume("bgm")',
      'global float restored_dialog_opacity = runtime.state.ui.dialog_opacity()',
      'scene main {',
      '  set counter = counter + 1',
      '  helper.checkpoint()',
      '  for iteration from 1 to 1 {',
      '    say narrator "loop save boundary"',
      '  }',
      '  choice "continue?" {',
      '    "yes" {',
      '      int local_counter = 7',
      '      say narrator "checkpoint"',
      '      set local_counter = local_counter + 1',
      '      say narrator str(local_counter)',
      '      say narrator str(restored_bgm_volume) + ":" + str(restored_dialog_opacity)',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(project.scenesRoot, 'helper.tds'), [
      'fn checkpoint() -> none {',
      '  say narrator "helper checkpoint"',
      '}',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
      version: 1, initial: 'title', saveId: defaultSaveId,
      screens: { title: { title: 'Test', items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 30, y: 30, width: 180, height: 48 }] } },
    }), 'utf8');
    const packagePath = path.join(project.buildRoot, 'main.nsp.json');
    await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    const saves = path.join(path.dirname(packagePath), 'saves');
    await fs.mkdir(saves, { recursive: true });
    await fs.writeFile(path.join(saves, 'slot-1.json'), JSON.stringify({
      version: 1, saveId: '', file: 'main.tds', scene: 'main', line: 11,
      variables: { counter: 1 }, locals: [{ local_counter: 7 }], readonlyLocals: [[]], loopScopes: [], speaker: '', text: 'checkpoint',
      presentation: { logicalTimeMs: 0, background: null, characters: [], images: [], bgm: null, effect: null,
        audio: { volumes: { bgm: 0.9, se: 0.8, voice: 0.5 }, volumeOverrides: { bgm: 0.24 } }, ui: { dialogOpacity: 0.42 } },
    }), 'utf8');
    const legacyThumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=', 'base64');
    const legacyThumbnailPath = path.join(saves, 'thumb-slot-1.png');
    await fs.writeFile(legacyThumbnailPath, legacyThumbnail);
    const conflictingLegacyThumbnail = Buffer.from('older package thumbnail');
    await fs.writeFile(path.join(saves, 'thumb-slot-2.png'), conflictingLegacyThumbnail);
    const userSaveRoot = isolatedSaveRoot;
    const existingUserThumbnail = Buffer.from('keep the already migrated thumbnail');
    await fs.mkdir(userSaveRoot, { recursive: true });
    await fs.writeFile(path.join(userSaveRoot, 'thumb-slot-2.png'), existingUserThumbnail);
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const missingPackage = path.join(tempRoot, 'missing package 日本語.nsp.json');
    const missingPackageResult = spawnSync(exe, [missingPackage], { encoding: 'utf8', cwd: unrelatedWorkingDirectory, timeout: 15000 });
    assert.notEqual(missingPackageResult.status, 0, 'Native reports a missing package as a startup error');
    assert.ok(missingPackageResult.stderr.includes(missingPackage), `Native startup diagnostics preserve the full Unicode package path: ${missingPackageResult.stderr}`);
    const nativeWrapper = path.resolve(__dirname, '../tools/native.js');
    const relativePackageArgument = path.relative(unrelatedWorkingDirectory, packagePath);
    const result = spawnSync(process.execPath, [nativeWrapper, relativePackageArgument, '--load-slot', '1', '--smoke'], {
      encoding: 'utf8', cwd: unrelatedWorkingDirectory, timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: userSaveRoot },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    await fs.access(path.join(userSaveRoot, 'slot-1.json'));
    assert.deepEqual(await fs.readFile(path.join(userSaveRoot, 'thumb-slot-1.png')), legacyThumbnail,
      'Native migrates the legacy slot thumbnail beside its snapshot into the isolated user save root');
    assert.deepEqual(await fs.readFile(legacyThumbnailPath), legacyThumbnail,
      'Native keeps the package-side legacy thumbnail as a recovery source');
    assert.deepEqual(await fs.readFile(path.join(userSaveRoot, 'thumb-slot-2.png')), existingUserThumbnail,
      'Native migration does not overwrite a thumbnail already present in the user save root');
    assert.deepEqual(await fs.readFile(path.join(saves, 'thumb-slot-2.png')), conflictingLegacyThumbnail,
      'Native keeps the skipped package-side thumbnail unchanged');
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.dialogue, { speaker: '', text: '0.24:0.42' }, 'Native preserves saved channel volume and dialogue opacity while resuming the saved local scope and TDS line');
    if (process.platform === 'win32') {
      assert.ok(process.env.APPDATA, 'Windows exposes the roaming profile path used by SDL_GetPrefPath');
      defaultSaveDirectory = path.join(process.env.APPDATA, 'NovelScript', defaultSaveId);
      assert.equal(await fs.stat(defaultSaveDirectory).then(() => true, () => false), false, 'the unique default save directory does not exist before the runtime check');
      const defaultEnv = { ...process.env, SDL_AUDIODRIVER: 'dummy' };
      delete defaultEnv.NOVEL_SAVE_ROOT;
      delete defaultEnv.SDL_VIDEODRIVER;
      const defaultSave = spawnSync(exe, [packagePath, '--screen-save-smoke'], {
        encoding: 'utf8', timeout: 20000, cwd: unrelatedWorkingDirectory, env: defaultEnv,
      });
      assert.equal(defaultSave.status, 0, defaultSave.stderr || defaultSave.error?.message || defaultSave.stdout);
      assert.deepEqual(JSON.parse(defaultSave.stdout.trim()), { save: true, thumbnail: true, fullFrame: true, text: 'revised' });
      assert.ok((await fs.readFile(path.join(defaultSaveDirectory, 'slot-1.json'), 'utf8')).includes('revised'),
        'Windows Native saves under the SDL roaming profile path even when started from another working directory');
      assert.ok((await fs.readFile(path.join(defaultSaveDirectory, 'thumb-slot-1.png')).then(data => data.length)) > 100,
        'Windows Native writes the thumbnail beside the save in the default profile directory');
    }
    const noticeCapture = path.join(os.tmpdir(), `novel-save-boundary-notice-${process.pid}.png`);
    const boundary = spawnSync(exe, [packagePath, '--save-boundary-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: path.join(isolatedSaveRoot, 'boundary-saves'), NOVEL_SAVE_NOTICE_CAPTURE_PATH: noticeCapture },
    });
    assert.equal(boundary.status, 0, boundary.stderr || boundary.error?.message);
    assert.deepEqual(JSON.parse(boundary.stdout.trim()), { functionBoundaryChecked: true, loopBoundaryChecked: true }, 'Native rejects slot and quick-save while a helper or loop is executing and does not write either snapshot');
    const notice = decodeRgbPng(await fs.readFile(noticeCapture));
    await fs.rm(noticeCapture, { force: true });
    const noticePixel = (Math.floor(notice.height - 43) * notice.width + Math.floor(notice.width / 2)) * notice.channels;
    const noticeColor = [...notice.pixels.subarray(noticePixel, noticePixel + 3)];
    assert.ok(noticeColor[0] > noticeColor[1] * 1.4 && noticeColor[0] > noticeColor[2] * 1.2,
      `Native renders the save-boundary recovery notice over the story frame: ${JSON.stringify(noticeColor)}`);
    await fs.writeFile(path.join(isolatedSaveRoot, 'slot-2.json'), JSON.stringify({
      version: 1, saveId: '', file: 'main.tds', scene: 'not-a-scene', line: 7, variables: {},
    }), 'utf8');
    const invalidScene = spawnSync(exe, [packagePath, '--load-slot', '2', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: isolatedSaveRoot },
    });
    assert.notEqual(invalidScene.status, 0, 'Native rejects an invalid saved scene identifier');
    assert.match(invalidScene.stderr, /Save slot のデータ形式が正しくありません/);
    await fs.writeFile(path.join(isolatedSaveRoot, 'slot-6.json'), '{"version":1,"saveId":"","file":"main.tds","scene":"main","line":1.1e1,"variables":{"counter":1},"locals":[{"local_counter":7}],"readonlyLocals":[[]],"loopScopes":[]}', 'utf8');
    const integralFloatLine = spawnSync(exe, [packagePath, '--load-slot', '6', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: isolatedSaveRoot },
    });
    assert.equal(integralFloatLine.status, 0, integralFloatLine.stderr || integralFloatLine.error?.message || 'Native accepts a finite integral JSON number for source line, matching Browser parsing');
    await fs.writeFile(path.join(isolatedSaveRoot, 'slot-7.json'), '{"version":1,"saveId":"","file":"main.tds","scene":"main","line":9007199254740992,"variables":{}}', 'utf8');
    const unsafeLine = spawnSync(exe, [packagePath, '--load-slot', '7', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: isolatedSaveRoot },
    });
    assert.notEqual(unsafeLine.status, 0, 'Native rejects source lines above JavaScript Number.MAX_SAFE_INTEGER, matching Browser loadability');
    await fs.writeFile(path.join(isolatedSaveRoot, 'slot-3.json'), JSON.stringify({
      version: 1, saveId: '', file: 'main.tds', scene: 'main', line: 11, variables: { counter: 1 },
      locals: [{ local_counter: 7 }], readonlyLocals: [], loopScopes: [],
      presentation: { logicalTimeMs: 0, background: null, characters: [], images: [], bgm: null, effect: null,
        audio: { volumes: { bgm: 0.24, se: 0.8, voice: 0.5 }, volumeOverrides: {} }, ui: { dialogOpacity: 0.42 } },
    }), 'utf8');
    const malformedFrames = spawnSync(exe, [packagePath, '--load-slot', '3', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: isolatedSaveRoot },
    });
    assert.notEqual(malformedFrames.status, 0, 'Native CLI rejects malformed readonly frame metadata before runtime restore');
    assert.match(malformedFrames.stderr, /Save slot のデータ形式が正しくありません/);
    await fs.writeFile(path.join(isolatedSaveRoot, 'slot-5.json'), JSON.stringify({
      version: 1, saveId: '', file: 'main.tds', scene: 'main', line: 11, variables: { counter: 1 },
      locals: [{}], readonlyLocals: [[]], loopScopes: [9],
    }), 'utf8');
    const invalidLoopScope = spawnSync(exe, [packagePath, '--load-slot', '5', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: isolatedSaveRoot },
    });
    assert.notEqual(invalidLoopScope.status, 0, 'Native rejects loop scope indexes that do not refer to a saved local frame');
    assert.match(invalidLoopScope.stderr, /Save slot のデータ形式が正しくありません/);
    await fs.writeFile(path.join(isolatedSaveRoot, 'slot-4.json'), JSON.stringify({
      version: 1, saveId: '', file: 'main.tds', scene: 'main', line: 11, variables: { counter: 1 },
      locals: [{ local_counter: 7 }], readonlyLocals: [[]], loopScopes: [],
      presentation: { logicalTimeMs: 0, background: null, characters: [], images: [], bgm: null, effect: null },
    }), 'utf8');
    const legacyPresentation = spawnSync(exe, [packagePath, '--load-slot', '4', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: isolatedSaveRoot },
    });
    assert.equal(legacyPresentation.status, 0, legacyPresentation.stderr || legacyPresentation.error?.message);
    assert.deepEqual(JSON.parse(legacyPresentation.stdout.trim()).dialogue, { speaker: '', text: '1:1' }, 'Native fills presentation fields omitted by legacy snapshots from project defaults');
    console.log('PASS native save data load: globals, local scope and TDS cursor restoration');
  } finally {
    if (defaultSaveDirectory && process.env.APPDATA
        && path.dirname(path.dirname(defaultSaveDirectory)) === path.resolve(process.env.APPDATA)
        && path.basename(defaultSaveDirectory) === defaultSaveId) {
      await fs.rm(defaultSaveDirectory, { recursive: true, force: true });
    }
    await fs.rm(isolatedSaveRoot, { recursive: true, force: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
