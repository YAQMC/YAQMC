# YAQMC documentation

> [简体中文](zh-CN/README.md) | **English**

This directory contains the public engineering and operating documentation for YAQMC. Internal implementation
plans under `docs/plans/` and `docs/superpowers/` are historical development records rather than user guidance.

## Start here

- [Architecture](architecture.md)
- [Playback](playback.md) and [progressive streaming](streaming.md)
- [QQ Music provider](qqmusic-provider.md), [authentication](authentication.md),
  [account library](account-library.md), and [entitlement](entitlement.md)
- [Lyrics](lyrics.md) and [lyric surfaces](lyrics-surfaces.md)
- [Appearance](appearance.md), [design system](design-system.md), and
  [internationalization](i18n.md)
- [Linux runtime](linux.md), [Linux graphics](linux-graphics.md), and
  [platform integration](platform-integration.md)
- [Local API](local-api.md) and its [OpenAPI 3.1 schema](local-api.openapi.yaml)

## Acceptance records

- [Windows acceptance](windows-acceptance.md)
- [Linux acceptance](linux-acceptance.md)

Acceptance records distinguish deterministic or local evidence from real-account and real-device gates that remain
open. Do not promote a pending gate to “verified” without the evidence described by that record.
