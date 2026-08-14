import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationContextMenu } from './ApplicationContextMenu';

describe('application context menu policy', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue('pasted'), writeText: vi.fn() },
    });
  });

  it('suppresses the browser menu over blank application areas', () => {
    render(
      <>
        <ApplicationContextMenu />
        <div data-testid="blank">Blank</div>
      </>,
    );

    const allowed = fireEvent.contextMenu(screen.getByTestId('blank'));
    expect(allowed).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows localized editing actions and pastes into an editable field', async () => {
    render(
      <>
        <ApplicationContextMenu />
        <input aria-label="Search" defaultValue="query" />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement;

    fireEvent.contextMenu(input, { clientX: 80, clientY: 40 });
    expect(screen.getByRole('menu', { name: 'Editing actions' })).toBeVisible();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paste' }));

    await waitFor(() => expect(input.value).toBe('querypasted'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
