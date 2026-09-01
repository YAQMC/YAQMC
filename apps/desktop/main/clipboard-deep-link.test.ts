import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClipboardDeepLinkMonitor, SELF_SHARE_SUPPRESSION_MS } from './clipboard-deep-link';

const firstLink = 'yaqmc://catalog/qqmusic/song?id=qqmusic%3Atrack%3A000qgbM90wbOxx';
const secondLink = 'yaqmc://catalog/qqmusic/song?id=qqmusic%3Atrack%3A001';

afterEach(() => vi.useRealTimers());

describe('clipboard deep-link fallback', () => {
  it('ignores startup contents and accepts each new valid link only once', () => {
    vi.useFakeTimers();
    let clipboard = firstLink;
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.start();
    monitor.setActive(true);
    vi.advanceTimersByTime(2_000);
    expect(accept).not.toHaveBeenCalled();

    clipboard = secondLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledWith({
      providerId: 'qqmusic',
      entityId: 'qqmusic:track:001',
    });
    vi.advanceTimersByTime(2_000);
    expect(accept).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('suppresses a YAQMC link written by the app, including a quick copy-away and copy-back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.start();
    monitor.setActive(true);
    monitor.noteSelfWrite(firstLink);
    clipboard = firstLink;
    vi.advanceTimersByTime(1_000);
    clipboard = 'copy-away';
    vi.advanceTimersByTime(1_000);
    clipboard = firstLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).not.toHaveBeenCalled();

    clipboard = 'copy-away-again';
    vi.advanceTimersByTime(SELF_SHARE_SUPPRESSION_MS);
    clipboard = firstLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('ignores links copied while inactive and re-baselines before resuming', () => {
    vi.useFakeTimers();
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const readText = vi.fn(() => clipboard);
    const monitor = createClipboardDeepLinkMonitor({
      readText,
      accept,
    });

    monitor.start();
    monitor.setActive(true);
    expect(readText).toHaveBeenCalledOnce();
    monitor.setActive(false);
    clipboard = firstLink;
    vi.advanceTimersByTime(2_000);
    expect(readText).toHaveBeenCalledOnce();
    monitor.setActive(true);
    expect(readText).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    expect(accept).not.toHaveBeenCalled();

    clipboard = 'ordinary text';
    vi.advanceTimersByTime(1_000);
    clipboard = firstLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('does not replay an accepted link after the main window loses and regains focus', () => {
    vi.useFakeTimers();
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.start();
    monitor.setActive(true);
    clipboard = firstLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).toHaveBeenCalledOnce();

    monitor.setActive(false);
    vi.advanceTimersByTime(2_000);
    monitor.setActive(true);
    vi.advanceTimersByTime(2_000);
    expect(accept).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('fails closed for malformed, padded, and oversized clipboard text', () => {
    vi.useFakeTimers();
    let clipboard = 'ordinary text';
    const accept = vi.fn();
    const monitor = createClipboardDeepLinkMonitor({
      readText: () => clipboard,
      accept,
    });

    monitor.start();
    monitor.setActive(true);
    for (const value of [
      ` ${firstLink}`,
      `${firstLink}\n`,
      'yaqmc://invalid',
      `yaqmc:${'x'.repeat(3_000)}`,
    ]) {
      clipboard = value;
      vi.advanceTimersByTime(1_000);
    }
    expect(accept).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('recovers from clipboard read failures without treating the first readable value as new', () => {
    vi.useFakeTimers();
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

    monitor.start();
    monitor.setActive(true);
    fail = false;
    vi.advanceTimersByTime(1_000);
    expect(accept).not.toHaveBeenCalled();
    clipboard = secondLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('continues polling when navigation handling rejects one clipboard link', () => {
    vi.useFakeTimers();
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

    monitor.start();
    monitor.setActive(true);
    clipboard = firstLink;
    vi.advanceTimersByTime(1_000);
    clipboard = secondLink;
    vi.advanceTimersByTime(1_000);
    expect(accept).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
