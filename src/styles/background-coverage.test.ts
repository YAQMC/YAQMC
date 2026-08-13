import { afterEach, describe, expect, it } from 'vitest';
import './index.css';

describe('application background viewport coverage', () => {
  afterEach(() => document.body.replaceChildren());

  it.each(['cover', 'contain'] as const)(
    'keeps a custom image pinned to the entire viewport in %s mode',
    (fit) => {
      document.body.innerHTML = `<div class="app-background" data-mode="image" data-fit="${fit}"><img class="app-background__image" /></div>`;
      const layer = document.querySelector<HTMLElement>('.app-background')!;
      const image = document.querySelector<HTMLElement>('.app-background__image')!;
      const layerStyle = getComputedStyle(layer);
      const imageStyle = getComputedStyle(image);

      expect(layerStyle.position).toBe('fixed');
      expect(layerStyle.width).toBe(`${window.innerWidth}px`);
      expect(layerStyle.height).toBe(`${window.innerHeight}px`);
      expect(imageStyle.maxWidth).toBe('none');
      expect(imageStyle.width).toBe('100%');
      expect(imageStyle.height).toBe('100%');
      expect(imageStyle.objectFit).toBe(fit);
    },
  );
});
