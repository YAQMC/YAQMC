# Official QQ Music interoperability evidence

> [简体中文](zh-CN/qqmusic-official-interoperability.md) | **English**

This page separates local evidence from reference research. It does not document a stable public QQ Music API.

## Local Windows evidence

Read-only inspection on 2026-08-14 used an installed QQ Music desktop client on a non-system volume. No files,
registry entries, credentials, or official-client settings were changed.

| Artifact               | Version | Authenticode                                         | SHA-256                                                            |
| ---------------------- | ------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `QQMusic.exe`          | 22.52   | Valid; Tencent Technology (Shenzhen) Company Limited | `4FC8AE4EF8390AE351E67EB493CED60B1205664C48A6E4D653659A391A5CC1E2` |
| `QQMusic_Protocol.dll` | 22.52   | Valid; Tencent Technology (Shenzhen) Company Limited | `D098182A33A9026D0C5B1BCBDF1367EA0EDF1BE3448E17CCB62FBD8469E895BB` |
| `QQMusicAsso.dll`      | 22.52   | Valid; Tencent Technology (Shenzhen) Company Limited | `060231A81CE4107E772DBE74CDC6E1777A5BC28B57304DAE9AAABBADB5438E26` |

Windows registered file associations for `.mflac`, `.mgg`, `.mmp4`, `.qmc0/2/3/4/6/8`, `.qmcflac`, `.qsc3`,
and `.tkm`. Their open command is the signed client executable with `/play "%1"`. Inspection of registered URL
protocols found no QQ Music-owned song, album, playlist, or artist scheme. The protocol DLL contains internal parser
interfaces, but an internal symbol is not evidence of a public Windows URI contract.

## Deep-link decision

YAQMC does not register, parse, or take over a guessed QQ Music URI scheme in this branch. No current Windows 22.52
entity URI grammar was verified, so implementing historical `qqmusic://` examples would create an unaudited protocol
surface and could steal an unrelated handler. Consequently there is no opt-in takeover setting to expose or restore.

If a future official-client build registers a scheme, verification must capture the exact registry owner and command,
exercise sanitized song/album/playlist/artist fixtures against the official client, and recheck the behavior after
restart. Only then may YAQMC add an allowlisted parser and reversible opt-in registration.

## Open-source references

`L-1124/QQMusicApi` at commit `108617ffe80abefec6358717b9f4d3677550db10` was used as a GPL-3.0-or-later
interoperability research reference. No GPL implementation was copied into YAQMC. The complete reference ledger and
other pinned projects are in [QQ Music provider](qqmusic-provider.md); credit and license boundaries are in the
repository [acknowledgements](../ACKNOWLEDGEMENTS-EN.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).

Tencent and QQ Music do not endorse YAQMC. Provider behavior can change without notice, so the deterministic tests
use sanitized fixtures rather than proprietary binaries or live account credentials.
