# Tragedy V2 Model

TOTC live registration now uses the V2 plugin path.

## Authority

- `TragedyOfTheCommonsV2Plugin` is registered in `packages/games/tragedy-of-the-commons/src/plugin.ts`.
- CLI MCP exposes V2 tools from `packages/cli/src/mcp-server.ts`.
- Setup action: `place_starting_camp`.
- Round actions: `build_road`, `build_structure`, `upgrade_structure`, `extract_tile`, `convert_timber_to_energy`, `offer_trade`, `pass`.

## Setup

- Initial V2 state has no starter structures and starts in `phase: "waiting"`.
- Player order is deterministic-randomized from seed before setup begins.
- `game_start` is a setup signal only; it must not bypass camp placement.
- On a setup turn, only the current unplaced player can call `place_starting_camp`.
- Starting camps are free, placed on empty intersections, and must be non-adjacent to existing starting camps.
- After every player places a legal starting camp, V2 automatically enters `phase: "playing"`, `round: 1`.

## State Shape

- Tiles are resource ecosystems: `tiles[]` with `terrain`, `primaryResource`, `health`, `status`.
- Intersections are build spots: `intersections[]` with stable ids and adjacent hexes.
- Structures occupy intersections: `structures[]` with `ownerId`, `intersectionId`, `type`.
- Roads connect intersections along tile edges: `roads[]` with `fromIntersectionId` and `toIntersectionId`.
- Players own ids: `ownedStructureIds`, `ownedRoadIds`.
- Do not infer fixed starter camps from player array order; read `structures[]` after setup.

## Web Adapter

- `SpectatorView` accepts either legacy `boardTiles` or V2 `tiles/intersections/structures/roads`.
- `OriginalObservatory` derives renderer `structureLocations`/`roadLocations` from V2 structures/roads and intersection hexes.
- Preview/test fixtures should not reintroduce `regions`, `regionId`, `regionIds`, `regionsControlled`, or `build_settlement`.

## Trust

- `trust-projector-tragedy` keeps v0 region parsing only as compatibility.
- V2 cards summarize structures, roads, solar investment, extraction pressure, and commons health.
