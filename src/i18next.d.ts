import 'i18next';
import type { resources } from './locales';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof resources)['en-US'];
    returnNull: false;
    strictKeyChecks: true;
    enableSelector: false;
  }
}
