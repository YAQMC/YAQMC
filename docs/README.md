# YAQMC documentation

> [简体中文](zh-CN/README.md) | **English**

This directory contains the public engineering and operating documentation for YAQMC. Internal implementation
plans under `docs/plans/` and `docs/superpowers/` are historical development records rather than user guidance.

## Start here

- [Architecture](architecture.md)
- [Playback](playback.md) and [progressive streaming](streaming.md)
- [QQ Music provider](qqmusic-provider.md), [authentication](authentication.md),
  [account library](account-library.md), [membership](account-membership.md), and
  [entitlement](entitlement.md)
- [Official-client interoperability](qqmusic-official-interoperability.md),
  [audio quality](audio-quality.md), [artwork](artwork.md), and [external URI security](deep-link.md)
- [Lyrics](lyrics.md), [lyric surfaces](lyrics-surfaces.md), and
  [lyrics presets](lyrics-presets.md)
- [Appearance](appearance.md), [design system](design-system.md), and
  [internationalization](i18n.md)
- [Linux runtime](linux.md), [Linux graphics](linux-graphics.md), and
  [platform integration](platform-integration.md)
- [Local API](local-api.md) and its [OpenAPI 3.1 schema](local-api.openapi.yaml)
- [Logging](logging.md), [diagnostics](diagnostics.md),
  [Issue reporting](issue-reporting.md), and [security & privacy](security.md)

## Acceptance records

- [Windows acceptance](windows-acceptance.md)
- [Linux acceptance](linux-acceptance.md)

Acceptance records distinguish deterministic or local evidence from real-account and real-device gates that remain
open. Do not promote a pending gate to “verified” without the evidence described by that record.
