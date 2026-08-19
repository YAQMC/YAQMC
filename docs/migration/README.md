# Electron migration baseline

This directory is the execution record for the Electron migration. Facts in these documents are captured from the `bc55b7ddd2a57cde8987c96c7c20f0b7d4a2e742` Tauri baseline unless explicitly marked as a future migration decision.

- [P12 conditional-entry waiver — 2026-08-20](p12-conditional-entry.md) (Actions quota is **BLOCKED-EXTERNAL**, not a product FAIL; P11 not PASS; ACC-01..04 allowed; ACC-05 / P13 blocked)
- [P12 acceptance tracker ACC-01..04](acceptance-p12.md) (living; not ACC-05 sign-off)
- [Temporary maintainer handoff — 2026-08-18](HANDOFF_2026-08-18.md) (frozen at `1d6b535`; not current HUMAN state; ignore its “P12 not started” line)
- [HUMAN ledger from PLAY-01 — 2026-08-19](linux-human-2026-08-19.md) (this session plus handoff §4 already-tested rows; not a phase sign-off; maintainer HUMAN default is Linux Wayland — do not switch to X11 to fill skipped rows)
- [QA agent AUTO/LIVE ledger — 2026-08-19](qa-agent-2026-08-19.md) (Windows agent pass; PASS-AUTO / LIVE only; not phase sign-off)
- [Test baseline](test-baseline.md)
- [Release assets and compatibility delta](release-assets.md)
- [Governance and factual deltas](governance.md)
- [Command inventory](command-inventory.md)
- [Binding amendment - 2026-08-16](plan-amendment-2026-08-16.md)
- [Migration plan deltas](plan-deltas.md)
- [PLAY-01 playback checklist](p7-playback-checklist.md)
- [SOAK-01 / PLAY-03 soak notes](soak-p7.md)
- [PLAT-06 local API SSE smoke](plat06-local-api.md)
- [PLAT-05 MPRIS playerctl smoke](plat05-mpris.md)
- [PACK-02 Windows NSIS / portable script](pack02-windows.md)
- [PACK-03 Linux AppImage/deb/rpm/tar.gz script](pack03-linux.md)
- [CI-03 arm64 core / Electron pack commands](ci03-arm64.md)
- [CI-02 Electron package matrix](ci02-electron-package.md)
- [CI-04 Electron release draft](ci04-electron-release.md)
- [Parked LIVE VERIFY / Actions freeze (2026-08-18 overlay)](parked-live-verify.md)
- [ACCT-02 QR login / session checklist](acct02-qr-session.md)
- [ACCT-03 session continuity checklist](acct03-session-continuity.md)
- [Copyright, contributor, and source provenance audit](provenance-audit.md)

The source specification is retained verbatim at repository root as `YAQMC_ELECTRON_MIGRATION_PLAN.md`.
