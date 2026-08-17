import { expect, type Page } from '@playwright/test';

export const FAKE_HOME = '/?provider=fake';
export const VITE_DEV_ORIGIN = 'http://127.0.0.1:1420';

export async function openFakeHome(page: Page, origin?: string) {
  const url = origin ? `${origin}/?provider=fake` : FAKE_HOME;
  await page.goto(url);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-provider-id', 'fake');
}

export function playerBar(page: Page) {
  return page.getByRole('contentinfo', { name: 'Music player' });
}

export async function waitForHydratedPlayer(page: Page) {
  await expect(page.getByRole('heading', { name: 'For you' })).toBeVisible();
  await expect(page.locator('[data-yaqmc="track-title"]')).toHaveText('Quiet Light');
  await expect(playerBar(page).getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
}

export async function waitForFakeShell(page: Page) {
  await expect(page.locator('.app-shell')).toHaveAttribute('data-provider-id', 'fake', {
    timeout: 60_000,
  });
}
