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

const TILE_FILLS: Record<string, string> = {
  ground: '#1e293b',
  wall: '#0f172a',
  base_a: '#1e3a5f',
  base_b: '#5f1e1e',
};

const CLASS_LETTERS: Record<string, string> = {
  rogue: 'R',
  knight: 'K',
  mage: 'M',
};

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

  return (
    <svg
      viewBox={viewBox}
      className="w-full h-full"
      style={{ maxHeight: '100%' }}
    >
      <defs>
        {/* Crosshatch pattern for walls */}
        <pattern
          id="wall-hatch"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="6"
            stroke="#1e293b"
            strokeWidth="1"
            opacity="0.3"
          />
        </pattern>
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

        // Determine fill
        let fill = '#0a0a0a'; // default fog/empty
        let opacity = 1;
        let strokeColor = '#334155';
        let strokeWidth = 1;

        if (!teamVisible) {
          // Completely hidden — dark empty hex
          fill = '#0a0a0a';
          opacity = 0.15;
          strokeColor = '#1e293b';
        } else if (tile) {
          fill = TILE_FILLS[tile.type] || TILE_FILLS.ground;
          if (isFog) {
            fill = '#0a0a0a';
            opacity = 0.3;
          }
        } else {
          opacity = 0.3;
        }

        const isWall = tile?.type === 'wall' && !isFog && teamVisible;

        // Determine if we should dim this tile based on team selection
        const unit = tile?.unit;
        const showUnit = unit && teamVisible;
        const dimUnit =
          unit &&
          selectedTeam !== 'all' &&
          unit.team !== selectedTeam;

        return (
          <g
            key={key}
            onClick={() => handleClick(q, r)}
            style={{ cursor: onHexClick ? 'pointer' : 'default' }}
          >
            {/* Base hex fill */}
            <polygon
              points={vertices}
              fill={fill}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              opacity={opacity}
            />

            {/* Wall crosshatch overlay */}
            {isWall && (
              <polygon
                points={vertices}
                fill="url(#wall-hatch)"
                stroke="none"
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
              if (allUnits.length === 1) {
                const u = allUnits[0];
                const dim = selectedTeam !== 'all' && u.team !== selectedTeam;
                return (
                  <>
                    <text
                      x={cx}
                      y={u.carryingFlag ? cy + 5 : cy + 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={HEX_SIZE * 0.7}
                      fontWeight="bold"
                      fill={u.team === 'A' ? '#60a5fa' : '#f87171'}
                      opacity={dim ? 0.3 : 1}
                      style={{ pointerEvents: 'none' }}
                    >
                      {CLASS_LETTERS[u.unitClass]}
                    </text>
                    {u.carryingFlag && (
                      <text
                        x={cx} y={cy - HEX_SIZE * 0.3}
                        textAnchor="middle" dominantBaseline="central"
                        fontSize={HEX_SIZE * 0.45} style={{ pointerEvents: 'none' }}
                      >🦞</text>
                    )}
                  </>
                );
              }
              // Multiple units — offset them
              return allUnits.map((u: any, i: number) => {
                const offsetX = i === 0 ? -HEX_SIZE * 0.25 : HEX_SIZE * 0.25;
                const dim = selectedTeam !== 'all' && u.team !== selectedTeam;
                return (
                  <g key={u.id}>
                    <text
                      x={cx + offsetX}
                      y={u.carryingFlag ? cy + 5 : cy + 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={HEX_SIZE * 0.55}
                      fontWeight="bold"
                      fill={u.team === 'A' ? '#60a5fa' : '#f87171'}
                      opacity={dim ? 0.3 : 1}
                      style={{ pointerEvents: 'none' }}
                    >
                      {CLASS_LETTERS[u.unitClass]}
                    </text>
                    {u.carryingFlag && (
                      <text
                        x={cx + offsetX} y={cy - HEX_SIZE * 0.3}
                        textAnchor="middle" dominantBaseline="central"
                        fontSize={HEX_SIZE * 0.35} style={{ pointerEvents: 'none' }}
                      >🦞</text>
                    )}
                  </g>
                );
              });
            })()}
          </g>
        );
      })}
    </svg>
  );
}
