# Account library

QQ Music account pages and mutations are implemented; live account acceptance is pending. Public catalog routes
remain usable in guest mode and do not depend on this subsystem.

## Surfaces and state

The main WebView exposes Favorites, Account playlists, Recently played when advertised, and owned-playlist detail.
The `AccountMusicProvider` contract is separate from `MusicProvider`, and `isAccountMusicProvider` gates account UI
at runtime. Desktop Lyrics and Lyrics Island have no account capability.

Each list resource has explicit idle, loading, ready, empty, stale, account-required,
reauthentication-required, and error states. Loading another page preserves coherent data. A network/protocol
failure can keep eligible cached data visibly marked stale; an authentication failure never does. React request
generations and abort signals prevent obsolete routes, pages, or sessions from overwriting the current view.

## Paging and projection

Native code converts provider cursors into random outward cursors held in a bounded, generation/resource-scoped
registry. Raw provider cursors and identity fields do not enter React or SQLite. Favorites use a two-minute cache;
playlist summaries/details and recent history use five minutes. Cache keys contain a random account scope and a
cursor digest.

A first-page refresh opens a projection epoch. Additional pages accumulate without dropping earlier pages; the
complete projection is atomically swapped only at the terminal page. A restart refetches a cached nonterminal first
page before issuing a new outward cursor. Offline stale fallback is terminal so it never exposes an unusable next
cursor.

## Mutation outcomes

Favorites and playlist mutations accept an opaque client operation ID and return one of four statuses:

- `applied`: the write response explicitly confirms success;
- `rejected`: the provider explicitly rejects the write;
- `reconciled`: an uncertain response was followed by a safe read that proves the requested state;
- `outcome-unknown`: bounded reconciliation could not prove either outcome.

Account writes are never automatically retried. A timeout may mean the provider applied the write, so the service
uses operation-specific reads: favorite membership, unique playlist-summary difference, lossless owned-playlist
edit metadata, track membership, or playlist absence. Same-entity writes are serialized, concurrent duplicate
operations are rejected before transport, and a bounded completed-operation cache makes a repeated operation ID
return the prior result without repeating the write.

Only owned playlists are mutable. Rename is disabled unless the current detail contains every edit field needed to
preserve description, image, and tags losslessly. Collected playlists cannot be renamed, edited, or deleted.
Projection and affected page-cache changes use one SQLite batch; a failure rolls back the batch. The auth
generation and opaque scope are rechecked around transport, reconciliation, and cache commit, so logout or account
replacement cannot repopulate an old library.

## Live acceptance safety

The deterministic fixture matrix covers pagination, restart, stale fallback, auth expiry, successful/rejected/
uncertain writes, rollback, concurrent operations, and logout/login-swap races. The live gate must use one uniquely
named temporary playlist, verify add/remove/rename behavior, remove any test track, and delete the playlist before
recording cleanup success. Favorite testing snapshots the original state, toggles once, verifies it, and restores
the original state. Recently played may be recorded as not supported only when the authenticated capability snapshot
does not advertise it.

The fixed-schema recorder accepts only check/result/classification enums and timestamps. It cannot store arbitrary
notes, URLs, profile values, playlist names, cookies, or response bodies. See [authentication](authentication.md),
[caching](caching.md), [entitlement](entitlement.md), and [the provider ledger](qqmusic-provider.md).
