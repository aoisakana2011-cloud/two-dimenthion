'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { format } = require('../shared/formatter');

async function collect(input) {
  const resolved = path.resolve(input);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) return /\.(?:tds|txt)$/i.test(resolved) ? [resolved] : [];
  if (!stat.isDirectory()) return [];
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && /\.(?:tds|txt)$/i.test(entry.name)) files.push(child);
    }
  }
  await visit(resolved);
  return files;
}

async function formatFiles(inputs) {
  const files = [...new Set((await Promise.all(inputs.map(collect))).flat())].sort();
  const changed = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const formatted = format(source);
    if (formatted === source) continue;
    await fs.writeFile(file, formatted, 'utf8');
    changed.push(file);
  }
  return { files, changed };
}

if (require.main === module) {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error('Usage: node tools/format.js <scenario file or directory> [...]');
    process.exitCode = 2;
  } else {
    formatFiles(inputs).then(({ files, changed }) => {
      console.log(`Formatted scene files: ${changed.length}/${files.length} changed`);
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

module.exports = { formatFiles };
