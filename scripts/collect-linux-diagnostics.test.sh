#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
collector="$repo_root/scripts/collect-linux-diagnostics.sh"
verifier="$repo_root/scripts/verify-lyrics-acceptance.mjs"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

bundle="$test_root/bundle"
mkdir -p "$bundle"
appimage="$bundle/YAQMC_0.1.0_amd64.AppImage"
cat >"$appimage" <<'APP'
#!/usr/bin/env bash
set -u
trap 'exit 0' TERM INT
case "${GDK_BACKEND-}" in
  wayland) backend=wayland-native ;;
  x11)
    if [[ "${XDG_SESSION_TYPE-}" == wayland ]]; then backend=xwayland; else backend=x11; fi
    ;;
  *)
    if [[ "${XDG_SESSION_TYPE-}" == wayland ]]; then backend=wayland-native; else backend=x11; fi
    ;;
esac
printf 'display_backend="%s"\n' "$backend"
while :; do sleep 0.05; done
APP
chmod +x "$appimage"
cp "$collector" "$bundle/collect-linux-diagnostics.sh"
cp "$verifier" "$bundle/verify-lyrics-acceptance.mjs"
printf '# Testing\n' >"$bundle/TESTING.md"
printf '# Acceptance\n' >"$bundle/ACCEPTANCE.md"
app_sha="$(sha256sum "$appimage" | cut -d' ' -f1)"
cat >"$bundle/BUILD-IDENTITY.json" <<EOF
{
  "schemaVersion": 1,
  "gitCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gitTree": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "workflowRunId": "123456789",
  "workflowRunAttempt": "2",
  "appVersion": "0.1.0",
  "appImage": {
    "fileName": "$(basename "$appimage")",
    "sha256": "$app_sha"
  }
}
EOF
(
  cd "$bundle"
  find . -type f ! -name SHA256SUMS -printf '%P\0' | sort -z | xargs -0 sha256sum >SHA256SUMS
)

node "$verifier" \
  --platform linux \
  --identity-only \
  --build-identity "$bundle/BUILD-IDENTITY.json"

shim_dir="$test_root/shims"
mkdir -p "$shim_dir"
cat >"$shim_dir/ps" <<'EOF'
#!/usr/bin/env bash
printf 'ps\n' >>"${YAQMC_TEST_SHIM_LOG:?}"
printf '%s %s 1.5 1024 2 00:01 fake-yaqmc\n' "${YAQMC_DIAGNOSTICS_ROOT_PID:-1}" 1
EOF
chmod +x "$shim_dir/ps"

run_mode() {
  local root="$1"
  local mode="$2"
  shift 2
  env \
    PATH="$shim_dir:$PATH" \
    XDG_SESSION_TYPE=wayland \
    WAYLAND_DISPLAY=wayland-test \
    DISPLAY=:99 \
    YAQMC_ACCEPTANCE_ROOT="$root" \
    YAQMC_BUILD_IDENTITY="$bundle/BUILD-IDENTITY.json" \
    YAQMC_DIAGNOSTICS_NONINTERACTIVE=1 \
    YAQMC_DIAGNOSTICS_AUTO_STOP=1 \
    YAQMC_DIAGNOSTICS_PHASE_DELAY=0.05 \
    YAQMC_TEST_SHIM_LOG="$test_root/shim-calls.log" \
    "$@" \
    bash "$collector" "$appimage" "$mode"
}

acceptance="$test_root/acceptance"
if env \
  YAQMC_BUILD_IDENTITY="$bundle/BUILD-IDENTITY.json" \
  bash "$collector" "$appimage" software >/dev/null 2>&1; then
  echo 'software mode was accepted without a confirmed native failure' >&2
  exit 1
fi
run_mode "$acceptance" auto
run_mode "$acceptance" native-wayland
run_mode "$acceptance" x11
run_mode "$acceptance" software YAQMC_ALLOW_SOFTWARE=confirmed-native-failure

node "$verifier" \
  --platform linux \
  --root "$acceptance" \
  --build-identity "$bundle/BUILD-IDENTITY.json"

node --input-type=module - "$acceptance" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const phases = [
  'startup-idle',
  'playback',
  'seek-pause-resume',
  'main-scroll-resize',
  'lyrics-normal',
  'lyrics-focus',
  'lyrics-fullscreen',
  'desktop-lyrics',
  'island-lyrics',
  'both-surfaces',
  'shutdown',
];
for (const [mode, backend] of [
  ['auto', 'wayland-native'],
  ['native-wayland', 'wayland-native'],
  ['x11', 'xwayland'],
  ['software', 'wayland-native'],
]) {
  const manifest = JSON.parse(readFileSync(join(root, mode, 'manifest.json'), 'utf8'));
  if (JSON.stringify(manifest.phases) !== JSON.stringify(phases)) throw new Error(`${mode}: phase order`);
  if (manifest.mode !== mode || manifest.reportedBackend !== backend) throw new Error(`${mode}: mode/backend`);
  if (mode === 'software' && manifest.mode === 'native-wayland') throw new Error('software labeled native');
}
NODE

alias_root="$test_root/alias"
run_mode "$alias_root" baseline
test -d "$alias_root/auto"
node --input-type=module - "$alias_root/auto/manifest.json" <<'NODE'
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (manifest.mode !== 'auto' || manifest.requestedMode !== 'baseline') {
  throw new Error('baseline was not preserved solely as the auto alias');
}
NODE
grep -F 'GDK_BACKEND=' "$acceptance/auto/launch-environment.txt" >/dev/null
grep -F 'GDK_BACKEND=wayland' "$acceptance/native-wayland/launch-environment.txt" >/dev/null
grep -F 'DISPLAY=' "$acceptance/native-wayland/launch-environment.txt" >/dev/null
grep -F 'GDK_BACKEND=x11' "$acceptance/x11/launch-environment.txt" >/dev/null
grep -F 'YAQMC_LINUX_RENDERER=software' "$acceptance/software/launch-environment.txt" >/dev/null
test -s "$test_root/shim-calls.log"

interrupt_root="$test_root/interrupt"
env \
  PATH="$shim_dir:$PATH" \
  XDG_SESSION_TYPE=wayland \
  WAYLAND_DISPLAY=wayland-test \
  DISPLAY=:99 \
  YAQMC_ACCEPTANCE_ROOT="$interrupt_root" \
  YAQMC_BUILD_IDENTITY="$bundle/BUILD-IDENTITY.json" \
  YAQMC_DIAGNOSTICS_NONINTERACTIVE=1 \
  YAQMC_DIAGNOSTICS_PHASE_DELAY=5 \
  YAQMC_TEST_SHIM_LOG="$test_root/shim-calls.log" \
  bash "$collector" "$appimage" auto &
collector_pid=$!
for _ in $(seq 1 100); do
  [[ -f "$interrupt_root/auto/app.pid" ]] && break
  sleep 0.02
done
test -f "$interrupt_root/auto/app.pid"
app_pid="$(cat "$interrupt_root/auto/app.pid")"
kill -TERM "$collector_pid"
if wait "$collector_pid"; then
  echo 'interrupted collector unexpectedly succeeded' >&2
  exit 1
fi
if kill -0 "$app_pid" 2>/dev/null; then
  echo 'interrupted collector leaked the AppImage process' >&2
  exit 1
fi
grep -F '"status": "incomplete"' "$interrupt_root/auto/manifest.json" >/dev/null

echo 'linux diagnostics collector tests passed'
