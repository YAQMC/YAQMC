import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.yaqmc.android',
  appName: 'YAQMC',
  webDir: '../../dist-android',
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
