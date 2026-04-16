#!/usr/bin/env bash
# spawn-bots.sh — join N bots into an existing CtL lobby and start their MCP servers
#
# Usage: ./scripts/spawn-bots.sh <lobby_id> <count>
#
# Each bot gets its own ephemeral wallet, authenticates, joins the lobby, then
# starts an HTTP MCP server so a Claude agent can connect and play.
#
# For automated testing, prefer:
#   tsx scripts/run-game.ts        — full e2e (ephemeral wallets, creates lobby)
#   tsx scripts/fill-bots.ts <id>  — fill an existing lobby from the pool
#
# Prerequisites:
#   - coga CLI installed globally: npm i -g coordination-games
#   - GAME_SERVER env var set (default: http://localhost:8787)
#   - node in PATH

set -euo pipefail

LOBBY_ID="${1:?Usage: $0 <lobby_id> <count>}"
COUNT="${2:?Usage: $0 <lobby_id> <count>}"
SERVER="${GAME_SERVER:-http://localhost:8787}"
BOT_DIR_BASE="/tmp/ctl-bots"
BASE_PORT=3100

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
  PORT=$((BASE_PORT + i - 1))

  # Init wallet if needed
  if [ ! -f "$BOT_DIR/keys/default.json" ]; then
    COORDINATION_DIR="$BOT_DIR" coga init --server "$SERVER" 2>/dev/null || true
  fi

  BOT_KEY=$(node -e "process.stdout.write(require('$BOT_DIR/keys/default.json').privateKey)")
  BOT_ADDR=$(node -e "process.stdout.write(require('$BOT_DIR/keys/default.json').address)")
  BOT_NAME="bot$i-${BOT_ADDR:2:6}"

  # Auth + join lobby via REST
  TOKEN=$(node --input-type=module <<EOF
import { ethers } from 'ethers';
const wallet = new ethers.Wallet('$BOT_KEY');
const {nonce, message} = await (await fetch('$SERVER/api/player/auth/challenge', {method:'POST'})).json();
const sig = await wallet.signMessage(message);
const {token} = await (await fetch('$SERVER/api/player/auth/verify', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({nonce, signature:sig, address:wallet.address, name:'$BOT_NAME'}),
})).json();
await fetch('$SERVER/api/player/lobby/join', {
  method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
  body: JSON.stringify({lobbyId:'$LOBBY_ID'}),
});
process.stdout.write(token);
EOF
)

  echo "$TOKEN" > "$BOT_DIR/token"
  echo "  Bot $i ($BOT_NAME) joined — MCP server will listen on http://localhost:$PORT/mcp"

  # Start HTTP MCP server so a Claude agent can connect
  COORDINATION_DIR="$BOT_DIR" coga serve \
    --http "$PORT" \
    --bot-mode \
    --key "$BOT_KEY" \
    --name "$BOT_NAME" \
    --server-url "$SERVER" \
    2>"$BOT_DIR/bot.log" &

  pids+=($!)
done

echo ""
echo "All bots joined and MCP servers running."
echo "Connect Claude agents to http://localhost:${BASE_PORT}/mcp through http://localhost:$((BASE_PORT + COUNT - 1))/mcp"
echo "Ctrl-C to stop all bots."
wait
