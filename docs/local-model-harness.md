# Local model harness

The local harness is committed at [`scripts/run-model-harness.ts`](../scripts/run-model-harness.ts). It creates throwaway wallet-backed bots, starts or joins a local lobby through the normal HTTP API, polls each bot's visible state, asks a model provider for chat/DM/action decisions, publishes reasoning evidence through the relay plugin, and submits legal game actions.

## What it is for

- End-to-end testing of Coordination Games without the browser.
- Reproducing model-agent negotiation, private messages, relay wakeups, and turn actions against a local Worker server.
- Verifying that trust cards and trust evidence publishing are produced from real game progress.

This harness is demo-specific today: it imports this repo's API helpers, assumes Coordination Games lobby/session endpoints, and includes Tragedy of the Commons prompt/action schemas. It should stay here unless it becomes a reusable cross-repo testing tool.

## Providers

Set `PROVIDER` to one of:

- `scripted` - deterministic local bot logic; no model API key required.
- `openai-compatible` - any OpenAI-compatible `/chat/completions` endpoint.
- `minimax` - MiniMax using the same OpenAI-compatible request shape.

Useful environment variables:

```bash
GAME_SERVER=http://127.0.0.1:8787
PROVIDER=scripted
MODEL=MiniMax-M2.7-highspeed
HARNESS_ROUNDS=12
HARNESS_COMMUNICATION_SWEEPS=1
OPENAI_BASE_URL=https://api.minimax.io/v1
MINIMAX_API_KEY=<export-in-your-shell-only>
```

Do not paste API keys into committed files, shell history, issue text, or logs. Export them in your own shell session or use a local ignored secret manager/env loader.

## Typical scripted run

Start the Worker on a non-conflicting port, then run:

```bash
PROVIDER=scripted \
GAME_SERVER=http://127.0.0.1:8787 \
HARNESS_ROUNDS=12 \
HARNESS_COMMUNICATION_SWEEPS=1 \
npm run harness:model
```

## Typical MiniMax run

```bash
export MINIMAX_API_KEY=<your-key>
PROVIDER=minimax \
OPENAI_BASE_URL=https://api.minimax.io/v1 \
GAME_SERVER=http://127.0.0.1:8787 \
HARNESS_ROUNDS=12 \
HARNESS_COMMUNICATION_SWEEPS=1 \
npm run harness:model
```

The harness now prints provider, bot, round, relay cursor, sweep, HTTP status, invalid JSON previews, and stack traces when a model call or relay publish fails. That is intentionally verbose: a failed autonomous run should identify the exact bot wakeup that broke.

## Lighthouse/IPFS publishing

Trust evidence publishing happens in the Worker, not in the browser or harness. The Worker needs:

```bash
TRUST_IPFS_PUBLISH_ENABLED=true
LIGHTHOUSE_API_KEY=<export-or-env-file-only>
TRUST_IPFS_VERIFY_GATEWAY=true
```

If Lighthouse returns 401, the current configured Lighthouse key is rejected by Lighthouse itself. The publisher stores a sanitized error preview from the response body, but it never stores or prints the key.
