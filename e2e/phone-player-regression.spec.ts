/// <reference lib="dom" />
import { expect, test, type Locator } from '@playwright/test';
import { openAndroidFixture, loadLongPlayerContent } from './android-fixture';
import { playerBar, waitForHydratedPlayer } from './fake-ui';

async function assertHitTarget(control: Locator): Promise<void> {
  await expect(control).toBeVisible();
  expect(
    await control.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === node || node.contains(hit);
    }),
  ).toBe(true);
}

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2.75 });

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
  { width: 915, height: 412 },
]) {
  test(`vinyl real-content regions and touch controls at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        'yaqmc.preferences.v2',
        JSON.stringify({ lyricsPresets: { selectedId: 'builtin.vinyl' } }),
      );
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.setProperty('--safe-area-inset-top', '28px');
        document.documentElement.style.setProperty('--safe-area-inset-bottom', '18px');
      });
    });
    await openAndroidFixture(page);
    await waitForHydratedPlayer(page);
    await loadLongPlayerContent(page);
    await playerBar(page).getByRole('button', { name: 'Open lyrics page' }).tap();
    const lyrics = page.getByRole('region', { name: 'Synchronized lyrics' });
    await expect(lyrics).toHaveAttribute('data-stage', 'open');
    await page.screenshot({ path: testInfo.outputPath('player.png') });
    const regions = await lyrics.locator('.lyrics-scene__widget').evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.getAttribute('data-widget'),
        ...node.getBoundingClientRect().toJSON(),
      })),
    );
    for (const [index, first] of regions.entries()) {
      expect(first.x).toBeGreaterThanOrEqual(0);
      expect(first.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(first.y).toBeGreaterThanOrEqual(28);
      expect(first.bottom).toBeLessThanOrEqual(viewport.height - 18 + 1);
      for (const second of regions.slice(index + 1)) {
        const overlaps =
          Math.min(first.right, second.right) - Math.max(first.x, second.x) > 1 &&
          Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y) > 1;
        expect(overlaps, `${first.id} overlaps ${second.id}`).toBe(false);
      }
    }
    const lyricScroll = lyrics.locator('.lyrics-stage__amll-static');
    expect((await lyricScroll.boundingBox())!.height).toBeGreaterThan(80);
    await expect(lyricScroll.getByRole('button').first()).toHaveText(
      'First real lyric must remain visible',
    );
    expect(await lyricScroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    if (viewport.width === 768 && viewport.height === 1024) {
      const disc = await lyrics.locator('.lyrics-stage__disc').boundingBox();
      const metadata = await lyrics.locator('.lyrics-scene__metadata').boundingBox();
      expect(disc).not.toBeNull();
      expect(metadata).not.toBeNull();
      expect(metadata!.y - (disc!.y + disc!.height)).toBeGreaterThanOrEqual(0);
      expect(metadata!.y - (disc!.y + disc!.height)).toBeLessThanOrEqual(24);
    }
    await lyricScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(lyricScroll.getByRole('button').last()).toBeInViewport();
    // Idle on a touch display must not remove core controls.
    await page.waitForTimeout(2600);
    await assertHitTarget(lyrics.getByRole('button', { name: 'Play', exact: true }));
    await assertHitTarget(lyrics.getByRole('button', { name: 'Collapse lyrics page' }));
    await lyrics.getByRole('button', { name: 'Play', exact: true }).tap();
    await expect(lyrics.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expect(lyrics).toHaveAttribute('data-song-id', 'quiet-light');
    await assertHitTarget(lyrics.getByRole('button', { name: 'Pause', exact: true }));
    await lyrics.getByRole('button', { name: 'Pause', exact: true }).tap();
    await expect(lyrics.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
