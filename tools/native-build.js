'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'native');
const toolchain = path.join(native, '.vcpkg', 'scripts', 'buildsystems', 'vcpkg.cmake');
const configure = spawnSync('cmake', ['-S', native, '-B', path.join(native, 'build'), `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, `-DVCPKG_INSTALLED_DIR=${path.join(native, 'vcpkg_installed')}`, '-DVCPKG_TARGET_TRIPLET=x64-windows'], { stdio: 'inherit' });
if (configure.status !== 0) process.exitCode = configure.status || 1;
else {
  const build = spawnSync('cmake', ['--build', path.join(native, 'build'), '--config', 'Release'], { stdio: 'inherit' });
  process.exitCode = build.status || 0;
}
