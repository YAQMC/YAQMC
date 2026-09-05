import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from './account-runtime';
import { useSafeArtworkSource } from './artwork-source';
import { ProviderContext } from './provider-context';

export interface AccountIdentity {
  avatarUrl: string | null;
  initial: string;
  label: string;
  summary: string;
  providerName: string;
}

export function useAccountIdentity(): AccountIdentity {
  const { t } = useTranslation('navigation');
  const provider = useContext(ProviderContext);
  const accountSnapshot = useAccountStore((state) => state.snapshot);
  const authenticated = accountSnapshot.state === 'authenticated';
  const profile = authenticated ? accountSnapshot.profile : null;
  const entitlement = authenticated ? accountSnapshot.entitlement : null;
  const providerName = provider?.displayName ?? 'YAQMC';
  const providerLabel = provider?.id === 'qqmusic' ? t('qqGuest') : providerName;
  const label = profile?.nickname ?? t('listener');
  const avatarUrl = useSafeArtworkSource(safeAccountAvatarUrl(profile?.avatarUrl), {
    pendingRemote: 'hide',
  });

  return {
    avatarUrl,
    initial: Array.from(label.trim())[0] ?? 'L',
    label,
    summary: entitlement
      ? t('accountSummary', {
          tier: t(`accountTier.${entitlement.tier}`),
          membership: t(`accountMembership.${entitlement.membership}`),
        })
      : providerLabel,
    providerName,
  };
}

export function safeAccountAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['qpic.y.qq.com', 'q.qlogo.cn', 'thirdwx.qlogo.cn', 'thirdqq.qlogo.cn'].includes(
        url.hostname,
      ) &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
