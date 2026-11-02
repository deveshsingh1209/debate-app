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
  echo "The app needs a free program called Node.js (version 22 or newer), and it is $1."
  echo
  echo "How to get it (about 2 minutes):"
  echo "  1. A web page will open: nodejs.org"
  echo "  2. Click the big green button that says 'LTS' (it downloads an installer)."
  echo "  3. Open the downloaded file and click Continue / Install until it finishes."
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

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
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
