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
- **OpenAI Codex / GPT-5.6 Sol** — for assistance with implementation, test design, code review, documentation,
  and release workflow. The project maintainer remains responsible for product choices, account operations, legal
  decisions, and releases.

## Interoperability research

Pinned versions of `L-1124/QQMusicApi`, `wxuyu/QQMusicApi`, `RethinkQAQ/allmusic-qqmusicapi`,
`tlyanyu/multiPlatformMusicApi`, and `wangwalk/qqm` were consulted only for observable protocol behavior. Exact
commits, detected licenses, and boundaries are recorded in the
[QQ Music provider ledger](docs/qqmusic-provider.md). Those projects do not endorse YAQMC.

QMC/mflac interoperability also independently adapts permitted behavior from the MIT-licensed QMCDecode, Unlock
Music, and miaosic projects. Reused dependencies, copyright notices, and complete license texts are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Thanks also to the maintainers of Rust, Tauri, React, Rodio/CPAL, i18next, WebKitGTK, WebView2, and the broader open
ecosystem on which YAQMC is built.
