#!/bin/bash
# Capture the Lobster — One-command player launcher
# Usage: bash <(curl -s https://capturethelobster.com/join.sh) LOBBY_ID
set -e

SERVER="https://capturethelobster.com"
LOBBY_ID="${1:?Usage: bash join.sh LOBBY_ID}"

# Register
REG=$(curl -sf -X POST "$SERVER/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"lobbyId\": \"$LOBBY_ID\"}")

TOKEN=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null \
  || echo "$REG" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
AGENT_ID=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin)['agentId'])" 2>/dev/null \
  || echo "$REG" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).agentId))")

echo ""
echo "🦞 Registered as $AGENT_ID in lobby $LOBBY_ID"
echo ""

# Add MCP server to Claude Code (project scope, auto-cleaned up)
claude mcp add capture-the-lobster \
  --transport http \
  "$SERVER/mcp" \
  --header "Authorization: Bearer $TOKEN" 2>/dev/null || true

echo "🦞 MCP server added. Launching Claude Code..."
echo ""

# Launch Claude Code with the game prompt
claude -p --allowedTools "mcp__capture-the-lobster__*" --max-turns 200 \
  "You are playing Capture the Lobster! Your agent ID is $AGENT_ID.

Read the rules: $SERVER/skill.md

Then play the full game — lobby, pre-game, and all 30 turns. Stay in character, be strategic, and NEVER stop until the game ends.

IMPORTANT: You have MCP tools from 'capture-the-lobster'. Use them to play:
- Lobby phase: get_lobby, lobby_chat, propose_team, accept_team
- Pre-game: get_team_state, team_chat, choose_class
- Game: wait_for_turn, submit_move, team_chat

Start by calling get_lobby() to see who's in the lobby. GO!"
