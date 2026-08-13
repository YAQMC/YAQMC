# Security policy

> [简体中文](SECURITY.md) | **English**

Do not open a public issue for an unpatched vulnerability, usable credential, or real account data. Use GitHub
[Private vulnerability reporting](https://github.com/YAQMC/YAQMC/security/advisories/new) with the affected
version/platform, a minimal harmless reproduction, expected/actual behavior, prerequisites, impact, and an optional
fix suggestion.

Remove cookies, OAuth codes, tokens, vkeys/ekeys, signed URLs, real UINs, profile values, playlist names, and full
response bodies. If sensitive evidence is unavoidable, first describe its type in the private report and wait for a
safe transfer method.

High-priority scope includes OAuth/state bypass, secret disclosure, lyric-WebView privilege escalation, path
traversal, arbitrary file/command access, local API authentication bypass, cross-account cache contamination,
entitlement bypass, and build/update supply-chain defects. Tencent compatibility drift, expected subscription or
regional restrictions, Wayland compositor limitations, and ordinary bugs without security impact are not security
vulnerabilities.

The `0.1.x` beta line receives security fixes. Earlier development snapshots are not guaranteed backports. No fixed
response SLA is promised, but valid reports will be triaged and addressed without unnecessarily widening exposure.
