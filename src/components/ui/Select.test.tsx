import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const options = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

describe('Select', () => {
  it('opens, navigates, and selects with the keyboard', () => {
    const onChange = vi.fn();
    render(<Select value="system" options={options} onChange={onChange} ariaLabel="Color mode" />);
    const trigger = screen.getByRole('combobox', { name: 'Color mode' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('closes on Escape without changing the value', () => {
    const onChange = vi.fn();
    render(<Select value="dark" options={options} onChange={onChange} ariaLabel="Color mode" />);
    const trigger = screen.getByRole('combobox', { name: 'Color mode' });
    fireEvent.keyDown(trigger, { key: ' ' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not open while disabled', () => {
    render(
      <Select
        value="system"
        options={options}
        onChange={() => undefined}
        ariaLabel="Color mode"
        disabled
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
