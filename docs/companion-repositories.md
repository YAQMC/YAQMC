# Companion repositories

> [简体中文](zh-CN/companion-repositories.md) | **English**

- [YAQMC/yaqmc-plugins](https://github.com/YAQMC/yaqmc-plugins) owns editable plugin examples, distributable packages, the copyable starter and its offline API reference.
- [YAQMC/yaqmc.github.io](https://github.com/YAQMC/yaqmc.github.io) owns the bilingual website, demo entry/song and GitHub Pages deployment at [yaqmc.github.io](https://yaqmc.github.io/).

The client keeps the host implementation, canonical SDK/WIT and API documentation. Runtime snapshots in `tests/fixtures/plugins` are offline regression inputs, not a second plugin catalog. Plugin and website builds no longer run as client Pages jobs.

The client validates API export on relevant `main` changes. Each companion repository checks the public client branch every 15 minutes and validates its mirror or renderer before committing the new revision. GitHub may delay scheduled jobs. Each workflow uses only its own repository's `GITHUB_TOKEN`; no personal token or cross-repository credential is stored. `UPSTREAM.json` records the source revision, and the starter API contract records source hashes. Manual workflow dispatch is available for immediate synchronization.

For local synchronization, clone the two companions beside the client, then run `npm run plugin:example:sync` and `node scripts/sync-companion-website.mjs`. The plugin repository's `npm run api:sync` rebuilds the mirror from its recorded public client revision. Each repository validates its own builds before publication.
