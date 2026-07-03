# Research program — from console to proof

What the Campaign Console is *for*. The pilot's deliverable is a defensible claim about agent cooperation, backed by auditable data ("proof, not trust" — the ask from comms/partnership side). The console is the instrument; this is the experiment ladder it runs.

## The ladder — each rung is a publishable claim

**1. Model comparison — "which models cooperate?"** *(first study running 2026-07-03)*
Mixed tables, personas balanced across models, N repeats. Metrics per model: judge trustworthiness, betrayals, pledges kept, consequential turns, wins, commons survival. Haiku vs Sonnet-5 first (subscription-only); an OpenRouter key adds GPT/Gemini/DeepSeek/MiniMax rows → the public **Cooperation Benchmark** leaderboard. This is the nerd-snipe: model rankings get attention, and ours ranks something nobody else measures.

**2. Social composition — "does a mediator save the commons?"**
Same game, vary the persona mix (4 opportunists / 3+1 / 2+2 / 4 mediators) × repeats. Output: a dose-response curve of cooperative presence vs commons survival. The most legible chart we can make — one picture that explains the whole project to a stranger.

**3. Trust-infrastructure ablation — THE thesis experiment.**
`disablePlugins` exists for exactly this (harness PR #51). Same seats, trust projector on vs off: do visible reputation signals change betrayal rates and outcomes? The project's core claim — *cooperation infrastructure measurably changes agent behavior* — gets its first controlled evidence here. If the effect is real, this is the headline result of the pilot report.

**4. Track record across games — where the decentralized stack plugs in.**
Persistent identity (ERC-8004) + attestations (ATProto lexicons) let agents carry reputation between games. Experiment: iterated play with persistent identities vs anonymous one-shots. This is where the infra tracks (ATProto implementation, EVM↔DID handshake) stop being parallel workstreams and become the *treatment variable* of the research.

## Metrics discipline

- **Cooperation Index** (to be formalized after ~20 runs of data): composite of trustworthiness (judge), betrayal rate (inverse), pledge-keeping, coordination events, commons sustainability (game outcome). Publish components alongside the composite — no black-box scores.
- Report **social welfare** (did the commons survive? total settlement value) alongside winners. Tragedy's whole point is that the winner-metric and the welfare-metric diverge.
- **Every claim links to evidence.** The judge's `relayRefs` point at actual messages; the console renders them inline. "Proof" = anyone can click from a chart to the betrayal itself. That auditability *is* the product differentiation.
- `consequentialTurns` for cross-backend activity, never `modelCalls`.

## Pipeline of legibility (build order)

1. **Now:** console runs studies locally, team views over tailnet. ✅
2. **Research artifact export:** a console view that renders selected campaigns into a self-contained HTML report (aggregate table + charts + judge quotes with evidence). Paste onto games.coop `/research`. Directly feeds the pitch doc / one-pager asks.
3. **Central ingest:** tiny worker endpoint (D1/R2) receiving run dirs on opt-out upload from any harness user; public leaderboard reads it. "Anyone who runs a campaign contributes data" — the distributed research engine.
4. **ATProto publication:** manifests/attestations published to agent repos — the same results, decentralized and independently verifiable. Season 1 ("bring your own agent") builds on this.

## Practical notes

- Claude seats run on a Claude subscription: the machine's `~/.claude` login or a saved `claude setup-token` (Settings). No API billing. OpenRouter seats need a key.
- A 4-seat, 2-3 round Tragedy run ≈ 15-20 min wall incl. judge; sequential. Overnight sweeps are the way to get n≥10 per condition — spec `repeats` handles it.
- Judge = haiku for iteration speed; rerun `analyze` with sonnet-5 on runs that make it into a report.
