const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compile } = require('../dist');
const { Runtime } = require('../Edit/runtime');

function makeCase(seed) {
  const start = 1 + (seed % 4);
  const branchA = 2 + ((seed * 3) % 7);
  const branchB = 1 + ((seed * 5) % 6);
  const flag = seed % 2;
  const threshold = 8 + (seed % 8);
  const step = 1 + (seed % 3);
  const stop = seed % 4;
  const selected = seed % (stop + 1);
  const markerStart = seed % 3;

  let value = flag === 1 ? branchA : branchB;
  let marker = markerStart;
  while (value < threshold) {
    value += step;
    marker += 1;
  }
  for (let i = 0; i <= stop; i += 1) {
    if (i === selected) value += i + 1;
    else value += 1;
  }
  const expected = BigInt(value + marker);
  const source = `
    int marker = ${markerStart}
    fn bump() -> none { set marker = marker + 1 }
    fn compute(flag: int) -> int {
      int value = ${start}
      if flag == 1 {
        set value = ${branchA}
      } else {
        set value = ${branchB}
      }
      while value < ${threshold} {
        set value = value + ${step}
        bump()
      }
      for i from 0 to ${stop} {
        if i == ${selected} {
          set value = value + i + 1
        } else {
          set value = value + 1
        }
      }
      return value + marker
    }
    int result = compute(${flag})
  `;
  return { source, expected };
}

test('compiler differential corpus preserves generated branch and loop semantics', async () => {
  for (let seed = 0; seed < 128; seed += 1) {
    const { source, expected } = makeCase(seed);
    const runtime = new Runtime();
    await runtime.run(compile(parse(source)));
    assert.equal(runtime.get('result'), expected, `seed ${seed}`);
  }
});
