# Binding migration amendment - 2026-08-16

This amendment is binding for the Electron migration. Where it conflicts with the retained source plan or an
earlier migration document, this amendment wins. It is additive: completed P0–P2 work remains in place and the
existing CHECK/Phase ordering remains in force.

## Protocol registry and payload boundaries

The 117-method protocol registry is a single source of truth. Every method record owns its public method name,
allowed origins, owner, timeout class, request-byte cap, and response-byte cap. Rust Core metadata, Electron Main
metadata, and TypeScript protocol metadata must be generated from that registry or mechanically checked against it;
hand-maintained three-way ACL lists are not allowed. TypeScript DTO mirrors may remain handwritten, provided their
registry-derived method metadata is checked.

The framed protocol has a **32 MiB absolute hard cap**. Ordinary request and response frames default to **1 MiB**;
each method has an explicit lower or higher method-specific cap, always no greater than the hard cap. On every
read, the implementation reads only the length prefix first, validates it against the hard and applicable method
limits, and only then allocates or reads the body.

The current 24 MiB background image becomes exactly 32 MiB when Base64-encoded before JSON framing, so it cannot fit
within the capped framed request. A 4 MiB `plugin_read_asset` payload becomes about 5.33 MiB in Base64 and exceeds
the ordinary limit. Later protocol work must use a controlled resource reference, chunking, or an explicitly reviewed
compatibility delta; it must not silently raise the hard cap.

## Human and live-account gates

P12's one-week daily-driver period is a **HUMAN GATE**. P14's three-day real-account soak, and every check using a
real account, are **LIVE_ACCOUNT GATE**s. Agents may prepare repeatable test packages, automation, observation
templates, and checklists. At each gate they pause for human evidence; they must never claim the gate passed from
agent-only execution.

## qm-api-rs transport and dependency policy

`ApiTransport` decoupling is mandatory before qm-api-rs integration. A reqwest 0.13 upgrade is conditional: it may
land only after full regression success. Version uniformity is not a reason to accept a protocol, transport,
timeout, redirect, cancellation, allowlist, or compatibility regression.

## Electron production security baseline

The production package must evaluate and verify Electron Fuses in the packaged application: disable `RunAsNode`,
`EnableNodeOptionsEnvironmentVariable`, and `EnableNodeCliInspectArguments`; enable `OnlyLoadAppFromAsar`. The
actual packaged fuse values are release evidence rather than development-only settings. Enable
`EnableEmbeddedAsarIntegrityValidation` only on Electron-supported targets (Windows and macOS); it is not a generic
Linux anti-tamper claim.

## Agent model policy

Subagents use Luna first and Terra if Luna is unavailable. This amendment does not change the root execution model
assigned by the environment.

## Git cutover and rollback

All migration development remains on `feat/electron-migration` and necessary child branches. Local and remote `main`
remain frozen, and the default release branch is unchanged, until the entire migration has passed automated checks and
final human acceptance.

Immediately before cutover, create both `backup/tauri-main` and the annotated `pre-electron-cutover` tag from the
same old `main` HEAD. Then integrate the accepted migration history into the existing `main`, preferring a
fast-forward and using a normal merge only when a fast-forward is impossible. Do not rename the old `main` or rename
the migration branch as a shortcut. Force-pushes and history rewrites are forbidden. After cutover, `main` is the
Electron release, while `backup/tauri-main` and `pre-electron-cutover` remain the Tauri rollback anchors.

No backup branch, tag, merge, default-branch change, or remote push is performed by recording this amendment.
