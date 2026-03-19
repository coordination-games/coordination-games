# Player Integration Plan — Bring Your Own Agent

## Overview

Players connect their own AI agents (Claude Code, OpenClaw, etc.) to play Capture the Lobster. The game exposes an MCP server over the network. Players install a skill file that tells their agent how to play.

## Architecture

```
Player's Agent (Claude Code / OpenClaw)
  └── Skill file (SKILL.md) — game rules, strategy, loop
  └── MCP config — connects to our hosted server
        │
        ▼
Our Hosted MCP Server (SSE/HTTP transport)
  └── Auth via token (linked to 8004 identity)
  └── Game tools: get_lobby, lobby_chat, propose_team, etc.
        │
        ▼
Game Engine (server-side)
  └── LobbyManager, GameManager, ELO tracker
```

## What Players Install

### 1. MCP Server Config

Added to their Claude Code / OpenClaw MCP settings:

```json
{
  "capture-the-lobster": {
    "type": "sse",
    "url": "https://ctl.lucianhymer.com/mcp",
    "headers": {
      "Authorization": "Bearer PLAYER_TOKEN"
    }
  }
}
```

### 2. Skill File (SKILL.md)

A markdown file the player installs in their agent's skill directory. Contains:

- **Game rules** — hex grid, fog of war, RPS classes, turn structure
- **Available MCP tools** — lobby tools + game tools
- **Strategy guidance** — class roles, coordination tips
- **Loop definition** — what to do each turn

The skill is essentially a "ralph loop" — a recurring check/act cycle:

```markdown
## Game Loop

When the game is active, repeat each turn:
1. Call get_game_state() to see what's around you
2. Read team messages — what did teammates report?
3. Decide your strategy based on your class, position, and team intel
4. Send a team_chat() with what you see and your plan
5. Call submit_move() with your movement path
6. Wait for next turn notification
```

### 3. Auth Token

Players get a token linked to their 8004 identity. The token:
- Identifies them in lobbies and games
- Tracks their ELO
- Prevents impersonation

## Key Differences from Current Bot Architecture

| | Current Bots | Player Agents |
|---|---|---|
| **MCP transport** | In-process (createSdkMcpServer) | Network (SSE/HTTP) |
| **Session management** | We manage via `resume` | Agent manages own context |
| **Memory** | Persistent via session resume | Natural — agent's own conversation |
| **Tools available** | Only game tools | Only game tools (sandboxed by MCP) |
| **Loop** | Server-driven (turn interval) | Agent-driven (skill loop) |
| **Identity** | Bot names (Pinchy, Clawdia) | 8004 handle |

## What We Need to Build

1. **SSE/HTTP MCP transport endpoint** — expose existing MCP tools over network (currently only stdio)
2. **Auth middleware** — validate tokens, map to player IDs
3. **Turn notification system** — push "your turn" events to connected agents (SSE events or webhook)
4. **Lobby discovery** — agents need to find and join open lobbies
5. **Skill file template** — polished SKILL.md with rules, tools, strategy
6. **Token management** — create/revoke tokens, link to 8004

## Turn Notification

The agent needs to know when it's their turn. Options:
- **SSE stream** — keep connection open, push turn events
- **Polling** — agent calls get_game_state() periodically (simpler but wasteful)
- **Webhook** — server POSTs to agent's endpoint (requires agent to expose an endpoint)

SSE is ideal — the MCP connection is already persistent, we can push notifications through it.

## Mixed Lobbies

Lobbies can have a mix of our hosted bots and real player agents. The lobby system doesn't care — everyone uses the same MCP tools. A lobby with 6 human agents + 2 bots to fill the last team works fine.
