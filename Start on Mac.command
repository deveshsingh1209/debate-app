#!/bin/bash
# Double-click this file to start the Debate App on a Mac.
# Options (Terminal only): --check  = only verify this Mac is ready, start nothing.

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

pause_and_exit() {
  echo
  echo "You can close this window now."
  # Only wait for a key when a person is looking at a window.
  if [ -t 0 ] && [ "$1" != "0" ]; then
    read -r -p "Press Enter to close. " _
  fi
  exit "$1"
}

echo "The Debate App"
echo "--------------"

need_node() {
  echo
  echo "The app needs a free program called Node.js (version 22.13 or newer), and it is $1."
  echo
  echo "How to get it (about 2 minutes):"
  echo "  1. A web page will open: nodejs.org"
  echo "  2. Click the big green button that says 'LTS' (it downloads an installer)."
  echo "  3. Open the downloaded file and click Continue / Install until it finishes."
  echo "     Already have an older Node.js? Do the same: the installer updates it in place."
  echo "  4. Come back and double-click 'Start on Mac.command' again."
  echo
  if [ -t 0 ]; then
    read -r -p "Open nodejs.org for you now? (y/n) " answer
    case "$answer" in
      [yY]*) open "https://nodejs.org/en/download" ;;
    esac
  fi
  pause_and_exit 1
}

if ! command -v node >/dev/null 2>&1; then
  need_node "not installed on this Mac"
fi

# The built-in database the app uses (node:sqlite) needs Node 22.13+, or 23.4+ on the short-lived 23 line.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 4) || (a === 22 && b >= 13) ? 0 : 1)' 2>/dev/null; then
  need_node "too old (you have $(node -v 2>/dev/null))"
fi

node scripts/start.mjs "$@"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo
  echo "The app stopped with a problem (see the message above)."
  echo "Help: README.md, section 'Troubleshooting'."
fi
pause_and_exit "$STATUS"
