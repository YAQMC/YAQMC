/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loadLongPlayerContent, openAndroidFixture } from './android-fixture';
import { playerBar, waitForHydratedPlayer } from './fake-ui';

const viewports = [
  { name: 'phone-390x844', width: 390, height: 844, layout: 'phone-portrait' },
  { name: 'phone-360x800', width: 360, height: 800, layout: 'phone-portrait' },
  { name: 'phone-844x390', width: 844, height: 390, layout: 'phone-landscape' },
  { name: 'phone-915x412', width: 915, height: 412, layout: 'phone-landscape' },
  { name: 'wide-phone-1080x432', width: 1080, height: 432, layout: 'phone-landscape' },
  { name: 'tablet-768x1024', width: 768, height: 1024, layout: 'tablet-portrait' },
  { name: 'tablet-1024x768', width: 1024, height: 768, layout: 'tablet-landscape' },
] as const;

const visibleAccount = (page: Page) =>
  page.locator('.topbar__account:visible, .sidebar__profile:visible');

async function expectTouchTarget(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const geometry = await target.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const center = element.ownerDocument.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    const viewport = element.ownerDocument.defaultView!;
    return {
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      viewportWidth: viewport.innerWidth,
      viewportHeight: viewport.innerHeight,
      centerHitsTarget: center !== null && element.contains(center),
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(43.5);
  expect(geometry.height).toBeGreaterThanOrEqual(43.5);
  expect(geometry.left).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.top).toBeGreaterThanOrEqual(-0.5);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);
  expect(geometry.centerHitsTarget).toBe(true);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page
    .locator('html, body, .app-shell, .content-shell, .main-content, .page, .player-bar')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          element: element.className || element.tagName,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        })),
    );
  expect(overflow).toEqual([]);
}

async function expectContentHasOwnSpace(page: Page): Promise<void> {
  // Route entry animates the content; compare settled rectangles, not a frame
  // mid-transition. No style overrides or fake Android DOM branches are used.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const topbar = document.querySelector('.topbar')!.getBoundingClientRect();
        const main = document.querySelector('.main-content')!.getBoundingClientRect();
        const player = document.querySelector('.player-bar')!.getBoundingClientRect();
        return main.top >= topbar.bottom - 0.5 && main.bottom <= player.top + 0.5;
      }),
    )
    .toBe(true);
}

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

for (const viewport of viewports) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('keeps Android search, navigation and mini-player reachable without overlap', async ({
      page,
    }, testInfo) => {
      await openAndroidFixture(page);
      await waitForHydratedPlayer(page);
      await loadLongPlayerContent(page);

      const portraitPhone = viewport.layout === 'phone-portrait';
      const navigation = page.locator(portraitPhone ? '.android-bottom-nav' : '.sidebar__nav');
      await expect(navigation).toBeVisible();
      await expect(navigation.getByRole('button')).toHaveCount(4);
      // These are absent from the actual Android render branch, not removed
      // after mounting by this test to make a CSS screenshot look correct.
      await expect(page.locator('.sidebar__section-label')).toHaveCount(0);
      for (const name of ['Home', 'Explore', 'Library', 'Search']) {
        await expectTouchTarget(navigation.getByRole('button', { name, exact: true }));
      }

      await expect(visibleAccount(page)).toHaveCount(1);
      await expectTouchTarget(visibleAccount(page));
      await expect(page.locator('.topbar .lucide-user-round')).toHaveCount(0);
      await expect(page.locator('.search-trigger kbd')).toHaveCount(0);

      const player = playerBar(page);
      for (const name of ['Previous track', 'Play', 'Next track']) {
        await expectTouchTarget(player.getByRole('button', { name, exact: true }));
      }
      await expectTouchTarget(player.getByRole('button', { name: 'Open lyrics page' }));
      const playerText = await page.locator('.player-bar__track-copy').boundingBox();
      const playerControls = await page.locator('.player-controls').boundingBox();
      expect(playerText).not.toBeNull();
      expect(playerControls).not.toBeNull();
      expect(playerText!.width).toBeGreaterThan(0);
      expect(playerText!.x + playerText!.width).toBeLessThanOrEqual(playerControls!.x + 0.5);
      await expectNoHorizontalOverflow(page);

      if (viewport.layout === 'phone-landscape') {
        const rail = await page.locator('.sidebar').boundingBox();
        const top = await page.locator('.topbar').boundingBox();
        const miniPlayer = await player.boundingBox();
        expect(rail!.width).toBeLessThanOrEqual(64);
        expect(top!.height).toBeLessThanOrEqual(52);
        expect(miniPlayer!.height).toBeLessThanOrEqual(64);
      } else if (viewport.layout === 'tablet-landscape') {
        // Height, not only width, distinguishes a real tablet from the extra
        // wide low-height phone case above.
        const rail = await page.locator('.sidebar').boundingBox();
        expect(rail!.width).toBeGreaterThanOrEqual(160);
        await expect(
          navigation.getByRole('button', { name: 'Home' }).locator('span'),
        ).toBeVisible();
      }

      await navigation.getByRole('button', { name: 'Search', exact: true }).tap();
      const search = page.getByRole('textbox', { name: 'Search music', exact: true });
      await expect(search).toBeVisible();
      await expect(page.getByRole('textbox')).toHaveCount(1);
      await expect(page.locator('.search-trigger')).toBeHidden();
      await expectContentHasOwnSpace(page);
      await expectTouchTarget(search);
      await expectNoHorizontalOverflow(page);

      await page.screenshot({ path: `output/playwright/android-shell-${viewport.name}.png` });
      await testInfo.attach('emulated-viewport-environment', {
        contentType: 'application/json',
        body: JSON.stringify(
          await page.evaluate(() => {
            const shell = document.querySelector('.app-shell')!;
            const style = getComputedStyle(shell);
            return {
              hostKind: shell.getAttribute('data-host-kind'),
              innerWidth,
              innerHeight,
              devicePixelRatio,
              visualViewport: visualViewport && {
                width: visualViewport.width,
                height: visualViewport.height,
                scale: visualViewport.scale,
                offsetTop: visualViewport.offsetTop,
              },
              coarsePointer: matchMedia('(pointer: coarse)').matches,
              noHover: matchMedia('(hover: none)').matches,
              phoneLandscape: matchMedia(
                '(orientation: landscape) and (min-width: 600px) and (max-height: 599px)',
              ).matches,
              safeInsets: ['top', 'right', 'bottom', 'left'].map((side) =>
                style.getPropertyValue(`--android-safe-${side}`).trim(),
              ),
            };
          }),
          null,
          2,
        ),
      });

      // Scroll only the existing content viewport. Its last section must be
      // reachable above the mini-player without moving the whole application.
      const main = page.locator('.main-content');
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const bottom = await page.locator('.search-page .content-section--last').boundingBox();
      const content = await main.boundingBox();
      expect(bottom).not.toBeNull();
      expect(content).not.toBeNull();
      expect(bottom!.y + bottom!.height).toBeLessThanOrEqual(content!.y + content!.height + 0.5);
      expect(bottom!.y + bottom!.height).toBeGreaterThan(content!.y);
      await expectContentHasOwnSpace(page);

      await main.evaluate((element) => {
        element.scrollTop = 0;
      });
      const query = 'A long search query without accidental horizontal overflow '.repeat(3);
      await search.fill(query);
      await expect(page.locator('.search-results__heading h1')).toContainText(query.trim());
      await expectTouchTarget(page.getByRole('button', { name: 'Clear search', exact: true }));
      await expectNoHorizontalOverflow(page);

      await page.getByRole('button', { name: 'Clear search', exact: true }).tap();
      await expect(search).toHaveValue('');
      await expect(visibleAccount(page)).toHaveCount(1);
      await visibleAccount(page).tap();
      await expect(page.locator('.settings-page')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}

test('rotation retains the search query and exposes the same guest settings destination', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAndroidFixture(page);
  await waitForHydratedPlayer(page);
  await page
    .locator('.android-bottom-nav')
    .getByRole('button', { name: 'Search', exact: true })
    .tap();
  const search = page.getByRole('textbox', { name: 'Search music', exact: true });
  await search.fill('Quiet');

  for (const viewport of [
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(search).toHaveValue('Quiet');
    await expect(playerBar(page).locator('[data-yaqmc="track-title"]')).toHaveText('Quiet Light');
    await expect(page.locator('.search-trigger')).toBeHidden();
    await expect(visibleAccount(page)).toHaveCount(1);
    await expectTouchTarget(visibleAccount(page));
    await expectContentHasOwnSpace(page);
    await expectNoHorizontalOverflow(page);
  }

  await visibleAccount(page).focus();
  await expect(visibleAccount(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.settings-page')).toBeVisible();
});
