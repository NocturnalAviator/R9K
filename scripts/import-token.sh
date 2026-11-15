#!/usr/bin/env bash
# Copies the bot token from a file into .env without ever printing it.
# Usage: scripts/import-token.sh [path-to-token-file]
set -euo pipefail

src="${1:-$HOME/Documents/Val9KBotToken}"
cd "$(dirname "$0")/.."

if [ ! -f "$src" ]; then
  # Accept the same name with any extension (e.g. Val9KBotToken.txt).
  match=$(ls "$src".* 2>/dev/null | head -n 1 || true)
  [ -n "$match" ] || { echo "Token file not found: $src" >&2; exit 1; }
  src="$match"
fi

# First thing in the file that looks like a bot token: <digits>:<35+ chars>.
token=$(grep -oE '[0-9]{6,}:[A-Za-z0-9_-]{30,}' "$src" | head -n 1 || true)
[ -n "$token" ] || { echo "No bot token found in $src" >&2; exit 1; }

touch .env
chmod 600 .env
grep -v '^BOT_TOKEN=' .env > .env.tmp || true
printf 'BOT_TOKEN=%s\n' "$token" >> .env.tmp
mv .env.tmp .env
chmod 600 .env

echo "BOT_TOKEN written to .env (bot id ${token%%:*}, secret not shown)."
