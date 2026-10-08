'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const native = path.join(root, 'native');
const toolchain = path.join(native, '.vcpkg', 'scripts', 'buildsystems', 'vcpkg.cmake');
function finish(result, stage) {
  if (result.error) {
    console.error(`Could not start CMake during ${stage}: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  } else {
    process.exitCode = 0;
  }
}
const configure = spawnSync('cmake', ['-S', native, '-B', path.join(native, 'build'), `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, `-DVCPKG_INSTALLED_DIR=${path.join(native, 'vcpkg_installed')}`, '-DVCPKG_TARGET_TRIPLET=x64-windows'], { stdio: 'inherit' });
if (configure.status !== 0) finish(configure, 'configure');
else {
  const build = spawnSync('cmake', ['--build', path.join(native, 'build'), '--config', 'Release'], { stdio: 'inherit' });
  finish(build, 'build');
}
