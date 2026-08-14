import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContextMenuSurface, type ContextMenuItem } from './ui/ContextMenu';

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const textInputTypes = new Set(['text', 'search', 'url', 'tel', 'email', 'password']);

function editableTarget(value: EventTarget | null): EditableTarget | null {
  if (!(value instanceof Element)) return null;
  const target = value.closest('input, textarea, [contenteditable="true"]');
  if (target instanceof HTMLInputElement) {
    return textInputTypes.has(target.type) && !target.disabled ? target : null;
  }
  if (target instanceof HTMLTextAreaElement) return target.disabled ? null : target;
  return target instanceof HTMLElement ? target : null;
}

function selectedText(target: EditableTarget): string {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() ?? '';
}

function isReadOnly(target: EditableTarget): boolean {
  return (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.readOnly
  );
}

function selectAll(target: EditableTarget): void {
  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.select();
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(target);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function replaceSelection(target: EditableTarget, text: string): void {
  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.setRangeText(text, start, end, 'end');
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
    return;
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  document.execCommand('copy');
}

export function ApplicationContextMenu() {
  const { t } = useTranslation('common');
  const [state, setState] = useState<{
    target: EditableTarget;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = editableTarget(event.target);
      if (!target) {
        setState(null);
        return;
      }
      const bounds = target.getBoundingClientRect();
      setState({
        target,
        position: {
          x: event.clientX || bounds.left + Math.min(24, bounds.width / 2),
          y: event.clientY || bounds.bottom,
        },
      });
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  if (!state) return null;
  const { target, position } = state;
  const readOnly = isReadOnly(target);
  const selection = selectedText(target);
  const items: readonly ContextMenuItem[] = [
    {
      id: 'cut',
      label: t('cut'),
      disabled: readOnly || selection.length === 0,
      action: async () => {
        await writeClipboard(selection);
        replaceSelection(target, '');
      },
    },
    {
      id: 'copy',
      label: t('copy'),
      disabled: selection.length === 0,
      action: () => writeClipboard(selection),
    },
    {
      id: 'paste',
      label: t('paste'),
      disabled: readOnly || !navigator.clipboard?.readText,
      action: async () => replaceSelection(target, await navigator.clipboard.readText()),
    },
    { id: 'select-all', label: t('selectAll'), action: () => selectAll(target) },
  ];

  return (
    <ContextMenuSurface
      label={t('editingMenu')}
      position={position}
      items={items}
      onClose={() => setState(null)}
    />
  );
}
