'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');
const { Runtime } = require('../Edit/runtime');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-tds-title-'));
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    await fs.writeFile(path.join(project.scenesRoot, 'title.tds'), 'fn title() -> str { start()\nreturn "Native resumed after start" }\nscene main { say narrator title() }\n', 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
      version: 1, initial: 'title', titleScene: { file: 'title.tds', scene: 'title_front' }, screens: { title: { items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 0, y: 0, width: 100, height: 40 }] } },
    }), 'utf8');
    const packagePath = path.join(project.buildRoot, 'title.nsp.json');
    const packaged = await pack(path.join(project.scenesRoot, 'title.tds'), packagePath, { projectRoot: project.projectRoot });
    assert.equal(packaged.program.scenes[0].name, 'main');
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const result = spawnSync(exe, [packagePath, '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stdout.trim()).dialogue.text, 'Native resumed after start', 'automated native playback resumes after the explicit front-end intrinsic');

    await fs.writeFile(path.join(project.scenesRoot, 'interactive-main.tds'), 'global int marker = 7\nscene main {\n  start()\n  set marker = 1\n}\n', 'utf8');
    const interactivePackagePath = path.join(project.buildRoot, 'interactive-start.nsp.json');
    await pack(path.join(project.scenesRoot, 'interactive-main.tds'), interactivePackagePath, { projectRoot: project.projectRoot });
    const interactive = spawnSync(exe, [interactivePackagePath, '--start-runtime-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(interactive.status, 0, interactive.stderr || interactive.error?.message || interactive.stdout);
    assert.deepEqual(JSON.parse(interactive.stdout.trim()), {
      resumedAfterStart: true, activeScreen: '', storyActive: true, markerAtFirstStartScreen: 7, marker: 1,
    }, 'interactive Native start() must wait for the SDL Start click and then resume the same TDS program');

    const missingScreenData = JSON.parse(await fs.readFile(interactivePackagePath, 'utf8'));
    delete missingScreenData.native_ui.game_screens;
    const missingScreenPackage = path.join(project.buildRoot, 'missing-start-screen.nsp.json');
    await fs.writeFile(missingScreenPackage, JSON.stringify(missingScreenData), 'utf8');
    const missingScreen = spawnSync(exe, [missingScreenPackage, '--start-runtime-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.notEqual(missingScreen.status, 0, 'interactive start() must reject a package without game screen configuration');
    assert.match(missingScreen.stderr, /start\(\)を使うには開始画面を設定してください/, 'Native uses the same Japanese user-facing guidance as Browser');

    const resumeProject = seedEmptyProject(path.join(tempRoot, 'resume-project'));
    await fs.writeFile(path.join(resumeProject.scenesRoot, 'main.tds'), 'fn initialize() -> int {\n  start()\n  return 1\n}\nglobal int marker = initialize()\nscene main {\n  wait 1\n}\n', 'utf8');
    const resumePackage = path.join(resumeProject.buildRoot, 'resume.nsp.json');
    await pack(path.join(resumeProject.scenesRoot, 'main.tds'), resumePackage, { projectRoot: resumeProject.projectRoot, debug: true });
    const malformedResumePackage = path.join(resumeProject.buildRoot, 'malformed-resume.nsp.json');
    const malformedResume = JSON.parse(await fs.readFile(resumePackage, 'utf8'));
    const malformedStart = { kind: 'call', name: 'start', args: [{ kind: 'literal', value: 7 }] };
    const setMalformedInitializer = compiled => {
      const markerDeclaration = compiled.globals.find(declaration => declaration.name === 'marker');
      assert.ok(markerDeclaration, 'debug package contains the global initializer');
      markerDeclaration.initial = malformedStart;
    };
    setMalformedInitializer(malformedResume.program);
    setMalformedInitializer(malformedResume.files['main.tds']);
    await fs.writeFile(malformedResumePackage, JSON.stringify(malformedResume), 'utf8');
    await assert.rejects(new Runtime().run(malformedResume.program, { scene: 'main' }), /start\(\)/, 'Browser rejects malformed start() even while resuming at a scene');
    const malformedResumeNative = spawnSync(exe, [malformedResumePackage, '--headless', '--debug-start', 'main.tds', 'main', '7', '{}'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.notEqual(malformedResumeNative.status, 0, 'Native rejects malformed start() even when startup calls are suppressed during resume');
    const resumed = spawnSync(exe, [resumePackage, '--debug-start', 'main.tds', 'main', '7', '{}'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.error?.message || 'Native resume replayed start() reached through a global initializer');

    const continueProject = seedEmptyProject(path.join(tempRoot, 'continue-project'));
    await fs.writeFile(path.join(continueProject.scenesRoot, 'main.tds'), 'global int marker = 0\nstart()\nscene main {\n  say narrator "fresh entry"\n}\nscene saved {\n  say narrator str(marker)\n}\n', 'utf8');
    await fs.writeFile(path.join(continueProject.settingsRoot, 'game-screens.json'), JSON.stringify({
      version: 1, initial: 'title', saveId: 'continue-smoke',
      screens: { title: { items: [
        { id: 'continue', type: 'button', label: 'Continue', action: 'continue', x: 0, y: 0, width: 100, height: 40 },
        { id: 'start', type: 'button', label: 'Start', action: 'start', x: 0, y: 50, width: 100, height: 40 },
      ] } },
    }), 'utf8');
    const continuePackage = path.join(continueProject.buildRoot, 'continue.nsp.json');
    await pack(path.join(continueProject.scenesRoot, 'main.tds'), continuePackage, { projectRoot: continueProject.projectRoot });
    const continueSaveDir = path.join(continueProject.buildRoot, 'saves');
    await fs.mkdir(continueSaveDir, { recursive: true });
    await fs.writeFile(path.join(continueSaveDir, 'slot-1.json'), JSON.stringify({
      version: 1, saveId: 'continue-smoke', file: 'main.tds', scene: 'saved', line: 7,
      variables: { marker: 42 }, locals: [], readonlyLocals: [], loopScopes: [], speaker: '', text: 'saved line',
    }), 'utf8');
    const continued = spawnSync(exe, [continuePackage, '--continue-runtime-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(continued.status, 0, continued.stderr || continued.error?.message || continued.stdout);
    assert.deepEqual(JSON.parse(continued.stdout.trim()), { restored: true, scene: 'saved', text: '42', marker: 42 },
      'Native Continue on the initial screen must transfer the queued save into the active Runtime and resume the saved TDS position');

    const transferProject = seedEmptyProject(path.join(tempRoot, 'transfer-project'));
    await fs.writeFile(path.join(transferProject.scenesRoot, 'main.tds'), 'global int score = 4\ngoto "next.tds"\n', 'utf8');
    await fs.writeFile(path.join(transferProject.scenesRoot, 'next.tds'), 'set score = score + 1\nsay narrator str(score)\n', 'utf8');
    const transferPackage = path.join(transferProject.buildRoot, 'transfer.nsp.json');
    await pack(path.join(transferProject.scenesRoot, 'main.tds'), transferPackage, { projectRoot: transferProject.projectRoot });
    const transferred = spawnSync(exe, [transferPackage, '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(transferred.status, 0, transferred.stderr || transferred.error?.message);
    assert.equal(JSON.parse(transferred.stdout.trim()).dialogue.text, '5', 'Native keeps entry-file global values through an external goto and executes the destination update');
    console.log('PASS Native start and global transfer: entry, debug resume, and external goto');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
