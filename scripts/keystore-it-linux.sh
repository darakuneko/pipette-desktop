#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Runs the OS key store test of pipette-secret-store
# (src-tauri/crates/pipette-secret-store/tests/os_keystore.rs) on Linux in a
# session of its own, never against the desktop session's key store:
#   - a dbus-run-session bus with no service files, so nothing is started
#     on demand (in particular not the user's gnome-keyring);
#   - an empty temporary home and runtime directory, no display, and only
#     PATH kept from the environment;
#   - with `available`, a gnome-keyring-daemon started inside that session
#     and unlocked with a throwaway password; with `unavailable`, no Secret
#     Service at all.
#
# Usage: scripts/keystore-it-linux.sh available|unavailable
# Needs dbus-run-session, and gnome-keyring-daemon for `available`.

set -euo pipefail

mode="${1:-}"
case "$mode" in
  available | unavailable) ;;
  *)
    echo "usage: $0 available|unavailable" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"

# Built outside the isolated session (cargo needs the real home); only the
# test binary runs inside it.
build_log="$(cd "$root/src-tauri" && cargo test -p pipette-secret-store --test os_keystore --no-run 2>&1)"
echo "$build_log"
binary="$(sed -n 's/^ *Executable .*(\(.*\))$/\1/p' <<< "$build_log" | tail -n 1)"
if [ -z "$binary" ]; then
  echo "could not find the os_keystore test binary" >&2
  exit 1
fi
binary="$root/src-tauri/$binary"

# Short paths: the bus and keyring sockets live under them.
work="$(mktemp -d /tmp/pks.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/home" "$work/run"
chmod 700 "$work/run"
cat > "$work/session.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=$work</listen>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF

inner='"$PIPETTE_KEYSTORE_IT_BINARY" --test-threads=1'
if [ "$mode" = available ]; then
  # A new login keyring in the temporary home, unlocked for the run.
  inner="printf 'keystore-test' | gnome-keyring-daemon --unlock --components=secrets > /dev/null && sleep 1 && $inner"
fi

env -i \
  PATH="$PATH" \
  HOME="$work/home" \
  XDG_RUNTIME_DIR="$work/run" \
  XDG_CONFIG_HOME="$work/home/.config" \
  XDG_DATA_HOME="$work/home/.local/share" \
  XDG_CACHE_HOME="$work/home/.cache" \
  PIPETTE_KEYSTORE_IT="$mode" \
  PIPETTE_KEYSTORE_IT_ISOLATED=1 \
  PIPETTE_KEYSTORE_IT_BINARY="$binary" \
  dbus-run-session --config-file="$work/session.conf" -- sh -c "$inner"
