#!/usr/bin/env bash
# Rebuild the electron-builder AppImage with the official appimagetool so it
# uses the static type2 runtime (no libfuse2 needed on the host), embeds
# AppImage update information, and ships a .zsync file next to it.
#
# Usage: bash scripts/repack-appimage.sh   (after `electron-builder --linux`)
# Requires: curl, sha256sum, node, unsquashfs (squashfs-tools). x86_64 only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
NAME="Pipette-linux-x86_64.AppImage"
UPDATE_INFO="gh-releases-zsync|darakuneko|pipette-desktop|latest|$NAME.zsync"
METAINFO="$ROOT/build/linux/app.pipette.desktop.metainfo.xml"

APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/pipette-appimage-tools"

die() {
  echo "repack-appimage: $*" >&2
  exit 1
}

# Download $1 to $CACHE/$3 unless a copy with SHA256 $2 is already cached.
fetch() {
  local url="$1" sha="$2" dest="$CACHE/$3"
  if [[ -f "$dest" && -x "$dest" ]] && echo "$sha  $dest" | sha256sum --check --status; then
    return
  fi
  mkdir -p "$CACHE"
  curl -fsSL --retry 3 -o "$dest.part" "$url"
  echo "$sha  $dest.part" | sha256sum --check --status || die "checksum mismatch for $url"
  chmod +x "$dest.part"
  mv -f "$dest.part" "$dest"
}

[[ "$(uname -m)" == "x86_64" ]] || die "only x86_64 hosts are supported"
[[ -f "$DIST/$NAME" ]] || die "$DIST/$NAME not found; run electron-builder --linux first"
command -v unsquashfs >/dev/null || die "unsquashfs not found; install squashfs-tools"

VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"

fetch "$APPIMAGETOOL_URL" "$APPIMAGETOOL_SHA256" appimagetool-x86_64.AppImage
fetch "$RUNTIME_URL" "$RUNTIME_SHA256" runtime-x86_64

# Inside dist/ so the final mv is a rename on the same filesystem.
WORK="$(mktemp -d "$DIST/.repack.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Run appimagetool from an extracted copy so the host needs no FUSE. The
# bundle also provides mksquashfs and zsyncmake.
mkdir "$WORK/tool"
(cd "$WORK/tool" && "$CACHE/appimagetool-x86_64.AppImage" --appimage-extract >/dev/null)

# unsquashfs keeps the original modes; --appimage-extract would turn every
# directory into 700, which becomes unreadable once repacked as root-owned.
unsquashfs -q -o "$("$DIST/$NAME" --appimage-offset)" -d "$WORK/AppDir" "$DIST/$NAME"

# AppStream wants the metainfo named after its component id and the desktop
# file under usr/share/applications. appimagetool's "AppStream upstream
# metadata is missing" warning is expected: it only looks for
# <desktop name>.appdata.xml.
install -Dm644 "$METAINFO" "$WORK/AppDir/usr/share/metainfo/app.pipette.desktop.metainfo.xml"
[[ -f "$WORK/AppDir/pipette-desktop.desktop" ]] || die "pipette-desktop.desktop not found at the AppDir root"
mkdir -p "$WORK/AppDir/usr/share/applications"
ln -sf ../../../pipette-desktop.desktop "$WORK/AppDir/usr/share/applications/pipette-desktop.desktop"

# Pass only the file name so the URL inside the .zsync stays relative.
mkdir "$WORK/out"
(cd "$WORK/out" && VERSION="$VERSION" ARCH=x86_64 "$WORK/tool/squashfs-root/AppRun" \
  --runtime-file "$CACHE/runtime-x86_64" -u "$UPDATE_INFO" "$WORK/AppDir" "$NAME")

# appimagetool only warns and still succeeds when it cannot write the .zsync.
[[ -s "$WORK/out/$NAME.zsync" ]] || die "$NAME.zsync was not generated"
[[ "$("$WORK/out/$NAME" --appimage-updateinformation)" == "$UPDATE_INFO" ]] \
  || die "update information mismatch"

mv -f "$WORK/out/$NAME" "$DIST/$NAME"
mv -f "$WORK/out/$NAME.zsync" "$DIST/$NAME.zsync"
echo "repack-appimage: rebuilt $DIST/$NAME"
