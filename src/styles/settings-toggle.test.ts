import { afterEach, describe, expect, it } from 'vitest';
import './index.css';

describe('settings surface toggle layout', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('keeps the toggle thumb vertically centered instead of inheriting description spacing', () => {
    document.body.innerHTML = `
      <div class="settings-surface__header">
        <div><strong>Lyrics Island</strong><span>Description</span></div>
        <button class="toggle-switch" type="button"><span></span></button>
      </div>
    `;

    const thumb = document.querySelector<HTMLElement>('.toggle-switch > span');
    expect(thumb).not.toBeNull();
    expect(getComputedStyle(thumb!).marginTop).toBe('0px');
  });
});
