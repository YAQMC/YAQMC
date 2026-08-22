# External URI and deep-link security

> [简体中文](zh-CN/deep-link.md) | **English**

All external URIs are untrusted input. YAQMC currently has no QQ Music takeover handler because the installed
Windows 22.52 client did not provide a verified public entity scheme. See
[official interoperability evidence](qqmusic-official-interoperability.md).

The packaged application registers no custom URI scheme and does not parse
launch arguments into catalog or playback commands. “Deep link” therefore
describes a deferred capability, not a hidden or partially supported feature.

Any future implementation must be opt-in and reversible; allowlist exact schemes, actions, entities, lengths, and
identifier syntax; normalize only to provider domain references; and reject unknown or injection-like values. URI
content must never become a shell argument, filesystem path, HTML fragment, SQL statement, or arbitrary host/Core
IPC command. Auxiliary lyrics renderers must not receive this capability.

The About page asks Electron Main to call `shell.openExternal`; the allowlist in
`apps/desktop/main/open-external.ts` restricts it to configured YAQMC links. It does not accept user-supplied URLs.
