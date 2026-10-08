'use strict';

// Rasterize the editable SVG source sprites to transparent PNGs for SDL_image.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');

const directory = path.resolve(__dirname, '../Title/asset/ui/controls/audio/volume');
const names = ['track', 'fill', 'thumb', 'thumb-hover', 'mute-off', 'mute-off-hover', 'mute-on', 'mute-on-hover'];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 64 }, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><head><style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent}img{display:block}</style></head><body><img id="sprite"></body></html>');
    for (const name of names) {
      const source = await fs.readFile(path.join(directory, `${name}.svg`), 'utf8');
      const dimensions = source.match(/<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
      if (!dimensions) throw new Error(`SVGに固定幅・高さがありません: ${name}`);
      const width = Number(dimensions[1]), height = Number(dimensions[2]);
      await page.setViewportSize({ width, height });
      const image = page.locator('#sprite');
      await image.evaluate((element, data) => { element.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(data)))}`; }, source);
      await image.evaluate(element => element.decode());
      await image.evaluate(element => { element.width = element.naturalWidth; element.height = element.naturalHeight; });
      const bounds = await image.boundingBox();
      await page.screenshot({ path: path.join(directory, `${name}.png`), omitBackground: true, clip: bounds });
      console.log(`${name}.pngを作成しました (${width}x${height}, 透明背景)`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
