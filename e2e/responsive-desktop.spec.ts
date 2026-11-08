/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openFakeHome, playerBar, waitForHydratedPlayer } from './fake-ui';

const sizes = [
  { width: 1280, height: 800 },
  { width: 999, height: 680 },
  { width: 840, height: 600 },
  { width: 768, height: 1024 },
  { width: 600, height: 500 },
  { width: 599, height: 400 },
  { width: 500, height: 400 },
  { width: 400, height: 700 },
  { width: 320, height: 240 },
  { width: 1280, height: 300 },
];

async function expectInsideViewport(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const size = page.viewportSize()!;
  const box = (await locator.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
}

test('desktop navigation, settings and playback survive live resizing below the old minimum', async ({
  page,
}) => {
  await openFakeHome(page);
  await waitForHydratedPlayer(page);
  const bar = playerBar(page);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expectInsideViewport(bar.getByRole('button', { name: 'Play', exact: true }), page);
    await expectInsideViewport(bar.getByRole('button', { name: 'Next track' }), page);
    for (const selector of ['.content-shell', '.player-bar']) {
      await expect
        .poll(() => page.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    const sidebar = page.locator('.sidebar');
    const navigation = (await sidebar.isVisible()) ? sidebar : page.locator('.android-bottom-nav');
    await navigation.getByRole('button', { name: 'Plugins', exact: true }).click();
    await expect(page.locator('.plugins-page')).toBeVisible();
    if (await sidebar.isVisible()) {
      await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
    } else {
      await page.locator('.topbar__account').click();
    }
    await expect(page.locator('.settings-page')).toBeVisible();
    const lastSection = page.locator('.settings-section').last();
    await lastSection.scrollIntoViewIfNeeded();
    await expect(lastSection).toBeInViewport();
    await navigation.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('[data-yaqmc="track-title"]')).toHaveText('Quiet Light');
  }
});

test('an open queue follows the current shell instead of stale desktop offsets', async ({
  page,
}) => {
  await openFakeHome(page);
  await waitForHydratedPlayer(page);
  await playerBar(page).getByRole('button', { name: 'Show queue' }).click();
  const panel = page.locator('.context-panel');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expectInsideViewport(panel, page);
    await expectInsideViewport(panel.locator('.context-panel__header button'), page);
    await expect
      .poll(async () => {
        const panelBox = (await panel.boundingBox())!;
        const playerBox = (await playerBar(page).boundingBox())!;
        return panelBox.y + panelBox.height - playerBox.y;
      })
      .toBeLessThanOrEqual(1);
    const upcoming = panel.locator('.queue-row').last();
    await upcoming.scrollIntoViewIfNeeded();
    await expect(upcoming).toBeInViewport();
  }
  await panel.locator('.context-panel__header button').click();
  await expect(panel).toBeHidden();
});

test('lyrics controls reflow during narrow, short and portrait window transitions', async ({
  page,
}) => {
  await openFakeHome(page);
  await waitForHydratedPlayer(page);
  await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
  const lyrics = page.getByRole('region', { name: 'Synchronized lyrics' });
  await expect(lyrics).toHaveAttribute('data-stage', 'open');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expectInsideViewport(lyrics.getByRole('button', { name: 'Play', exact: true }), page);
    await expectInsideViewport(lyrics.getByRole('button', { name: 'Collapse lyrics page' }), page);
    await expect
      .poll(() =>
        lyrics.locator('[data-widget="transport"]').evaluate((widget) => {
          const area = widget.getBoundingClientRect();
          return [...widget.querySelectorAll('button')]
            .filter((button) => button.getBoundingClientRect().width > 0)
            .every((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.left >= area.left - 1 &&
                box.right <= area.right + 1 &&
                box.top >= area.top - 1 &&
                box.bottom <= area.bottom + 1
              );
            });
        }),
      )
      .toBe(true);
    await expect
      .poll(() => lyrics.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(1);
    if (size.width > size.height && size.height < 600) {
      await expect
        .poll(async () => {
          const controls = (await lyrics.locator('[data-widget="transport"]').boundingBox())!;
          const text = (await lyrics.locator('[data-widget="lyrics"]').boundingBox())!;
          return controls.x + controls.width - text.x;
        })
        .toBeLessThanOrEqual(1);
    }
  }
  await lyrics.getByRole('button', { name: 'Collapse lyrics page' }).click();
  await expect(lyrics).toBeHidden();
  await expect(page.locator('[data-yaqmc="track-title"]')).toHaveText('Quiet Light');
});

test('compact macOS layouts leave space for native traffic lights', async ({ page }) => {
  await openFakeHome(page);
  await waitForHydratedPlayer(page);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'macos';
  });
  for (const size of [
    { width: 400, height: 700 },
    { width: 320, height: 240 },
  ]) {
    await page.setViewportSize(size);
    const search = page.locator('.search-trigger');
    await expect.poll(async () => (await search.boundingBox())!.x).toBeGreaterThanOrEqual(96);
    await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
    await expect(page.locator('.lyrics-stage')).toHaveAttribute('data-stage', 'open');
    const collapse = page.getByRole('button', { name: 'Collapse lyrics page' });
    await expectInsideViewport(collapse, page);
    await expect.poll(async () => (await collapse.boundingBox())!.y).toBeGreaterThanOrEqual(44);
    await collapse.click();
    await expect(page.locator('.lyrics-stage')).toBeHidden();
  }
});
