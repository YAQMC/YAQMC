import { expect, test } from '@playwright/test';
import { openFakeHome, playerBar, waitForHydratedPlayer } from './fake-ui';

test.describe('FE-06 fake-mode UI', () => {
  test('boots fake home with the offline provider', async ({ page }) => {
    await openFakeHome(page);
    await expect(page.getByRole('heading', { name: 'For you' })).toBeVisible();
    await expect(page.getByText('Offline fixtures')).toBeVisible();
    await expect(page).toHaveURL(/[?&]provider=fake/);
  });

  test('shows primary sidebar navigation', async ({ page }) => {
    await openFakeHome(page);
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(nav.getByRole('button', { name: 'Home' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Search' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Explore' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Settings' })).toBeVisible();
  });

  test('shows the top-bar search trigger', async ({ page }) => {
    await openFakeHome(page);
    await expect(page.getByRole('button', { name: /Ctrl K/ })).toBeVisible();
    await expect(page.locator('.search-trigger')).toContainText('Search');
  });

  test('opens the search page with a search box', async ({ page }) => {
    await openFakeHome(page);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Search' })
      .click();
    await expect(page.getByRole('textbox', { name: 'Search music' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Find your next listen' })).toBeVisible();
  });

  test('searches the fake catalog', async ({ page }) => {
    await openFakeHome(page);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Search' })
      .click();
    await page.getByRole('textbox', { name: 'Search music' }).fill('Night');
    await expect(page.getByRole('heading', { name: '“Night”' })).toBeVisible();
    await expect(page.getByText('Night Geometry')).toBeVisible();
  });

  test('plays and pauses from the player bar', async ({ page }) => {
    await openFakeHome(page);
    await waitForHydratedPlayer(page);
    const player = playerBar(page);
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  });

  test('opens the play queue', async ({ page }) => {
    await openFakeHome(page);
    await waitForHydratedPlayer(page);
    await page.getByRole('button', { name: 'Show queue' }).click();
    const queue = page.getByRole('complementary', { name: 'Play queue' });
    await expect(queue).toBeVisible();
    await expect(queue.getByText('Quiet Light')).toBeVisible();
  });

  test('adds a radar track to the queue', async ({ page }) => {
    await openFakeHome(page);
    await waitForHydratedPlayer(page);
    await page.getByRole('button', { name: 'More actions for Paper Sun' }).first().click();
    await page.getByRole('menuitem', { name: 'Add to queue' }).click();
    await page.getByRole('button', { name: 'Show queue' }).click();
    await expect(
      page.getByRole('complementary', { name: 'Play queue' }).getByText('Paper Sun'),
    ).toBeVisible();
  });

  test('removes a queued track', async ({ page }) => {
    await openFakeHome(page);
    await waitForHydratedPlayer(page);
    await page.getByRole('button', { name: 'Show queue' }).click();
    const queue = page.getByRole('complementary', { name: 'Play queue' });
    await expect(queue.getByText('Night Geometry')).toBeVisible();
    await queue.getByRole('button', { name: 'More queue actions for Night Geometry' }).click();
    await page.getByRole('menuitem', { name: 'Remove from queue' }).click();
    await expect(queue.getByText('Night Geometry')).toHaveCount(0);
  });

  test('opens settings', async ({ page }) => {
    await openFakeHome(page);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Settings' })
      .click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  });

  test('goes back from settings to home', async ({ page }) => {
    await openFakeHome(page);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Settings' })
      .click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page.getByRole('heading', { name: 'For you' })).toBeVisible();
  });

  test('opens the lyrics panel', async ({ page }) => {
    await openFakeHome(page);
    await waitForHydratedPlayer(page);
    await page.getByRole('button', { name: 'Show lyrics' }).click();
    await expect(page.getByRole('region', { name: 'Synchronized lyrics' })).toBeVisible();
  });

  test('external links do not navigate the app shell', async ({ page }) => {
    await openFakeHome(page);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Settings' })
      .click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const popupPromise = page.waitForEvent('popup', { timeout: 5_000 }).catch(() => null);
    await page.getByRole('button', { name: 'GitHub repository' }).click();
    const popup = await popupPromise;
    if (popup) {
      await expect(popup).toHaveURL(/github\.com\/YAQMC\/YAQMC/);
    }
    await expect(page).toHaveURL(/[?&]provider=fake/);
    await expect(page).not.toHaveURL(/github\.com/);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-provider-id', 'fake');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('surface=desktop is a lyrics window, not the app shell', async ({ page }) => {
    await page.goto('/?provider=fake&surface=desktop');
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'desktop');
    await expect(page.locator('main.lyrics-surface-root')).toHaveAttribute('data-kind', 'desktop');
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(page.getByText('Waiting for synchronized lyrics')).toBeVisible();
  });

  test('opens the explore page', async ({ page }) => {
    await openFakeHome(page);
    await page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('button', { name: 'Explore' })
      .click();
    await expect(page.getByRole('heading', { name: 'Explore' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Charts' })).toBeVisible();
  });

  test('Ctrl+K opens search', async ({ page }) => {
    await openFakeHome(page);
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('textbox', { name: 'Search music' })).toBeFocused();
  });
});
