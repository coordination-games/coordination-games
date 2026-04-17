# Comedy of the Commons

Initial upstream package scaffold for bringing **Comedy of the Commons** into the `coordination-games` engine as a normal `CoordinationGame` plugin.

This package is intentionally being built in phases.

## Purpose of this first slice

This branch starts the upstream port without pretending the full local prototype is already ported.

What this first step does:

- reserves the upstream package path
- defines the initial v0 type surface
- records the source-material mapping back to the richer local prototype

What this first step does **not** claim yet:

- full gameplay loop parity
- trust portability
- commitment / attestation parity
- Olympiad support

## Local source material

Primary source files currently live in the local arena prototype:

- `arena/src/games/nexus/comedy-engine.ts`
- `arena/src/games/nexus/types.ts`
- `arena/src/games/nexus/world-map.ts`
- `arena/src/games/nexus/trade.ts`

The upstream port should stay smaller than the local prototype at first.

## Intended v0 shape

Comedy v0 should become the smallest playable upstream slice:

- game package under `packages/games/comedy-of-the-commons`
- simple config builder / lobby path
- spectator plugin later
- basic resource, commons, trading, and building loop

## Rule

Do not silently port every rich subsystem from the local arena. Add only what is required for a believable playable v0, then layer v1/v2 features in later slices.
