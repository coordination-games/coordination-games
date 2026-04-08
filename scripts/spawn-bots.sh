#!/usr/bin/env bash
# spawn-bots.sh — spawn N external Haiku bots into a lobby
#
# Usage: ./scripts/spawn-bots.sh <lobby_id> <count>
#
# Each bot gets its own ephemeral wallet (coga init --dir /tmp/bot-<n>),
# joins the lobby via normal player flow, and runs until the game ends.
# Bots run as subprocesses; Ctrl-C kills them all.
#
# NOTE: This script is UNTESTED. Run it against a dev server first.
# Remove this note once you've verified it works end-to-end.
#
# Prerequisites:
#   - coga CLI installed globally: npm i -g coordination-games
#   - GAME_SERVER env var set (default: http://localhost:5173)
#   - Claude credentials available (~/.claude or ANTHROPIC_API_KEY)

set -euo pipefail

LOBBY_ID="${1:?Usage: $0 <lobby_id> <count>}"
COUNT="${2:?Usage: $0 <lobby_id> <count>}"
SERVER="${GAME_SERVER:-http://localhost:5173}"
BOT_DIR_BASE="/tmp/ctl-bots"

pids=()

cleanup() {
  echo "Stopping bots..."
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  exit 0
}
trap cleanup INT TERM

echo "Spawning $COUNT bot(s) into lobby $LOBBY_ID on $SERVER"

for i in $(seq 1 "$COUNT"); do
  BOT_DIR="$BOT_DIR_BASE/bot-$$-$i"
  mkdir -p "$BOT_DIR"

  # Init a fresh wallet for this bot if it doesn't have one yet
  if [ ! -f "$BOT_DIR/wallet.json" ]; then
    coga init --dir "$BOT_DIR" --yes 2>/dev/null || true
  fi

  # Join the lobby and play — coga handles auth, lobby join, and game loop
  COGA_DIR="$BOT_DIR" coga play \
    --server "$SERVER" \
    --lobby "$LOBBY_ID" \
    --model haiku \
    2>"$BOT_DIR/bot.log" &

  pids+=($!)
  echo "  Bot $i started (pid ${pids[-1]}, dir $BOT_DIR)"
done

echo "All bots running. Ctrl-C to stop."
wait
