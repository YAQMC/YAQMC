# Plugins page and plugin store

> [简体中文](zh-CN/plugin-store.md) | **English**

**Plugins** is a top-level destination: in the desktop sidebar's application group (before **Settings**) and as the
fifth item of the Android bottom navigation and tablet rail. It replaces the plugin section that used to live in
Settings. The page has two tabs, **Plugin Management** (default) and **Plugin Store**. Tabs are part of the route, so
Back returns to the previous tab; both panels stay mounted once opened, so searches and filters survive a tab switch.
The page never waits for the selected music provider, so it works while a platform is offline, signed out or disabled.

Plugin-defined API v4 pages keep their own `plugin-page` routes. They are listed under **Plugin pages** in the sidebar
(also on Android now) and as shortcuts at the top of Plugin Management, so a phone without a sidebar can still reach
them.

## Plugin Management

The toolbar searches installed plugins (name, ID, description, authors), filters by status (active, disabled, needs
attention), installs a local `.yaqmc-plugin`, checks **signed** updates, and refreshes. _Check signed updates_ only
reaches plugins bound to a trusted source described in [Plugin updates](plugin-updates.md); it never implies that a
store package updates itself.

Cards show status in text; failed and incompatible plugins show the host's reason. Enable/disable and **Details** are
primary actions; replacement, diagnostics and uninstall are in the card's secondary menu. Details contain permissions,
API and platforms, source (local file, plugin store repository, trusted source), repository link, release, hash,
diagnostics and the plugin's own settings form; for example the music plugin's `isolated` / `aggregate` mode.
Safe Mode, Developer Mode and unpacked folders are under **Advanced**. Loading unpacked folders is desktop-only.

## Plugin Store

Discovery uses anonymous, read-only GitHub REST calls made by Core (never the renderer):

- `GET /search/repositories` with the mandatory qualifier `topic:yaqmc-plugin`. User text is tokenized; qualifiers,
  boolean operators, negation and grouping are removed, so input can only narrow results. The field selector maps to
  GitHub semantics: default fields, `in:name`, `in:description`, `user:<login>` or `repo:<owner>/<repo>`.
- `GET /repos/{owner}/{repo}/releases` per repository, ten releases per page, on demand. Drafts are never shown;
  prereleases only when _Include prereleases_ is selected. The store prefetches release summaries for at most twelve
  cards with two concurrent requests and stops when GitHub reports a rate limit.

Results are bounded (20 per page, 10 pages), deduplicated by repository ID and re-checked for the topic. Responses are
cached in memory for five minutes and revalidated with `ETag`; if GitHub is offline or rate-limited, the last good
response is shown and marked as saved. `incomplete_results` is surfaced. 403/429 responses become a localized
message with the reset time from `Retry-After` or `X-RateLimit-Reset`; quotas are never hard-coded. Older searches
cannot overwrite newer ones.

A package candidate is a release asset whose name ends exactly (case-insensitively) with `.yaqmc-plugin` and whose
state is `uploaded`. Source archives, checksums, `.yaqmc-plugin.sig`, installers, APKs and Actions artifacts are not
candidates. A repository is not a plugin ID: if a release has several packages the user chooses one; the store only
preselects the single package or the single package whose name targets the current platform. Names are hints; the
downloaded manifest decides plugin ID, API and platforms.

Ownership by the `YAQMC` GitHub organization is labelled; every other owner is labelled **Community**. Neither label
means a signature was verified.

## Installation and trust boundary

**Download and review** sends `{ owner, repo, releaseId, assetId }` to `plugin_update_prepare` as `github`. The renderer
never passes a URL or path. Core then:

1. re-reads the repository (it must still carry the topic), the release (not a draft) and the asset (package suffix,
   uploaded, size within the 32 MiB component package limit);
2. downloads `https://api.github.com/repos/{owner}/{repo}/releases/assets/{id}` through the existing update HTTP
   client: HTTPS only, at most three redirects, each hop restricted to `api.github.com`, `github.com`,
   `release-assets.githubusercontent.com` or `objects.githubusercontent.com`, DNS results pinned and private, loopback
   and transition addresses rejected, no credentials or cookies, connect/inactivity/total timeouts, cancellation;
3. streams into the operation's private staging directory with an exact size check and compares the SHA-256 with the
   digest GitHub publishes, when present;
4. runs the normal package inspection and preparation (path, file-count, size and compression-ratio limits, manifest,
   compatibility, permissions) and shows the review.

Applying uses only that prepared operation, so the reviewed bytes are the installed bytes. Store installs are always
**unverified**: the review requires confirmation, sensitive permissions require explicit grants, and the plugin
records the source `github:<owner>/<repo>/releases/<id>`. Replacing a plugin ID that came from another repository,
from a local file, or from a trusted source adds the **source-change** confirmation. Store installs never enter the
trusted update sources and never update automatically. A second click while an operation for the same asset is still
running joins that operation. Progress and the final state come from Core's operation records, so reopening the page
after navigation reconnects to them.

`plugin_store_search` and `plugin_store_releases` are main-window methods. Errors are stable codes such as
`store-rate-limited:<resetMs>`, `store-offline`, `store-timeout`, `store-not-found`,
`store-not-a-plugin-repository`, `store-asset-unavailable`, `store-asset-too-large` and
`store-asset-digest-mismatch`.

## Publishing a plugin

Add the `yaqmc-plugin` topic to the repository and attach the built `.yaqmc-plugin` to a GitHub Release. Actions
artifacts are not visible to the store. `YAQMC/yaqmc-music-providers` ships a tag/manual release workflow for this.
As of 2026-11-06 its public release list was empty, so the store correctly reports _No releases_ for it until a
maintainer publishes one.
