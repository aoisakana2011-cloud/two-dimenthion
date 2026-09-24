'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.NOVEL_EDITOR_PACKAGE_OUT || path.join(root, 'release'));
const packageInfo = require('../package.json');
const nativePlayer = path.join(root, 'native', 'build', 'Release', 'novel_player.exe');

function ignorePath(filePath) {
  const resolvedPath = path.resolve(filePath);
  const rootPrefix = `${root}${path.sep}`;
  const isInsideRoot = resolvedPath === root || resolvedPath.toLowerCase().startsWith(rootPrefix.toLowerCase());
  const relative = (isInsideRoot ? path.relative(root, resolvedPath) : filePath.replace(/^[\\/]+/, ''))
    .replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../')) return false;

  const excludedRoots = ['.git', 'node_modules', 'release', 'build', 'test', 'src', 'llama.cpp', 'Title'];
  if (excludedRoots.some((name) => relative === name || relative.startsWith(`${name}/`))) return true;

  if (relative === 'native' || relative === 'native/build' || relative === 'native/build/Release') return false;
  if (relative.startsWith('native/build/Release/')) {
    // Keep the prebuilt player, DLLs, image checker, and engine_data together.
    // Windows resolves the runtime DLLs beside the distributed executable.
    return false;
  }
  if (relative.startsWith('native/')) return true;

  return relative === 'package-lock.json' || relative === 'npm-shrinkwrap.json';
}

async function main() {
  if (!fs.existsSync(nativePlayer)) {
    throw new Error('Native player not found. Run npm.cmd run native:build first.');
  }

  const appPaths = await packager({
    dir: root,
    out: output,
    name: 'Novel Script Editor',
    executableName: 'NovelScriptEditor',
    platform: 'win32',
    arch: 'x64',
    appVersion: packageInfo.version,
    icon: path.join(root, 'Edit', 'assets', 'desktop-icon.ico'),
    asar: false,
    prune: true,
    overwrite: true,
    ignore: ignorePath,
    win32metadata: {
      CompanyName: 'Novel Script',
      FileDescription: 'Novel Script Editor',
      ProductName: 'Novel Script Editor',
      InternalName: 'NovelScriptEditor',
    },
  });

  console.log(`Windows editor package created: ${path.join(appPaths[0], 'NovelScriptEditor.exe')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
