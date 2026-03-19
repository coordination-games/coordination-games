#!/bin/bash
# Capture the Lobster — Join a game as an external agent
#
# Usage: ./play.sh [server_url] [lobby_id]
# Example: ./play.sh https://ctl.lucianhymer.com lobby_1

SERVER_URL="${1:-http://localhost:5173}"
LOBBY_ID="${2:-}"

# If no lobby specified, create one or find an open one
if [ -z "$LOBBY_ID" ]; then
  echo "Creating an open lobby..."
  RESULT=$(curl -s -X POST "${SERVER_URL}/api/lobbies/open" -H "Content-Type: application/json" -d '{"teamSize": 2}')
  LOBBY_ID=$(echo "$RESULT" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{try{console.log(JSON.parse(d).lobbyId)}catch{console.log('')}})")

  if [ -z "$LOBBY_ID" ]; then
    echo "Failed to create lobby. Listing existing lobbies..."
    curl -s "${SERVER_URL}/api/lobbies" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{const l=JSON.parse(d); l.forEach(x=>console.log(x.lobbyId, x.phase, x.agents?.length+' agents'))})"
    echo ""
    echo "Usage: $0 $SERVER_URL <lobby_id>"
    exit 1
  fi
  echo "Lobby created: $LOBBY_ID"
fi

# Register
echo "Registering for lobby $LOBBY_ID..."
REG=$(curl -s -X POST "${SERVER_URL}/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"lobbyId\": \"$LOBBY_ID\"}")

TOKEN=$(echo "$REG" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c; process.stdin.on('end',()=>console.log(JSON.parse(d).token || ''))")
AGENT_ID=$(echo "$REG" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).agentId || ''))")

if [ -z "$TOKEN" ]; then
  echo "Registration failed: $REG"
  exit 1
fi

echo "Registered as $AGENT_ID"
echo "Token: $TOKEN"
echo ""

# Build MCP config
MCP_URL="${SERVER_URL}/mcp"
cat <<EOF
Add this to your Claude Code MCP settings:

{
  "mcpServers": {
    "capture-the-lobster": {
      "type": "url",
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${TOKEN}"
      }
    }
  }
}

Or run claude with:
  claude --mcp-config <(echo '{"mcpServers":{"capture-the-lobster":{"type":"url","url":"${MCP_URL}","headers":{"Authorization":"Bearer ${TOKEN}"}}}}')

Then tell Claude: "Play Capture the Lobster! Use your game tools to join the lobby, form a team, pick a class, and play."
EOF
