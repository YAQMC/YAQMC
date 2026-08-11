import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  releaseAccountDialogOwnership,
  useAccountStore,
  type AccountRuntimeError,
} from '../application/account-runtime';
import { useMusicProvider } from '../application/provider-context';
import type { AccountSnapshot } from '../domain/music';
import { isAccountMusicProvider } from '../providers/music-provider';

function isOwnedState(snapshot: AccountSnapshot): boolean {
  return (
    snapshot.state === 'starting-login' ||
    snapshot.state === 'waiting-for-scan' ||
    snapshot.state === 'waiting-for-confirmation'
  );
}

function safeQrProjection(value: string | null): string | null {
  return value &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg);base64,[a-z0-9+/]+={0,2}$/i.test(value)
    ? value
    : null;
}

function stateMessage(
  snapshot: AccountSnapshot,
  error: AccountRuntimeError | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (error) {
    return t(
      (
        {
          network: 'errorNetwork',
          authorization: 'errorAuthorization',
          'secure-store': 'errorSecureStore',
          protocol: 'errorProtocol',
          unknown: 'errorUnknown',
        } satisfies Record<AccountRuntimeError, string>
      )[error],
    );
  }
  switch (snapshot.state) {
    case 'guest':
      return t('guest');
    case 'restoring-session':
      return t('restoring');
    case 'starting-login':
      return t('starting');
    case 'waiting-for-scan':
      return t('waitingScan');
    case 'waiting-for-confirmation':
      return t('waitingConfirmation');
    case 'expired':
      return t('expired');
    case 'rejected':
      return t('rejected');
    case 'cancelled':
      return t('cancelled');
    case 'network-error':
      return t('networkError');
    case 'protocol-error':
      return t('protocolError');
    case 'authenticated':
      return t('authenticated', { nickname: snapshot.profile.nickname });
    case 'session-expired':
      return t('sessionExpired');
    case 'reauthentication-required':
      return t('reauth');
    case 'secure-store-unavailable':
      return t('secureStore');
  }
}

export function AccountDialog() {
  const provider = useMusicProvider();
  const { t } = useTranslation('accountDialog');
  const { t: common } = useTranslation('common');
  const dialogOpen = useAccountStore((state) => state.dialogOpen);
  const snapshot = useAccountStore((state) => state.snapshot);
  const displayedQrImageDataUri = useAccountStore((state) => state.displayedQrImageDataUri);
  const busy = useAccountStore((state) => state.busy);
  const error = useAccountStore((state) => state.error);
  const closeDialog = useAccountStore((state) => state.closeDialog);
  const startLogin = useAccountStore((state) => state.startLogin);
  const cancelLogin = useAccountStore((state) => state.cancelLogin);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const accountProvider = isAccountMusicProvider(provider) ? provider : null;

  useEffect(() => {
    if (dialogOpen) closeRef.current?.focus();
  }, [dialogOpen]);

  useEffect(
    () => () => {
      if (
        accountProvider &&
        useAccountStore.getState().dialogOpen &&
        isOwnedState(useAccountStore.getState().snapshot)
      ) {
        releaseAccountDialogOwnership(accountProvider);
      }
    },
    [accountProvider],
  );

  if (!dialogOpen || !accountProvider) return null;

  const qrImage =
    snapshot.state === 'waiting-for-scan' ? safeQrProjection(displayedQrImageDataUri) : null;
  const effectiveError =
    snapshot.state === 'waiting-for-scan' && displayedQrImageDataUri && !qrImage
      ? 'protocol'
      : error;
  const waiting = isOwnedState(snapshot);
  const canStart =
    snapshot.state === 'guest' ||
    snapshot.state === 'cancelled' ||
    snapshot.state === 'rejected' ||
    snapshot.state === 'network-error' ||
    snapshot.state === 'protocol-error' ||
    snapshot.state === 'expired' ||
    snapshot.state === 'session-expired' ||
    snapshot.state === 'reauthentication-required';

  const close = () => void closeDialog(accountProvider);
  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input') ??
        [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="account-dialog-backdrop">
      <div
        ref={dialogRef}
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-dialog-title"
        onKeyDown={trapFocus}
      >
        <header className="account-dialog__header">
          <div>
            <p>{t('eyebrow')}</p>
            <h2 id="account-dialog-title">{t('title')}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="button button--quiet account-dialog__close"
            onClick={close}
          >
            {common('close')}
          </button>
        </header>

        <div className="account-dialog__body">
          {qrImage && (
            <div className="account-dialog__qr">
              <img src={qrImage} alt={t('scanAlt')} />
            </div>
          )}
          <p role="status">{stateMessage(snapshot, effectiveError, t)}</p>
          {canStart && <small className="account-dialog__notice">{t('oauthNotice')}</small>}
          {busy && <small>{t('busy')}</small>}
        </div>

        <footer className="account-dialog__actions">
          {canStart && (
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void startLogin(accountProvider, 'qq')}
            >
              {t('signInQq')}
            </button>
          )}
          {canStart && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void startLogin(accountProvider, 'wechat')}
            >
              {t('signInWechat')}
            </button>
          )}
          {waiting && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void cancelLogin(accountProvider)}
            >
              {t('cancel')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
