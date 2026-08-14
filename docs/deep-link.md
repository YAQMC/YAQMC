# External URI and deep-link security

> [简体中文](zh-CN/deep-link.md) | **English**

All external URIs are untrusted input. YAQMC currently has no QQ Music takeover handler because the installed
Windows 22.52 client did not provide a verified public entity scheme. See
[official interoperability evidence](qqmusic-official-interoperability.md).

Any future implementation must be opt-in and reversible; allowlist exact schemes, actions, entities, lengths, and
identifier syntax; normalize only to provider domain references; and reject unknown or injection-like values. URI
content must never become a shell argument, filesystem path, HTML fragment, SQL statement, or arbitrary Tauri
command. Auxiliary lyrics WebViews must not receive this capability.

The About page uses Tauri's official opener plugin with a capability scope restricted to the configured YAQMC GitHub
repository. It does not accept user-supplied URLs.
