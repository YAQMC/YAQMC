# Account library

> [简体中文](zh-CN/account-library.md) | **English**

QQ Music account pages and mutations are implemented; live account acceptance is pending. Public catalog routes
remain usable in guest mode and do not depend on this subsystem.

## Surfaces and state

The main WebView exposes Favorites, Account playlists, Recently played when advertised, and owned-playlist detail.
The sidebar's "Library" entry was removed because it duplicated the "Playlists" page (both rendered the account
playlist grid); only the Playlists entry remains. The `AccountMusicProvider` contract is separate from
`MusicProvider`, and `isAccountMusicProvider` gates account UI at runtime. Desktop Lyrics and Lyrics Island have no
account capability.

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

## Playlist detail normalization

`CgiGetDiss` requires `disstid` as a numeric JSON value together with the full parameter set
(`dirid`/`tag`/`userinfo`/`orderlist`/`onlysonglist`); a string `disstid` makes QQ Music return `req.code 10004`
("not accessible"), which is surfaced to the UI as a distinct `unavailable` library error rather than a generic
protocol message.

For self-created (owned) and collected playlists the detail `dirinfo` may come back with an empty title, creator,
and timestamp. `playlist_tracks` therefore falls back to the metadata already held from the playlist list for the
title, description, owner, and update time; for owned playlists the empty creator falls back to the signed-in
account nickname. This prevents "QQ Music" and a 1970 year from being rendered.

## Playlist list normalization

The self-created playlist read (`GetPlaylistByUin`) returns every self-created playlist in a single response and
must not receive `sin`/`ein` pagination parameters, which truncate the result. Only `dirId 201` denotes the
Favorite Songs folder; `dirId 1` is a regular self-created playlist and is normalized as `Owned` (treating it as
favorites previously collapsed real playlists into the favorites collection by id). Favorite Songs and owned
playlists belong to the signed-in account, so an empty `creator`/`nick` falls back to the account nickname.

The frontend loads playlist pages automatically (`autoLoadAll`) until the list is terminal, so the grid shows all
playlists without requiring a "Load more" click. A playlist that fails normalization is dropped individually with a
`qqmusic.playlist` warn carrying its `tid`/`dirId`/`name` (sanitized) and the error, instead of failing the whole
page silently.

Normalization failures emit a `qqmusic.playlist` warn with the request context, the CGI `code`/`req_code`/
`subcode`, a redacted response preview, and a structural `shape` summary of the `req.data` object (key set,
`songlist`/`cdlist` counts, `dirinfo` fields) so a schema drift or routing change is diagnosable from logs.

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
