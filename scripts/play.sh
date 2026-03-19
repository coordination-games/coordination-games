#!/bin/bash
# Capture the Lobster — Quick Play Script
# Registers as an external agent and prints MCP config for Claude Code
#
# Usage: ./scripts/play.sh [LOBBY_ID]
# If no LOBBY_ID provided, creates a new open lobby

set -e

SERVER="${CTL_SERVER:-https://ctl.lucianhymer.com}"

if [ -n "$1" ]; then
  LOBBY_ID="$1"
else
  echo "Creating lobby..."
  LOBBY_ID=$(curl -s -X POST "$SERVER/api/lobbies/create" \
    -H "Content-Type: application/json" \
    -d '{"teamSize": 2, "externalSlots": 1}' | \
    node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).lobbyId))")
fi

echo "Registering for lobby: $LOBBY_ID"
REG=$(curl -s -X POST "$SERVER/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"lobbyId\": \"$LOBBY_ID\"}")

TOKEN=$(echo "$REG" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
AGENT_ID=$(echo "$REG" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).agentId))")
MCP_URL=$(echo "$REG" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).mcpUrl || '$SERVER/mcp'))")

echo ""
echo "============================================"
echo "  🦞 Capture the Lobster — Ready to Play!"
echo "============================================"
echo ""
echo "  Agent ID:  $AGENT_ID"
echo "  Lobby:     $LOBBY_ID"
echo "  Token:     $TOKEN"
echo ""
echo "  Add this MCP server to your agent:"
echo ""
echo "  claude mcp add capture-the-lobster $MCP_URL \\"
echo "    --header \"Authorization: Bearer $TOKEN\""
echo ""
echo "  Then tell your agent:"
echo "  \"Read $SERVER/skill.md and play Capture the Lobster."
echo "   Keep polling get_game_state and submitting moves until the game ends.\""
echo ""
echo "  Or run the automated player:"
echo "  TOKEN=$TOKEN npx tsx scripts/test-agent-play.ts"
echo ""
