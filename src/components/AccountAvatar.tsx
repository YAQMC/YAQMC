import { useTranslation } from 'react-i18next';
import type { AccountIdentity } from '../application/account-identity';

export function AccountAvatar({
  identity,
  className,
}: {
  identity: AccountIdentity;
  className: string;
}) {
  const { t } = useTranslation('navigation');
  return identity.avatarUrl ? (
    <img
      className={className}
      src={identity.avatarUrl}
      alt={t('accountAvatar', { nickname: identity.label })}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className={className} aria-hidden="true">
      {identity.initial}
    </span>
  );
}
