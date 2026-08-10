import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export function IconButton({
  label,
  children,
  active = false,
  size = 'medium',
  className = '',
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-active={active || undefined}
      className={`icon-button icon-button--${size} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}
