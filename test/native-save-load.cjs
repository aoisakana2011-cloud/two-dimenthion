'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-save-load-'));
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
      'global int counter = 0',
      'scene main {',
      '  set counter = counter + 1',
      '  choice "continue?" {',
      '    "yes" {',
      '      int local_counter = 7',
      '      say narrator "checkpoint"',
      '      set local_counter = local_counter + 1',
      '      say narrator str(local_counter)',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf8');
    const packagePath = path.join(project.buildRoot, 'main.nsp.json');
    await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    const saves = path.join(path.dirname(packagePath), 'saves');
    await fs.mkdir(saves, { recursive: true });
    await fs.writeFile(path.join(saves, 'slot-1.json'), JSON.stringify({
      version: 1, file: 'main.tds', scene: 'main', line: 7,
      variables: { counter: 1 }, locals: [{ local_counter: 7 }], readonlyLocals: [[]], loopScopes: [], speaker: '', text: 'checkpoint',
      presentation: { logicalTimeMs: 0, background: null, characters: [], images: [], bgm: null, effect: null },
    }), 'utf8');
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const result = spawnSync(exe, [packagePath, '--load-slot', '1', '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy', NOVEL_SAVE_ROOT: path.join(tempRoot, 'user-saves') },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    await fs.access(path.join(tempRoot, 'user-saves', 'slot-1.json'));
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.dialogue, { speaker: '', text: '8' }, 'Native restores choice-local scope and resumes at the saved TDS line');
    console.log('PASS native save data load: globals, local scope and TDS cursor restoration');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
