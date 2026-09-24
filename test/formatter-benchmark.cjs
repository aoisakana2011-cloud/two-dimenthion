const assert = require('node:assert/strict');
const { format } = require('../shared/formatter');

const lines = [];
for (let index = 0; index < 12_000; index++) {
  lines.push(index % 6 === 0 ? `if ready${index % 3}{` : `say narrator "line ${index} {safe}"`);
  if (index % 6 === 5) lines.push('}');
}
const source = lines.join('\r\n');
const warmup = format(source);
assert.equal(format(warmup), warmup, 'benchmark input must remain idempotent');
const samples = [];
for (let index = 0; index < 7; index++) {
  const start = process.hrtime.bigint();
  const output = format(source);
  samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  assert.equal(output, warmup);
}
const sorted = [...samples].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.floor(sorted.length * 0.95)];
console.log(JSON.stringify({ lines: lines.length, bytes: Buffer.byteLength(source), samplesMs: samples.map((value) => Number(value.toFixed(2))), p50Ms: Number(p50.toFixed(2)), p95Ms: Number(p95.toFixed(2)) }));
