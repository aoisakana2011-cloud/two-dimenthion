'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-tds-title-'));
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    await fs.writeFile(path.join(project.scenesRoot, 'title.tds'), 'scene after_title { say narrator "wrong entry" }\nscene title_front { say narrator "TDS title" }\n', 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
      version: 1, initial: 'title', titleScene: { file: 'title.tds', scene: 'title_front' }, screens: { title: { items: [] } },
    }), 'utf8');
    const packagePath = path.join(project.buildRoot, 'title.nsp.json');
    const packaged = await pack(path.join(project.scenesRoot, 'title.tds'), packagePath, { projectRoot: project.projectRoot });
    assert.equal(packaged.program.scenes[0].name, 'title_front');
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const result = spawnSync(exe, [packagePath, '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stdout.trim()).dialogue.text, 'TDS title', 'native playback enters the configured scene without showing the JSON title overlay first');
    console.log('PASS native TDS title: package entry, scene selection and pre-story screen bypass');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
