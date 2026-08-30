# Song sharing and deep links

> [简体中文](zh-CN/deep-link.md) | **English**

The song page, Player Bar, lyrics page, and track menus expose the same provider-neutral share actions:

- **Copy public song link** uses only the HTTPS URL returned by the provider. YAQMC does not construct a provider
  website route in React. If the provider has no public URL, the app explains the unavailable action instead of
  guessing a link.
- **Copy YAQMC link** creates
  `yaqmc://catalog/<provider>/song?id=<percent-encoded-id>`.
- **Copy song and artist** is the text-only fallback and never presents itself as a clickable URL.

Installed desktop builds register the `yaqmc` protocol. A valid link focuses the existing main window (or opens one
instance) and navigates to song details. It never starts playback, signs in, changes an account, opens a lyrics
surface, or forwards input to an external shell. The integration can be disabled under **Settings → Desktop
integration**; the same page reports whether the operating system accepted protocol registration. Development and
portable builds do not register themselves as the system handler, avoiding a stale temporary executable path.

## Accepted grammar

Electron Main accepts only the exact catalog-song shape above. The parser limits the complete URI to 2,048 bytes and
the decoded entity ID to 256 bytes. It rejects credentials, ports, fragments, unknown or repeated query parameters,
control characters, invalid percent escapes, unsupported entities, and invalid provider IDs. Windows/Linux
`second-instance`, macOS `open-url`, and cold-start arguments all use this one pure parser.

External URIs remain untrusted input. A parsed value becomes only a typed “open song details” renderer event; it does
not become a shell argument, filesystem path, HTML fragment, SQL statement, or arbitrary host/Core command. Auxiliary
lyrics windows do not receive this event. Product links opened from About remain separately allowlisted by
`apps/desktop/main/open-external.ts`.

Implementation follows Electron's [Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)
single-instance guidance.
