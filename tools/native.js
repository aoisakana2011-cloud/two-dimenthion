'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { projectLayout, projectOption, entryFile } = require('./project-layout');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const layout = projectLayout(projectOption(args));
const entry = entryFile(layout);
const forwarded = [];
let requestedPackage = null;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--project') { index++; continue; }
  if (argument === '--debug-start') {
    forwarded.push(argument, ...args.slice(index + 1, index + 5));
    index += 4;
    continue;
  }
  if (argument === '--load-slot' || argument === '--debug-state') {
    forwarded.push(argument, args[index + 1]);
    index++;
    continue;
  }
  if (argument.startsWith('-')) {
    forwarded.push(argument);
    continue;
  }
  if (requestedPackage === null) requestedPackage = argument;
  else forwarded.push(argument);
}
const packagePath = path.resolve(requestedPackage
  || path.join(layout.buildRoot, path.basename(entry, path.extname(entry)) + '.nsp.json'));
const executable = path.join(root, 'native', 'build', 'Release', 'novel_player.exe');

if (!fs.existsSync(executable)) {
  console.error('Native Player not found. Run npm.cmd run native:build.');
  process.exitCode = 1;
} else if (!fs.existsSync(packagePath)) {
  console.error(`Package not found: ${path.relative(root, packagePath)}`);
  process.exitCode = 1;
} else {
  const child = spawn(executable, [packagePath, ...forwarded], { cwd: root, stdio: 'inherit' });
  child.on('error', (error) => {
    console.error(`Could not start Native Player: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
