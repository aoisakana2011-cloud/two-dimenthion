'use strict';

const path = require('node:path');

function createProjectLockFs(fs, ownerToken) {
  const ownerFile = (directory) => path.join(directory, '.novel-editor-owner');
  const isReclaimedDirectory = (directory) => path.basename(directory).includes('.reclaim-');

  function removeOwnedDirectory(directory, callback) {
    if (isReclaimedDirectory(directory)) {
      fs.unlink(ownerFile(directory), (error) => {
        if (error && error.code !== 'ENOENT') return callback(error);
        fs.rmdir(directory, callback);
      });
      return;
    }
    fs.readFile(ownerFile(directory), 'utf8', (error, owner) => {
      if (error || owner !== ownerToken) return callback();
      fs.unlink(ownerFile(directory), (unlinkError) => {
        if (unlinkError && unlinkError.code !== 'ENOENT') return callback(unlinkError);
        fs.rmdir(directory, callback);
      });
    });
  }

  function removeOwnedDirectorySync(directory) {
    if (!isReclaimedDirectory(directory)) {
      try {
        if (fs.readFileSync(ownerFile(directory), 'utf8') !== ownerToken) return;
      } catch { return; }
    }
    try { fs.unlinkSync(ownerFile(directory)); }
    catch (error) { if (error.code !== 'ENOENT') return; }
    try { fs.rmdirSync(directory); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
  }

  return Object.assign(Object.create(fs), {
    mkdir(directory, callback) {
      fs.mkdir(directory, (error) => {
        if (error) return callback(error);
        fs.writeFile(ownerFile(directory), ownerToken, {flag: 'wx'}, (writeError) => {
          if (!writeError) return callback();
          fs.rmdir(directory, () => callback(writeError));
        });
      });
    },
    rmdir: removeOwnedDirectory,
    rmdirSync: removeOwnedDirectorySync,
  });
}

module.exports = {createProjectLockFs};
