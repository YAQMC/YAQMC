import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, active = false, size = 'medium', className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
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
});
