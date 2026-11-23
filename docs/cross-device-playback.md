# Experimental QQ Music cross-device playback

> [简体中文](zh-CN/cross-device-playback.md) | **English**

The device icon in the player controls is available on native desktop and Android hosts for an authenticated QQ Music
profile. It reads the other client's recent current-playlist snapshot. Reading or refreshing never changes playback.
The preview shows the current song, queue size and upstream timestamp. Confirmation replaces the local queue, starts
the current song from its beginning and issues one explicit listening-state report.

The snapshot contains no exact seek position, playback mode, paused flag or stable device identifier. It is not play
history. A valid song ID and timestamp are required; snapshots older than their positive card lifetime (capped at five
minutes), or five minutes when no lifetime is present, are ignored. The queue is limited to 100 entries, with duplicates
and order preserved; the current song is included even when it lies outside that slice. Unsupported music types or
missing metadata are omitted and indicated as an incomplete queue. An unavailable current song prevents the attempt.

## What is and is not verified

The current integration uses qm-api-rs `065a50c06606a2377ee8044c036ce3f659a914f0` and its audited mobile-format
`GetOtherPlatCurrentPlaylist` / `ListeningMusicReport` calls. Android uses the Android CGI profile with QIMEI and
GetSession; desktop uses Desktop. Each installation/profile/platform retains its device identity across requests and
restarts. Account-generation changes invalidate cached sessions. The latter reports duration and remaining
time in milliseconds, normal speed, the locally started song and its actual queue. It does not use the experimental
Windows report whose native time units remain unconfirmed.

There is no verified dedicated takeover command or acknowledgment of the original device's pause. A returned report
call is displayed separately from local playback; the library's permissive receipt decoder is not treated as proof
of remote pause or even an authoritative takeover acknowledgment. This feature is an opt-in interoperability experiment,
with no automatic takeover or write replay after ambiguous failure. It does not implement a remote pause receiver.

**Share playback with my other devices** is off by default and persisted per profile. Enable it on each YAQMC device
to make ordinary full-track playback discoverable. Core samples the authoritative local player every three seconds,
reports playback/pause/seek/queue transitions once and sends a fresh position report every 15 seconds while playing.
Official previews are excluded. Disabling cancels pending sharing work; account changes clear the previous report
status. Network failures never interrupt local playback. The displayed report status is not proof of remote pause.

Live WeChat-login reports returned business code `405` with `errmsg="wx login"`, yet the other device could read
an updated song and queue. This receipt therefore does not prove that state publication failed. YAQMC keeps it
unconfirmed, never replays the same explicit takeover, and continues sampling later player states when sharing is
enabled. The observed source device did not pause automatically. A restored queue must load an actual playback
source before sharing can report it.

Successful empty snapshots may return `playList: null`. YAQMC normalizes that field to an empty queue for this
request before SDK decoding. Other malformed playlist shapes still fail.

`provider_device_playback_preview`, `provider_device_playback_takeover` and `provider_device_playback_sharing` are
main-window RPCs, scoped to the exact
provider/profile. Core retains one preview with an opaque, single-use token for 30 seconds. Claiming checks profile,
account generation and expiry, then rereads the remote snapshot. Changed current song or queue requires a new preview.
Concurrent attempts are rejected. A playback failure prevents the report; playback/session or account changes before
reporting suppress it. Authentication cancellation also interrupts network work. An uncertain report outcome does not
undo local playback or trigger retries, and reusing a consumed token cannot repeat the write.
If only an official preview can play locally, no listening report is sent.

Core captures local playback before the confirmation's remote reread. The player checks session, queue entries,
transport state, seek revision and playback modes under its queue write lock before replacement. User actions during
that network wait therefore invalidate the attempt; normal position-clock advancement does not.

## Live interoperability result (2026-11-17)

With the same WeChat-login account on physical Android and Windows YAQMC, Android's current song and a 20-track
queue were read on Windows and full local playback started. The Android source continued playing. The opposite
direction returned no usable snapshot, despite full playback and sharing being enabled on Windows. This remains
a one-direction experiment; remote pause and complete bidirectional takeover have not passed. Android Back closed
the dialog without interrupting playback. Account switching and network interruption were tested synthetically,
not destructively against the signed-in devices.

## Manual interoperability procedure

1. Sign in to the same QQ Music account on desktop and Android YAQMC (or use an official client as one endpoint).
   For YAQMC-to-YAQMC, enable playback sharing on both devices and play a full track rather than an official preview.
2. Start a supported song on the official client and open the device icon in YAQMC.
3. Check song, timestamp and queue; confirm **Play here and try taking over**.
4. Observe local audio, the displayed report result, and whether the original client actually pauses. Record the
   official client's platform/version and any failure code without sharing cookies or credentials.
5. Repeat with desktop/Android roles reversed; also test no snapshot, stale snapshot, sign-out, unavailable tracks,
   rapid double clicks, local pause/skip during loading and a network interruption during reporting.

Synthetic tests validate state and protocol boundaries. Official-client pause behavior remains unverified; the
YAQMC-to-YAQMC results above do not establish official-client interoperability.
