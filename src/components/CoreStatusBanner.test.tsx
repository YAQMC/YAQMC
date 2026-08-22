import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CoreStatusPayload } from '@yaqmc/client';
import { CoreStatusBanner, type CoreStatusSubscribe } from './CoreStatusBanner';

function controlledSubscribe(): {
  subscribe: CoreStatusSubscribe;
  emit: (payload: CoreStatusPayload) => void;
} {
  let handler: ((payload: CoreStatusPayload) => void) | undefined;
  return {
    subscribe: (next) => {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
    emit: (payload) => handler?.(payload),
  };
}

describe('CoreStatusBanner', () => {
  it('stays inert when the host channel is silent', () => {
    const { container } = render(<CoreStatusBanner subscribe={() => () => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows restarting and hides again on ready', () => {
    const { subscribe, emit } = controlledSubscribe();
    render(<CoreStatusBanner subscribe={subscribe} />);
    act(() => emit({ status: 'restarting' }));
    expect(screen.getByRole('status')).toHaveTextContent('Playback engine restarting…');
    act(() => emit({ status: 'ready' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows safe-mode without offering auto-resume', () => {
    const { subscribe, emit } = controlledSubscribe();
    render(<CoreStatusBanner subscribe={subscribe} />);
    act(() => emit({ status: 'safe-mode' }));
    expect(screen.getByRole('status')).toHaveAttribute('data-status', 'safe-mode');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
