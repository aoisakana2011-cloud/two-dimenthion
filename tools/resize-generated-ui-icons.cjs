'use strict';

// Downscale generated 1024px transparent PNG interface icons to a compact
// 128px runtime size using Chromium's alpha-preserving image pipeline.
const fs = require('node:fs/promises');
const { chromium } = require('../build/audit-tools/node_modules/playwright');

const names = ['save', 'load', 'system', 'sound', 'favorite', 'tips'];
const directory = require('node:path').resolve(__dirname, '../Title/asset/ui/icons');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><body style="margin:0;background:transparent"><img id="icon" width="128" height="128" style="object-fit:contain"></body></html>');
    for (const name of names) {
      const file = `${directory}/${name}.png`;
      const encoded = (await fs.readFile(file)).toString('base64');
      await page.locator('#icon').evaluate((image, data) => { image.src = `data:image/png;base64,${data}`; }, encoded);
      await page.locator('#icon').evaluate(image => image.decode());
      await page.screenshot({ path: file, omitBackground: true });
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
