# Complete Rust platform Provider Component

This deterministic API v3 example exercises every frozen provider capability without embedding an upstream route in
YAQMC. It is a development fixture, not a production music service. Build and package it from the repository root:

```text
rustup target add wasm32-wasip2
npm run plugin:build:provider-platform-example
npm run plugin:pack:provider-platform-example
```

The same `wasm32-wasip2` component package is used on Windows and Linux, x64 and arm64. The guest is `no_std`; JSON uses
only an allocator, and the Host supplies the explicit WIT imports declared by `provider-account`.

## Capability and recovery model

| Capability                | Example behavior                                                                    | Primary threat                                                    | Host boundary and recovery                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.catalog`        | Search, entity detail, Home, and Discover fixtures                                  | Malformed or oversized entity graphs                              | Core validates depth, node count, strings, and DTO shape. Disable the plugin or retry after a fixed package update.                                                                     |
| `provider.playback`       | Creates a short WAV fixture in the managed cache and returns an opaque cache recipe | Leaking paths, URLs, headers, or stale account authority          | Only Core receives the recipe. Disable/account-change revokes existing opaque sources; re-enable resolves a fresh source.                                                               |
| `provider.recommendation` | Returns one deterministic continuation item                                         | Late responses crossing an account switch                         | Core fences results by provider account generation. Retry starts a new provider-scoped continuation.                                                                                    |
| `provider.lyrics`         | Returns line-timed fixture lyrics                                                   | Invalid timing or unbounded text                                  | Core validates the frozen response envelope. Failure degrades to unavailable lyrics without affecting playback.                                                                         |
| `provider.account`        | Synthetic OAuth completion stores one plugin-private credential handle              | OAuth state confusion or access to another provider's credentials | Host creates state/attempt IDs, restricts exact origins, namespaces handles, and never returns a secret. Sign out deletes the handle; uninstall with data removal clears the namespace. |

The authorization origin is deliberately `https://accounts.example.com`. Automated tests complete the callback locally;
the example must not be used for a real account. Updating the package to add any capability or origin requires a new
permission review. Existing Plugin API v1/v2 examples remain separate and unchanged.
