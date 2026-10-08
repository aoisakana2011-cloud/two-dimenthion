'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

test('Native CLI forwards flags without mistaking their operands for package paths', async t => {
  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch (error) {
    if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) return t.skip('Native player is not built');
    throw error;
  }
  const usage = spawnSync(executable, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--headless\|--smoke.*--load-slot.*--debug-state/);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel native cli project - '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = seedEmptyProject(root);
  const sourceFile = path.join(layout.scenesRoot, 'main.tds');
  await fs.writeFile(sourceFile, 'global int marker = 1\nscene main {\n  say narrator "cli-ok"\n}\n', 'utf8');
  const packagePath = path.join(layout.buildRoot, 'main.nsp.json');
  await pack(sourceFile, packagePath, { projectRoot: root, debug: true });

  const wrapper = path.resolve(__dirname, '../tools/native.js');
  const defaultPackage = spawnSync(process.execPath, [wrapper, '--project', root, '--headless'], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(defaultPackage.status, 0, defaultPackage.stderr || defaultPackage.error?.message);
  assert.equal(JSON.parse(defaultPackage.stdout).globals.marker, 1);

  const debugStart = spawnSync(process.execPath, [wrapper, '--project', root, '--debug-start', 'main.tds', 'main', '3', '{}', '--headless'], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(debugStart.status, 0, debugStart.stderr || debugStart.error?.message);
  assert.deepEqual(JSON.parse(debugStart.stdout).commands.map(command => command.args[1]), ['cli-ok']);

  const explicitPackage = spawnSync(process.execPath, [wrapper, '--project', root, '--headless', packagePath], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(explicitPackage.status, 0, explicitPackage.stderr || explicitPackage.error?.message);
  assert.equal(JSON.parse(explicitPackage.stdout).globals.marker, 1);

  const invalidPackagePath = path.join(root, 'invalid package.nsp.json');
  await fs.writeFile(invalidPackagePath, '{ invalid json', 'utf8');
  const playerFailure = spawnSync(process.execPath, [wrapper, '--project', root, invalidPackagePath, '--headless'], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(playerFailure.status, 1, playerFailure.stderr || playerFailure.error?.message);
  assert.match(playerFailure.stderr, /Player error/);

  const validPackage = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const missingMetadataPath = path.join(root, 'missing-metadata.nsp.json');
  const { source: _source, files: _files, native_ui: _nativeUi, ...programOnly } = validPackage;
  await fs.writeFile(missingMetadataPath, JSON.stringify(programOnly), 'utf8');
  const missingMetadata = spawnSync(executable, [missingMetadataPath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(missingMetadata.status, 1);
  assert.match(missingMetadata.stderr, /Package source/);

  const missingNativeUiPath = path.join(root, 'missing-native-ui.nsp.json');
  const { native_ui: _omittedNativeUi, ...withoutNativeUi } = validPackage;
  await fs.writeFile(missingNativeUiPath, JSON.stringify(withoutNativeUi), 'utf8');
  const missingNativeUi = spawnSync(executable, [missingNativeUiPath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(missingNativeUi.status, 1);
  assert.match(missingNativeUi.stderr, /Package native_ui/);

  const mismatchedSourcePath = path.join(root, 'mismatched-source.nsp.json');
  await fs.writeFile(mismatchedSourcePath, JSON.stringify({ ...validPackage, source: 'other.tds' }), 'utf8');
  const mismatchedSource = spawnSync(executable, [mismatchedSourcePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(mismatchedSource.status, 1);
  assert.match(mismatchedSource.stderr, /Package filesにentry sourceがありません/);

  const malformedFilesPath = path.join(root, 'malformed-files.nsp.json');
  await fs.writeFile(malformedFilesPath, JSON.stringify({ ...validPackage, files: [] }), 'utf8');
  const malformedFiles = spawnSync(executable, [malformedFilesPath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(malformedFiles.status, 1);
  assert.match(malformedFiles.stderr, /Package filesはJSON object/);

  const malformedEntryPath = path.join(root, 'malformed-entry.nsp.json');
  await fs.writeFile(malformedEntryPath, JSON.stringify({
    ...validPackage, program: { ...validPackage.program, scenes: {} },
  }), 'utf8');
  const malformedEntry = spawnSync(executable, [malformedEntryPath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(malformedEntry.status, 1);
  assert.match(malformedEntry.stderr, /Package program\.scenes はJSON array/);
});
