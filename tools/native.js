'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { projectLayout, projectOption, entryFile, positionalArguments } = require('./project-layout');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const layout = projectLayout(projectOption(args));
const entry = entryFile(layout);
const requestedPackage = positionalArguments(args)[0];
const packagePath = path.resolve(requestedPackage
  || path.join(layout.buildRoot, path.basename(entry, path.extname(entry)) + '.nsp.json'));
const executable = path.join(root, 'native', 'build', 'Release', 'novel_player.exe');

if (!fs.existsSync(executable)) {
  console.error('ネイティブプレイヤーが見つかりません。npm.cmd run native:build を実行してください。');
  process.exitCode = 1;
} else if (!fs.existsSync(packagePath)) {
  console.error(`パッケージが見つかりません: ${path.relative(root, packagePath)}`);
  process.exitCode = 1;
} else {
  let skippedPackage = !requestedPackage;
  const forwarded = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--project') { index++; continue; }
    if (!skippedPackage && args[index] === requestedPackage) { skippedPackage = true; continue; }
    forwarded.push(args[index]);
  }
  const child = spawn(executable, [packagePath, ...forwarded], { cwd: root, stdio: 'inherit' });
  child.on('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
