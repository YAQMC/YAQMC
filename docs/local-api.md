# Local HTTP API

> [简体中文](zh-CN/local-api.md) | **English**

The embedded API is a local automation surface for widgets, scripts, status displays, Stream Deck-style
integrations, and future companion applications. It is not a public or LAN server.

## Security and lifecycle

- Disabled by default; while disabled there is no listening socket.
- Binds only to IPv4 loopback `127.0.0.1`. It never binds `0.0.0.0`.
- Defaults to port `19532`; the Settings page can change it without restarting the application.
- A random 256-bit bearer token is generated on first enable. The token is stored through the operating-system
  credential service, is never logged or written to SQLite/config JSON, and is shown only after an explicit reveal
  action. A legacy plaintext config token is migrated once and removed from the file.
- Regenerating the token restarts an active listener and immediately invalidates previous clients.
- Every `/v1` route requires authentication. `/health` is public and returns only service/version status.
- CORS is not enabled. Requests are limited to 16 KiB and JSON bodies reject unknown fields.
- There is no generic command, shell, filesystem-path, plugin-execution, or Tauri-invoke endpoint.
- Duplicate starts are idempotent. Stop uses Axum graceful shutdown, releases the port, and is also called on
  application exit. Bind failures are retained as status for the Settings UI.

The token protects the API from accidental browser access and ordinary local callers. It does not create a
security boundary against malware already running as the same operating-system user and able to read that
user's files or process memory.

## Enabling

Open **Settings > Local HTTP API**, choose a port, and enable the toggle. The UI reports `running`, `disabled`,
or `error`, the bound address, and the actual bound port. Reveal/copy the token only when configuring a local
client.

The checked-in [OpenAPI 3.1 description](./local-api.openapi.yaml) is the normative HTTP shape for v1.

## Authentication examples

PowerShell:

```powershell
$apiToken = '<token copied from Settings>'
$headers = @{ Authorization = "Bearer $apiToken" }
Invoke-RestMethod -Uri 'http://127.0.0.1:19532/v1/player' -Headers $headers
```

curl:

```bash
curl -H "Authorization: Bearer $YAQMC_API_TOKEN" \
  http://127.0.0.1:19532/v1/player
```

## Endpoints

| Method | Route                 | Purpose                                         |
| ------ | --------------------- | ----------------------------------------------- |
| `GET`  | `/health`             | Public, non-sensitive service health            |
| `GET`  | `/v1/player`          | Complete queue/playback snapshot                |
| `GET`  | `/v1/player/track`    | Current normalized track or `null`              |
| `GET`  | `/v1/player/queue`    | Queue tracks and active index                   |
| `POST` | `/v1/player/play`     | Resume the selected track                       |
| `POST` | `/v1/player/pause`    | Pause playback                                  |
| `POST` | `/v1/player/toggle`   | Toggle play/pause                               |
| `POST` | `/v1/player/next`     | Select the next track                           |
| `POST` | `/v1/player/previous` | Restart or select the previous track            |
| `PUT`  | `/v1/player/seek`     | Seek with `{ "positionMs": 123456 }`            |
| `PUT`  | `/v1/player/volume`   | Set normalized volume with `{ "volume": 0.72 }` |
| `PUT`  | `/v1/player/shuffle`  | Set shuffle with `{ "enabled": true }`          |
| `PUT`  | `/v1/player/repeat`   | Set repeat mode to `off`, `all`, or `one`       |
| `GET`  | `/v1/lyrics`          | Complete normalized lyric document or `null`    |
| `GET`  | `/v1/lyrics/current`  | Current structured line/word state              |
| `GET`  | `/v1/events`          | Server-Sent Events stream                       |

Controls return the resulting player snapshot. Position is integer milliseconds. Volume is a finite number
from `0.0` through `1.0`. Seek values beyond the current duration and volume values outside the range return
`422`.

`playbackState` distinguishes `idle`, `loading`, `buffering`, `playing`, `paused`, `stopped`, `ended`,
`recoverable-error`, and `fatal-error`. `playbackDurationMs` is the decoded source duration (which may be an
official preview) and `playbackError` is a stable `{ code, message, retryable }` object when present.

Example control:

```powershell
$body = @{ positionMs = 45000 } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri 'http://127.0.0.1:19532/v1/player/seek' `
  -Headers $headers -ContentType 'application/json' -Body $body
```

## Event stream

Connect with the bearer header:

```bash
curl -N -H "Authorization: Bearer $YAQMC_API_TOKEN" \
  http://127.0.0.1:19532/v1/events
```

The connection starts with `player.snapshot`, then emits meaningful transitions:

- `player.playback`, `player.track`, `player.position`, `player.volume`, `player.mode`
- `queue.changed`
- `lyrics.changed`, `lyrics.line`, `lyrics.word`

Position events are capped at four per second. Line and word events occur only at timing boundaries. Every
event contains `version`, `type`, Unix `timestampMs`, and structured `data`; clients can interpolate position
between snapshots.

## Errors

Errors never contain stack traces or secrets:

```json
{
  "error": {
    "code": "position_out_of_range",
    "message": "positionMs exceeds the current track duration."
  }
}
```

Authentication failures return `401`; malformed or out-of-range JSON returns `422`; controls requiring a
selected track return `409`.
