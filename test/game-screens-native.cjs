'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-game-screens-native-'));
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    const imagePath = path.join(project.assetsRoot, 'bg', 'museum-night.png');
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/museum-night.png'), imagePath);
    const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/asset/ui/game-screens.json'), 'utf8'));
    await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
    await fs.writeFile(path.join(project.assetsRoot, 'ui', 'game-screens.json'), JSON.stringify(config, null, 2));
    const packagePath = path.join(project.buildRoot, 'main.nsp.json');
    const packaged = await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    assert.equal(packaged.native_ui.game_screens, 'ui/game-screens.json');
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'bg', 'museum-night.png'));
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const smoke = spawnSync(exe, [packagePath, '--screen-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.error?.message);
    console.log('PASS native game screen package: title/menu descriptions and background render');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
