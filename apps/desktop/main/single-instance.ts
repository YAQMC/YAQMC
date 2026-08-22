export type SingleInstanceApp = {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: (...args: unknown[]) => void): unknown;
};

export type MainWindowLike = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

/**
 * §11.4: one Electron instance so two cores cannot fight over SQLite / port 19532.
 * The second process focuses and shows the existing main window.
 */
export function acquireSingleInstanceLock(
  electronApp: SingleInstanceApp,
  getMainWindow: () => MainWindowLike | undefined,
): boolean {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }
  electronApp.on('second-instance', () => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });
  return true;
}
