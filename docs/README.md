# YAQMC documentation

> [简体中文](zh-CN/README.md) | **English**

This directory contains the public engineering and operating documentation for YAQMC. Internal implementation
plans under `docs/plans/` and `docs/superpowers/` are historical development records rather than user guidance.

## Start here

- [Architecture](architecture.md)
- [Development](development.md) and [data locations, upgrades, and uninstall](data-locations.md)
- [Playback](playback.md) and [progressive streaming](streaming.md)
- [QQ Music provider](qqmusic-provider.md), [authentication](authentication.md),
  [home recommendations](home-recommendations.md), [discover page](discover.md),
  [account library](account-library.md),
  [membership](account-membership.md), and [entitlement](entitlement.md)
- [Official-client interoperability](qqmusic-official-interoperability.md),
  [audio quality](audio-quality.md), [artwork](artwork.md), and [external URI security](deep-link.md)
- [Lyrics](lyrics.md), [lyric surfaces](lyrics-surfaces.md),
  [lyrics presets](lyrics-presets.md), and [lyrics composer](lyrics-composer.md)
- [Appearance](appearance.md), [design system](design-system.md), and
  [internationalization](i18n.md)
- [Plugin platform](plugin-platform.md), [manifest](plugin-manifest.md),
  [security](plugin-security.md), [development](plugin-development.md),
  [example plugins](plugin-examples.md),
  [style API](plugin-style-api.md), and [scene API](plugin-scene-api.md)
- [Linux runtime](linux.md), [Linux graphics](linux-graphics.md), and
  [platform integration](platform-integration.md)
- [Local API](local-api.md) and its [OpenAPI 3.1 schema](local-api.openapi.yaml)
- [Logging](logging.md), [diagnostics](diagnostics.md),
  [Issue reporting](issue-reporting.md), and [security & privacy](security.md)
- [CI, caches, and downloadable artifacts](ci.md)
- [Electron migration execution archive](migration/README.md)

## Acceptance records

- [Windows acceptance](windows-acceptance.md)
- [Linux acceptance](linux-acceptance.md)

Acceptance records distinguish deterministic or local evidence from real-account and real-device gates that remain
open. Do not promote a pending gate to “verified” without the evidence described by that record.
