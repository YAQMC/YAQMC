import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearBlurredArtworkCache, renderBlurredArtwork } from './blurred-artwork';

vi.mock('stackblur-canvas', () => ({ canvasRGB: vi.fn() }));

let images: MockImage[];
class MockImage {
  width = 320;
  height = 320;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    images.push(this);
  }
}

beforeEach(() => {
  clearBlurredArtworkCache();
  images = [];
  vi.stubGlobal('Image', MockImage);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,result',
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearBlurredArtworkCache();
});

async function load(source: string) {
  const previous = images.length;
  const result = renderBlurredArtwork(source);
  if (images.length > previous) images.at(-1)!.onload!();
  await result;
}

it('deduplicates concurrent renders and evicts the least recently used cover', async () => {
  const one = renderBlurredArtwork('0');
  const two = renderBlurredArtwork('0');
  expect(one).toBe(two);
  expect(images).toHaveLength(1);
  images[0]!.onload!();
  await one;
  for (let index = 1; index < 8; index += 1) await load(String(index));
  await load('0');
  await load('8');
  expect(images).toHaveLength(9);
  await load('0');
  expect(images).toHaveLength(9);
  await load('1');
  expect(images).toHaveLength(10);
});

it('budgets source strings as well as output and does not cache oversize sources', async () => {
  const large = 'x'.repeat(9 * 1024 * 1024);
  await load(large + 'a');
  await load(large + 'b');
  await load(large + 'a');
  expect(images).toHaveLength(3);
  const oversize = 'x'.repeat(16 * 1024 * 1024);
  await load(oversize);
  await load(oversize);
  expect(images).toHaveLength(5);
});

it('does not repopulate a cleared cache from late work or remove a newer request', async () => {
  const old = renderBlurredArtwork('cover');
  clearBlurredArtworkCache();
  const fresh = renderBlurredArtwork('cover');
  images[0]!.onload!();
  await old;
  expect(renderBlurredArtwork('cover')).toBe(fresh);
  images[1]!.onload!();
  await fresh;
  await load('cover');
  expect(images).toHaveLength(2);
});

it('retries failures', async () => {
  const failed = renderBlurredArtwork('cover');
  images[0]!.onerror!();
  expect(await failed).toBeNull();
  await load('cover');
  expect(images).toHaveLength(2);
});
