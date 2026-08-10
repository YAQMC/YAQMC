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

if grep -Fq 'export GDK_BACKEND="${GDK_BACKEND:-x11}"' "$HOOK"; then
  printf 'GTK backend hook already respects an explicit GDK_BACKEND.\n'
elif grep -Eq '^export GDK_BACKEND=x11([[:space:]]|$)' "$HOOK"; then
  sed -i 's/^export GDK_BACKEND=x11\([[:space:]].*\)\?$/export GDK_BACKEND="${GDK_BACKEND:-x11}"\1/' "$HOOK"
else
  printf 'Refusing to modify an unknown GTK backend hook.\n' >&2
  exit 4
fi

grep -Fq 'export GDK_BACKEND="${GDK_BACKEND:-x11}"' "$HOOK"

(
  cd "$WORK_DIR"
  "$APPIMAGETOOL" --appimage-extract >/dev/null
  mv squashfs-root appimagetool.AppDir
)

mkdir -p "$(dirname "$OUTPUT_APPIMAGE")"
ARCH=x86_64 "$WORK_DIR/appimagetool.AppDir/AppRun" "$WORK_DIR/appdir" "$OUTPUT_APPIMAGE"
chmod +x "$OUTPUT_APPIMAGE"

printf 'Repacked AppImage: %s\n' "$OUTPUT_APPIMAGE"
