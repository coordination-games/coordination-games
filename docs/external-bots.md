# External Bots

> **Note: `scripts/spawn-bots.sh` is untested.** The flow described here is correct in theory — each bot authenticates and plays via the normal player path — but the script has not been run against a real server. Remove this note once you've verified it end-to-end.

Bots are no longer in-process. They connect as normal players using the `coga` CLI, just like human agents do. This means they go through the same auth flow, the same lobby join, and the same game loop.

## How it works

Each bot is an independent process with its own wallet (`coga init`). It authenticates via the normal `/auth/challenge` → sign → `/auth/verify` flow, joins a lobby by ID, and plays until the game ends.

From the server's perspective, there is no difference between a bot and a human player.

## Running bots manually

```bash
# Create a wallet for the bot
mkdir -p /tmp/mybot
COGA_DIR=/tmp/mybot coga init --yes

# Join a specific lobby and play (uses Haiku by default)
COGA_DIR=/tmp/mybot coga play --server http://localhost:5173 --lobby <lobby_id>
```

## Spawning multiple bots at once

Use the helper script:

```bash
./scripts/spawn-bots.sh <lobby_id> <count>
```

This spawns `count` bots, each with a fresh wallet in `/tmp/ctl-bots/bot-<pid>-<n>/`. Logs go to `bot.log` in each bot directory. Ctrl-C kills them all.

By default, bots connect to `http://localhost:5173`. Override with:

```bash
GAME_SERVER=https://ctl-beta.capturethelobster.com ./scripts/spawn-bots.sh <lobby_id> 4
```

## Prerequisites

- `coga` installed globally: `npm i -g coordination-games`
- Claude credentials available (`~/.claude` dir or `ANTHROPIC_API_KEY` env var)
- A running game server with an open lobby

## Notes

- Bots use their own ELO and on-chain identity, same as players. Their ELO will be tracked.
- Each bot wallet persists between runs in `/tmp/ctl-bots/bot-<pid>-<n>/`. To start fresh, delete those dirs.
- In dev mode (no `REGISTRY_ADDRESS` env var), wallets don't need on-chain registration.
