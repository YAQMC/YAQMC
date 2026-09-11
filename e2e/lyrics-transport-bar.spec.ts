/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openFakeHome, playerBar, waitForHydratedPlayer } from './fake-ui';
import { loadLongPlayerContent, openAndroidFixture } from './android-fixture';

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
  { width: 844, height: 390 },
  { width: 915, height: 412 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];
const STYLES = ['builtin.transport.window', 'builtin.transport.fullscreen'] as const;

for (const viewport of VIEWPORTS.slice(0, 2)) {
  test(`synchronized fullscreen lyrics stay readable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await openFakeHome(page);
    await waitForHydratedPlayer(page);
    await loadLongPlayerContent(page, true);
    await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
    await expect(page.locator('.lyrics-stage')).toHaveAttribute('data-stage', 'open');
    await page.keyboard.press('F11');
    const renderer = page.locator('.lyrics-stage__amll');
    await expect(renderer).toBeVisible();
    await expect
      .poll(() =>
        renderer.evaluate((node) => {
          const range = document.createRange();
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          const viewport = node.getBoundingClientRect();
          let visible = 0;
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue;
            range.selectNodeContents(walker.currentNode);
            for (const rect of range.getClientRects()) {
              if (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.width === 0)
                continue;
              if (rect.left < viewport.left - 1 || rect.right > viewport.right + 1) return false;
              visible++;
            }
          }
          return visible > 0;
        }),
      )
      .toBe(true);
    await page.screenshot({ path: info.outputPath('synchronized-fullscreen.png') });
  });
}

async function assertControls(bar: Locator, page: Page) {
  await expect(bar.locator('.lyrics-transport__artwork, .lyrics-transport__track')).toHaveCount(0);
  await expect(bar.locator('button')).toHaveCount(3);
  for (const control of await bar.locator('button, input[type="range"]').all()) {
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.width).toBeGreaterThanOrEqual(43.5);
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(
      await control.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === node || (hit !== null && node.contains(hit));
      }),
    ).toBe(true);
  }
}

for (const viewport of VIEWPORTS) {
  for (const preset of STYLES) {
    test(`${preset} in both modes at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((preset) => {
        localStorage.setItem(
          'yaqmc.preferences.v2',
          JSON.stringify({
            transport: { schemaVersion: 1, window: preset, fullscreen: preset },
          }),
        );
      }, preset);
      await openFakeHome(page);
      await waitForHydratedPlayer(page);
      await loadLongPlayerContent(page);
      await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
      const lyrics = page.getByRole('region', { name: 'Synchronized lyrics' });
      await expect(lyrics).toHaveAttribute('data-stage', 'open');
      const bar = lyrics.locator('.lyrics-transport');
      for (const mode of ['window', 'fullscreen'] as const) {
        if (mode === 'fullscreen') await page.keyboard.press('F11');
        await expect(bar).toHaveAttribute('data-surface', mode);
        await expect(bar).toHaveAttribute('data-transport-preset', preset);
        await assertControls(bar, page);
        const scroll = lyrics.locator('.lyrics-stage__amll-static');
        const textBounds = await scroll.evaluate((element) => {
          const clip = element.getBoundingClientRect();
          const range = document.createRange();
          const line = element.querySelector('button')!;
          range.selectNodeContents(line);
          return {
            left: clip.left,
            right: clip.right,
            text: [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right })),
          };
        });
        for (const rect of textBounds.text) {
          expect(rect.left).toBeGreaterThanOrEqual(textBounds.left - 1);
          expect(rect.right).toBeLessThanOrEqual(textBounds.right + 1);
        }
        expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
        await scroll.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await expect(scroll.getByRole('button').last()).toBeInViewport();
        await page.screenshot({ path: info.outputPath(mode + '.png') });
      }
      await page.keyboard.press('Escape');
      await expect(bar).toHaveAttribute('data-surface', 'window');
      expect(await lyrics.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    });
  }
}

for (const preset of STYLES) {
  for (const viewport of VIEWPORTS.slice(0, 6)) {
    test(`Android ${preset} at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((preset) => {
        localStorage.setItem(
          'yaqmc.preferences.v2',
          JSON.stringify({
            transport: { schemaVersion: 1, window: preset, fullscreen: preset },
          }),
        );
      }, preset);
      await openAndroidFixture(page);
      await waitForHydratedPlayer(page);
      await loadLongPlayerContent(page);
      await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
      const lyrics = page.getByRole('region', { name: 'Synchronized lyrics' });
      await expect(lyrics).toHaveAttribute('data-stage', 'open');
      await expect(lyrics.locator('.lyrics-transport')).toHaveAttribute(
        'data-transport-preset',
        preset,
      );
      await assertControls(lyrics.locator('.lyrics-transport'), page);
    });
  }
}

test('keeps the real page visible but inert during enter/exit and restores it on close', async ({
  page,
}) => {
  await openFakeHome(page);
  await waitForHydratedPlayer(page);
  const content = page.locator('.content-shell');
  const before = await content.boundingBox();
  // Pause the actual CSS animation so the transitional layout can be inspected deterministically.
  await page.addStyleTag({
    content:
      ".lyrics-stage[data-stage='entering'], .lyrics-stage[data-stage='exiting'] { animation-play-state: paused; }",
  });
  await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
  await expect(content).toHaveAttribute('inert', '');
  await expect(content).toHaveCSS('visibility', 'visible');
  expect(await content.boundingBox()).toEqual(before);
  await page.locator('.lyrics-stage').evaluate((node) => {
    node.dispatchEvent(
      new AnimationEvent('animationend', { animationName: 'lyrics-stage-enter', bubbles: true }),
    );
  });
  await expect(content).toHaveCSS('visibility', 'hidden');
  await page.keyboard.press('Escape');
  await expect(content).toHaveCSS('visibility', 'visible');
  await expect(content).toHaveAttribute('inert', '');
  await page.locator('.lyrics-stage').evaluate((node) => {
    node.dispatchEvent(
      new AnimationEvent('animationend', { animationName: 'lyrics-stage-exit', bubbles: true }),
    );
  });
  await expect(content).not.toHaveAttribute('inert');
  await expect(content).toBeVisible();
});

test('both built-in styles are available in both settings selectors', async ({ page }) => {
  await openFakeHome(page);
  await waitForHydratedPlayer(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  for (const name of ['Window lyrics bar', 'Fullscreen lyrics bar']) {
    const select = page.getByRole('combobox', { name, exact: true });
    await select.click();
    await expect(page.getByRole('option', { name: 'Built-in compact style' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Built-in immersive style' })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});
