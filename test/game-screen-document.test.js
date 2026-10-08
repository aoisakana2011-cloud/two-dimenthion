'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMarkup, compileScreenDocument, compileGameScreens } = require('../Edit/screen-document');
const { validateGameScreens, withSaveLoadScreens } = require('../Edit/game-screens');

test('screen HTML lays out flex menus into shared absolute geometry', () => {
  const { tree } = compileScreenDocument(
    '<main><nav class="menu"><button id="start" data-action="start">Start</button><button id="load" data-action="load">Load</button></nav></main>',
    'main{width:100%;height:100%}.menu{position:absolute;left:100px;top:40px;width:200px;display:flex;flex-direction:column;gap:10px}button{height:40px}',
    { width: 800, height: 450 },
  );
  const menu = tree[0].children[0];
  assert.deepEqual(menu.rect, { x: 100, y: 40, width: 200, height: 90 });
  assert.deepEqual(menu.children.map(node => node.rect), [
    { x: 100, y: 40, width: 200, height: 40 },
    { x: 100, y: 90, width: 200, height: 40 },
  ]);
});

test('br preserves an explicit line break in paragraph text and void element order', () => {
  const tree = parseMarkup('<main><p>First<br>second<br/>third</p><img src="asset/icon.png" alt=""><input type="checkbox" data-setting="audio.bgmMuted"></main>');
  assert.deepEqual(tree[0].children.map(node => node.tag), ['p', 'img', 'input']);
  assert.equal(tree[0].children[0].text, 'First\nsecond\nthird');
  assert.equal(tree[0].children[0].children.length, 0);
  assert.throws(() => parseMarkup('<main><br onclick="bad"></main>'), /未対応の属性/);
  assert.throws(() => parseMarkup('<main><br data-action="back"></main>'), /brには表示用属性だけ/);
  assert.throws(() => parseMarkup(`<main>${'<br>'.repeat(2000)}</main>`), /2000個以内/);
  const { tree: layout } = compileScreenDocument('<main><p>First<br>second</p></main>', '', { width: 800, height: 450 });
  assert.equal(layout[0].children[0].rect.height, 48, 'intrinsic layout accounts for explicit text lines');
});

test('portable line-height accepts native-resolvable units and inherits through the shared screen tree', () => {
  const { tree } = compileScreenDocument('<main><p>First<br>Second</p></main>', 'main{line-height:1.5}p{font-size:20px}', { width: 800, height: 450 });
  assert.equal(tree[0].style['line-height'], '1.5');
  assert.equal(tree[0].children[0].style['line-height'], '1.5');
  const percent = compileScreenDocument('<main><p>First<br>Second</p></main>', 'main{font-size:20px;line-height:150%}p{font-size:10px}', { width: 800, height: 450 }).tree;
  assert.equal(percent[0].style['line-height'], '30px', 'percentage line-height resolves against the parent font size');
  assert.equal(percent[0].children[0].style['line-height'], '30px', 'the computed percentage line-height is inherited as a fixed value even when a child changes font size');
  assert.equal(percent[0].children[0].style['font-size'], '10px');
  assert.equal(percent[0].children[0].rect.height, 60, 'intrinsic text height reserves both computed 30px lines');
  for (const value of ['20px', '150%', '0']) assert.doesNotThrow(() => compileScreenDocument('<main>Text</main>', `main{line-height:${value}}`));
  for (const value of ['-1', '1.2em', 'normal', '1e3', '1000001']) assert.throws(() => compileScreenDocument('<main>Text</main>', `main{line-height:${value}}`), /line-heightには0〜1000000の数値、px、または%/);
});

test('screen images require an explicit alt attribute while allowing decorative images', () => {
  assert.throws(() => parseMarkup('<main><img src="asset/portrait.png"></main>'), /alt属性を指定してください/);
  assert.doesNotThrow(() => parseMarkup('<main><img src="asset/portrait.png" alt="Ayaka"></main>'));
  assert.doesNotThrow(() => parseMarkup('<main><img src="asset/ornament.png" alt=""></main>'));
});

test('screen HTML rejects mixed text and child content that Browser and Native cannot order consistently', () => {
  assert.throws(
    () => parseMarkup('<main><p>Before <strong>middle</strong> after</p></main>'),
    /混在コンテンツには対応していません/,
  );
  assert.doesNotThrow(() => parseMarkup('<main><p><strong>Nested text</strong></p><p>Text only</p></main>'));
});

test('flex children consume free space before justify-content distributes leftover space', () => {
  const { tree } = compileScreenDocument(
    '<main><nav class="menu"><div class="first"></div><div class="second"></div></nav></main>',
    'main{width:100%;height:100%}.menu{position:absolute;left:0;top:0;width:100px;height:20px;display:flex;justify-content:space-between}.first,.second{flex-grow:1;height:20px}',
    { width: 100, height: 20 },
  );
  const menu = tree[0].children[0];
  assert.deepEqual(menu.children.map(node => node.rect), [
    { x: 0, y: 0, width: 50, height: 20 },
    { x: 50, y: 0, width: 50, height: 20 },
  ]);
});

test('gap shorthand expands to row and column gaps with CSS declaration-order overrides', () => {
  const markup = '<main><div class="grid override"><i></i><i></i><i></i></div><div class="grid shorthand"><i></i><i></i><i></i></div></main>';
  const css = 'main{width:100px;height:100px}.grid{position:absolute;left:0;width:100px;height:60px;display:grid;grid-template-columns:20px 20px;grid-auto-rows:20px}.override{top:0;gap:10px 20px;column-gap:30px;row-gap:5px}.shorthand{top:70px;column-gap:30px;gap:10px 20px}';
  const { tree } = compileScreenDocument(markup, css, { width: 100, height: 140 });
  const [override, shorthand] = tree[0].children;
  assert.deepEqual(override.children.map(node => [node.rect.x, node.rect.y]), [[0, 0], [50, 0], [0, 25]], 'later longhands override the corresponding gap shorthand axes');
  assert.deepEqual(shorthand.children.map(node => [node.rect.x, node.rect.y]), [[0, 70], [40, 70], [0, 100]], 'a later shorthand replaces both earlier longhand axes');
  assert.throws(() => compileScreenDocument('<main><div class="grid"></div></main>', '.grid{gap:1px 2px 3px}'), /gapには1つまたは2つ/);
});

test('accepted justify-content and align-items values produce the expected shared rectangles', () => {
  const markup = '<main><div class="justify"><div class="first"></div><div class="second"></div></div><div class="align"><span class="child">X</span></div></main>';
  const cases = [
    ['start', [0, 30]], ['flex-start', [0, 30]], ['end', [50, 80]], ['flex-end', [50, 80]],
    ['center', [25, 55]], ['space-between', [0, 80]], ['space-around', [12.5, 67.5]],
    ['space-evenly', [100 / 6, 190 / 3]],
  ];
  for (const [value, expected] of cases) {
    const { tree } = compileScreenDocument(markup, `main{width:100px;height:150px}.justify{position:absolute;left:0;top:0;width:100px;height:20px;display:flex;gap:10px;justify-content:${value}}.first,.second{width:20px;height:10px}`, { width: 100, height: 150 });
    const actual = tree[0].children[0].children.map(node => node.rect.x);
    assert.equal(actual.length, expected.length);
    actual.forEach((x, index) => assert.ok(Math.abs(x - expected[index]) < 1e-9, `justify-content:${value} child ${index} x=${x}`));
  }
  const alignments = [
    ['stretch', { y: 40, height: 24 }], ['start', { y: 40, height: 24 }], ['flex-start', { y: 40, height: 24 }],
    ['end', { y: 116, height: 24 }], ['flex-end', { y: 116, height: 24 }], ['center', { y: 78, height: 24 }],
  ];
  for (const [value, expected] of alignments) {
    const { tree } = compileScreenDocument(markup, `main{width:100px;height:150px}.align{position:absolute;left:0;top:40px;width:100px;height:100px;display:flex;align-items:${value}}.child{width:20px;height:24px}`, { width: 100, height: 150 });
    const rect = tree[0].children[1].children[0].rect;
    assert.deepEqual({ y: rect.y, height: rect.height }, expected, `align-items:${value}`);
  }
});

test('overflowing flex items retain negative space for positional justification', () => {
  const markup = '<main><div class="center"><i class="item"></i><i class="item"></i></div><div class="end"><i class="item"></i><i class="item"></i></div><div class="between"><i class="item"></i><i class="item"></i></div><div class="around"><i class="item"></i><i class="item"></i></div><div class="evenly"><i class="item"></i><i class="item"></i></div></main>';
  const css = 'main{width:100px;height:100px}.center,.end,.between,.around,.evenly{position:absolute;left:0;width:100px;height:20px;display:flex}.center{top:0;justify-content:center}.end{top:20px;justify-content:flex-end}.between{top:40px;justify-content:space-between}.around{top:60px;justify-content:space-around}.evenly{top:80px;justify-content:space-evenly}.item{width:80px;height:20px}';
  const { tree } = compileScreenDocument(markup, css, { width: 100, height: 100 });
  const [center, end, between, around, evenly] = tree[0].children;
  assert.deepEqual(center.children.map(node => node.rect.x), [-30, 50], 'center distributes negative free space on both sides');
  assert.deepEqual(end.children.map(node => node.rect.x), [-60, 20], 'flex-end aligns the overflowing group to the end edge');
  assert.deepEqual(between.children.map(node => node.rect.x), [0, 80], 'space-between falls back to start when free space is negative');
  assert.deepEqual(around.children.map(node => node.rect.x), [0, 80], 'space-around falls back to start when free space is negative in Edge');
  assert.deepEqual(evenly.children.map(node => node.rect.x), [0, 80], 'space-evenly falls back to start when free space is negative in Edge');
});

test('grid auto rows place every implicit row and preserve overflow in the shared tree', () => {
  const markup = '<main><div class="grid"><i></i><i></i><i></i><i></i><i></i></div></main>';
  const { tree } = compileScreenDocument(markup, 'main{width:100px;height:100px}.grid{position:absolute;left:10px;top:20px;width:100px;height:30px;display:grid;grid-template-columns:40px 1fr;grid-auto-rows:20px;column-gap:5px;row-gap:7px}', { width: 150, height: 150 });
  const grid = tree[0].children[0];
  assert.deepEqual(grid.children.map(node => ({ x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height })), [
    { x: 10, y: 20, width: 40, height: 20 }, { x: 55, y: 20, width: 55, height: 20 },
    { x: 10, y: 47, width: 40, height: 20 }, { x: 55, y: 47, width: 55, height: 20 },
    { x: 10, y: 74, width: 40, height: 20 },
  ], 'the third implicit row remains positioned beyond the 30px grid container');
  assert.throws(() => compileScreenDocument(markup, '.grid{overflow:hidden}'), /Browser／Native共通画面では未対応のCSSです: overflow/);
});

test('implicit auto grid tracks size intrinsically and stretch evenly inside a definite container', () => {
  const markup = '<main><div class="grid"><i class="cell"></i><i class="cell"></i><i class="cell"></i><i class="cell"></i></div></main>';
  const { tree } = compileScreenDocument(markup, 'main{width:100px;height:100px}.grid{position:absolute;left:0;top:0;width:100px;height:100px;display:grid;grid-template-columns:20px 20px;row-gap:5px}.cell{width:20px;height:20px}', { width: 100, height: 100 });
  const grid = tree[0].children[0];
  assert.deepEqual(grid.children.map(node => ({ y: node.rect.y, height: node.rect.height })), [
    { y: 0, height: 20 }, { y: 0, height: 20 }, { y: 52.5, height: 20 }, { y: 52.5, height: 20 },
  ], 'auto rows start from 20px intrinsic contributions, then stretch equally to fill the 100px grid while fixed-height items keep their size');
});

test('unequal auto grid tracks preserve per-row intrinsic contributions before even stretch', () => {
  const markup = '<main><div class="grid"><i class="tall"></i><i class="tall"></i><i class="short"></i><i class="short"></i></div></main>';
  const css = 'main{width:100px;height:100px}.grid{position:absolute;left:0;top:0;width:100px;height:100px;display:grid;grid-template-columns:20px 20px;row-gap:5px}.tall{height:30px}.short{height:10px}';
  const { tree } = compileScreenDocument(markup, css, { width: 100, height: 100 });
  const grid = tree[0].children[0];
  assert.deepEqual(grid.children.map(node => ({ y: node.rect.y, height: node.rect.height })), [
    { y: 0, height: 30 }, { y: 0, height: 30 }, { y: 62.5, height: 10 }, { y: 62.5, height: 10 },
  ], 'the 30px and 10px intrinsic rows retain their unequal bases and each receives 27.5px of stretch around the 5px gap');
});

test('auto-sized grid in a flex row reserves its authored fixed track widths', () => {
  const markup = '<main><div class="row"><div class="grid"><i class="cell"></i><i class="cell"></i></div><div class="next"></div></div></main>';
  const css = 'main{width:400px;height:100px}.row{display:flex;width:400px;height:50px}.grid{display:grid;grid-template-columns:100px 100px;column-gap:5px;height:50px}.cell{width:20px;height:10px}.next{width:20px;height:10px}';
  const { tree } = compileScreenDocument(markup, css, { width: 400, height: 100 });
  const [grid, next] = tree[0].children[0].children;
  assert.equal(grid.rect.width, 205, 'the grid intrinsic width includes both fixed tracks and their gap');
  assert.equal(next.rect.x, 205, 'the following flex item starts after the grid tracks');
});

test('display-none and absolute children do not consume flow, flex, or grid positions', () => {
  const { tree } = compileScreenDocument(
    '<main><div class="flex"><span class="item"></span><span class="hidden item"></span><span class="absolute item"></span><span class="item"></span></div><div class="grid"><span class="hidden item"></span><span class="item"></span><span class="absolute item"></span><span class="item"></span></div></main>',
    '.flex{display:flex;width:300px;height:50px;gap:10px}.grid{display:grid;position:absolute;left:0;top:100px;width:300px;height:100px;grid-template-columns:repeat(2,1fr);grid-auto-rows:50px;gap:10px}.item{flex:1;height:20px}.hidden{display:none}.absolute{position:absolute;left:250px;top:0;width:40px;height:20px}',
    { width: 800, height: 450 },
  );
  const [flex, grid] = tree[0].children;
  assert.deepEqual(flex.children.map(child => child.rect.x), [0, 0, 250, 155]);
  assert.equal(flex.children[1].rect.width, 0);
  assert.deepEqual(grid.children.map(child => [child.rect.x, child.rect.y]), [[0, 100], [0, 100], [250, 100], [155, 100]]);
  assert.equal(grid.children[0].rect.width, 0);
});

test('display-none and absolute children do not consume block-flow height', () => {
  const { tree } = compileScreenDocument(
    '<main><div class="flow"><span class="hidden item"></span><span class="item"></span><span class="absolute-flow"></span><span class="item"></span></div></main>',
    '.flow{position:absolute;left:20px;top:30px;width:100px;height:100px}.hidden{display:none}.item{height:20px}.absolute-flow{position:absolute;left:0;top:50px;width:20px;height:20px}',
    { width: 800, height: 450 },
  );
  const children = tree[0].children[0].children;
  assert.deepEqual(children.map(child => child.rect.y), [30, 30, 80, 50]);
  assert.equal(children[0].rect.height, 0);
});

test('hidden and absolute descendants do not inflate auto-sized ancestors', () => {
  const { tree } = compileScreenDocument(
    '<main><section class="parent"><div class="nested"><span class="hidden"></span><span class="absolute"></span><span class="visible"></span></div></section></main>',
    '.nested{width:120px}.hidden{display:none;width:120px;height:300px}.absolute{position:absolute;left:0;top:0;width:120px;height:200px}.visible{width:120px;height:24px}',
    { width: 800, height: 450 },
  );
  const parent = tree[0].children[0];
  const nested = parent.children[0];
  assert.equal(nested.rect.height, 24, 'the nested auto-height only includes its in-flow visible child');
  assert.equal(parent.rect.height, 24, 'the parent auto-height follows the nested in-flow geometry');
});

test('grid track definitions reject malformed and non-finite numeric widths', () => {
  const markup = '<main><div class="grid"><div></div></div></main>';
  for (const columns of ['auto 1fr', 'minmax(20px,1fr)', 'repeat(2,1..fr)', '1.2.3fr', `${'9'.repeat(400)}fr`]) {
    assert.throws(
      () => compileScreenDocument(markup, `.grid{display:grid;width:100px;height:20px;grid-template-columns:${columns};grid-auto-rows:20px}`),
      /grid-template-columns/,
      `reject malformed track expression ${columns}`,
    );
  }
  for (const columns of ['repeat(2001,1fr)', `repeat(${Number.MAX_SAFE_INTEGER + 1},1fr)`]) {
    assert.throws(
      () => compileScreenDocument(markup, `.grid{display:grid;width:100px;height:20px;grid-template-columns:${columns}}`),
      /grid-template-columns.*列数/,
      `reject excessive track count ${columns}`,
    );
  }
});

test('flex growth factors stay within finite layout bounds', () => {
  const markup = '<main><div class="box"><span class="child"></span></div></main>';
  for (const declaration of [`flex-grow:${'9'.repeat(400)}`, `flex:${'9'.repeat(400)}`, 'flex-grow:1000001']) {
    assert.throws(
      () => compileScreenDocument(markup, `.box{display:flex;width:100px;height:20px}.child{${declaration}}`),
      /有限範囲の0〜1000000/,
      `reject non-finite or excessive growth factor ${declaration.slice(0, 32)}`,
    );
  }
});

test('flex-grow preserves each child basis while flex shorthand uses the shared zero basis', () => {
  const source = '<main><div class="grow-box"><div class="grow-a"></div><div class="grow-b"></div></div><div class="flex-box"><div class="flex-a"></div><div class="flex-b"></div></div></main>';
  const { tree } = compileScreenDocument(source, [
    'main{width:600px;height:40px}',
    '.grow-box,.flex-box{position:absolute;left:0;top:0;width:300px;height:40px;display:flex}',
    '.flex-box{left:300px}',
    '.grow-a{width:50px;height:40px;flex-grow:1}',
    '.grow-b{width:100px;height:40px;flex-grow:1}',
    '.flex-a{width:50px;height:40px;flex:1}',
    '.flex-b{width:100px;height:40px;flex:1}',
  ].join(''), { width: 600, height: 40 });
  const [growA, growB] = tree[0].children[0].children;
  const [flexA, flexB] = tree[0].children[1].children;
  assert.deepEqual([growA.rect, growB.rect].map(({ x, width }) => ({ x, width })), [
    { x: 0, width: 125 }, { x: 125, width: 175 },
  ], 'flex-grow distributes the 150px remainder on top of 50px and 100px bases');
  assert.deepEqual([flexA.rect, flexB.rect].map(({ x, width }) => ({ x, width })), [
    { x: 300, width: 150 }, { x: 450, width: 150 },
  ], 'numeric flex shorthand distributes the container from zero basis');
});

test('grid fraction weights stay proportional when their raw sum overflows', () => {
  const weight = `1${'0'.repeat(308)}`;
  const { tree } = compileScreenDocument(
    '<main><div class="grid"><div></div><div></div><div></div></div></main>',
    `main{width:100%;height:20px}.grid{display:grid;width:100px;height:20px;grid-template-columns:repeat(3,${weight}fr);grid-auto-rows:20px}`,
    { width: 100, height: 20 },
  );
  assert.deepEqual(tree[0].children[0].children.map(node => node.rect.width), [100 / 3, 100 / 3, 100 / 3]);
});

test('grid fixed track totals reject non-finite geometry', () => {
  const width = `1${'0'.repeat(308)}`;
  assert.throws(
    () => compileScreenDocument(
      '<main><div class="grid"><div></div><div></div><div></div></div></main>',
      `main{width:100%;height:20px}.grid{display:grid;width:100px;height:20px;grid-template-columns:repeat(3,${width}px);grid-auto-rows:20px}`,
      { width: 100, height: 20 },
    ),
    /grid-template-columns.*有限範囲/,
  );
});

test('screen CSS expands padding shorthands and lets zero longhands override them', () => {
  const markup = '<main><section class="box"><div class="child">Text</div></section></main>';
  const compile = css => compileScreenDocument(markup, css, { width: 800, height: 450 }).tree[0].children[0];
  const twoValues = compile('.box{position:absolute;left:0;top:0;width:200px;height:100px;padding:10px 20px}.child{width:50px;height:20px}');
  assert.deepEqual(twoValues.children[0].rect, { x: 20, y: 10, width: 50, height: 20 });
  assert.equal(twoValues.style['padding-left'], '20px');
  assert.equal(twoValues.style['padding-top'], '10px');

  const longhandAfter = compile('.box{position:absolute;left:0;top:0;width:200px;height:100px;padding:10px;padding-left:0}.child{width:50px;height:20px}');
  assert.equal(longhandAfter.children[0].rect.x, 0, 'an explicit zero longhand overrides the shorthand');
  const shorthandAfter = compile('.box{position:absolute;left:0;top:0;width:200px;height:100px;padding-left:0;padding:10px}.child{width:50px;height:20px}');
  assert.equal(shorthandAfter.children[0].rect.x, 10, 'a later shorthand resets the earlier longhand');
  assert.throws(() => compileScreenDocument(markup, '.box{padding:-1px}'), /paddingに負の値は指定できません/);
  assert.throws(() => compileScreenDocument(markup, '.box{padding-left:-1px}'), /paddingに負の値は指定できません/);
});

test('screen CSS rejects negative or malformed shared geometry values', () => {
  const markup = '<main><div class="box">Text</div></main>';
  for (const [property, value] of [
    ['width', '-10px'], ['height', '-4px'], ['gap', '-2px'], ['row-gap', '-1%'],
    ['font-size', '-12px'], ['border-width', '-1px'], ['grid-auto-rows', '-2px'],
  ]) {
    assert.throws(() => compileScreenDocument(markup, `.box{${property}:${value}}`), new RegExp(`${property}\u306b\u8ca0\u306e\u5024\u306f\u6307\u5b9a\u3067\u304d\u307e\u305b\u3093`));
  }
  assert.throws(() => compileScreenDocument(markup, '.box{width:10px 20px}'), /寸法はpx、%、vw、vhで指定してください/);
  assert.throws(() => compileScreenDocument(markup, '.box{flex-grow:-1}'), /property 'flex-grow'/);
});

test('percent dimensions resolve once against the containing block and padding compiles to shared pixels', () => {
  const markup = '<main><section class="outer"><div class="child"><span class="grandchild">Text</span></div></section></main>';
  const css = 'main{width:100%;height:100%}.outer{position:absolute;left:0;top:0;width:200px;height:100px}.child{width:50%;height:50%;padding-left:10%;font-size:50%;border-width:2%}.grandchild{width:50%;height:10px}';
  const { tree } = compileScreenDocument(markup, css, { width: 800, height: 450 });
  const outer = tree[0].children[0], child = outer.children[0], grandchild = child.children[0];
  assert.deepEqual(child.rect, { x: 0, y: 0, width: 100, height: 50 }, 'block child percentages are not applied twice');
  assert.equal(child.style['padding-left'], '20px', 'percentage padding uses the containing block width and is normalized for both renderers');
  assert.equal(child.style['font-size'], '50px', 'percentage font-size resolves against the available containing-block height');
  assert.equal(child.style['border-width'], '4px', 'percentage border width resolves against the containing-block width');
  assert.deepEqual(grandchild.rect, { x: 24, y: 4, width: 36, height: 10 }, 'nested percentages use the content box inside the parent border and padding');

  const unitless = compileScreenDocument('<main><div class="box">Text</div></main>', '.box{font-size:14;border-width:2}', { width: 800, height: 450 }).tree[0].children[0];
  assert.equal(unitless.style['font-size'], '14px');
  assert.equal(unitless.style['border-width'], '2px');
});

test('relative position offsets move the shared node rectangle and its descendants', () => {
  const markup = '<main><section class="box"><div class="child">Text</div></section></main>';
  const css = 'main{width:100%;height:100%}.box{position:relative;left:20px;top:10px;width:100px;height:80px}.child{width:20px;height:20px}';
  const { tree } = compileScreenDocument(markup, css, { width: 800, height: 450 });
  const box = tree[0].children[0], child = box.children[0];
  assert.deepEqual(box.rect, { x: 20, y: 10, width: 100, height: 80 });
  assert.deepEqual(child.rect, { x: 20, y: 10, width: 20, height: 20 });
});

test('slot roles expand with grid placement and compile to actionable items', () => {
  const source = '<main><section class="slots" data-role="save-slots" data-count="4"></section><button id="back" data-action="back">Back</button><button id="start" data-action="start">Start</button></main>';
  const stylesheet = '.slots{position:absolute;left:10px;top:20px;width:500px;height:200px;display:grid;grid-template-columns:repeat(2,1fr);grid-auto-rows:80px;gap:10px}';
  const result = compileGameScreens({ version: 1, initial: 'title', titleScene: { file: 'main.tds', scene: 'title' }, stylesheet: 'screens/ui.css', screens: { title: { title: '', background: '', items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 0, y: 0, width: 100, height: 40 }], template: 'screens/title.html' } } }, {
    'screens/ui.css': stylesheet,
    'screens/title.html': source,
  }, { width: 800, height: 450 });
  const screen = result.screens.title;
  assert.equal(screen.role, 'save-slots');
  assert.deepEqual(screen.slotLayout, { x: 10, y: 20, width: 500, height: 200, rowHeight: 80, gap: 0, count: 4 });
  assert.equal(screen.items.length, 6);
  assert.equal(screen.items[0].slotIndex, 0);
  assert.equal(screen.items[4].action, 'back');
  assert.equal(screen.items[5].action, 'start');
  assert.deepEqual(screen.items.slice(0,4).map(item => [item.x, item.y]), [[10,20],[265,20],[10,110],[265,110]]);
});

test('one slot card template expands into independent, bindable cards', () => {
  const markup = '<main><div class="slots" data-role="load-slots" data-count="3"><button class="card"><span class="number" data-slot-field="number"></span><span class="excerpt" data-slot-field="text"></span></button></div></main>';
  const css = '.slots{position:absolute;left:20px;top:30px;width:600px;height:120px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.card{position:relative;width:100%;height:100px}.number{position:absolute;left:8px;top:8px;width:30px;height:20px}.excerpt{position:absolute;left:45px;top:8px;width:120px;height:60px}';
  const { tree } = compileScreenDocument(markup, css, { width: 800, height: 450 });
  const cards = tree[0].children[0].children;
  assert.deepEqual(cards.map(card => card.attrs['data-slot-index']), ['0', '1', '2']);
  assert.deepEqual(cards.map(card => card.rect.x), [20, 223.33333333333334, 426.6666666666667]);
  assert.equal(cards[1].children[1].attrs['data-slot-field'], 'text');
  assert.equal(cards[1].children[1].rect.x, cards[1].rect.x + 45);
  assert.notStrictEqual(cards[0].children[0], cards[1].children[0]);
  assert.throws(() => compileScreenDocument('<main><span data-slot-field="text"></span></main>', ''), /テンプレート内/);
  assert.throws(() => compileScreenDocument('<main><div data-role="save-slots"><button><button data-action="quit">X</button></button></div></main>', ''), /別のrole|1つだけ/);
  assert.throws(() => compileScreenDocument('<main><div data-role="save-slots"><button><span data-slot-field="secret"></span></button></div></main>', ''), /未対応のセーブ枠フィールド/);
});

test('save-slot state selectors compile into the renderer-neutral card style table', () => {
  const { tree } = compileScreenDocument(
    '<main><div class="slots" data-role="load-slots" data-count="2"><button class="save-slot"><span data-slot-field="status"></span></button></div></main>',
    '.slots{position:absolute;left:0;top:0;width:400px;height:100px;display:grid;grid-template-columns:repeat(2,1fr)}.save-slot[data-state="empty"],.save-slot[data-state="ready"],.save-slot[data-state="corrupt"],.save-slot[data-state="incompatible"]{opacity:1}.save-slot[data-state="corrupt"]{background-color:#f7ece7;border-color:#bf806d}.save-slot[data-state="incompatible"]{background-color:#f2efe7;border-color:#aa956b}',
    { width: 800, height: 450 },
  );
  const cards = tree[0].children[0].children;
  assert.equal(cards[0].slotStateStyles.corrupt['background-color'], '#f7ece7');
  assert.equal(cards[0].slotStateStyles.incompatible['border-color'], '#aa956b');
  for (const state of ['empty', 'ready', 'corrupt', 'incompatible']) assert.equal(cards[0].slotStateStyles[state].opacity, '1');
  assert.deepEqual(cards[1].slotStateStyles, cards[0].slotStateStyles);
  assert.throws(() => compileScreenDocument('<main><button class="not-a-slot">x</button></main>', '.not-a-slot[data-state="corrupt"]{color:#ffffff}'), /セーブ枠テンプレートのルート/);
  assert.throws(() => compileScreenDocument('<main><div data-role="load-slots" data-count="1"><button class="save-slot"><span class="status"></span></button></div></main>', '.status[data-state="corrupt"]{color:#ffffff}'), /セーブ枠テンプレートのルート/);
});

test('document compiler rejects executable markup, event handlers and external resources', () => {
  assert.throws(() => compileScreenDocument('<main><script>alert(1)</script></main>', ''), /未対応の要素/);
  assert.throws(() => compileScreenDocument('<main><button onclick="alert(1)">x</button></main>', ''), /未対応の属性/);
  assert.throws(() => compileScreenDocument('<main></main>', 'main{background-image:url(https://example.invalid/x.png)}'), /外部参照/);
  assert.throws(() => compileScreenDocument('<main><img src="../secret.png" alt="bad path"></main>', ''), /asset内/);
});

test('shared screen CSS rejects unsupported renderer features without silently dropping them', () => {
  const markup = '<main><section class="panel"><button data-action="start">Start</button></section></main>';
  const css = '.panel{background-color:#111111;color:#ffffff;border:1px solid #333333}.panel:hover{background-color:#222222}';
  assert.doesNotThrow(() => compileScreenDocument(markup, css));
  assert.throws(() => compileScreenDocument(markup, '.panel{--tone:#ffffff}'), /CSSカスタムプロパティには対応していません/);
  assert.throws(() => compileScreenDocument(markup, '.panel{background:var(--tone)}'), /CSS変数を使用できません/);
  assert.throws(() => compileScreenDocument(markup, '.panel{flex-basis:50px}'), /未対応の画面CSSプロパティです: flex-basis/);
  assert.throws(() => compileScreenDocument(markup, '.panel{flex-shrink:0}'), /Browser／Native共通画面では未対応のCSSです: flex-shrink/);
  const borderTree = compileScreenDocument(markup, '.panel{border:2px solid #334455}').tree;
  assert.equal(borderTree[0].children[0].style['border-width'], '2px');
  assert.equal(borderTree[0].children[0].style['border-color'], '#334455');
  assert.equal(borderTree[0].children[0].style['border-style'], 'solid');
  assert.throws(() => compileScreenDocument(markup, '.unused{}\n.panel{border-radius:12px}'), /CSS 2\u884c8\u5217.*Browser\uff0fNative\u5171\u901a\u753b\u9762\u3067\u306f\u672a\u5bfe\u5fdc\u306eCSS/);
  assert.throws(() => compileScreenDocument(markup, '.panel {\n  color: #ffffff;\n  border-radius: 12px;\n}'), /CSS .*property 'border-radius'/);
  assert.throws(() => compileScreenDocument(markup, '.panel {\n  color #ffffff;\n}'), /property: value/);
  assert.throws(() => compileScreenDocument(markup, '.panel > button:hover{color:#ffffff}'), /Browser／Native共通画面では未対応です/);
  assert.throws(() => compileScreenDocument(markup, '.panel{mask-image:url(https://example.invalid/a.png)}'), /未対応|外部参照/);
  assert.throws(() => compileScreenDocument('<main><button id=bad data-action="start">X</button></main>', ''), /引用符/);
  const result = compileGameScreens({ version: 1, initial: 'title', stylesheet: 'ui.css', screens: { title: { template: 'title.html' } } }, { 'title.html': markup, 'ui.css': css });
  assert.equal(Object.hasOwn(result.screens.title, 'webDocument'), false);
  const containsStart = nodes => nodes.some(node => node.attrs?.['data-action'] === 'start' || containsStart(node.children || []));
  assert.equal(containsStart(result.screens.title.uiTree), true);
  assert.throws(() => compileGameScreens(
    { version: 1, initial: 'title', stylesheet: 'screens/shared.css', screens: { title: { template: 'screens/title.html' } } },
    { 'screens/title.html': markup, 'screens/shared.css': '.panel{border-radius:12px}' },
  ), /property 'border-radius'.*border-radius/);
});

test('focus-visible styles remain distinct from ordinary focus in the compiled UI tree', () => {
  const { tree } = compileScreenDocument(
    '<main><button class="menu-item" data-action="start">Start</button></main>',
    '.menu-item:hover{background-color:#112233}.menu-item:focus{color:#aabbcc}.menu-item:focus-visible{border:2px solid #aabbcc}',
    { width: 800, height: 450 },
  );
  const button = tree[0].children[0];
  assert.equal(button.hoverStyle['background-color'], '#112233');
  assert.equal(button.focusStyle.color, '#aabbcc');
  assert.equal(button.focusStyle['border-width'], undefined);
  assert.equal(button.focusVisibleStyle.color, '#aabbcc', ':focus-visible retains declarations that also match :focus');
  assert.equal(button.focusVisibleStyle['border-width'], '2px');
  assert.equal(button.focusVisibleStyle['border-color'], '#aabbcc');
  assert.equal(button.focusVisibleStyle['border-style'], 'solid');
  const focusAfterVisible = compileScreenDocument(
    '<main><button class="menu-item" data-action="start">Start</button></main>',
    '.menu-item:focus-visible{background-color:#cc0000}.menu-item:focus{background-color:#00cc00}',
  ).tree[0].children[0];
  assert.equal(focusAfterVisible.focusStyle['background-color'], '#00cc00');
  assert.equal(focusAfterVisible.focusVisibleStyle['background-color'], '#00cc00', 'a later :focus declaration overrides :focus-visible when both match');
  const visibleAfterFocus = compileScreenDocument(
    '<main><button class="menu-item" data-action="start">Start</button></main>',
    '.menu-item:focus{background-color:#00cc00}.menu-item:focus-visible{background-color:#cc0000}',
  ).tree[0].children[0];
  assert.equal(visibleAfterFocus.focusStyle['background-color'], '#00cc00');
  assert.equal(visibleAfterFocus.focusVisibleStyle['background-color'], '#cc0000', 'a later :focus-visible declaration overrides :focus when both match');
  const input = compileScreenDocument(
    '<main><input class="menu-item" type="range" data-setting="audio.master" /></main>',
    '.menu-item:focus{border-color:#00cc00}.menu-item:focus-visible{border-color:#cc0000}',
    { width: 800, height: 450 }, [], { 'audio.master': 0.5 },
  ).tree[0].children[0];
  assert.equal(input.focusStyle['border-color'], '#00cc00');
  assert.equal(input.focusVisibleStyle['border-color'], '#cc0000', 'input nodes retain keyboard-visible focus separately');
});

test('inherited paint properties preserve local declarations separately for state-style parity', () => {
  const { tree } = compileScreenDocument('<main><button class="probe"><span id="label">Start</span></button></main>', '.probe{color:#ffffff}.probe:focus-visible{color:#00ff00}', { width: 1280, height: 720 });
  const button = tree[0].children[0], label = button.children[0];
  assert.equal(button.focusVisibleStyle.color, '#00ff00');
  assert.equal(label.style.color, '#ffffff', 'the shared tree retains the base inherited value for Native');
  assert.equal(label.specifiedStyle.color, undefined, 'the child marks inherited color as non-local so Browser state inheritance and Native runtime propagation can override it');
});

test('tabindex accepts signed 32-bit integers and rejects values Native cannot represent', () => {
  const { tree } = compileScreenDocument('<main><div id="skip" tabindex="-1" data-action="back">Back</div><button id="priority" tabindex="2" data-action="start">Start</button></main>', '', { width: 1280, height: 720 });
  assert.equal(tree[0].children[0].attrs.tabindex, '-1');
  assert.equal(tree[0].children[1].attrs.tabindex, '2');
  for (const value of ['auto', '1.5', '2147483648', '-2147483649']) {
    assert.throws(() => compileScreenDocument(`<main><button tabindex="${value}" data-action="start">Start</button></main>`, '', { width: 1280, height: 720 }), /tabindexには32-bit signed integer/);
  }
});

test('z-index paint sorting does not reorder compiled screen actions or source focus order', () => {
  const config = { version: 1, initial: 'title', stylesheet: 'screen.css', screens: { title: { template: 'title.html' } } };
  const { screens } = compileGameScreens(config, {
    'title.html': '<main><button id="first" data-action="start">Start</button><button id="second" data-action="back">Back</button></main>',
    'screen.css': '#first{z-index:20}#second{z-index:1}',
  });
  const screen = screens.title;
  assert.deepEqual(screen.items.map(item => item.action), ['start', 'back'], 'screen action order follows authored document order');
  assert.deepEqual(screen.uiTree[0].children.map(node => node.attrs.id), ['second', 'first'], 'the shared paint tree remains ordered by z-index');
  assert.deepEqual(screen.uiTree[0].children.slice().sort((a, b) => a.sourceOrder - b.sourceOrder).map(node => node.attrs.id), ['first', 'second'], 'source order remains available to Browser DOM and Native keyboard focus');
});

test('shared screen controls require a declared safe key, matching type and bounded values', () => {
  const settings = require('../Edit/screen-document').parseControlSettings('audio.master=0.8\naudio.bgmMuted=false\nui.dialogOpacity=0.65');
  assert.deepEqual(settings, { 'audio.master': 0.8, 'audio.bgmMuted': false, 'ui.dialogOpacity': 0.65 });
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('anything.secret=1'), /不正/);
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.master=1.1'), /audio\.master/);
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.master=0.5\naudio.master=0.6'), /重複/);
  assert.throws(() => compileScreenDocument('<main><input type="range" data-setting="runtime.command" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /対応する/);
  assert.throws(() => compileScreenDocument('<main><input type="checkbox" data-setting="audio.master" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /boolean/);
  assert.throws(() => compileScreenDocument('<main><input type="range" step="1e-20" data-setting="audio.master" /></main>', '', { width: 800, height: 450 }, [], { 'audio.master': 1 }), /step/);
  const characterControls = require('../Edit/screen-document').parseControlSettings('audio.voice.ayaka=0.8\naudio.voice.ayaka.muted=false');
  assert.deepEqual(characterControls, { 'audio.voice.ayaka': 0.8, 'audio.voice.ayaka.muted': false });
  assert.throws(() => require('../Edit/screen-document').parseControlSettings('audio.voice.bad-id=1'), /不正|未対応/);
  const characterInputs = compileScreenDocument('<main><input type="range" data-setting="audio.voice.ayaka"/><input type="checkbox" data-setting="audio.voice.ayaka.muted"/></main>', '', undefined, [], characterControls).tree[0].children;
  assert.deepEqual(characterInputs.map(node => node.attrs['data-setting']), ['audio.voice.ayaka', 'audio.voice.ayaka.muted']);
  const result = compileScreenDocument('<main><input class="volume" type="range" min="0" max="1" step="0.01" data-setting="audio.master" aria-label="Master" /></main>', '.volume{position:absolute;left:10px;top:20px;width:200px;height:24px;accent-color:#94b5e8}', { width: 800, height: 450 }, [], { 'audio.master': 1 });
  assert.equal(result.tree[0].children[0].attrs['data-setting'], 'audio.master');
  assert.equal(result.tree[0].children[0].rect.width, 200);
});

test('function-key bindings are validated and compile as shared clickable controls', () => {
  const { parseControlSettings, shortcutActions } = require('../Edit/screen-document');
  const defaults = parseControlSettings('ui.shortcut.F1=system\nui.shortcut.F12=none');
  assert.deepEqual(defaults, { 'ui.shortcut.F1': 'system', 'ui.shortcut.F12': 'none' });
  assert.deepEqual(shortcutActions, ['none','system','save','load','replay-voice','auto','clear-text','fullscreen','skip','quick-save','history','quick-load']);
  assert.throws(() => parseControlSettings('ui.shortcut.F13=save'), /不正|未対応/);
  assert.throws(() => parseControlSettings('ui.shortcut.F1=run-arbitrary-code'), /ショートカット動作が正しくありません/);
  assert.throws(() => compileScreenDocument('<main><button data-action="shortcut-cycle" data-target="F13">x</button></main>'), /shortcut-cycle/);
  const { tree } = compileScreenDocument('<main><button class="bind" data-action="shortcut-cycle" data-target="F1">System</button></main>', '.bind{position:absolute;left:10px;top:10px;width:120px;height:28px}', { width: 800, height: 450 });
  assert.equal(tree[0].children[0].attrs['data-action'], 'shortcut-cycle');
  assert.equal(tree[0].children[0].attrs['data-target'], 'F1');
});

test('screen controls bind validated image skins without changing their setting semantics', () => {
  const skins = {
    romanceVolume: { type: 'range', track: 'asset/ui/volume/track.png', fill: 'ui/volume/fill.png', thumb: 'ui/volume/thumb.png', thumbHover: 'ui/volume/thumb-hover.png', trackHeight: 8, thumbWidth: 28, thumbHeight: 30 },
    romanceMute: { type: 'checkbox', off: 'ui/volume/mute-off.png', on: 'ui/volume/mute-on.png' },
  };
  const controls = { 'audio.bgm': 0.75, 'audio.bgmMuted': false };
  const { tree } = compileScreenDocument(
    '<main><input type="range" min="0" max="1" step="0.01" data-setting="audio.bgm" data-skin="romanceVolume" aria-label="BGM"><input type="checkbox" data-setting="audio.bgmMuted" data-skin="romanceMute" aria-label="Mute"></main>',
    '', { width: 800, height: 450 }, [], controls, skins,
  );
  const [range, checkbox] = tree[0].children;
  assert.equal(range.controlSkin.type, 'range');
  assert.equal(range.controlSkin.track, 'ui/volume/track.png');
  assert.equal(checkbox.controlSkin.type, 'checkbox');
  assert.equal(range.attrs['data-setting'], 'audio.bgm');
  assert.throws(() => compileScreenDocument('<main><input type="range" data-setting="audio.bgm" data-skin="missing"></main>', '', undefined, [], controls, skins), /スキンがありません/);
  assert.throws(() => compileScreenDocument('<main><input type="checkbox" data-setting="audio.bgmMuted" data-skin="romanceVolume"></main>', '', undefined, [], controls, skins), /input typeが一致/);
  assert.throws(() => validateGameScreens({ version: 1, initial: 'title', screens: { title: { template: 'screens/title.html' } }, controlSkins: { unsafe: { type: 'range', track: '../escape.png', fill: 'ui/fill.png', thumb: 'ui/thumb.png' } } }), /相対パス/);
});

test('vertical range skins preserve orientation for both renderers and reject unknown axes', () => {
  const skins = { vertical: { type: 'range', orientation: 'vertical', track: 'ui/track.png', fill: 'ui/fill.png', thumb: 'ui/thumb.png' } };
  const { tree } = compileScreenDocument(
    '<main><input type="range" data-setting="audio.master" data-skin="vertical" /></main>',
    '', undefined, [], { 'audio.master': 0.5 }, skins,
  );
  assert.equal(tree[0].children[0].controlSkin.orientation, 'vertical');
  assert.throws(() => compileScreenDocument('<main></main>', '', undefined, [], {}, { invalid: { ...skins.vertical, orientation: 'diagonal' } }), /horizontalまたはvertical/);
});

test('boolean setting-value buttons are limited to declared safe settings and compile to equivalent values', () => {
  const config = { version: 1, initial: 'system', titleScene: { file: 'main.tds', scene: 'title' }, screens: { system: { template: 'system.html' } } };
  const { screens } = compileGameScreens(config, {
    'system.html': '<main><button data-action="setting-value" data-target="ui.effects" data-value="false">なし</button><button data-action="start">Start</button></main>',
  });
  assert.deepEqual(screens.system.items.filter(item => item.action !== 'start').map(({ action, target, value }) => ({ action, target, value })), [
    { action: 'setting-value', target: 'ui.effects', value: false },
  ]);
  assert.throws(() => compileGameScreens(config, {
    'system.html': '<main><button data-action="setting-value" data-target="runtime.secret" data-value="true">bad</button></main>',
  }), /設定値/);
  assert.throws(() => compileGameScreens(config, {
    'system.html': '<main><button data-action="setting-value" data-target="ui.effects" data-value="perhaps">bad</button></main>',
  }), /設定値/);
});

test('font-family choices are a safe persisted enum and window reset is a recognized action', () => {
  const config = { version: 1, initial: 'system', titleScene: { file: 'main.tds', scene: 'title' }, controlSettings: 'ui-controls.txt', screens: { system: { template: 'system.html' } } };
  const { screens, controlDefaults } = compileGameScreens(config, {
    'ui-controls.txt': 'ui.fontFamily=default',
    'system.html': '<main><button data-action="setting-value" data-target="ui.fontFamily" data-value="mincho">明朝</button><button data-action="reset-window-size">戻す</button><button data-action="start">Start</button></main>',
  });
  assert.equal(controlDefaults['ui.fontFamily'], 'default');
  assert.deepEqual(screens.system.items.filter(item => item.action !== 'start').map(({ action, target, value }) => ({ action, target, value })), [
    { action: 'setting-value', target: 'ui.fontFamily', value: 'mincho' },
    { action: 'reset-window-size', target: undefined, value: undefined },
  ]);
  assert.throws(() => compileGameScreens(config, { 'ui-controls.txt': 'ui.fontFamily=Comic Sans', 'system.html': '<main></main>' }), /許可された選択肢/);
});

test('screen actions must target defined screens and only one HTML root is accepted', () => {
  assert.throws(() => compileScreenDocument('<main><button data-action="open-screen" data-target="missing">Go</button></main>', '', { width: 800, height: 450 }, ['title']), /遷移先がありません/);
  assert.throws(() => compileScreenDocument('<main></main><footer></footer>', ''), /1つのルート要素/);
  const noStart = { version: 1, initial: 'title', screens: { title: { template: 'screens/title.html', background: '' } } };
  assert.throws(() => compileGameScreens(noStart, { 'screens/title.html': '<main><p>Missing start</p></main>' }, { width: 800, height: 450 }), /ゲーム開始/);
});

test('reference canvas scales without distortion and centers letterboxed layouts', () => {
  const transform = require('../Edit/screen-document').canvasTransform;
  assert.deepEqual(transform(1600, 900, { width: 1280, height: 720 }), { scaleX: 1.25, scaleY: 1.25, offsetX: 0, offsetY: 0 });
  assert.deepEqual(transform(1600, 1000, { width: 1280, height: 720 }), { scaleX: 1.25, scaleY: 1.25, offsetX: 0, offsetY: 50 });
  assert.deepEqual(transform(1000, 1600, { width: 1280, height: 720 }), { scaleX: 0.78125, scaleY: 0.78125, offsetX: 0, offsetY: 518.75 });
  assert.deepEqual(transform(1600, 1000, { width: 1280, height: 720 }, 'stretch'), { scaleX: 1.25, scaleY: 1.3888888888888888, offsetX: 0, offsetY: 0 });
  assert.throws(() => transform(0, 900, { width: 1280, height: 720 }), /正の有限値/);
  assert.throws(() => transform(1600, 900, { width: 1280, height: 720 }, 'unknown'), /未対応/);
  const config = require('../Edit/game-screens').defaultGameScreens();
  assert.equal(validateGameScreens({ ...config, scaleMode: 'cover' }).scaleMode, 'cover');
  assert.throws(() => validateGameScreens({ ...config, scaleMode: 'distort' }), /scaleMode/);
});

test('viewport CSS units resolve against the authored reference canvas, not their parent as pixels', () => {
  const { tree } = compileScreenDocument(
    '<main><section class="viewport-box"></section></main>',
    'main{width:100%;height:100%}.viewport-box{position:absolute;left:10vw;top:10vh;width:50vw;height:25vh}',
    { width: 1280, height: 720 },
  );
  assert.deepEqual(tree[0].children[0].rect, { x: 128, y: 72, width: 640, height: 180 });
});

test('the sample project screen templates compile with all navigation targets and slot geometry', () => {
  const root = path.resolve(__dirname, '..', 'Title', 'setting');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'game-screens.json'), 'utf8'));
  const names = new Set([source.stylesheet, source.controlSettings, ...Object.values(source.screens).map(screen => screen.template)].filter(Boolean));
  const documents = Object.fromEntries([...names].map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
  assert.equal(Object.hasOwn(source.screens.title, 'items'), false, 'HTML-backed screen source does not duplicate legacy button definitions');
  const compiled = compileGameScreens(withSaveLoadScreens(validateGameScreens(source)), documents, { width: 1280, height: 720 });
  assert.equal(compiled.screens.title.uiTree.length, 1);
  assert.deepEqual(compiled.screens.title.items.map(item => item.action), ['continue', 'start', 'load', 'open-screen', 'open-screen', 'quit']);
  assert.equal(compiled.screens.save.items.filter(item => item.slotIndex !== undefined).length, 12);
  assert.equal(compiled.screens.load.items.find(item => item.action === 'back').label, 'ゲームに戻る');
  assert.equal(compiled.screens.system.uiTree[0].children[0].attrs.class, 'screen-dimmer');
  const heading = (() => { const find = nodes => { for (const node of nodes || []) { if (node.tag === 'h1' && node.attrs.class === 'screen-title') return node; const nested = find(node.children); if (nested) return nested; } return null; }; return find(compiled.screens.system.uiTree); })();
  assert.equal(heading?.style.margin, '0', 'the shared screen tree neutralizes Browser heading defaults to match Native layout');
  assert.equal(compiled.screens.sound.items.filter(item => item.action === 'open-screen').length >= 3, true);
});
