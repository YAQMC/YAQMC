# Acknowledgements

> [简体中文](ACKNOWLEDGEMENTS.md) | **English**

YAQMC is an independently implemented, unofficial QQ Music desktop client. The people, projects, and tools below
provided public knowledge, observable protocol references, testing methods, or engineering assistance. Inclusion
does not imply endorsement, participation in a release, or support for YAQMC.

## Special thanks

- **Flechazo** — for publicly sharing research and engineering ideas around QMC/MFLAC, Master-quality source
  resolution, and local seekable stream decryption. `Flechazo/qmc` had no repository license when reviewed, so
  YAQMC used it only to corroborate behavior: no source was copied, vendored, or rewritten. YAQMC's Rust
  implementation and tests are independent.
- **[amll-dev/applemusic-like-lyrics](https://github.com/amll-dev/applemusic-like-lyrics)** — a behavioral and
  interaction reference for lyric timelines, interludes, and motion hierarchy. Upstream is `AGPL-3.0-only`;
  YAQMC uses neither its package nor its source code, and implements the renderer independently against its own
  domain model. See the [lyrics documentation](docs/lyrics.md#amll-decision) for the licensing decision.
- **OpenAI Codex / GPT-5.6 Sol** — for assistance with implementation, test design, code review, documentation,
  and release workflow.

## Interoperability research

`L-1124/QQMusicApi` was pinned to corroborate account, membership, source, and interoperability behavior. It is a
GPL-3.0-or-later research reference; YAQMC copied no GPL implementation and the project does not endorse YAQMC.
Pinned versions of `wxuyu/QQMusicApi`, `RethinkQAQ/allmusic-qqmusicapi`, `tlyanyu/multiPlatformMusicApi`, and
`wangwalk/qqm` were likewise consulted only for observable protocol behavior. Exact
commits, detected licenses, and boundaries are recorded in the
[QQ Music provider ledger](docs/qqmusic-provider.md). Those projects do not endorse YAQMC.

QMC/mflac interoperability independently adapts permitted behavior from the MIT-licensed QMCDecode project.
`miaosic` was used only to corroborate EVkey/quality behavior and is not an in-tree
implementation source. Reused copyright notices and complete license texts are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Thanks also to the maintainers of Rust, Electron, Chromium, React, Rodio/CPAL, and i18next. We retain historical
credit for the Tauri, WebKitGTK, and WebView2 maintainers whose work supported YAQMC's retired desktop host.
