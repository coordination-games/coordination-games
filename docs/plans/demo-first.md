# Demo-first: from instrument to demonstration

Steer (Aaron, 2026-07-03): the console is "way too techy-configurable, way not enough *just run a thing and it demonstrates the value*." The audience for the next block is not the researcher — it's the viewer: Kevin, Spencer, a funder, a partner. They should open one page, press one button, and *watch AI agents cooperate* — then be handed the finding in plain English.

## The three-layer demo experience

**1. The front door: demonstrations, not campaigns.**
Home page = three big cards phrased as questions, one button each:
- *"Can AI agents share a commons?"* — one quick game, ~5 min
- *"Which AI cooperates better?"* — haiku vs sonnet-5 face-off
- *"Does a peacemaker change everything?"* — 0-mediators vs 4-mediators contrast
Zero configuration. The console auto-starts the game server, launches the canned spec, and routes the viewer to a progress → findings flow. All the existing config becomes the "Lab" (moved aside, not removed).

**2. The middle: watch it happen.**
A story view over a running/finished game — chat bubbles, action lines ("bot3 extracted from the shared forest"), round markers, a commons-health meter. Two candidate sources, to be assessed:
- the existing packages/web spectator/replay UI (rich, game-aware; currently stubbed off on prod)
- a console-native narrative feed over `/api/admin/session/:id/inspect` (relayMessages + gameState, already authenticated via inspector token)

**3. The payoff: findings, not tables.**
Per-campaign Findings view: conditions grouped (label minus `-rN`), n / commons-health / trust / incidents per condition, an inline SVG bar chart, judge quotes, and a plain-English verdict line. One button exports it as a self-contained HTML research artifact (feeds games.coop/research + the pitch).

## Build order (Sonnet subagents; Fable orchestrates + merges)

- **A (research):** assess packages/web spectator/replay readiness for Tragedy V2 — what it takes to serve it locally/tailnet and link "watch" from the console. Informs layer 2's build choice.
- **B (build):** demo front door — server-side canned demos (`/api/demos`, `/api/demos/:id/run` with game-server auto-start), Home = demo cards, existing pages become the Lab.
- **C (build):** Findings — `/api/campaigns/:id/findings` aggregation + FindingsPage with SVG chart + HTML export endpoint.
- **D (build, after A):** the story view, via whichever source A recommends.

## Principles

- A demo must never show a stack trace. Every failure path ends in a plain sentence and a retry button.
- Plain English first, numbers second, JSON last (still reachable — dig-in transparency).
- Nothing new in the harness; demos are canned specs through the same CLI path (One Rule).
- Sonnet builds, Fable reviews and merges; worktrees for parallel builders.
