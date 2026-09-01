import { describe, expect, it, vi } from 'vitest';
import { createClipboardDeepLinkMonitor } from './clipboard-deep-link';

const firstLink = 'yaqmc://catalog/qqmusic/song?id=qqmusic%3Atrack%3A000qgbM90wbOxx';
const equivalentFirstLink = 'yaqmc://catalog/qqmusic/song?id=qqmusic:track:000qgbM90wbOxx';
const secondLink = 'yaqmc://catalog/qqmusic/song?id=qqmusic%3Atrack%3A001';

describe('clipboard deep-link fallback', () => {
  it('reads only while enabled and focused, using the first read as a baseline', () => {
    let clipboard = 'ordinary text';
    const readText = vi.fn(() => clipboard);
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({ readText, accept });

    monitor.setFocused(true);
    expect(readText).not.toHaveBeenCalled();

    monitor.setEnabled(true);
    expect(readText).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();

    monitor.setFocused(false);
    clipboard = firstLink;
    expect(readText).toHaveBeenCalledOnce();

    monitor.setFocused(true);
    expect(readText).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledOnce();
    monitor.setFocused(true);
    expect(readText).toHaveBeenCalledTimes(2);

    monitor.setEnabled(false);
    monitor.setFocused(false);
    monitor.setFocused(true);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it('accepts a link copied in another app when YAQMC regains focus', () => {
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    monitor.setFocused(false);
    clipboard = firstLink;
    monitor.setFocused(true);

    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith({
      providerId: 'qqmusic',
      entityId: 'qqmusic:track:000qgbM90wbOxx',
    });
  });

  it('never parses the same song target twice during one app session', () => {
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    for (const value of [firstLink, 'ordinary text', equivalentFirstLink, firstLink]) {
      monitor.setFocused(false);
      clipboard = value;
      monitor.setFocused(true);
    }
    expect(accept).toHaveBeenCalledOnce();

    monitor.setFocused(false);
    clipboard = secondLink;
    monitor.setFocused(true);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it('never parses a YAQMC link copied by YAQMC itself during the same session', () => {
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    monitor.noteSelfWrite(firstLink);
    for (const value of [firstLink, 'ordinary text', equivalentFirstLink, firstLink]) {
      monitor.setFocused(false);
      clipboard = value;
      monitor.setFocused(true);
    }

    expect(accept).not.toHaveBeenCalled();
  });

  it('does not replay the current link after repeated window switches', () => {
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    monitor.setFocused(false);
    clipboard = firstLink;
    monitor.setFocused(true);
    for (let index = 0; index < 5; index += 1) {
      monitor.setFocused(false);
      monitor.setFocused(true);
    }

    expect(accept).toHaveBeenCalledOnce();
  });

  it('fails closed for malformed, padded, and oversized clipboard text', () => {
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    for (const value of [
      ` ${firstLink}`,
      `${firstLink}\n`,
      'yaqmc://invalid',
      `yaqmc:${'x'.repeat(3_000)}`,
    ]) {
      monitor.setFocused(false);
      clipboard = value;
      monitor.setFocused(true);
    }
    expect(accept).not.toHaveBeenCalled();
  });

  it('recovers from read failures without treating the first readable value as new', () => {
    let fail = true;
    let clipboard = firstLink;
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => {
        if (fail) throw new Error('clipboard unavailable');
        return clipboard;
      },
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    monitor.setFocused(false);
    fail = false;
    monitor.setFocused(true);
    expect(accept).not.toHaveBeenCalled();

    monitor.setFocused(false);
    clipboard = secondLink;
    monitor.setFocused(true);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('consumes a rejected navigation once and continues with later links', () => {
    let clipboard = 'ordinary text';
    const accept = vi
      .fn<(target: { providerId: string; entityId: string }) => void>()
      .mockImplementationOnce(() => {
        throw new Error('window unavailable');
      });
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.setEnabled(true);
    monitor.setFocused(true);
    for (const value of [firstLink, 'ordinary text', firstLink, secondLink]) {
      monitor.setFocused(false);
      clipboard = value;
      monitor.setFocused(true);
    }

    expect(accept).toHaveBeenCalledTimes(2);
  });
});
