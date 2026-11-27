import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

function localOrigin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.href, `${url.origin}/`, 'expected a loopback HTTP origin');
  return url.origin;
}

const [previewArgument, fixturePath, outputDirectory] = process.argv.slice(2);
assert.ok(previewArgument && fixturePath, 'usage: node tools/check-pull-toolbar.mjs PREVIEW_ORIGIN FIXTURE_JSON [SCREENSHOT_DIR]');
const preview = localOrigin(previewArgument);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const primary = localOrigin(fixture.primary);
assert.equal(fixture.code, 'fixture-code');
const require = createRequire(process.env.EXACT ? resolve(process.env.EXACT, 'package.json') : import.meta.url);
const { chromium } = require('playwright-core');
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
const expectedUrl = 'https://review.example.invalid/fixture/client/pull/9?tab=details#overview';

try {
  for (const width of [320, 393, 900]) {
    const shareAvailable = width !== 320;
    const page = await browser.newPage({ viewport: { width, height: 852 }, colorScheme: shareAvailable ? 'dark' : 'light' });
    const by = (id) => page.getByTestId(id);
    await page.addInitScript((shareAvailable) => {
      window.toolbarWrites = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => window.toolbarWrites.push(value) } });
      Object.defineProperty(navigator, 'share', { value: shareAvailable ? async (data) => window.toolbarWrites.push(data) : undefined });
    }, shareAvailable);
    await page.goto(preview);
    await by('empty-add-environment').click();
    await by('address').fill(primary);
    await by('pair-code').fill(fixture.code);
    await by('connect').click();
    await by('thread-fixture:alpha').waitFor();
    await by('tab-pullRequests').click();
    await by('pull-fixture-first.test-fixture/client-shared-9').click();
    const file = by('pull-file-src/panel.test.ts');
    await file.waitFor();
    assert.equal(await by('pull-detail-subtitle').innerText(), 'fixture/client');
    await by('pull-link-options').click();
    await by('pull-copy-link').click();
    assert.deepEqual(await page.evaluate(() => window.toolbarWrites), [expectedUrl]);
    await by('pull-link-options').click();
    if (shareAvailable) {
      await by('pull-share-link').click();
      const [, shared] = await page.evaluate(() => window.toolbarWrites);
      assert.equal(shared.url, expectedUrl);
      assert.equal(shared.title, 'Updated title from the environment after the list was loaded');
    } else {
      assert.equal(await by('pull-share-link').count(), 0);
      await page.keyboard.press('Escape');
    }
    await file.click();
    const back = page.getByRole('button', { name: 'Back to pull request', exact: true });
    const options = page.getByRole('button', { name: 'Diff options', exact: true });
    await options.waitFor();
    for (const rootSize of [16, 32, 53]) {
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
      const header = page.locator('header').filter({ has: options });
      const [bar, left, title, right] = await Promise.all([header, back, header.getByRole('heading'), options].map((element) => element.boundingBox()));
      const sample = { width, rootSize, bar, left, title, right };
      console.log(JSON.stringify(sample));
      assert.ok(bar && left && title && right);
      for (const button of [left, right]) assert.ok(button.width >= 44 && button.height >= 44);
      assert.ok(left.x >= 0 && right.x + right.width <= width + 1);
      assert.ok(left.x + left.width <= title.x + 1 && title.x + title.width <= right.x + 1);
      const center = (rect) => rect.y + rect.height / 2;
      assert.ok(Math.abs(center(left) - center(right)) <= 1 && Math.abs(center(title) - center(right)) <= 2);
      assert.ok(bar.height <= Math.max(left.height, right.height, title.height) + 2);
      if (outputDirectory) await page.screenshot({ path: resolve(outputDirectory, `diff-${width}-${rootSize}.png`) });
    }
    await back.click();
    await file.waitFor();
    await page.close();
  }
} finally {
  await browser.close();
}
