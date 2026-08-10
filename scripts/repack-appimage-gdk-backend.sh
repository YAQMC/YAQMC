#!/usr/bin/env bash
set -euo pipefail

SOURCE_APPIMAGE="${1:?source AppImage is required}"
APPIMAGETOOL="${2:?appimagetool AppImage is required}"
OUTPUT_APPIMAGE="${3:?output AppImage is required}"

SOURCE_APPIMAGE="$(realpath "$SOURCE_APPIMAGE")"
APPIMAGETOOL="$(realpath "$APPIMAGETOOL")"
OUTPUT_APPIMAGE="$(realpath -m "$OUTPUT_APPIMAGE")"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf -- "$WORK_DIR"' EXIT

(
  cd "$WORK_DIR"
  "$SOURCE_APPIMAGE" --appimage-extract >/dev/null
  mv squashfs-root appdir
)

HOOK="$WORK_DIR/appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if [[ ! -f "$HOOK" ]]; then
  printf 'GTK AppRun hook not found: %s\n' "$HOOK" >&2
  exit 3
fi

POLICY_MARKER='# YAQMC session-aware GTK backend policy'
if grep -Fq "$POLICY_MARKER" "$HOOK"; then
  printf 'GTK backend hook already has the YAQMC session policy.\n'
elif grep -Eq '^export GDK_BACKEND=(x11|"\$\{GDK_BACKEND:-x11\}")([[:space:]]|$)' "$HOOK"; then
  awk '
    /^export GDK_BACKEND=x11([[:space:]]|$)/ || /^export GDK_BACKEND="\$\{GDK_BACKEND:-x11\}"([[:space:]]|$)/ {
      print "# YAQMC session-aware GTK backend policy"
      print "if [[ -z \"${GDK_BACKEND:-}\" ]]; then"
      print "  if [[ \"${XDG_SESSION_TYPE:-}\" == \"wayland\" && -n \"${WAYLAND_DISPLAY:-}\" ]]; then"
      print "    export GDK_BACKEND=wayland"
      print "  else"
      print "    export GDK_BACKEND=x11"
      print "  fi"
      print "fi"
      next
    }
    { print }
  ' "$HOOK" >"$HOOK.yaqmc"
  mv "$HOOK.yaqmc" "$HOOK"
else
  printf 'Refusing to modify an unknown GTK backend hook.\n' >&2
  exit 4
fi

grep -Fq "$POLICY_MARKER" "$HOOK"
grep -Fq 'export GDK_BACKEND=wayland' "$HOOK"
grep -Fq 'export GDK_BACKEND=x11' "$HOOK"

(
  cd "$WORK_DIR"
  "$APPIMAGETOOL" --appimage-extract >/dev/null
  mv squashfs-root appimagetool.AppDir
)

mkdir -p "$(dirname "$OUTPUT_APPIMAGE")"
ARCH=x86_64 "$WORK_DIR/appimagetool.AppDir/AppRun" "$WORK_DIR/appdir" "$OUTPUT_APPIMAGE"
chmod +x "$OUTPUT_APPIMAGE"

printf 'Repacked AppImage: %s\n' "$OUTPUT_APPIMAGE"
