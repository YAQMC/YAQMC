# Issue reporting

> [简体中文](zh-CN/issue-reporting.md) | **English**

The Issue Reporter turns a user report into a fully prefilled GitHub Issue
form without ever holding a GitHub token. The user is always the party that
clicks Submit.

## Entry points

- **Settings → About → Report a problem** — the primary entry point for
  general feedback.
- **Settings → Diagnostics & logging → Report a problem** — the same dialog,
  positioned next to the bundle exporter for maintainers walking users
  through a bug.
- **Error surfaces → Report this issue** — opens the dialog with the linked
  error code and correlation ID prefilled.

The dialog is `src/components/IssueReporterDialog.tsx`. It uses the native
HTML `<dialog>` element for modality and focus trapping.

## Workflow

```
Report problem
    ↓
choose category (Bug / Linux / Playback / Provider / Lyrics / UI / Other)
    ↓
enter short summary + description
    ↓
review preview (title + body composed by Rust)
    ↓
optionally generate diagnostic ZIP
    ↓
Open GitHub (default browser)
    ↓
YAQMC reveals the ZIP in the file manager
    ↓
user reviews the form and presses Submit themselves
```

Every arrow above is a distinct user action. **YAQMC never auto-submits an
issue.** The only network activity is the user's browser session hitting
`github.com`.

## Categories

The initial category set is deliberately small (one dropdown, seven values):

| Slug       | Label               | Template                  |
| ---------- | ------------------- | ------------------------- |
| `bug`      | Bug report          | `bug-report.yml`          |
| `linux`    | Linux compatibility | `linux-compatibility.yml` |
| `playback` | Playback / audio    | `bug-report.yml`          |
| `provider` | QQ Music / account  | `bug-report.yml`          |
| `lyrics`   | Lyrics              | `bug-report.yml`          |
| `ui`       | UI / appearance     | `bug-report.yml`          |
| `other`    | Other               | `bug-report.yml`          |

Adding a Scene category later is expected and does not require any schema
change beyond appending to `IssueCategory::ALL` and mapping the new template.

## GitHub URL prefill

Rust composes the URL in `src-tauri/src/issue_reporter.rs::compose_url`.
Supported GitHub Issue Form query parameters are used:

- `template=` — the target Issue Form file.
- `title=` — the localized title with the category prefix (`[Bug]`,
  `[Linux]`).
- `labels=` — `needs-triage,reporter:<slug>` so maintainer triage rules can
  detect reporter-originated issues.
- Body field ID — either `diagnostics=` for the bug-report form or
  `evidence=` for the Linux compatibility form. Each maps to the
  corresponding Issue Form field.
- `area=` — pre-selects the dropdown value on the bug-report form when the
  category maps to a known area.

The generated URL is capped at 6 000 characters. If the composed body pushes
past that limit the dialog surfaces a warning, and the user can fall back to
**Copy issue text** and paste the body manually.

## Prefilled fields

Every generated body includes:

- summary,
- steps/details,
- YAQMC version + short commit,
- build channel + type,
- OS + architecture,
- renderer (WebView2 on Windows, `WebKitGTK <version>` on Linux),
- audio backend + resolved policy + host,
- provider mode + connection + membership tier (never secrets),
- log level + session ID,
- optional linked error code + correlation ID,
- optional attached bundle file name.

Log content is **never** embedded in the URL. The bundle attachment is
handled through the browser file picker manually after GitHub opens.

## Preview + Copy issue text

Before opening the browser, the dialog shows:

- rendered title,
- rendered body,
- which Issue Form template will be used,
- which fields will be prefilled,
- a warning banner when the URL exceeds the browser limit.

`Copy issue text` copies `title` + `\n\n` + `body` to the clipboard so the
workflow still works if `openUrl` fails or the browser rejects the URL.

## Diagnostic bundle attachment

Because Issue Forms do not accept file uploads via query parameters, the
workflow is:

1. `handleGenerateBundle` invokes `diagnostics_export_bundle`.
2. `handleOpen` calls `openIssueUrl` after validating the URL — the browser
   opens the prefilled Issue.
3. The dialog then calls `diagnostics_reveal_bundle` to reveal the ZIP in the
   platform file manager (`explorer /select` on Windows, `xdg-open` on
   Linux).
4. A small hint reminds the user to drag the ZIP into the Issue attachment
   area.

There is no browser DOM automation and no attempt to programmatically press
GitHub's Submit button.

## Browser open security

`openIssueUrl` calls `issue_reporter_validate_url` (Rust) before invoking
`openUrl` (Tauri opener plugin). The Rust check requires that the URL:

- starts with `https://github.com/YAQMC/YAQMC/issues/new`,
- contains no whitespace,
- is under the 6 000-character soft limit.

The opener capability in `src-tauri/capabilities/main-window.json`
(`opener:allow-open-url` with a scoped `url` allowlist) restricts the
plugin to the same GitHub Issues origin+path. Both checks must pass before
the browser sees the URL.

No GitHub OAuth is used. YAQMC does not read browser cookies. If the user
happens to be logged into GitHub in their browser already, the browser
transparently reuses that session; that is the extent of the "GitHub
integration".

## Error codes

When a report is linked to an application error, we prepopulate a stable
error code. The taxonomy lives in `src-tauri/src/error_codes.rs` and follows
the pattern `YAQMC-<DOMAIN>-<REASON>`, e.g.:

```
YAQMC-QQ-AUTH-COOKIES-INVALID
YAQMC-QQ-SOURCE-NO-MATCH
YAQMC-AUDIO-OUTPUT-OPEN-FAILED
YAQMC-AUDIO-DECODE-UNSUPPORTED
YAQMC-LYRICS-FETCH-FAILED
YAQMC-NETWORK-RANGE-STALLED
YAQMC-UI-EVENT
```

The frontend logger auto-attaches `YAQMC-UI-EVENT` to any `logger.error(...)`
call so even legacy call sites participate in the ring buffer.

## What the reporter will not do

- Ask for a GitHub token.
- Store or read GitHub credentials.
- Automate the Submit button.
- Upload the diagnostic bundle for you.
- Contact any third-party service.
- Emit telemetry.
