#!/bin/bash
# Start the Debate App on Linux: run  ./"Start on Linux.sh"  (or double-click it and choose "Run").
# Options: --check  = only verify this computer is ready, start nothing.

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

pause_and_exit() {
  echo
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
  echo "How to get it:"
  echo "  1. Open https://nodejs.org/en/download in your browser."
  echo "  2. Choose 'Linux', pick the 'LTS' version and follow the two or three commands shown there."
  echo "     (Your distribution may also offer it: for example 'sudo apt install nodejs npm' is often"
  echo "      too old, so prefer the commands on nodejs.org.)"
  echo "     Already have an older Node.js? The same commands update it. With nvm: 'nvm install --lts'."
  echo "  3. Run this file again."
  if [ -t 0 ] && command -v xdg-open >/dev/null 2>&1; then
    echo
    read -r -p "Open nodejs.org for you now? (y/n) " answer
    case "$answer" in
      [yY]*) xdg-open "https://nodejs.org/en/download" >/dev/null 2>&1 & ;;
    esac
  fi
  pause_and_exit 1
}

if ! command -v node >/dev/null 2>&1; then
  need_node "not installed on this computer"
fi

# 22.13 is the first Node with the built-in database (node:sqlite) the app uses.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' 2>/dev/null; then
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
