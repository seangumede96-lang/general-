// Renders character.html headlessly and saves PNGs.
// Usage: node render.js <view 0|1> <out.png> [width height]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const [view = '0', out = `view${view}.png`, w, h] = process.argv.slice(2);
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  const url = 'file://' + path.resolve(__dirname, 'character.html') +
    `?view=${view}` + (w ? `&w=${w}&h=${h}` : '');
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.result, null, { timeout: 0, polling: 1000 });
  const data = await page.evaluate(() => window.result);
  fs.writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
  console.log(`saved ${out} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await browser.close();
})();
