# Model harness

`scripts/run-model-harness.ts` is a lightweight, model-agnostic game runner.
It sits outside the game engine: the engine exposes auth, lobbies, game tools,
and relay tools; the harness chooses a model/provider and drives agents.

## Providers

- `PROVIDER=scripted` — no model calls; validates game/reasoning plumbing.
- `PROVIDER=openai-compatible` or `PROVIDER=minimax` — calls an OpenAI-compatible
  `/chat/completions` API. MiniMax works through this path.

## MiniMax example

Do not put secrets in files. Export them only in your shell/session:

```bash
GAME_SERVER=http://127.0.0.1:3101 \
PROVIDER=minimax \
OPENAI_BASE_URL=https://api.minimax.io/v1 \
OPENAI_API_KEY=... \
MODEL=MiniMax-M2.7-highspeed \
HARNESS_ROUNDS=3 \
tsx scripts/run-model-harness.ts
```

The harness will:

1. authenticate ephemeral players,
2. create and fill a Tragedy lobby,
3. wait for the lobby to auto-start a game,
4. ask the provider for public reasoning + one action,
5. publish `reasoning` relay entries,
6. submit the chosen game action,
7. print game and Inspector URLs.

## Contract

The model should return only JSON:

```json
{
  "reasoning": "public strategy note, not hidden chain-of-thought",
  "action": { "type": "pass" }
}
```

Invalid or rejected actions fall back to `pass` so local demos keep moving.
