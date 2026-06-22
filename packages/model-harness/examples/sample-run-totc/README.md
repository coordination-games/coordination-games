# Sample run — Tragedy of the Commons (4 Haiku bots)

A real, unedited output from `coga-harness run runs/claude-totc.yaml` — four
Claude Haiku bots (2 `peaceful-mediator`, 2 `win-focused-opportunist`) playing
Tragedy of the Commons V2 to completion through the real coga MCP path.

- `manifest.json` — run metadata, seats, final `outcome` (winner + scores), and
  per-bot consequential/talk-only turn counts.
- `analysis.json` — the automated judge report (coordination, betrayals,
  notable moments, per-bot style + trust).

The full per-bot transcripts (`bots/*.jsonl`) and relay ground truth
(`relay.jsonl`) are produced alongside these in a real run but are omitted here
to keep the sample small (see `runs/.gitignore`).

In this game the **win-focused-opportunist won** (VP 3) by declining the
mediators' low-intensity extraction pact and optimizing for victory points — a
nice contrast to runs where the cooperative pact holds and a mediator wins.
