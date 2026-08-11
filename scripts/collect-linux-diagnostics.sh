#!/usr/bin/env bash
set -Eeuo pipefail

readonly PHASES=(
  startup-idle
  playback
  seek-pause-resume
  main-scroll-resize
  lyrics-normal
  lyrics-focus
  lyrics-fullscreen
  desktop-lyrics
  island-lyrics
  both-surfaces
  shutdown
)
readonly REPORT_FILES=(
  checklist.md
  commands.log
  environment.txt
  launch-environment.txt
  manifest.json
  process-samples.tsv
  process-tree-samples.tsv
  state.jsonl
  yaqmc.log
)

usage() {
  cat >&2 <<'EOF'
Usage: collect-linux-diagnostics.sh <final.AppImage> <auto|native-wayland|x11|software>

`baseline` is accepted only as a compatibility alias for `auto`.
`software` additionally requires YAQMC_ALLOW_SOFTWARE=confirmed-native-failure.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

absolute_file() {
  local path="$1"
  local directory
  local file_name
  directory="$(dirname -- "$path")"
  file_name="$(basename -- "$path")"
  (cd -- "$directory" && printf '%s/%s\n' "$PWD" "$file_name")
}

utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

field_value() {
  local value="${1-}"
  value="${value//$'\t'/ }"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  printf '%s' "$value"
}

if [[ "$#" -ne 2 ]]; then
  usage
  exit 2
fi

require_command node
require_command sha256sum
require_command ps
require_command awk

APPIMAGE="$(absolute_file "$1")"
REQUESTED_MODE="$2"
MODE="$REQUESTED_MODE"
if [[ "$MODE" == baseline ]]; then
  MODE=auto
fi
case "$MODE" in
  auto|native-wayland|x11) ;;
  software)
    if [[ "${YAQMC_ALLOW_SOFTWARE-}" != confirmed-native-failure ]]; then
      fail 'software mode is conditional; first reproduce a native graphics failure, then set YAQMC_ALLOW_SOFTWARE=confirmed-native-failure'
    fi
    ;;
  *) usage; exit 2 ;;
esac

[[ -f "$APPIMAGE" ]] || fail "AppImage not found: $APPIMAGE"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERIFIER="$SCRIPT_DIR/verify-lyrics-acceptance.mjs"
IDENTITY_PATH="${YAQMC_BUILD_IDENTITY:-$SCRIPT_DIR/BUILD-IDENTITY.json}"
IDENTITY_PATH="$(absolute_file "$IDENTITY_PATH")"
[[ -f "$VERIFIER" ]] || fail "verifier not found beside collector: $VERIFIER"
[[ -f "$IDENTITY_PATH" ]] || fail "build identity not found: $IDENTITY_PATH"

node "$VERIFIER" \
  --platform linux \
  --identity-only \
  --build-identity "$IDENTITY_PATH"

mapfile -t IDENTITY_VALUES < <(
  node --input-type=module - "$IDENTITY_PATH" <<'NODE'
import { readFileSync } from 'node:fs';

const identity = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const value of [
  identity.gitCommit,
  identity.gitTree,
  identity.workflowRunId,
  identity.workflowRunAttempt,
  identity.appVersion,
  identity.appImage.fileName,
  identity.appImage.sha256,
]) {
  console.log(value);
}
NODE
)
if [[ "${#IDENTITY_VALUES[@]}" -ne 7 ]]; then
  fail 'BUILD-IDENTITY.json did not yield the required fields'
fi
GIT_COMMIT="${IDENTITY_VALUES[0]}"
GIT_TREE="${IDENTITY_VALUES[1]}"
WORKFLOW_RUN_ID="${IDENTITY_VALUES[2]}"
WORKFLOW_RUN_ATTEMPT="${IDENTITY_VALUES[3]}"
APP_VERSION="${IDENTITY_VALUES[4]}"
PACKAGED_APPIMAGE_NAME="${IDENTITY_VALUES[5]}"
PACKAGED_APPIMAGE_SHA="${IDENTITY_VALUES[6]}"
PACKAGED_APPIMAGE="$(absolute_file "$(dirname -- "$IDENTITY_PATH")/$PACKAGED_APPIMAGE_NAME")"
if [[ "$APPIMAGE" != "$PACKAGED_APPIMAGE" ]]; then
  fail "collector must run the exact packaged AppImage named by BUILD-IDENTITY.json: $PACKAGED_APPIMAGE"
fi
ACTUAL_APPIMAGE_SHA="$(sha256sum "$APPIMAGE" | awk '{print $1}')"
if [[ "$ACTUAL_APPIMAGE_SHA" != "$PACKAGED_APPIMAGE_SHA" ]]; then
  fail 'AppImage hash changed after build-identity verification'
fi

ACCEPTANCE_ROOT="${YAQMC_ACCEPTANCE_ROOT:-$PWD/YAQMC-linux-acceptance-${GIT_COMMIT:0:12}}"
mkdir -p -- "$ACCEPTANCE_ROOT"
OUT="$ACCEPTANCE_ROOT/$MODE"
if [[ -e "$OUT" ]]; then
  fail "evidence directory already exists; preserve it and choose a new YAQMC_ACCEPTANCE_ROOT: $OUT"
fi
mkdir -- "$OUT"

APP_PID=''
FINALIZED=0
REPORTED_BACKEND=unknown
STARTED_AT_UTC="$(utc_now)"
CAPTURED_PHASES=()
GRAPHICS_MODE=auto

write_manifest() {
  local status="$1"
  local ended_at="$2"
  local captured_phases
  captured_phases="$(IFS=,; printf '%s' "${CAPTURED_PHASES[*]-}")"
  STATUS="$status" \
  ENDED_AT_UTC="$ended_at" \
  CAPTURED_PHASES_CSV="$captured_phases" \
  MODE="$MODE" \
  REQUESTED_MODE="$REQUESTED_MODE" \
  STARTED_AT_UTC="$STARTED_AT_UTC" \
  GIT_COMMIT="$GIT_COMMIT" \
  GIT_TREE="$GIT_TREE" \
  WORKFLOW_RUN_ID="$WORKFLOW_RUN_ID" \
  WORKFLOW_RUN_ATTEMPT="$WORKFLOW_RUN_ATTEMPT" \
  APP_VERSION="$APP_VERSION" \
  PACKAGED_APPIMAGE_NAME="$PACKAGED_APPIMAGE_NAME" \
  PACKAGED_APPIMAGE_SHA="$PACKAGED_APPIMAGE_SHA" \
  REPORTED_BACKEND="$REPORTED_BACKEND" \
    node --input-type=module >"$OUT/manifest.json" <<'NODE'
import { writeFileSync } from 'node:fs';

const manifest = {
  schemaVersion: 1,
  platform: 'linux',
  status: process.env.STATUS,
  mode: process.env.MODE,
  requestedMode: process.env.REQUESTED_MODE,
  startedAtUtc: process.env.STARTED_AT_UTC,
  endedAtUtc: process.env.ENDED_AT_UTC,
  gitCommit: process.env.GIT_COMMIT,
  gitTree: process.env.GIT_TREE,
  workflowRunId: process.env.WORKFLOW_RUN_ID,
  workflowRunAttempt: process.env.WORKFLOW_RUN_ATTEMPT,
  appVersion: process.env.APP_VERSION,
  appImage: {
    fileName: process.env.PACKAGED_APPIMAGE_NAME,
    sha256: process.env.PACKAGED_APPIMAGE_SHA,
  },
  reportedBackend: process.env.REPORTED_BACKEND,
  phases: (process.env.CAPTURED_PHASES_CSV ?? '').split(',').filter(Boolean),
};
writeFileSync(1, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

stop_app() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do
      if ! kill -0 "$APP_PID" 2>/dev/null; then
        break
      fi
      sleep 0.02
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
  fi
  APP_PID=''
  rm -f -- "$OUT/app.pid"
}

finalize_incomplete() {
  local status="$?"
  if [[ "$FINALIZED" -eq 0 ]]; then
    stop_app
    write_manifest incomplete "$(utc_now)" || true
  fi
  return "$status"
}

signal_exit() {
  exit 130
}

trap finalize_incomplete EXIT
trap signal_exit INT TERM HUP

{
  printf 'schemaVersion=1\n'
  printf 'generatedUtc=%s\n' "$STARTED_AT_UTC"
  printf 'requestedMode=%s\n' "$REQUESTED_MODE"
  printf 'mode=%s\n' "$MODE"
  printf 'appImage=%s\n' "$PACKAGED_APPIMAGE_NAME"
  printf 'appImageSha256=%s\n' "$PACKAGED_APPIMAGE_SHA"
  printf 'gitCommit=%s\n' "$GIT_COMMIT"
  printf 'gitTree=%s\n' "$GIT_TREE"
  printf 'workflowRunId=%s\n' "$WORKFLOW_RUN_ID"
  printf 'workflowRunAttempt=%s\n' "$WORKFLOW_RUN_ATTEMPT"
  printf 'kernel='; uname -srmo 2>/dev/null || true
  if [[ -r /etc/os-release ]]; then
    sed -n 's/^\(NAME\|VERSION\|ID\|VERSION_ID\)=/os.\1=/p' /etc/os-release
  fi
  for key in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY GDK_BACKEND YAQMC_LINUX_RENDERER WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE LIBGL_ALWAYS_SOFTWARE __NV_DISABLE_EXPLICIT_SYNC; do
    printf '%s=%s\n' "$key" "$(field_value "${!key-}")"
  done
  printf 'desktopProcesses='
  ps 2>/dev/null | awk 'NR > 1 { print $NF }' | grep -Ei 'gnome-shell|kwin|sway|hyprland|weston|Xwayland|Xorg' | sort -u | paste -sd, - || true
  printf '\n'
} >"$OUT/environment.txt"

unset GDK_BACKEND YAQMC_LINUX_RENDERER WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE LIBGL_ALWAYS_SOFTWARE __NV_DISABLE_EXPLICIT_SYNC
case "$MODE" in
  auto) ;;
  native-wayland)
    export GDK_BACKEND=wayland
    unset DISPLAY
    ;;
  x11)
    export GDK_BACKEND=x11
    ;;
  software)
    export YAQMC_LINUX_RENDERER=software
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    export LIBGL_ALWAYS_SOFTWARE=1
    GRAPHICS_MODE=software
    ;;
esac
export RUST_LOG='linux.graphics=debug,linux.window=debug,audio.backend=debug,stream.range=debug,stream.buffer=debug,mpris=debug,smtc=debug,tray=debug,shortcut=debug,yaqmc=info'

{
  printf 'mode=%s\n' "$MODE"
  printf 'requestedMode=%s\n' "$REQUESTED_MODE"
  for key in XDG_SESSION_TYPE WAYLAND_DISPLAY DISPLAY GDK_BACKEND YAQMC_LINUX_RENDERER WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE LIBGL_ALWAYS_SOFTWARE __NV_DISABLE_EXPLICIT_SYNC RUST_LOG; do
    printf '%s=%s\n' "$key" "$(field_value "${!key-}")"
  done
} >"$OUT/launch-environment.txt"

: >"$OUT/commands.log"
: >"$OUT/state.jsonl"
printf 'phase\ttimestamp_utc\tprocess_count\ttotal_cpu_percent\ttotal_rss_kib\ttotal_pss_kib\ttotal_threads\twindow_state\treported_backend\txdg_session_type\tgdk_backend\tgraphics_mode\tdmabuf_disabled\tsoftware_gl\n' >"$OUT/process-samples.tsv"
printf 'phase\ttimestamp_utc\tpid\tppid\tcpu_percent\trss_kib\tpss_kib\tthreads\telapsed\tcommand\n' >"$OUT/process-tree-samples.tsv"

chmod +x -- "$APPIMAGE"
printf 'launch %q\n' "$APPIMAGE" >>"$OUT/commands.log"
"$APPIMAGE" >"$OUT/yaqmc.log" 2>&1 &
APP_PID=$!
export YAQMC_DIAGNOSTICS_ROOT_PID="$APP_PID"
printf '%s\n' "$APP_PID" >"$OUT/app.pid"

for _ in $(seq 1 200); do
  if grep -Eq 'display_backend="(wayland-native|xwayland|x11)"' "$OUT/yaqmc.log"; then
    REPORTED_BACKEND="$(sed -n 's/.*display_backend="\(wayland-native\|xwayland\|x11\)".*/\1/p' "$OUT/yaqmc.log" | tail -n 1)"
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    fail 'AppImage exited before reporting its display backend; inspect yaqmc.log'
  fi
  sleep 0.05
done
if [[ "$REPORTED_BACKEND" == unknown ]]; then
  fail 'AppImage did not report display_backend within 10 seconds'
fi
if [[ "$MODE" == native-wayland && "$REPORTED_BACKEND" != wayland-native ]]; then
  fail "native-wayland requested but runtime reported $REPORTED_BACKEND"
fi
if [[ "$MODE" == x11 && "$REPORTED_BACKEND" != x11 && "$REPORTED_BACKEND" != xwayland ]]; then
  fail "x11 requested but runtime reported $REPORTED_BACKEND"
fi

process_pss_kib() {
  local pid="$1"
  if [[ -r "/proc/$pid/smaps_rollup" ]]; then
    awk '$1 == "Pss:" { print $2; found=1; exit } END { if (!found) print 0 }' "/proc/$pid/smaps_rollup" 2>/dev/null
  elif [[ -r "/proc/$pid/smaps" ]]; then
    awk '$1 == "Pss:" { total += $2 } END { print total + 0 }' "/proc/$pid/smaps" 2>/dev/null
  else
    printf '0\n'
  fi
}

snapshot_process_tree() {
  local phase="$1"
  local timestamp="$2"
  local snapshot="$OUT/.process-snapshot.tsv"
  local selected="$OUT/.process-selected.tsv"
  local count=0
  local total_cpu=0
  local total_rss=0
  local total_pss=0
  local total_threads=0

  ps -eo pid=,ppid=,%cpu=,rss=,nlwp=,etime=,args= >"$snapshot"
  awk -v root="$APP_PID" 'BEGIN { OFS="\t" }
    {
      row[NR] = $0
      pid[NR] = $1
      parent[$1] = $2
      cpu[$1] = $3
      rss[$1] = $4
      threads[$1] = $5
      elapsed[$1] = $6
      command[$1] = $7
      for (field = 8; field <= NF; field++) command[$1] = command[$1] " " $field
    }
    function belongs_to_tree(candidate, current, hops) {
      current = candidate
      for (hops = 0; hops < 256 && current != "" && current != "0"; hops++) {
        if (current == root) return 1
        current = parent[current]
      }
      return 0
    }
    END {
      for (row_index = 1; row_index <= NR; row_index++) {
        current = pid[row_index]
        if (belongs_to_tree(current)) {
          gsub(/\t/, " ", command[current])
          print current, parent[current], cpu[current], rss[current], threads[current], elapsed[current], command[current]
        }
      }
    }' "$snapshot" >"$selected"

  while IFS=$'\t' read -r pid ppid cpu rss threads elapsed command; do
    [[ -n "$pid" ]] || continue
    local pss
    pss="$(process_pss_kib "$pid")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$phase" "$timestamp" "$pid" "$ppid" "$cpu" "$rss" "$pss" "$threads" "$elapsed" "$(field_value "$command")" \
      >>"$OUT/process-tree-samples.tsv"
    count=$((count + 1))
    total_cpu="$(awk -v left="$total_cpu" -v right="$cpu" 'BEGIN { printf "%.1f", left + right }')"
    total_rss=$((total_rss + rss))
    total_pss=$((total_pss + pss))
    total_threads=$((total_threads + threads))
  done <"$selected"

  rm -f -- "$snapshot" "$selected"
  if [[ "$count" -eq 0 ]]; then
    fail "no process tree was captured for phase $phase"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\trunning\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$phase" "$timestamp" "$count" "$total_cpu" "$total_rss" "$total_pss" "$total_threads" \
    "$REPORTED_BACKEND" "$(field_value "${XDG_SESSION_TYPE-}")" "$(field_value "${GDK_BACKEND-}")" \
    "$GRAPHICS_MODE" "$(field_value "${WEBKIT_DISABLE_DMABUF_RENDERER-}")" "$(field_value "${LIBGL_ALWAYS_SOFTWARE-}")" \
    >>"$OUT/process-samples.tsv"
}

record_state() {
  local phase="$1"
  local sequence="$2"
  local timestamp="$3"
  local window_state="$4"
  printf '{"schemaVersion":1,"seq":%s,"phase":"%s","timestampUtc":"%s","mode":"%s","windowState":"%s","reportedBackend":"%s","graphicsMode":"%s"}\n' \
    "$sequence" "$phase" "$timestamp" "$MODE" "$window_state" "$REPORTED_BACKEND" "$GRAPHICS_MODE" \
    >>"$OUT/state.jsonl"
  printf 'phase %s: captured\n' "$phase" >>"$OUT/commands.log"
  CAPTURED_PHASES+=("$phase")
}

phase_prompt() {
  local phase="$1"
  case "$phase" in
    startup-idle) printf 'Leave YAQMC idle on Home. Press Enter to capture startup-idle.\n' ;;
    playback) printf 'Start a real track and wait for audible playback. Press Enter to capture playback.\n' ;;
    seek-pause-resume) printf 'Seek, pause, then resume. Press Enter to capture seek-pause-resume.\n' ;;
    main-scroll-resize) printf 'Scroll and resize the main window. Press Enter to capture main-scroll-resize.\n' ;;
    lyrics-normal) printf 'Open Lyrics in normal presentation. Press Enter to capture lyrics-normal.\n' ;;
    lyrics-focus) printf 'Enable Lyrics Focus. Press Enter to capture lyrics-focus.\n' ;;
    lyrics-fullscreen) printf 'Enter native Lyrics fullscreen. Press Enter to capture lyrics-fullscreen.\n' ;;
    desktop-lyrics) printf 'Exit fullscreen, enable desktop lyrics, and verify lock/unlock. Press Enter to capture desktop-lyrics.\n' ;;
    island-lyrics) printf 'Enable island lyrics and verify lock/unlock. Press Enter to capture island-lyrics.\n' ;;
    both-surfaces) printf 'Enable both lyric surfaces and verify interaction. Press Enter to capture both-surfaces.\n' ;;
    shutdown) printf 'Close YAQMC completely, then press Enter to capture shutdown.\n' ;;
  esac
}

PHASE_DELAY="${YAQMC_DIAGNOSTICS_PHASE_DELAY:-1}"
for index in "${!PHASES[@]}"; do
  phase="${PHASES[$index]}"
  sequence=$((index + 1))
  if [[ "$phase" == shutdown ]]; then
    if [[ "${YAQMC_DIAGNOSTICS_AUTO_STOP-}" == 1 ]]; then
      stop_app
    else
      phase_prompt "$phase"
      read -r _
      if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
        wait "$APP_PID" || true
      fi
      APP_PID=''
      rm -f -- "$OUT/app.pid"
    fi
    timestamp="$(utc_now)"
    printf '%s\t%s\t0\t0\t0\t0\t0\tstopped\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$phase" "$timestamp" "$REPORTED_BACKEND" "$(field_value "${XDG_SESSION_TYPE-}")" "$(field_value "${GDK_BACKEND-}")" \
      "$GRAPHICS_MODE" "$(field_value "${WEBKIT_DISABLE_DMABUF_RENDERER-}")" "$(field_value "${LIBGL_ALWAYS_SOFTWARE-}")" \
      >>"$OUT/process-samples.tsv"
    record_state "$phase" "$sequence" "$timestamp" stopped
    continue
  fi

  if ! kill -0 "$APP_PID" 2>/dev/null; then
    fail "AppImage exited before phase $phase"
  fi
  if [[ "${YAQMC_DIAGNOSTICS_NONINTERACTIVE-}" == 1 ]]; then
    sleep "$PHASE_DELAY"
  else
    phase_prompt "$phase"
    read -r _
  fi
  timestamp="$(utc_now)"
  snapshot_process_tree "$phase" "$timestamp"
  record_state "$phase" "$sequence" "$timestamp" running
done

{
  printf '# YAQMC Linux lyrics acceptance\n\n'
  printf -- '- verification: pending\n'
  printf -- '- physicalPass: false\n'
  printf -- '- mode: %s\n' "$MODE"
  printf -- '- requestedMode: %s\n' "$REQUESTED_MODE"
  printf -- '- reportedBackend: %s\n\n' "$REPORTED_BACKEND"
  printf '## Captured phases\n\n'
  for phase in "${PHASES[@]}"; do
    printf -- '- [x] %s\n' "$phase"
  done
  printf '\nThis collector records evidence only. A maintainer must run the verifier before any pass claim.\n'
} >"$OUT/checklist.md"

write_manifest captured "$(utc_now)"
(
  cd -- "$OUT"
  for name in "${REPORT_FILES[@]}"; do
    sha256sum "$name"
  done
) | sort -k2 >"$OUT/sha256.txt"

FINALIZED=1
trap - EXIT INT TERM HUP
printf 'Linux evidence captured (not yet verified): %s\n' "$OUT"
