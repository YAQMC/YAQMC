/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { openFakeHome, playerBar, waitForHydratedPlayer } from './fake-ui';
import { openAndroidFixture } from './android-fixture';

interface ViewportCase {
  name: string;
  width: number;
  height: number;
  android: boolean;
  layout: 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'tablet-landscape' | 'desktop';
}

const viewports: readonly ViewportCase[] = [
  { name: 'phone-390x844', width: 390, height: 844, android: true, layout: 'phone-portrait' },
  { name: 'phone-360x800', width: 360, height: 800, android: true, layout: 'phone-portrait' },
  { name: 'phone-844x390', width: 844, height: 390, android: true, layout: 'phone-landscape' },
  { name: 'phone-915x412', width: 915, height: 412, android: true, layout: 'phone-landscape' },
  { name: 'tablet-768x1024', width: 768, height: 1024, android: true, layout: 'tablet-portrait' },
  { name: 'tablet-1024x768', width: 1024, height: 768, android: true, layout: 'tablet-landscape' },
  { name: 'desktop-1366x768', width: 1366, height: 768, android: false, layout: 'desktop' },
  { name: 'desktop-1920x1080', width: 1920, height: 1080, android: false, layout: 'desktop' },
];

const phoneDetailViewports = [
  { name: 'phone-detail-360x800', width: 360, height: 800, layout: 'portrait' },
  { name: 'phone-detail-844x390', width: 844, height: 390, layout: 'landscape' },
] as const;

for (const viewport of viewports) {
  test(`${viewport.name} keeps player, navigation, and lyrics usable`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    if (viewport.android) await openAndroidFixture(page);
    else await openFakeHome(page);
    await waitForHydratedPlayer(page);

    const shell = page.locator('.app-shell');
    await expect(shell).toBeVisible();

    const overflowers = await page
      .locator('.app-shell, .content-shell, .main-content, .page, .player-bar')
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map(
            (element) =>
              `${element.className}: ${String(element.scrollWidth)} > ${String(element.clientWidth)}`,
          ),
      );
    expect(overflowers).toEqual([]);

    const heroArtwork = page.locator('.media-card--hero .artwork').first();
    await expect(heroArtwork).toBeVisible();
    const heroBox = await heroArtwork.boundingBox();
    expect(heroBox).not.toBeNull();
    expect(heroBox!.x).toBeGreaterThanOrEqual(-0.5);
    expect(heroBox!.x + heroBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    if (viewport.layout === 'phone-portrait') {
      expect(heroBox!.width).toBeLessThanOrEqual(311);
      expect(heroBox!.height).toBeLessThanOrEqual(viewport.height * 0.43);
    }

    const visibleAccountEntries = await page
      .locator('[data-yaqmc="account-avatar"], .sidebar__profile')
      .evaluateAll(
        (elements) =>
          elements.filter((element) => {
            const style = element.ownerDocument.defaultView!.getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0;
          }).length,
      );
    expect(visibleAccountEntries).toBe(1);

    const topAccount = page.locator('.topbar [data-yaqmc="account-avatar"]');
    const bottomNavigation = page.locator('.android-bottom-nav');
    if (viewport.layout === 'phone-portrait') {
      await expect(topAccount).toBeVisible();
      await expect(bottomNavigation).toBeVisible();
      await expect(page.locator('.sidebar')).toBeHidden();
    } else {
      await expect(topAccount).toBeHidden();
      await expect(page.locator('.sidebar__profile')).toBeVisible();
      await expect(bottomNavigation).toBeHidden();
    }

    if (viewport.android) {
      const undersizedControls = await page
        .locator(
          '.search-trigger:visible, .topbar .icon-button:visible, .topbar__account:visible, .player-bar__artwork-button:visible, .player-controls button:visible, .player-bar__track > .icon-button:visible, .player-bar__track > .action-menu > button:visible, .player-quality-select:visible, .android-bottom-nav button:visible, .sidebar__profile:visible, .sidebar__item:visible',
        )
        .evaluateAll((elements) =>
          elements
            .map((element) => {
              const bounds = element.getBoundingClientRect();
              return {
                label: element.getAttribute('aria-label') ?? element.textContent,
                ...bounds.toJSON(),
              };
            })
            .filter((bounds) => bounds.width < 43.5 || bounds.height < 43.5),
        );
      expect(undersizedControls).toEqual([]);
    }

    const bar = playerBar(page);
    const playButton = bar.getByRole('button', { name: 'Play', exact: true });
    await expect(playButton).toBeVisible();
    const playBox = await playButton.boundingBox();
    expect(playBox).not.toBeNull();
    expect(playBox!.y + playBox!.height).toBeLessThanOrEqual(viewport.height + 0.5);

    await bar.getByRole('button', { name: 'Open lyrics page' }).click();
    const lyrics = page.getByRole('region', { name: 'Synchronized lyrics' });
    await expect(lyrics).toBeVisible();
    await expect(lyrics).toHaveAttribute('data-stage', 'open');
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.locator('.player-bar')).toBeHidden();
    await expect(page.locator('.sidebar')).toBeHidden();
    const lyricPlay = lyrics.getByRole('button', { name: 'Play', exact: true });
    await expect(lyricPlay).toBeVisible();

    if (viewport.android) {
      const lyricsControls = lyrics.locator(
        '.lyrics-stage__topbar button:visible, .lyrics-stage__chrome button:visible, .lyrics-stage__control-buttons button:visible',
      );
      const controlRects = await lyricsControls.evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label') ?? element.textContent,
            ...bounds.toJSON(),
          };
        }),
      );
      expect(controlRects.every((bounds) => bounds.width >= 43.5 && bounds.height >= 43.5)).toBe(
        true,
      );
      for (const [index, first] of controlRects.entries()) {
        for (const second of controlRects.slice(index + 1)) {
          const overlaps =
            Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 &&
            Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1;
          expect(overlaps, `${String(first.label)} overlaps ${String(second.label)}`).toBe(false);
        }
      }
    }

    const lyricsOverflow = await lyrics.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(lyricsOverflow).toBeLessThanOrEqual(1);

    if (viewport.layout === 'phone-portrait' || viewport.layout === 'phone-landscape') {
      const artworkWidget = lyrics.locator('[data-widget="artwork"]');
      const lyricWidget = lyrics.locator('[data-widget="lyrics"]');
      const transportWidget = lyrics.locator('[data-widget="transport"]');
      for (const widget of [artworkWidget, lyricWidget, transportWidget]) {
        const box = await widget.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(-0.5);
        expect(box!.y).toBeGreaterThanOrEqual(-0.5);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 0.5);
      }
      if (viewport.layout === 'phone-landscape') {
        const artworkBox = (await artworkWidget.boundingBox())!;
        const lyricBox = (await lyricWidget.boundingBox())!;
        expect(artworkBox.x + artworkBox.width).toBeLessThanOrEqual(lyricBox.x + 0.5);

        const metadataBox = await lyrics.locator('.lyrics-scene__metadata').boundingBox();
        const playBox = await lyricPlay.boundingBox();
        expect(metadataBox).not.toBeNull();
        expect(playBox).not.toBeNull();
        const overlaps =
          metadataBox!.x < playBox!.x + playBox!.width &&
          metadataBox!.x + metadataBox!.width > playBox!.x &&
          metadataBox!.y < playBox!.y + playBox!.height &&
          metadataBox!.y + metadataBox!.height > playBox!.y;
        expect(overlaps).toBe(false);
      }
    }

    if (viewport.layout === 'tablet-landscape') {
      const metadata = lyrics.locator('.lyrics-scene__metadata');
      const metadataTitleSize = await metadata
        .locator('strong')
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      expect(metadataTitleSize).toBeGreaterThanOrEqual(16);
      const metadataBox = await metadata.boundingBox();
      const playBox = await lyricPlay.boundingBox();
      expect(metadataBox).not.toBeNull();
      expect(playBox).not.toBeNull();
      const overlaps =
        metadataBox!.x < playBox!.x + playBox!.width &&
        metadataBox!.x + metadataBox!.width > playBox!.x &&
        metadataBox!.y < playBox!.y + playBox!.height &&
        metadataBox!.y + metadataBox!.height > playBox!.y;
      expect(overlaps).toBe(false);
    }

    if (viewport.layout === 'phone-portrait' || viewport.layout === 'phone-landscape') {
      const chrome = lyrics.locator('.lyrics-stage__chrome');
      await expect(chrome).not.toHaveAttribute('data-hidden');
    }

    await lyrics.getByRole('button', { name: 'Collapse lyrics page' }).click();
    await expect(lyrics).toBeHidden();
    await expect(page.locator('.player-bar')).toBeVisible();

    if (
      viewport.layout === 'phone-portrait' ||
      viewport.layout === 'phone-landscape' ||
      viewport.layout === 'tablet-portrait'
    ) {
      await page.locator('.player-bar__more > button').click();
      await expect(page.getByRole('menuitem', { name: 'Show queue' })).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: /Audio quality for the current track: Automatic/ }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
    }

    const settingsEntry =
      viewport.layout === 'phone-portrait' ? topAccount : page.locator('.sidebar__profile');
    await settingsEntry.click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    if (viewport.layout === 'phone-portrait' && viewport.name === 'phone-390x844') {
      await page.locator('.topbar .search-trigger').click();
      await expect(page.locator('.search-page')).toBeVisible();
      await expect(page.locator('.search-page__field input')).toHaveCount(1);
      await expect(page.locator('.topbar .search-trigger')).toBeHidden();
    }
  });
}

for (const viewport of phoneDetailViewports) {
  test(`${viewport.name} keeps detail metadata and actions inside the hero`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openAndroidFixture(page);
    await waitForHydratedPlayer(page);

    await page.getByRole('button', { name: 'Open Night Drive', exact: true }).click();
    const hero = page.locator('.detail-hero');
    const artwork = hero.locator('.detail-hero__art');
    const copy = hero.locator('.detail-hero__copy');
    await expect(hero).toBeVisible();

    const layout = await hero.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const copyBounds = element.querySelector('.detail-hero__copy')!.getBoundingClientRect();
      const artBounds = element.querySelector('.detail-hero__art')!.getBoundingClientRect();
      return {
        width: bounds.width,
        scrollWidth: element.scrollWidth,
        copy: copyBounds.toJSON(),
        art: artBounds.toJSON(),
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.copy.width).toBeGreaterThan(220);
    expect(layout.art.width).toBeLessThanOrEqual(220.5);

    if (viewport.layout === 'portrait') {
      expect(layout.copy.x).toBeLessThanOrEqual(layout.art.x + 0.5);
      expect(layout.copy.y).toBeGreaterThanOrEqual(layout.art.bottom - 0.5);
    } else {
      expect(layout.art.right).toBeLessThanOrEqual(layout.copy.x + 0.5);
      expect(layout.art.height).toBeLessThanOrEqual(viewport.height * 0.45 + 1);
      const playerBounds = await page.locator('.player-bar').boundingBox();
      const heroBounds = await hero.boundingBox();
      expect(playerBounds).not.toBeNull();
      expect(heroBounds).not.toBeNull();
      expect(heroBounds!.y + heroBounds!.height).toBeLessThanOrEqual(playerBounds!.y + 0.5);
    }

    await expect(copy.locator('h1')).toHaveCSS('white-space', 'normal');
    await expect(artwork).toBeVisible();

    const actionSizes = await hero.locator('.detail-hero__actions button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
    expect(actionSizes.length).toBeGreaterThan(0);
    expect(actionSizes.every(({ height }) => height >= 43.5)).toBe(true);
  });
}

test('phone vinyl scene keeps real content in bounded regions', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'yaqmc.preferences.v2',
      JSON.stringify({ lyricsPresets: { selectedId: 'builtin.vinyl' } }),
    );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openAndroidFixture(page);
  await waitForHydratedPlayer(page);
  await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).click();
  const lyrics = page.getByRole('region', { name: 'Synchronized lyrics' });
  await expect(lyrics).toHaveAttribute('data-stage', 'open');
  const scene = lyrics.locator('.lyrics-scene[data-cover-layout="vinyl"]');
  await expect(scene).toBeVisible();
  await page.screenshot({
    path: 'output/playwright/p0-p1-20260905/vinyl-portrait-after.png',
    fullPage: true,
  });
  const regions = await scene.locator('.lyrics-scene__widget').evaluateAll((items) =>
    items.map((item) => ({
      id: item.getAttribute('data-widget'),
      rect: item.getBoundingClientRect().toJSON(),
    })),
  );
  expect(regions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'artwork' }),
      expect.objectContaining({ id: 'lyrics' }),
      expect.objectContaining({ id: 'transport' }),
    ]),
  );
  const lyricBox = regions.find((item) => item.id === 'lyrics')!.rect;
  expect(lyricBox.height).toBeGreaterThan(80);
  expect(await scene.locator('.lyrics-stage__disc').count()).toBe(1);
  const lyricFontSize = await scene
    .locator('.lyrics-stage__amll')
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  expect(lyricFontSize).toBeLessThanOrEqual(28);
});
