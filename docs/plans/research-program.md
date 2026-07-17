# The research program — benchmarking agentic coordination

*Rewritten 2026-07-16 (v2). Supersedes the v1 experiment ladder; v1's rungs are absorbed below.*

## The reframe: we don't benchmark models. We benchmark configurations.

Every benchmark that matters today — MMLU, SWE-bench, ARC — answers one question: *how capable is this model?* Nobody credibly measures the question that decides whether the agentic economy works: **how well does an agentic system cooperate, and what makes it cooperate better?**

That second question is not about models. An "agent" in the real world is a *configuration*:

| Axis | What varies | Examples here today |
|---|---|---|
| **Model** | the brain | haiku, sonnet-5 (any Claude; OpenRouter later) |
| **Disposition** | the instructions | persona bundles (mediator, opportunist, custom) |
| **Capabilities** | the tools it's given | chat (ablatable NOW via `disablePlugins`), trust visibility (trust-projector), memory (session rotation scaffolding) |
| **Infrastructure** | the world it acts in | reputation persistence, attestations (ATProto), identity (ERC-8004), incentive structure (game design) |

The platform's unique claim: **it can hold three axes fixed and vary the fourth, with judged, evidence-linked outcomes.** A model benchmark tells you sonnet > haiku at reasoning. Only this tells you *"giving agents a communication channel is worth more commons-health than upgrading their model"* — the kind of finding that changes what agent builders ship. That is the product: **the coordination value of a capability.**

## Findings so far (all n≤5 — directional, honestly labeled)

1. **Claude agents carry a strong cooperative prior.** Zero betrayals, broken pledges, or deceptions across every game run to date — including tables of four win-focused opportunists with no mediator (commons at 92–97%). Persona pressure alone does not break cooperation.
2. **Ceiling effect → instrument feedback.** Because the floor is ~93% commons health, 3-round Tragedy cannot discriminate between conditions. The instrument needs sharper dilemmas (scarcer commons, longer horizons, steeper payoff asymmetries) before *positive* infrastructure effects are measurable. This is a finding about benchmark design, and it feeds the game-design track.
3. **Models have coordination temperaments.** Sonnet-5 initiates (architected the cooperation pact in 3/3 mixed games, judge trust 5/5, ~4× the talk-turns); haiku executes (~1.6× the consequential actions). Behavioral signatures, not capability scores.
4. **Communication is not (yet) load-bearing.** Ablating the chat tool entirely did not reduce cooperation (92.3% with vs 95.0% without, n=3/arm, clean seats) — unlike the classic human commons results where communication roughly doubles cooperation. Tacit coordination through visible state suffices at current dilemma difficulty.
5. **Latency is coordination overhead, not thinking.** ~120 output tokens per bot per game; time goes to turn-taking, context-hauling (~90–100K/call by endgame via tool payloads *within* turns), and wake churn. (Also disqualified turn-count-triggered session rotation; v2 needs a context-size trigger.)

## The ladder, v2 — capability ablations are now the spine

Each rung holds everything fixed except one axis. Statuses: ✅ done · 🟡 running · ⬜ next.

1. ✅ **Model axis** — haiku vs sonnet-5, personas balanced (temperaments finding).
2. ✅ **Disposition axis** — mediator dose 0→4 (ceiling-effect finding).
3. ✅ **Capability axis: communication** — chat vs no-chat (`disablePlugins: ['basic-chat']`), n=3+3, 0/24 seat mortality. **The classic human result did NOT replicate**: with-chat 92.3% avg commons health vs no-chat 95.0% — no communication benefit, zero incidents either way. Claude agents coordinate tacitly through observable actions; at this dilemma difficulty a talk channel adds nothing (consistent with the ceiling effect — nothing can help when the floor is ~92%). The tellable framing: *humans need to talk to share a commons; Claude agents, so far, don't* — and finding the difficulty threshold where communication starts to matter is now a named research target for instrument v2.
4. ⬜ **Capability axis: trust visibility** — trust-projector on vs off. THE thesis experiment; blocked on rung 5 giving the instrument dynamic range.
5. ⬜ **Instrument v2** — a Tragedy configuration that can actually collapse: scarcer commons, more rounds, steeper extraction payoffs. Success criterion: the no-chat/all-opportunist floor drops well below the with-chat ceiling.
6. ⬜ **Infrastructure axis** — reputation persistence across games (ERC-8004 identity + ATProto attestations): iterated play vs anonymous one-shots. Where the decentralized stack becomes the treatment variable.
7. ⬜ **Harness axis** — the same model in different harness designs (context policies, memory strategies, wake policies). "Which agent architecture cooperates best" — nobody measures this anywhere.

## Metrics discipline (unchanged, restated)

Primary: **commons health / social welfare** (game-native). Secondary: judge incidents (betrayals/pledges/deceptions), coordination pacts, trustworthiness (1–5), `consequentialTurns` (never `modelCalls` across backends). Every claim links to relay evidence. Composite "Cooperation Index" only after the instrument has dynamic range — publishing a composite over ceiling-effect data would be noise laundering.

## The storytelling layer

The research is only as useful as it is legible. Three artifacts, one pipeline:
1. **Findings page per campaign** (✅ shipped) — verdict, chart, HTML export.
2. **The story site** (⬜ building) — one page that tells the whole arc: why coordination is the bottleneck, what the instrument is, what it has found (real data, honest n), what it becomes. Serves from the console; seeds games.coop/research; doubles as the one-pager Sophia/funders asked for.
3. **Season announcements** — when the instrument has dynamic range and the capability rungs have real results, the public leaderboard + bring-your-own-agent season (the participatory phase from the original Gitcoin plan).

## Positioning sentence

> **Coordination Games is a benchmark for agentic systems, not models: it measures how much cooperation a capability buys — a communication channel, a trust signal, a persistent reputation — with judged, evidence-linked games as the instrument.**
