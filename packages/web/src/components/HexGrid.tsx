import { useMemo, useCallback } from 'react';
import type { VisibleTile } from '../types';

interface HexGridProps {
  tiles: VisibleTile[];
  fogTiles?: Set<string>;
  mapRadius: number;
  selectedTeam: 'A' | 'B' | 'all';
  visibleA?: Set<string>;
  visibleB?: Set<string>;
  onHexClick?: (q: number, r: number) => void;
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

const CLASS_VISION: Record<string, number> = {
  rogue: 4,
  knight: 2,
  mage: 3,
};


/** Simple seeded hash from q,r to pick a grass variant consistently */
function grassVariant(q: number, r: number): string {
  // Simple hash: mix q and r to get a stable pseudo-random value
  const hash = Math.abs(((q * 73856093) ^ (r * 19349663)) | 0) % 3;
  const variants = ['/tiles/terrain/green.png', '/tiles/terrain/green2.png', '/tiles/terrain/green3.png'];
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

  // Flat-top hex neighbor offsets: N, NE, SE, S, SW, NW
  const HEX_NEIGHBORS: [number, number][] = [
    [0, -1], [+1, -1], [+1, 0], [0, +1], [-1, +1], [-1, 0],
  ];

  // Build vision data: which hexes each team can see + boundary detection
  const visionData = useMemo(() => {
    // Collect all visible units
    const units: { q: number; r: number; team: string; unitClass: string }[] = [];
    for (const t of tiles) {
      const allUnits = (t as any).units ?? (t.unit ? [t.unit] : []);
      for (const u of allUnits) {
        if (u.id) {
          units.push({ q: t.q, r: t.r, team: u.team ?? 'A', unitClass: u.unitClass ?? 'rogue' });
        }
      }
    }

    // Sets of hex keys visible to each team
    const seenA = new Set<string>();
    const seenB = new Set<string>();

    for (const u of units) {
      const vision = CLASS_VISION[u.unitClass] ?? 3;
      const seen = u.team === 'A' ? seenA : seenB;

      for (let dq = -vision; dq <= vision; dq++) {
        for (
          let dr = Math.max(-vision, -dq - vision);
          dr <= Math.min(vision, -dq + vision);
          dr++
        ) {
          const tq = u.q + dq;
          const tr = u.r + dr;
          const dist = hexDistance(u.q, u.r, tq, tr);
          if (dist > vision) continue;
          seen.add(hexKey(tq, tr));
        }
      }
    }

    // For each hex, determine if it's on the boundary of a team's vision
    // (inside vision but has at least one neighbor NOT in that team's vision)
    const boundaryA = new Set<string>();
    const boundaryB = new Set<string>();

    for (const key of seenA) {
      const [q, r] = key.split(',').map(Number);
      for (const [dq, dr] of HEX_NEIGHBORS) {
        if (!seenA.has(hexKey(q + dq, r + dr))) {
          boundaryA.add(key);
          break;
        }
      }
    }
    for (const key of seenB) {
      const [q, r] = key.split(',').map(Number);
      for (const [dq, dr] of HEX_NEIGHBORS) {
        if (!seenB.has(hexKey(q + dq, r + dr))) {
          boundaryB.add(key);
          break;
        }
      }
    }

    return { seenA, seenB, boundaryA, boundaryB };
  }, [tiles]);

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
      case 'ground':
      default: {
        // Use dirt for ground tiles near bases
        const nearBase = basePositions.some(
          (b) => hexDistance(q, r, b.q, b.r) <= 2
        );
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
    <svg
      viewBox={viewBox}
      className="w-full h-full"
      style={{ maxHeight: '100%' }}
    >
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

        // Determine team visibility
        const teamVisible = selectedTeam === 'all' ? true
          : selectedTeam === 'A' ? visibleA?.has(key) ?? true
          : visibleB?.has(key) ?? true;

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
          <g
            key={key}
            onClick={() => handleClick(q, r)}
            style={{ cursor: onHexClick ? 'pointer' : 'default' }}
          >
            {/* Black background for hex (visible through transparency) */}
            <polygon
              points={vertices}
              fill="#0a0a0a"
              stroke="none"
            />

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
            {isFogged && (
              <polygon
                points={vertices}
                fill="#0a0a0a"
                opacity={0.6}
              />
            )}

            {/* Vision brightening — white overlay on hexes within any unit's vision */}
            {isVisible && (visionData.seenA.has(key) || visionData.seenB.has(key)) && (
              <polygon
                points={vertices}
                fill="white"
                opacity={0.08}
                style={{ pointerEvents: 'none' }}
              />
            )}

            {/* Vision boundary — outer edges only, per-edge basis */}
            {isVisible && (() => {
              const inA = visionData.seenA.has(key);
              const inB = visionData.seenB.has(key);
              if (!inA && !inB) return null;

              // Edge-to-neighbor mapping for flat-top hex:
              // Edge i connects vertex i to vertex (i+1)%6
              // Edge 0 (SE side) → neighbor (+1, 0)
              // Edge 1 (S side)  → neighbor (0, +1)
              // Edge 2 (SW side) → neighbor (-1, +1)
              // Edge 3 (NW side) → neighbor (-1, 0)
              // Edge 4 (N side)  → neighbor (0, -1)
              // Edge 5 (NE side) → neighbor (+1, -1)
              const EDGE_NEIGHBORS: [number, number][] = [
                [+1, 0], [0, +1], [-1, +1], [-1, 0], [0, -1], [+1, -1],
              ];

              const edges: React.ReactNode[] = [];
              for (let i = 0; i < 6; i++) {
                const [dq, dr] = EDGE_NEIGHBORS[i];
                const neighborKey = hexKey(q + dq, r + dr);

                const angle1 = (Math.PI / 3) * i;
                const angle2 = (Math.PI / 3) * ((i + 1) % 6);
                const x1 = cx + HEX_SIZE * Math.cos(angle1);
                const y1 = cy + HEX_SIZE * Math.sin(angle1);
                const x2 = cx + HEX_SIZE * Math.cos(angle2);
                const y2 = cy + HEX_SIZE * Math.sin(angle2);

                // Is this edge on Team A's outer boundary?
                const edgeA = inA && !visionData.seenA.has(neighborKey);
                // Is this edge on Team B's outer boundary?
                const edgeB = inB && !visionData.seenB.has(neighborKey);

                if (edgeA && edgeB) {
                  // Both boundaries share this exact edge — dashed alternating
                  edges.push(
                    <line key={`ea-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke="#3b82f6" strokeWidth={2.5}
                      strokeDasharray="4 4" strokeDashoffset={0}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'none' }} />,
                    <line key={`eb-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke="#ef4444" strokeWidth={2.5}
                      strokeDasharray="4 4" strokeDashoffset={4}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'none' }} />,
                  );
                } else if (edgeA) {
                  edges.push(
                    <line key={`ea-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke="#3b82f6" strokeWidth={2.5}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'none' }} />
                  );
                } else if (edgeB) {
                  edges.push(
                    <line key={`eb-${i}`} x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke="#ef4444" strokeWidth={2.5}
                      strokeLinecap="round"
                      style={{ pointerEvents: 'none' }} />
                  );
                }
              }

              return edges.length > 0 ? edges : null;
            })()}

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
            {showUnit && !isFog && (() => {
              const allUnits = (tile as any)?.units ?? (unit ? [unit] : []);
              if (allUnits.length === 0) return null;

              const renderUnit = (u: any, offsetX: number, spriteSize: number, fontSize: number) => {
                const dim = selectedTeam !== 'all' && u.team !== selectedTeam;
                const unitSprite = `/tiles/units/${u.unitClass}.png`;
                const isTeamB = u.team === 'B';
                return (
                  <g key={u.id} opacity={dim ? 0.3 : 1}>
                    {/* Team color circle behind unit */}
                    <circle
                      cx={cx + offsetX}
                      cy={cy}
                      r={spriteSize * 0.38}
                      fill={u.team === 'A' ? '#3b82f6' : '#ef4444'}
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
                        filter: isTeamB ? 'hue-rotate(160deg) saturate(1.3)' : 'none',
                      }}
                    />
                    {/* Unit label */}
                    <text
                      x={cx + offsetX}
                      y={u.carryingFlag ? cy + spriteSize * 0.42 : cy + spriteSize * 0.35}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={fontSize}
                      fontWeight="bold"
                      fill={u.team === 'A' ? '#93c5fd' : '#fca5a5'}
                      stroke="#000"
                      strokeWidth={2.5}
                      paintOrder="stroke"
                      style={{ pointerEvents: 'none' }}
                    >
                      {CLASS_LETTERS[u.unitClass]}{unitTeamIndex.get(u.id) ?? ''}
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
                      >🦞</text>
                    )}
                  </g>
                );
              };

              if (allUnits.length === 1) {
                return renderUnit(allUnits[0], 0, unitSpriteSize, HEX_SIZE * 0.45);
              }

              // Multiple units — offset them
              return allUnits.map((u: any, i: number) => {
                const offsetX = i === 0 ? -HEX_SIZE * 0.28 : HEX_SIZE * 0.28;
                return renderUnit(u, offsetX, unitSpriteSize * 0.75, HEX_SIZE * 0.38);
              });
            })()}
          </g>
        );
      })}
    </svg>
  );
}
