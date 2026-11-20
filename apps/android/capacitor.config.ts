import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.yaqmc.android',
  appName: 'YAQMC',
  webDir: '../../dist-android',
  android: {
    // The MV proxy is HTTP on loopback; network_security_config permits no other cleartext host.
    allowMixedContent: true,
    captureInput: true,
  },
};

export default config;
