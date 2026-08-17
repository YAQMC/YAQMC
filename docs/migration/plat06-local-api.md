# PLAT-06: Local API external-consumer smoke

Maintainer script: `node scripts/migration/plat06-local-api-sse.mjs`

The script hits FACT loopback `127.0.0.1:19532` (override with `YAQMC_API_HOST` /
`YAQMC_API_PORT`):

1. `GET /health` — public, no `Authorization` header
2. `GET /v1/player` — `Authorization: Bearer <token>`
3. `GET /v1/events` — SSE; read a few events, then exit

Copy the token from **Settings > Local HTTP API** reveal, or set `YAQMC_API_TOKEN`.
The script does not start `yaqmc-core` and does not enable the API.

Port conflicts after a host crash: leftover `yaqmc-core` can keep `19532` bound.
Core writes `{data}/core.pid`; the Electron supervisor kills that PID only when
the process image name is `yaqmc-core` / `yaqmc-core.exe`. See the existing note
in [Local HTTP API](../local-api.md). This checkpoint does not rewrite that
security model.

## LIVE VERIFY

**Pending.** CI covers the script against a tiny mock HTTP+SSE server
(`scripts/ci/plat06-local-api-sse.test.mjs`, `npm run ci:test-scripts`). A
maintainer run against a real enabled Local API is still required.

## Checkpoint

The 32 MiB protocol hard cap is unchanged. Provenance remains **BLOCKED**.
