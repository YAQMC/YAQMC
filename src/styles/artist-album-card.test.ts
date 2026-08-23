import { describe, expect, it } from 'vitest';
import './index.css';

describe('artist album preview card button reset', () => {
  it('removes native button chrome from the entity card', () => {
    document.body.innerHTML =
      '<button class="artist-page__album-card" type="button">Album</button>';

    const card = document.querySelector<HTMLElement>('.artist-page__album-card');
    expect(card).not.toBeNull();
    expect(getComputedStyle(card!).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(card!).borderTopWidth).toBe('0px');
    expect(getComputedStyle(card!).paddingTop).toBe('0px');
    expect(getComputedStyle(card!).fontFamily).toBe(getComputedStyle(document.body).fontFamily);
    expect(getComputedStyle(card!).appearance).toBe('none');
  });
});
