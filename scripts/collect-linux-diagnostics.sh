#!/usr/bin/env bash
set -u

APPIMAGE="${1:-}"
MODE="${2:-environment-only}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${PWD}/YAQMC-linux-report-${STAMP}-${MODE}"
mkdir -p "$OUT"

run() {
  local name="$1"
  shift
  { printf '$'; printf ' %q' "$@"; printf '\n'; "$@"; } >"$OUT/${name}.txt" 2>&1 || true
}

{
  printf 'generated_utc=%s\n' "$STAMP"
  printf 'mode=%s\n' "$MODE"
  for key in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY; do
    printf '%s=%s\n' "$key" "${!key-}"
  done
} >"$OUT/environment.txt"

run uname uname -a
run os-release sh -c 'cat /etc/os-release 2>/dev/null'
run desktop-processes sh -c 'ps -eo comm= | grep -Ei "gnome-shell|kwin|sway|hyprland|weston|Xwayland|Xorg" | sort -u'
run gpu sh -c 'command -v lspci >/dev/null && lspci -nnk | grep -A3 -Ei "VGA|3D|Display"'
run webkit-packages sh -c 'command -v pacman >/dev/null && pacman -Q | grep -Ei "webkit2gtk|gtk3|mesa|nvidia"; command -v dpkg-query >/dev/null && dpkg-query -W "libwebkit2gtk*" "libgtk-3*" "mesa*" 2>/dev/null; command -v rpm >/dev/null && rpm -qa | grep -Ei "webkit2gtk|gtk3|mesa|nvidia"'
run audio sh -c 'command -v wpctl >/dev/null && wpctl status; command -v pactl >/dev/null && pactl info; command -v aplay >/dev/null && aplay -l'

if [[ -n "$APPIMAGE" ]]; then
  if [[ ! -f "$APPIMAGE" ]]; then
    printf 'AppImage not found: %s\n' "$APPIMAGE" >&2
    exit 2
  fi
  chmod +x "$APPIMAGE"
  export RUST_LOG='linux.graphics=debug,linux.window=debug,audio.backend=debug,stream.range=debug,stream.buffer=debug,mpris=debug,smtc=debug,tray=debug,shortcut=debug,yaqmc=info'
  case "$MODE" in
    baseline) ;;
    nv-explicit-sync) export __NV_DISABLE_EXPLICIT_SYNC=1 ;;
    disable-dmabuf) export YAQMC_LINUX_RENDERER=disable-dmabuf ;;
    software) export YAQMC_LINUX_RENDERER=software ;;
    disable-compositing) export WEBKIT_DISABLE_COMPOSITING_MODE=1 ;;
    *) printf 'Unknown mode: %s\n' "$MODE" >&2; exit 2 ;;
  esac
  printf 'YAQMC is running. Test playback, scrolling, resize and enabled lyric surfaces, then close YAQMC.\n'
  START_NS="$(date +%s%N)"
  "$APPIMAGE" >"$OUT/yaqmc.log" 2>&1 &
  APP_PID=$!
  printf 'timestamp_utc,cpu_percent,rss_kib,elapsed\n' >"$OUT/process-samples.csv"
  while kill -0 "$APP_PID" 2>/dev/null; do
    SAMPLE="$(ps -p "$APP_PID" -o %cpu=,rss=,etime= 2>/dev/null || true)"
    if [[ -n "$SAMPLE" ]]; then
      printf '%s,%s\n' "$(date -u +%FT%TZ)" "$(printf '%s' "$SAMPLE" | xargs | tr ' ' ',')" >>"$OUT/process-samples.csv"
    fi
    sleep 1
  done
  wait "$APP_PID" || true
  END_NS="$(date +%s%N)"
  printf 'process_lifetime_ms=%s\n' "$(( (END_NS - START_NS) / 1000000 ))" >"$OUT/timing.txt"
fi

printf 'Report created: %s\n' "$OUT"
