# Tragedy Simple Commons V2

End-to-end no-code spec for the simplified Tragedy redesign. Goal: a readable commons game where tiles are resources, buildings create extraction capacity, rivers carry damage, and clean energy competes with dirty energy.

## Core Model

The board has three object layers only:

- **Tiles** — resource ecosystems with health.
- **Intersections** — build spots at tile corners.
- **Roads** — edges connecting intersections.

Remove regions, plains, commons tiles, fisheries-as-separate-tiles, and wasteland-as-starting-terrain. The whole map is the commons. Wasteland/collapse is a tile state, not a tile type.

## Tile Types

| Tile | Produces | Role |
| --- | --- | --- |
| Forest | Timber | Renewable but damaged by wood harvest. |
| Mountain | Ore | Valuable extraction; pollutes connected river systems. |
| River | Fish/Food or Water | Water connector; carries downstream damage. |
| Wetland | Fish/Food or Water | Downstream sink; absorbs pollution and can degrade. |
| Oil Field | Energy | Rare, high-energy tile with heavy local/downstream damage. |

Every tile has health: **healthy → strained → collapsed**. Collapsed tiles are non-harvestable and produce nothing until they rest/recover above the collapse threshold.

## River / Wetland Topology

No separate river paths. River tiles are the path.

- River tiles connect upstream/downstream through neighboring river tiles.
- Wetlands are downstream endpoints and buffers.
- Upstream of a river can be river, forest, mountain, or oil.
- Forest and mountain can border each other.
- Damage only travels downstream when the harvested tile is connected to a river/wetland system.
- Isolated forest/mountain damage stays local.

Downstream damage should travel up to **3 river/wetland tiles**, losing strength each step. Wetlands reduce incoming damage but take some damage themselves.

## Extraction

Each settlement can perform a number of extractions per turn based on size:

| Building | VP | Extractions / turn |
| --- | ---: | ---: |
| Camp | 1 | 1 |
| Village | 2 | 2 |
| City | 3 | 3 |

Each extraction chooses one adjacent tile and one resource available from that tile.

- River: choose Fish/Food or Water.
- Wetland: choose Fish/Food or Water.
- Forest: Timber.
- Mountain: Ore.
- Oil Field: Energy.

Oil is special: each oil extraction produces **2 Energy** and causes heavier damage.

## Damage Rules

Use red overlays to show damage immediately after harvest.

- Forest harvest damages the forest tile. If connected to river, lightly damages the bordering river and downstream tiles.
- Mountain harvest damages the mountain tile. If connected to river, moderately damages the bordering river and downstream tiles.
- River/Wetland harvest damages that river/wetland tile because water/fish carrying capacity is reduced.
- Oil harvest damages the oil tile, adjacent tiles, and downstream river/wetland tiles if connected.
- Timber-to-energy conversion does not add extra forest damage; damage already happened when timber was harvested.

Suggested downstream damage falloff:

- Timber: adjacent river `-2`, next `-1`.
- Ore: adjacent river `-4`, next `-2`, next `-1`.
- Oil: adjacent/neighbor tiles `-6`, downstream `-5`, `-3`, `-1`.

Tune these after playtests.

## Energy

Energy is intentionally important.

Sources:

- **Oil**: fast dirty energy; 1 extraction = 2 Energy.
- **Solar Farm / Solar Array**: clean energy buildings at intersections.
- **Timber conversion**: `2 Timber → 1 Energy`, no additional tile damage.

## Intersections and Buildings

Each intersection can hold exactly one structure:

- Camp / Village / City, or
- Solar Farm / Solar Array.

Settlements harvest adjacent tiles. Solar buildings do not harvest; they generate clean Energy each round.

| Building | Output / Role | VP |
| --- | --- | ---: |
| Camp | 1 extraction/turn | 1 |
| Village | 2 extractions/turn | 2 |
| City | 3 extractions/turn | 3 |
| Solar Farm | +1 Energy/round | 1 |
| Solar Array | +2 Energy/round | 2 |

## Roads

Roads are lines between intersections.

- Roads connect expansion paths.
- Roads do not produce resources.
- New Camps must connect to your road network after initial placement.
- Roads cost Energy so expansion competes with extraction and upgrades.

## Starting Setup

- Randomize player order.
- Each player places one free Camp.
- Camps cannot be directly adjacent; leave at least one empty intersection between camps.
- No snake placement for v2.

## Build Costs

| Build | Cost |
| --- | --- |
| Road | 1 Timber + 1 Energy |
| Camp | 1 Timber + 1 Fish/Food + 1 Water + 1 Energy |
| Upgrade to Village | 2 Timber + 1 Fish/Food + 1 Water + 2 Energy |
| Upgrade to City | 2 Ore + 2 Fish/Food + 1 Water + 3 Energy |
| Solar Farm | 1 Ore + 1 Timber + 2 Energy |
| Upgrade to Solar Array | 2 Ore + 2 Water + 3 Energy |

## Scoring

Players win with victory points and final commons payout.

- Camp: 1 VP.
- Village: 2 VP.
- City: 3 VP.
- Solar Farm: 1 VP.
- Solar Array: 2 VP.
- Optional endgame conversion: every 3 banked resources = 1 VP.
- Final payout/score is reduced by low average tile health.

The game should reward building and upgrading, but punish winning through collapse.

## Current Assets We Can Reuse

- Forest health states.
- Mountain health states.
- Shared river/wetland health states for first prototype.
- Resource icons: fish, water, timber, ore, energy.
- Settlement sprites: camp, village, city. Township can be retired or reserved.
- VFX: extraction, health-drain, warning, regeneration, collapse, build, winner.

## Missing Visual Assets

- Oil Field tile with healthy / strained / collapsed states.
- Separate River tile health states.
- Separate Wetland tile health states.
- Road sprites/edge segments.
- Intersection/build-spot marker sprites.
- Solar Farm building sprite.
- Solar Array upgraded building sprite.
- Red damage overlay frames for affected tiles.
- Downstream pollution flow VFX across river/wetland tiles.
- Wetland absorption/buffer VFX.
- Oil spill / oil smoke VFX.
- Timber-to-energy conversion icon/VFX.

## Image Generator Prompt

Create a cohesive isometric/flat-top hex strategy board asset pack for a game called “Tragedy of the Commons.” Match a polished painterly digital-board-game style: readable at small size, transparent PNG sprites, warm natural palette, dramatic but not cartoonish, no text baked into images, no UI frames, no perspective mismatch.

Needed assets:

1. Oil Field terrain tile, flat-top hex, four health states: healthy/untapped, active/strained, leaking/damaged, collapsed/exhausted. Show oil derricks, dark soil, and increasing spill damage. Transparent background.
2. River terrain tile, flat-top hex, four health states: clear healthy river, reduced/murky river, polluted red-brown warning river, collapsed/dry-toxic river. Transparent background.
3. Wetland terrain tile, flat-top hex, four health states: lush wetland, healthy wetland, polluted/murky wetland, collapsed/dead marsh. Transparent background.
4. Road sprites for hex-board edges: straight road segment, slight curved road segment, junction cap, all transparent PNG, designed to sit between hex corners/intersections.
5. Build-spot/intersection markers: empty legal build spot, highlighted legal build spot, blocked build spot, subtle glowing ring style, transparent PNG.
6. Solar Farm building token for an intersection: compact clean-energy installation with solar panels, small battery, natural base, transparent PNG.
7. Solar Array upgraded building token: larger/brighter version of Solar Farm with more panels and stronger energy glow, transparent PNG.
8. Red damage overlay VFX frames: 6 transparent overlay frames, red translucent pulse that can sit over any hex tile after harvesting.
9. Downstream pollution flow VFX frames: 6 transparent frames showing red/brown pollution moving through river water from upstream to downstream.
10. Wetland absorption VFX frames: 6 transparent frames showing wetland absorbing/softening pollution, red fading into green/blue.
11. Oil spill VFX frames: 6 transparent frames showing black oil/smoke spreading from an oil tile.
12. Timber-to-energy conversion icon/VFX: small icon or 6-frame effect showing logs converting into energy/lightning, transparent PNG.

Constraints: keep all assets visually consistent with existing forest/mountain/settlement/resource icons; top-down isometric board-game readability; no labels; no characters; no buildings inside river/wetland tiles except environmental features; oil field should be rare and visually distinct from mountains; solar buildings must look like intersection tokens, not terrain tiles.
