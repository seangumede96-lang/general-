#!/usr/bin/env bash
# Installs the boot script into Termux:Boot's folder. Safe to run again.
# Works from plain Termux or from inside proot Ubuntu.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/boot-v2a-portal.sh"
TERMUX_HOME=/data/data/com.termux/files/home
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ] && TERMUX_HOME=$HOME
if [ ! -d "$TERMUX_HOME" ]; then
  echo "Can't reach Termux's home folder from here. Run this from plain Termux instead:"
  echo "  mkdir -p ~/.termux/boot && cp '$SRC' ~/.termux/boot/ && chmod +x ~/.termux/boot/boot-v2a-portal.sh"
  exit 1
fi
mkdir -p "$TERMUX_HOME/.termux/boot"
cp "$SRC" "$TERMUX_HOME/.termux/boot/boot-v2a-portal.sh"
chmod +x "$TERMUX_HOME/.termux/boot/boot-v2a-portal.sh"
echo "Installed. The portal will start each time the phone turns on (needs the Termux:Boot app, opened once)."
