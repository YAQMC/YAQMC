import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SelectProps<Value extends string> {
  value: Value;
  options: readonly SelectOption<Value>[];
  onChange: (value: Value) => void;
  ariaLabel: string;
  disabled?: boolean;
  icon?: LucideIcon;
  className?: string;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function Select<Value extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  icon: Icon,
  className = '',
}: SelectProps<Value>) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selected = options[selectedIndex] ?? options[0];

  const updatePosition = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 7;
    const availableBelow = window.innerHeight - rect.bottom - gap - 10;
    const availableAbove = rect.top - gap - 10;
    const estimatedHeight = Math.min(options.length * 46 + 12, 320);
    const openAbove =
      availableBelow < Math.min(estimatedHeight, 180) && availableAbove > availableBelow;
    const maxHeight = Math.max(96, Math.min(320, openAbove ? availableAbove : availableBelow));
    const width = Math.max(rect.width, 180);
    const left = Math.min(Math.max(10, rect.left), window.innerWidth - width - 10);
    setPosition({
      top: openAbove
        ? Math.max(10, rect.top - Math.min(estimatedHeight, maxHeight) - gap)
        : rect.bottom + gap,
      left,
      width,
      maxHeight,
    });
  }, [options.length]);

  const firstEnabled = (direction: 1 | -1, from = activeIndex): number => {
    for (let step = 1; step <= options.length; step += 1) {
      const index = (from + direction * step + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return from;
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex);
        setOpen(true);
      } else {
        setActiveIndex((index) => firstEnabled(event.key === 'ArrowDown' ? 1 : -1, index));
      }
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(options.findIndex((option) => !option.disabled));
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      let lastEnabled = options.length - 1;
      while (lastEnabled > 0 && options[lastEnabled]?.disabled) lastEnabled -= 1;
      setActiveIndex(lastEnabled);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(activeIndex);
      else {
        setActiveIndex(selectedIndex);
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const closeForOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener('pointerdown', closeForOutsidePointer, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', closeForOutsidePointer, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const activeOption = menu.current?.querySelector<HTMLElement>('[data-active="true"]');
    activeOption?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ui-select__trigger ${className}`.trim()}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => {
          setActiveIndex(selectedIndex);
          setOpen((current) => !current);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && menu.current?.contains(next)) return;
          window.setTimeout(() => {
            if (!menu.current?.contains(document.activeElement)) setOpen(false);
          });
        }}
      >
        {Icon && <Icon size={16} aria-hidden="true" />}
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-listbox`}
            className="ui-select__menu"
            role="listbox"
            aria-label={ariaLabel}
            style={
              {
                '--select-top': `${position.top}px`,
                '--select-left': `${position.left}px`,
                '--select-width': `${position.width}px`,
                '--select-max-height': `${position.maxHeight}px`,
              } as CSSProperties
            }
          >
            {options.map((option, index) => (
              <div
                id={`${id}-option-${index}`}
                key={option.value}
                className="ui-select__option"
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={activeIndex === index || undefined}
                data-selected={option.value === value || undefined}
                tabIndex={-1}
                onPointerMove={() => !option.disabled && setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className="ui-select__check">
                  {option.value === value && <Check size={14} aria-hidden="true" />}
                </span>
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
