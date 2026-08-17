import { describe, expect, it } from 'vitest';
import { dispatchPlayerCommand, setPlayerCommandAdapter } from './player-command-adapter';

describe('player command adapter', () => {
  it('coalesces rapid seeks so only the latest position is sent', async () => {
    const seeks: number[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    setPlayerCommandAdapter(async (command) => {
      if (command.type !== 'seek') return;
      calls += 1;
      seeks.push(command.positionMs);
      if (calls === 1) await first;
    });
    expect(dispatchPlayerCommand({ type: 'seek', positionMs: 1_000 })).toBe(true);
    expect(dispatchPlayerCommand({ type: 'seek', positionMs: 2_000 })).toBe(true);
    expect(dispatchPlayerCommand({ type: 'seek', positionMs: 3_000 })).toBe(true);
    release();
    await viWait(() => seeks.length === 2);
    expect(seeks).toEqual([1_000, 3_000]);
    setPlayerCommandAdapter(null);
  });
});

async function viWait(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error('timed out waiting for coalesced seeks');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
