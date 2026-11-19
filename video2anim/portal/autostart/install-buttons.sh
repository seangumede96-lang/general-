#!/usr/bin/env bash
# Puts the Start / Stop video2anim buttons where Termux:Widget finds them (~/.shortcuts in Termux's home).
# Works from plain Termux or from inside proot Ubuntu. Safe to run again.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TERMUX_HOME=/data/data/com.termux/files/home
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX/bin" ] && TERMUX_HOME=$HOME
[ -d "$TERMUX_HOME" ] || { echo "Can't reach Termux's home folder from here."; exit 1; }
mkdir -p "$TERMUX_HOME/.shortcuts"
cp "$HERE/start-video2anim.sh" "$TERMUX_HOME/.shortcuts/Start video2anim"
cp "$HERE/stop-video2anim.sh" "$TERMUX_HOME/.shortcuts/Stop video2anim"
chmod 700 "$TERMUX_HOME/.shortcuts" "$TERMUX_HOME/.shortcuts/Start video2anim" "$TERMUX_HOME/.shortcuts/Stop video2anim"
echo "Buttons installed. Add the Termux:Widget widget to your home screen to see them."
