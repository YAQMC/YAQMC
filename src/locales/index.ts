import { enUS } from './en-US';
import { zhCN } from './zh-CN';

export const defaultLocale = 'en-US' as const;
export const supportedLocales = ['en-US', 'zh-CN'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export const resources = {
  'en-US': enUS,
  'zh-CN': zhCN,
} as const;
