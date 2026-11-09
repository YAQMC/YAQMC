import type { Session } from 'electron';
import { isUpdateUrlAllowed, type UpdateFetch } from './update-io';

/** Chromium fetch rejects manual redirects; enforce the same policy on its network requests. */
export function createElectronUpdateFetch(updaterSession: Session): UpdateFetch {
  const hops = new Map<number, number>();
  const filter = { urls: ['<all_urls>'] };
  updaterSession.webRequest.onBeforeRequest(filter, (request, callback) => {
    const count = (hops.get(request.id) ?? 0) + 1;
    hops.set(request.id, count);
    callback({ cancel: !isUpdateUrlAllowed(request.url) || count > 6 });
  });
  updaterSession.webRequest.onCompleted(filter, ({ id }) => hops.delete(id));
  updaterSession.webRequest.onErrorOccurred(filter, ({ id }) => hops.delete(id));
  return (url, init) => {
    if (!isUpdateUrlAllowed(url)) return Promise.reject(new Error('update-redirect-denied'));
    return updaterSession.fetch(url, { ...init, credentials: 'omit', redirect: 'follow' });
  };
}
