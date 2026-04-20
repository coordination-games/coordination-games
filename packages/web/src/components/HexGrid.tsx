import { useCallback, useMemo } from 'react';
import type { VisibleTile } from '../types';

/** A unit rendered at absolute pixel coordinates (for animations) */
export interface FloatingUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: 'rogue' | 'knight' | 'mage';
  carryingFlag: boolean;
  alive: boolean;
  x: number;
  y: number;
}

/** A kill effect at absolute pixel coordinates */
export interface KillEffectDisplay {
  victimId: string;
  /** Death location */
  x: number;
  y: number;
  /** Respawn location */
  respawnX: number;
  respawnY: number;
  killerX: number;
  killerY: number;
  /** 0..1 progress through the kill animation (poof/skull at death spot) */
  progress: number;
  /** 0..1 progress through float-to-respawn */
  floatProgress: number;
}

interface HexGridProps {
  tiles: VisibleTile[];
  fogTiles?: Set<string>;
  mapRadius: number;
  selectedTeam: 'A' | 'B' | 'all';
  visibleA?: Set<string>;
  visibleB?: Set<string>;
  onHexClick?: (q: number, r: number) => void;
  onUnitClick?: (unitId: string, team: 'A' | 'B') => void;
  /** Override visibility — when set, only these hexes are visible (for per-unit view) */
  visibleOverride?: Set<string>;
  /** Units rendered at animated pixel positions (for movement animations) */
  floatingUnits?: FloatingUnit[];
  /** Unit IDs to hide from normal tile rendering (currently floating or being killed) */
  hiddenUnitIds?: Set<string>;
  /** Active kill effects to render */
  killEffects?: KillEffectDisplay[];
  /** Opacity for vision boundary paths during animation (0..1) */
  visionOpacity?: number;
  /** Unit IDs dying this turn — render with death overlay */
  dyingUnitIds?: Set<string>;
}

const HEX_SIZE = 28;
const SQRT3 = Math.sqrt(3);

/** Axial to pixel (flat-top) */
function axialToPixel(q: number, r: number, size: number): [number, number] {
  const x = size * (3 / 2) * q;
  const y = size * ((SQRT3 / 2) * q + SQRT3 * r);
  return [x, y];
}

/** Flat-top hex vertices */
function hexVertices(cx: number, cy: number, size: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const px = cx + size * Math.cos(angle);
    const py = cy + size * Math.sin(angle);
    points.push(`${px},${py}`);
  }
  return points.join(' ');
}

function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

const CLASS_LETTERS: Record<string, string> = {
  rogue: 'R',
  knight: 'K',
  mage: 'M',
};

/** Simple seeded hash from q,r to pick a grass variant consistently */
function grassVariant(q: number, r: number): string {
  // Simple hash: mix q and r to get a stable pseudo-random value
  const hash = Math.abs(((q * 73856093) ^ (r * 19349663)) | 0) % 3;
  const variants = [
    '/tiles/terrain/green.png',
    '/tiles/terrain/green2.png',
    '/tiles/terrain/green3.png',
  ];
  // @ts-expect-error TS2322: Type 'string | undefined' is not assignable to type 'string'. — TODO(2.3-followup)
  return variants[hash];
}

/** Check if hex is "near" a base (within distance 2) for dirt tiles */
function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

export default function HexGrid({
  tiles,
  fogTiles,
  mapRadius,
  selectedTeam,
  visibleA,
  visibleB,
  onHexClick,
  onUnitClick,
  visibleOverride,
  floatingUnits,
  hiddenUnitIds,
  killEffects,
  visionOpacity = 1,
  // biome-ignore lint/correctness/noUnusedFunctionParameters: unused param; cleanup followup — TODO(2.3-followup)
  dyingUnitIds,
}: HexGridProps) {
  // Build a lookup of tile data by key
  const tileMap = useMemo(() => {
    const map = new Map<string, VisibleTile>();
    for (const t of tiles) {
      map.set(hexKey(t.q, t.r), t);
    }
    return map;
  }, [tiles]);

  // Find base hex positions for dirt proximity check
  const basePositions = useMemo(() => {
    const bases: { q: number; r: number }[] = [];
    for (const t of tiles) {
      if (t.type === 'base_a' || t.type === 'base_b') {
        bases.push({ q: t.q, r: t.r });
      }
    }
    return bases;
  }, [tiles]);

  // Build unit ID -> 1-based team index (e.g., first unit on team A = 1)
  const unitTeamIndex = useMemo(() => {
    const indexMap = new Map<string, number>();
    const teamCounters: Record<string, number> = { A: 0, B: 0 };
    for (const t of tiles) {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      const allUnits = (t as any).units ?? (t.unit ? [t.unit] : []);
      for (const u of allUnits) {
        if (u.id && !indexMap.has(u.id)) {
          const team = u.team ?? 'A';
          teamCounters[team] = (teamCounters[team] ?? 0) + 1;
          indexMap.set(u.id, teamCounters[team]);
        }
      }
    }
    return indexMap;
  }, [tiles]);

  // Use server-computed visibility sets (includes wall-blocking LoS)
  const seenA = visibleA ?? new Set<string>();
  const seenB = visibleB ?? new Set<string>();

  // Edge-to-neighbor mapping for flat-top hex
  const EDGE_NEIGHBORS: [number, number][] = useMemo(
    () => [
      [+1, 0],
      [0, +1],
      [-1, +1],
      [-1, 0],
      [0, -1],
      [+1, -1],
    ],
    [],
  );

  // Pre-compute all vision boundary edges as path data
  // Rendered as single <path> elements to avoid anti-aliasing artifacts
  const visionBoundaryPaths = useMemo(() => {
    let pathA = ''; // Team A only edges
    let pathB = ''; // Team B only edges
    let pathBoth = ''; // Shared edges (both teams)

    // Check every hex in both visibility sets
    const allSeen = new Set([...seenA, ...seenB]);

    for (const key of allSeen) {
      const [q, r] = key.split(',').map(Number);
      // @ts-expect-error TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'nu — TODO(2.3-followup)
      const [cx, cy] = axialToPixel(q, r, HEX_SIZE);
      const inA = seenA.has(key);
      const inB = seenB.has(key);

      for (let i = 0; i < 6; i++) {
        // @ts-expect-error TS2488: Type '[number, number] | undefined' must have a '[Symbol.iterator]()' method tha — TODO(2.3-followup)
        const [dq, dr] = EDGE_NEIGHBORS[i];
        const neighborKey = hexKey(q + dq, r + dr);

        const edgeA = inA && !seenA.has(neighborKey);
        const edgeB = inB && !seenB.has(neighborKey);

        if (!edgeA && !edgeB) continue;

        const angle1 = (Math.PI / 3) * i;
        const angle2 = (Math.PI / 3) * ((i + 1) % 6);
        const x1 = (cx + HEX_SIZE * Math.cos(angle1)).toFixed(1);
        const y1 = (cy + HEX_SIZE * Math.sin(angle1)).toFixed(1);
        const x2 = (cx + HEX_SIZE * Math.cos(angle2)).toFixed(1);
        const y2 = (cy + HEX_SIZE * Math.sin(angle2)).toFixed(1);

        const segment = `M${x1},${y1}L${x2},${y2}`;

        if (edgeA && edgeB) {
          pathBoth += segment;
        } else if (edgeA) {
          pathA += segment;
        } else {
          pathB += segment;
        }
      }
    }

    return { pathA, pathB, pathBoth };
  }, [seenA, seenB, EDGE_NEIGHBORS]);

  // Generate all hex positions in the map
  const allHexes = useMemo(() => {
    const hexes: { q: number; r: number }[] = [];
    for (let dq = -mapRadius; dq <= mapRadius; dq++) {
      for (
        let dr = Math.max(-mapRadius, -dq - mapRadius);
        dr <= Math.min(mapRadius, -dq + mapRadius);
        dr++
      ) {
        hexes.push({ q: dq, r: dr });
      }
    }
    return hexes;
  }, [mapRadius]);

  // Calculate SVG viewBox
  const viewBox = useMemo(() => {
    const padding = HEX_SIZE * 2;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const { q, r } of allHexes) {
      const [x, y] = axialToPixel(q, r, HEX_SIZE);
      minX = Math.min(minX, x - HEX_SIZE);
      maxX = Math.max(maxX, x + HEX_SIZE);
      minY = Math.min(minY, y - HEX_SIZE);
      maxY = Math.max(maxY, y + HEX_SIZE);
    }
    return `${minX - padding} ${minY - padding} ${maxX - minX + padding * 2} ${maxY - minY + padding * 2}`;
  }, [allHexes]);

  const handleClick = useCallback(
    (q: number, r: number) => {
      onHexClick?.(q, r);
    },
    [onHexClick],
  );

  // Determine the terrain image for each tile type
  function getTerrainImage(tile: VisibleTile | undefined, q: number, r: number): string {
    if (!tile) return grassVariant(q, r);

    switch (tile.type) {
      case 'wall':
        // Grass base underneath — forest overlay is rendered separately
        return grassVariant(q, r);
      case 'base_a':
      case 'base_b':
        // Flag hex uses keep, surrounding base/spawn uses castle
        if (tile.flag) {
          return '/tiles/terrain/keep.png';
        }
        return '/tiles/terrain/castle.png';
      default: {
        // Use dirt for ground tiles near bases
        const nearBase = basePositions.some((b) => hexDistance(q, r, b.q, b.r) <= 2);
        if (nearBase) return '/tiles/terrain/dirt.png';
        return grassVariant(q, r);
      }
    }
  }

  // The hex tile images are 72x72. We need to scale them to fit our hex size.
  // Flat-top hex: width = 2 * HEX_SIZE, height = sqrt(3) * HEX_SIZE
  const hexWidth = HEX_SIZE * 2;
  const hexHeight = SQRT3 * HEX_SIZE;
  // Forest tiles are 144x144 (double size), we'll scale them a bit larger for canopy effect
  const forestScale = 1.3;
  const forestWidth = hexWidth * forestScale;
  const forestHeight = hexHeight * forestScale;

  // Unit sprite size — slightly smaller than hex
  const unitSpriteSize = HEX_SIZE * 1.5;

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: pre-existing decorative svg; cleanup followup — TODO(2.3-followup)
    <svg viewBox={viewBox} style={{ width: '100%', height: '100%' }}>
      <defs>
        {/* Clip path for hex shape — used to clip terrain images */}
        <clipPath id="hex-clip">
          <polygon points={hexVertices(0, 0, HEX_SIZE)} />
        </clipPath>
        {/* Larger clip for forest canopy */}
        <clipPath id="hex-clip-forest">
          <polygon points={hexVertices(0, 0, HEX_SIZE * forestScale)} />
        </clipPath>
      </defs>

      {allHexes.map(({ q, r }) => {
        const key = hexKey(q, r);
        const tile = tileMap.get(key);
        const [cx, cy] = axialToPixel(q, r, HEX_SIZE);
        const isFog = fogTiles?.has(key) ?? false;
        const vertices = hexVertices(cx, cy, HEX_SIZE);

        // Determine visibility — per-unit override takes priority
        const teamVisible = visibleOverride
          ? visibleOverride.has(key)
          : selectedTeam === 'all'
            ? true
            : selectedTeam === 'A'
              ? (visibleA?.has(key) ?? true)
              : (visibleB?.has(key) ?? true);

        // Determine visibility state
        const isHidden = !teamVisible;
        const isFogged = isFog && teamVisible;
        const isVisible = teamVisible && !isFog;
        const isWall = tile?.type === 'wall';

        const unit = tile?.unit;
        const showUnit = unit && isVisible;

        const terrainSrc = getTerrainImage(tile, q, r);
        const isForest = isWall;

        // Base terrain always uses hex size (grass base for walls too)
        const imgW = hexWidth;
        const imgH = hexHeight;

        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: pre-existing div onClick; cleanup followup — TODO(2.3-followup)
          <g
            key={key}
            onClick={() => handleClick(q, r)}
            style={{ cursor: onHexClick ? 'pointer' : 'default' }}
          >
            {/* Black background for hex (visible through transparency) */}
            <polygon points={vertices} fill="#0a0a0a" stroke="none" />

            {/* Terrain tile image — clipped to hex shape */}
            {(isVisible || isFogged || isForest) && (
              <g
                opacity={isHidden ? 0.15 : isFogged ? 0.3 : 1}
                clipPath="url(#hex-clip)"
                transform={`translate(${cx},${cy})`}
              >
                <image
                  href={terrainSrc}
                  x={-imgW / 2}
                  y={-imgH / 2}
                  width={imgW}
                  height={imgH}
                  preserveAspectRatio="xMidYMid slice"
                />
              </g>
            )}

            {/* Forest overlay — always render for wall tiles (with opacity for fog) */}
            {isForest && (
              <g
                opacity={isHidden ? 0.15 : isFogged ? 0.3 : 1}
                clipPath="url(#hex-clip)"
                transform={`translate(${cx},${cy})`}
              >
                <image
                  href="/tiles/terrain/forest-deciduous.png"
                  x={-forestWidth / 2}
                  y={-forestHeight / 2}
                  width={forestWidth}
                  height={forestHeight}
                  preserveAspectRatio="xMidYMid slice"
                />
              </g>
            )}

            {/* Hex border */}
            <polygon
              points={vertices}
              fill="none"
              stroke={isHidden ? '#1e293b' : '#334155'}
              strokeWidth={1}
              opacity={isHidden ? 0.15 : 1}
            />

            {/* Fog/hidden overlay */}
            {isHidden && (
              <polygon
                points={vertices}
                fill="#0a0a0a"
                opacity={0.85}
                stroke="#1e293b"
                strokeWidth={1}
              />
            )}
            {isFogged && <polygon points={vertices} fill="#0a0a0a" opacity={0.6} />}

            {/* Vision brightening — white overlay on hexes within any unit's vision */}
            {isVisible && (seenA.has(key) || seenB.has(key)) && (
              <polygon
                points={vertices}
                fill="white"
                opacity={0.08}
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* Vision boundary edges rendered as batch paths below */}

            {/* Base team color tint overlay */}
            {(tile?.type === 'base_a' || tile?.type === 'base_b') && isVisible && (
              <polygon
                points={vertices}
                fill={tile.type === 'base_a' ? '#3b82f6' : '#ef4444'}
                opacity={0.15}
              />
            )}

            {/* Flag on ground (not carried by unit) */}
            {tile?.flag && !tile.unit?.carryingFlag && !isFog && teamVisible && (
              <text
                x={cx}
                y={cy + 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={HEX_SIZE * 0.8}
                style={{ pointerEvents: 'none' }}
              >
                🦞
              </text>
            )}

            {/* Unit rendering — support multiple units on one hex */}
            {showUnit &&
              !isFog &&
              (() => {
                // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
                const allUnits = ((tile as any)?.units ?? (unit ? [unit] : [])).filter(
                  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
                  (u: any) => !hiddenUnitIds?.has(u.id),
                );
                if (allUnits.length === 0) return null;

                const renderUnit = (
                  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
                  u: any,
                  offsetX: number,
                  spriteSize: number,
                  fontSize: number,
                ) => {
                  const dim = selectedTeam !== 'all' && u.team !== selectedTeam;
                  const isDead = u.alive === false;
                  const unitSprite = `/tiles/units/${u.unitClass}.png`;
                  const isTeamB = u.team === 'B';
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: pre-existing div onClick; cleanup followup — TODO(2.3-followup)
                    <g
                      key={u.id}
                      opacity={dim ? 0.3 : isDead ? 0.4 : 1}
                      style={{ cursor: onUnitClick ? 'pointer' : 'default' }}
                      onClick={(e) => {
                        if (onUnitClick) {
                          e.stopPropagation();
                          onUnitClick(u.id, u.team);
                        }
                      }}
                    >
                      {/* Team color circle behind unit */}
                      <circle
                        cx={cx + offsetX}
                        cy={cy}
                        r={spriteSize * 0.38}
                        fill={isDead ? '#666' : u.team === 'A' ? '#3b82f6' : '#ef4444'}
                        opacity={0.35}
                      />
                      {/* Unit sprite */}
                      <image
                        href={unitSprite}
                        x={cx + offsetX - spriteSize / 2}
                        y={cy - spriteSize / 2}
                        width={spriteSize}
                        height={spriteSize}
                        style={{
                          pointerEvents: 'none',
                          filter: isDead
                            ? 'grayscale(1) opacity(0.6)'
                            : isTeamB
                              ? 'hue-rotate(160deg) saturate(1.3)'
                              : 'none',
                        }}
                      />
                      {/* Skull overlay for dead units */}
                      {isDead && (
                        <text
                          x={cx + offsetX}
                          y={cy - spriteSize * 0.05}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={spriteSize * 0.55}
                          style={{ pointerEvents: 'none' }}
                        >
                          ☠️
                        </text>
                      )}
                      {/* Unit label */}
                      <text
                        x={cx + offsetX}
                        y={u.carryingFlag ? cy + spriteSize * 0.42 : cy + spriteSize * 0.35}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={fontSize}
                        fontWeight="bold"
                        fill={isDead ? '#888' : u.team === 'A' ? '#93c5fd' : '#fca5a5'}
                        stroke="#000"
                        strokeWidth={2.5}
                        paintOrder="stroke"
                        style={{ pointerEvents: 'none' }}
                      >
                        {CLASS_LETTERS[u.unitClass]}
                        {unitTeamIndex.get(u.id) ?? ''}
                      </text>
                      {/* Carrying flag indicator */}
                      {u.carryingFlag && (
                        <text
                          x={cx + offsetX}
                          y={cy - spriteSize * 0.35}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={HEX_SIZE * 0.4}
                          style={{ pointerEvents: 'none' }}
                        >
                          🦞
                        </text>
                      )}
                    </g>
                  );
                };

                if (allUnits.length === 1) {
                  return renderUnit(allUnits[0], 0, unitSpriteSize, HEX_SIZE * 0.45);
                }

                // Multiple units — offset them
                // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
                return allUnits.map((u: any, i: number) => {
                  const offsetX = i === 0 ? -HEX_SIZE * 0.28 : HEX_SIZE * 0.28;
                  return renderUnit(u, offsetX, unitSpriteSize * 0.75, HEX_SIZE * 0.38);
                });
              })()}
          </g>
        );
      })}
      {/* Vision boundary paths — rendered on top of everything as single paths */}
      <g
        opacity={visionOpacity}
        style={{ pointerEvents: 'none', transition: 'opacity 0.05s linear' }}
      >
        {(selectedTeam === 'all' || selectedTeam === 'A') && visionBoundaryPaths.pathA && (
          <path
            d={visionBoundaryPaths.pathA}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {(selectedTeam === 'all' || selectedTeam === 'B') && visionBoundaryPaths.pathB && (
          <path
            d={visionBoundaryPaths.pathB}
            fill="none"
            stroke="#ef4444"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {selectedTeam === 'all' && visionBoundaryPaths.pathBoth && (
          <>
            <path
              d={visionBoundaryPaths.pathBoth}
              fill="none"
              stroke="#3b82f6"
              strokeWidth={2.5}
              strokeDasharray="6 6"
              strokeDashoffset={0}
              strokeLinecap="round"
            />
            <path
              d={visionBoundaryPaths.pathBoth}
              fill="none"
              stroke="#ef4444"
              strokeWidth={2.5}
              strokeDasharray="6 6"
              strokeDashoffset={6}
              strokeLinecap="round"
            />
          </>
        )}
        {selectedTeam === 'A' && visionBoundaryPaths.pathBoth && (
          <path
            d={visionBoundaryPaths.pathBoth}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        )}
        {selectedTeam === 'B' && visionBoundaryPaths.pathBoth && (
          <path
            d={visionBoundaryPaths.pathBoth}
            fill="none"
            stroke="#ef4444"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        )}
      </g>

      {/* Floating units layer — animated units at sub-tile pixel positions */}
      {floatingUnits?.map((u) => {
        const dim = selectedTeam !== 'all' && u.team !== selectedTeam;
        const unitSprite = `/tiles/units/${u.unitClass}.png`;
        const isTeamB = u.team === 'B';

        return (
          <g key={`float-${u.id}`} style={{ pointerEvents: 'none' }}>
            <circle
              cx={u.x}
              cy={u.y}
              r={unitSpriteSize * 0.38}
              fill={u.team === 'A' ? '#3b82f6' : '#ef4444'}
              opacity={dim ? 0.15 : 0.35}
            />
            <image
              href={unitSprite}
              x={u.x - unitSpriteSize / 2}
              y={u.y - unitSpriteSize / 2}
              width={unitSpriteSize}
              height={unitSpriteSize}
              style={{
                filter: isTeamB ? 'hue-rotate(160deg) saturate(1.3)' : 'none',
              }}
            />
            <text
              x={u.x}
              y={u.carryingFlag ? u.y + unitSpriteSize * 0.42 : u.y + unitSpriteSize * 0.35}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={HEX_SIZE * 0.45}
              fontWeight="bold"
              fill={u.team === 'A' ? '#93c5fd' : '#fca5a5'}
              stroke="#000"
              strokeWidth={2.5}
              paintOrder="stroke"
            >
              {CLASS_LETTERS[u.unitClass]}
              {unitTeamIndex.get(u.id) ?? ''}
            </text>
            {u.carryingFlag && (
              <text
                x={u.x}
                y={u.y - unitSpriteSize * 0.35}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={HEX_SIZE * 0.4}
              >
                🦞
              </text>
            )}
          </g>
        );
      })}

      {/* Kill effects layer */}
      {killEffects?.map((k) => {
        if (k.progress >= 1 && k.floatProgress >= 1) return null; // fully done

        // Phase 1: Poof + skull at death spot
        const showPoof = k.progress < 1;
        const poofRadius = 8 + k.progress * 30;
        const poofOpacity = Math.max(0, 1 - k.progress * 1.5);
        const skullY = k.y - k.progress * 25;
        const skullOpacity =
          k.progress < 0.3 ? k.progress / 0.3 : k.progress > 0.7 ? (1 - k.progress) / 0.3 : 1;
        const sparkCount = 6;

        // Phase 2: Ghost float from death spot to respawn spot
        const showFloat = k.progress >= 0.8 && k.floatProgress < 1;
        const floatX = k.x + (k.respawnX - k.x) * k.floatProgress;
        const floatY = k.y + (k.respawnY - k.y) * k.floatProgress;
        const floatOpacity =
          k.floatProgress < 0.1
            ? k.floatProgress / 0.1
            : k.floatProgress > 0.8
              ? (1 - k.floatProgress) / 0.2
              : 0.5;

        return (
          <g key={`kill-${k.victimId}`} style={{ pointerEvents: 'none' }}>
            {/* Phase 1: Poof at death spot */}
            {showPoof && (
              <>
                {/* Expanding poof circle */}
                <circle
                  cx={k.x}
                  cy={k.y}
                  r={poofRadius}
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  opacity={poofOpacity}
                />
                <circle
                  cx={k.x}
                  cy={k.y}
                  r={poofRadius * 0.6}
                  fill="#fbbf24"
                  opacity={poofOpacity * 0.3}
                />

                {/* Spark particles */}
                {Array.from({ length: sparkCount }, (_, i) => {
                  const angle = (Math.PI * 2 * i) / sparkCount + k.progress * 0.5;
                  const dist = k.progress * 20 + 5;
                  const sx = k.x + Math.cos(angle) * dist;
                  const sy = k.y + Math.sin(angle) * dist;
                  const sparkOpacity = Math.max(0, 1 - k.progress * 2);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: list is stable; refactor in cleanup followup — TODO(2.3-followup)
                    <circle key={i} cx={sx} cy={sy} r={1.5} fill="#fcd34d" opacity={sparkOpacity} />
                  );
                })}

                {/* Skull float-up at death spot */}
                <text
                  x={k.x}
                  y={skullY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={HEX_SIZE * 0.6}
                  opacity={skullOpacity}
                >
                  ☠️
                </text>
              </>
            )}

            {/* Phase 2: Ghost skull floats from death to respawn */}
            {showFloat && (
              <text
                x={floatX}
                y={floatY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={HEX_SIZE * 0.5}
                opacity={floatOpacity}
              >
                ☠️
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
