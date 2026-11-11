# Provider Component API

> [简体中文](zh-CN/provider-component-api.md) | **English**

Plugin API v3 freezes the `yaqmc:provider@0.1.0` WIT package. Its machine-readable operation inventory is
[`protocol-v0.1.json`](https://github.com/YAQMC/YAQMC/blob/main/wit/yaqmc-provider/protocol-v0.1.json); the WIT world and Host imports are
[`yaqmc-provider.wit`](https://github.com/YAQMC/YAQMC/blob/main/wit/yaqmc-provider/yaqmc-provider.wit). CI rejects drift between that inventory, Core's
Component adapter, renderer IPC fixtures, and the provider identity in the local OpenAPI schema.

## Envelope

Every Component exports one function:

```text
invoke(capability, operation, payload-json) -> result<string, string>
```

Requests and successful responses use bounded JSON. Guest errors use `{ code, message, retryable }`; Core sanitizes
their shape and never accepts a secret value in an error. This JSON envelope versions application DTOs independently
from the Component ABI. It does not grant authority: the Host checks the manifest capability before each dispatch,
and a Component can call only the imports present in its selected WIT world.

## Capabilities

| Capability                | Operation family                                        | Host behavior                                                                        |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `provider.catalog`        | search, entities, artist pages, Home, Discover, areas   | Validates and re-scopes every entity and provider reference.                         |
| `provider.playback`       | resolve, client fallback, quality selection             | Accepts only an opaque managed-cache or exact-origin HTTPS recipe; Core streams it.  |
| `provider.recommendation` | next continuation batch                                 | Fences results by provider/account generation and discards stale responses.          |
| `provider.lyrics`         | normalized lyric document                               | Validates bounded line/word timing and degrades independently.                       |
| `provider.comments`       | read-only song comments and replies                     | Renders a shared comment drawer and lyrics overlay; validates bounded pages.         |
| `provider.account`        | login, snapshot, library, favorites, playlist mutations | Binds state, cancellation, storage, and credential handles to one provider instance. |

The JSON fixture is the complete list of operation names. An implementation may return a sanitized
`unsupported-operation` error for optional account mutations, but it may not invent an undeclared capability or call
an operation under a different capability.

Frozen operations:

- `provider.catalog`: `catalog.search`, `catalog.song`, `catalog.album`, `catalog.artist`, `catalog.artist-page`,
  `catalog.playlist`, `catalog.home`, `catalog.discover`, `catalog.area`, `catalog.artwork-data-uri`.
- `provider.playback`: `playback.resolve`, `playback.resolve-client-fallback`,
  `playback.set-preferred-quality`, `playback.set-current-quality`.
- `provider.recommendation`: `recommendation.next`; `provider.lyrics`: `lyrics.get`.
- `provider.comments`: `comments.list`. See [Song comments](https://github.com/YAQMC/YAQMC/blob/main/docs/song-comments.md) for request/response, pagination, legacy compatibility and lifecycle.
- `provider.account`: `account.snapshot`, `account.restore-session`, `account.sign-out`, account library/playlist
  reads and mutations, plus the `account.auth.*` QR/OAuth lifecycle. The fixture is authoritative for every exact
  account operation name.

The fixture also commits one golden request/response for every capability, a sanitized permission-revocation error,
and disable/re-enable/account-generation lifecycle outcomes. The playback sample deliberately contains only a Host
cache recipe; it contains no media URL, request header, credential value, or filesystem path.

## Plugin-owned song badges

Platform labels are declared by plugins through [`songBadges` and `ui.songBadges`](plugin-manifest.md#declarative-song-badges).
The host contains no platform-to-label mapping. Direct songs match their validated provider ID; federated songs
match the original member's optional `provider.originProviderId`, assigned by the host and preserved through
nesting and persistence. Component responses cannot assign this host-owned field. Unknown sources stay unlabelled.

Playback, lyrics, comments, credentials and permissions still follow `providerId` / `profileId` / `trackId`.
The origin reference is display metadata and never grants routing authority. Labels disappear when the contributing
plugin is disabled or uninstalled. Older federated records without an origin reference need reloading for a label.

## Compatibility and lifecycle

The `network.request` JSON envelope accepts optional `responseJsonFields` when `responseFormat` is `json`.
It is a list of 1–128 unique, nonempty field names (at most 64 UTF-8 bytes each, without control characters).
For successful JSON responses, the Host recursively retains only those object keys before returning `bodyJson`;
array order and scalar values remain unchanged. Retained nesting is limited to 64 levels. Omitting the option
preserves the full response; error bodies retain their existing behavior. Network permissions, response byte limits,
and Component execution limits still apply.

Account snapshot `revision` and account page `authRevision` use the same Host-owned account generation. Reading an
unchanged snapshot preserves it; account state, identity, capabilities, and explicit login/session transitions can
advance it. Remote history may use `source: "provider-account"`; `qqmusic-account` remains valid for existing providers.

Manifest v1 / API v1-v2 packages keep their existing Worker, style, Scene, storage, and UI contracts. They do not
select a WIT world and cannot acquire API v3 Provider permissions. A manifest v2 package contains exactly one
Component and cannot mix legacy entrypoints.

Provider IDs remain attached to songs, queue entries, and catalog routes. Disabling/uninstalling a provider revokes
its in-flight calls and opaque sources. Automatic queue traversal skips its entries while the UI keeps them visibly
unavailable and removable. Re-enabling the same ID restores page and queue eligibility without cross-provider lookup.

The Component Model's WIT world is the explicit import/export boundary; see the Bytecode Alliance documentation on
[worlds](https://component-model.bytecodealliance.org/design/worlds.html) and
[`wit-bindgen`](https://github.com/bytecodealliance/wit-bindgen). YAQMC pins its concrete Host and guest versions in
the workspace and example lockfiles rather than relying on an unbounded toolchain.
