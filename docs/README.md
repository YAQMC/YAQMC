# YAQMC documentation

> [简体中文](zh-CN/README.md) | **English**

This directory contains the public user, tester, contributor, and release documentation for YAQMC.

## Users

- Getting started: [data locations, upgrades, and uninstall](data-locations.md),
  [appearance](appearance.md), and [Linux runtime](linux.md)
- Browsing and accounts: [authentication](authentication.md), [account library](account-library.md),
  [membership](account-membership.md), [home recommendations](home-recommendations.md), and
  [Discover](discover.md)
- Listening: [playback](playback.md), [progressive streaming](streaming.md),
  [audio quality](audio-quality.md), [listening statistics](listening-statistics.md), and [artwork](artwork.md)
- Lyrics: [lyrics](lyrics.md), [desktop surfaces](lyrics-surfaces.md),
  [presets](lyrics-presets.md), and [composer](lyrics-composer.md)
- Help: [Issue reporting](issue-reporting.md), [diagnostics](diagnostics.md), and
  [security & privacy](security.md)

## Contributors

- Start with the [feature roadmap](roadmap.md), [development](development.md), [architecture](architecture.md),
  [design system](design-system.md), and [internationalization](i18n.md)
- Core boundaries: [provider contract](provider-contract.md), [QQ Music provider](qqmusic-provider.md),
  [entitlement](entitlement.md), [caching](caching.md), and [platform integration](platform-integration.md)
- Interoperability: [QQ Music artwork](qqmusic-artwork.md),
  [official-client evidence](qqmusic-official-interoperability.md), and [external URI security](deep-link.md)
- Integrations: [local API](local-api.md) with its [OpenAPI 3.1 schema](local-api.openapi.yaml)

## Plugin authors

- [Platform](plugin-platform.md), [manifest](plugin-manifest.md), [Provider Component API](provider-component-api.md),
  [security](plugin-security.md), and [development](plugin-development.md)
- [Example plugins](plugin-examples.md), [style API](plugin-style-api.md), and
  [scene API](plugin-scene-api.md)

## Testing and release

- [CI, caches, and artifacts](ci.md), [logging](logging.md), and [Linux graphics](linux-graphics.md)
- [Windows acceptance](windows-acceptance.md) and [Linux acceptance](linux-acceptance.md)
- [Release and compliance records](release/README.md)

Acceptance records distinguish deterministic checks from real-account and real-device evidence. A pending gate must
not be described as verified without the evidence required by its acceptance record.
