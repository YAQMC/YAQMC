/** Desktop build boundary. Vite replaces this module for Android builds only. */
export const androidApp: {
  addListener(event: 'backButton', callback: () => void): Promise<{ remove(): Promise<void> }>;
  exitApp(): Promise<void>;
} = {
  async addListener() {
    throw new Error('Android app lifecycle is unavailable in a desktop build');
  },
  async exitApp() {
    throw new Error('Android app lifecycle is unavailable in a desktop build');
  },
};
