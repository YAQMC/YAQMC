#!/usr/bin/env bash
set -u

APPIMAGE="${1:-}"
MODE="${2:-}"
if [[ -z "$MODE" ]]; then
  if [[ -n "$APPIMAGE" ]]; then
    MODE="baseline"
  else
    MODE="environment-only"
  fi
fi
case "$MODE" in
  environment-only|baseline|native-wayland|nv-explicit-sync|disable-dmabuf|software|disable-compositing) ;;
  *) printf 'Unknown mode: %s\n' "$MODE" >&2; exit 2 ;;
esac
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
  for key in XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP WAYLAND_DISPLAY DISPLAY GDK_BACKEND YAQMC_LINUX_RENDERER WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE LIBGL_ALWAYS_SOFTWARE __NV_DISABLE_EXPLICIT_SYNC; do
    printf '%s=%s\n' "$key" "${!key-}"
  done
} >"$OUT/environment.txt"

run uname uname -a
run os-release sh -c 'cat /etc/os-release 2>/dev/null'
run desktop-processes sh -c 'ps -eo comm= | grep -Ei "gnome-shell|kwin|sway|hyprland|weston|Xwayland|Xorg" | sort -u'
run gpu sh -c 'command -v lspci >/dev/null && lspci -nnk | grep -A3 -Ei "VGA|3D|Display"'
run webkit-packages sh -c 'command -v pacman >/dev/null && pacman -Q | grep -Ei "webkit2gtk|gtk3|mesa|nvidia"; command -v dpkg-query >/dev/null && dpkg-query -W "libwebkit2gtk*" "libgtk-3*" "mesa*" 2>/dev/null; command -v rpm >/dev/null && rpm -qa | grep -Ei "webkit2gtk|gtk3|mesa|nvidia"'
run audio sh -c 'command -v wpctl >/dev/null && wpctl status; command -v pactl >/dev/null && pactl info; command -v aplay >/dev/null && aplay -l'

snapshot_process_tree() {
  local timestamp snapshot
  timestamp="$(date -u +%FT%TZ)"
  snapshot="$(ps -eo pid=,ppid=,%cpu=,rss=,etime=,comm= 2>/dev/null | awk -v root="$APP_PID" -v timestamp="$timestamp" '
    {
      pid[NR] = $1
      parent[$1] = $2
      cpu[$1] = $3
      rss[$1] = $4
      elapsed[$1] = $5
      command[$1] = $6
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
      count = 0
      total_cpu = 0
      total_rss = 0
      root_elapsed = ""
      for (i = 1; i <= NR; i++) {
        current_pid = pid[i]
        if (!belongs_to_tree(current_pid)) continue
        count++
        total_cpu += cpu[current_pid]
        total_rss += rss[current_pid]
        if (current_pid == root) root_elapsed = elapsed[current_pid]
        printf "process,%s,%s,%s,%s,%s,%s,%s\n", timestamp, current_pid, parent[current_pid], cpu[current_pid], rss[current_pid], elapsed[current_pid], command[current_pid]
      }
      if (count > 0) printf "summary,%s,%d,%.1f,%d,%s\n", timestamp, count, total_cpu, total_rss, root_elapsed
    }
  ')"
  if [[ -n "$snapshot" ]]; then
    printf '%s\n' "$snapshot" | awk -F, '$1 == "process" { sub(/^process,/, ""); print }' >>"$OUT/process-tree-samples.csv"
    printf '%s\n' "$snapshot" | awk -F, '$1 == "summary" { sub(/^summary,/, ""); print }' >>"$OUT/process-samples.csv"
  fi
}

if [[ -n "$APPIMAGE" ]]; then
  if [[ ! -f "$APPIMAGE" ]]; then
    printf 'AppImage not found: %s\n' "$APPIMAGE" >&2
    exit 2
  fi
  chmod +x "$APPIMAGE"
  export RUST_LOG='linux.graphics=debug,linux.window=debug,audio.backend=debug,stream.range=debug,stream.buffer=debug,mpris=debug,smtc=debug,tray=debug,shortcut=debug,yaqmc=info'
  case "$MODE" in
    baseline) ;;
    native-wayland) export GDK_BACKEND=wayland ;;
    nv-explicit-sync) export __NV_DISABLE_EXPLICIT_SYNC=1 ;;
    disable-dmabuf) export YAQMC_LINUX_RENDERER=disable-dmabuf ;;
    software) export YAQMC_LINUX_RENDERER=software ;;
    disable-compositing) export WEBKIT_DISABLE_COMPOSITING_MODE=1 ;;
    environment-only) ;;
  esac
  {
    printf 'mode=%s\n' "$MODE"
    for key in GDK_BACKEND YAQMC_LINUX_RENDERER WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE LIBGL_ALWAYS_SOFTWARE __NV_DISABLE_EXPLICIT_SYNC; do
      printf '%s=%s\n' "$key" "${!key-}"
    done
  } >"$OUT/launch-environment.txt"
  printf 'YAQMC is running. Test playback, scrolling, resize and enabled lyric surfaces, then close YAQMC.\n'
  START_NS="$(date +%s%N)"
  "$APPIMAGE" >"$OUT/yaqmc.log" 2>&1 &
  APP_PID=$!
  printf 'timestamp_utc,process_count,lifetime_cpu_percent_sum,total_rss_kib,root_elapsed\n' >"$OUT/process-samples.csv"
  printf 'timestamp_utc,pid,ppid,lifetime_cpu_percent,rss_kib,elapsed,command\n' >"$OUT/process-tree-samples.csv"
  while kill -0 "$APP_PID" 2>/dev/null; do
    snapshot_process_tree
    sleep 1
  done
  wait "$APP_PID" || true
  END_NS="$(date +%s%N)"
  printf 'process_lifetime_ms=%s\n' "$(( (END_NS - START_NS) / 1000000 ))" >"$OUT/timing.txt"
fi

printf 'Report created: %s\n' "$OUT"
