// State-derived board VFX helpers. Everything here is computed from real typed
// tile state (terrain + ecosystem status + health + axial position) so the
// board never shows an effect the engine state does not justify.

import { hexToPixel } from './hex-math';

// The engine classifies every ecosystem as one of four statuses; damage tiers
// map straight onto that classification so the board never invents a severity
// the engine did not report. Health is only a fallback when status is absent.
export type DamageTier = 'healthy' | 'damaged' | 'collapsed';

interface TileLike {
  q: number;
  r: number;
  terrain?: string;
  ecosystemStatus?: string;
  ecosystemHealth?: number;
}

const WATER_TERRAINS = new Set(['river', 'rivers', 'wetland', 'wetlands']);
const AXIAL_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];

export function damageTier(tile: TileLike): DamageTier {
  const status = tile.ecosystemStatus;
  if (status === 'collapsed') return 'collapsed';
  if (status === 'strained') return 'damaged';
  if (status === 'flourishing' || status === 'stable') return 'healthy';
  const health = tile.ecosystemHealth;
  if (typeof health === 'number' && Number.isFinite(health)) {
    if (health <= 0.25) return 'collapsed';
    if (health <= 0.55) return 'damaged';
  }
  return 'healthy';
}

export function damageTierLabel(tier: DamageTier): string {
  if (tier === 'collapsed') return 'Collapsed';
  if (tier === 'damaged') return 'Damaged';
  return 'Healthy';
}

function isWater(tile: TileLike): boolean {
  return WATER_TERRAINS.has(tile.terrain ?? '');
}

function tileHealth(tile: TileLike): number {
  const health = tile.ecosystemHealth;
  return typeof health === 'number' && Number.isFinite(health) ? health : 1;
}

export interface PollutionFlow {
  fromQ: number;
  fromR: number;
  toQ: number;
  toR: number;
  intensity: number;
}

// Downstream pollution flows from a stricken WATER tile toward its lowest-health
// adjacent WATER neighbour. "Downstream" = the direction water actually carries
// the contamination, derived from real neighbour health, never hardcoded.
export function derivePollutionFlows(tiles: TileLike[]): PollutionFlow[] {
  const byKey = new Map(tiles.map((tile) => [`${tile.q},${tile.r}`, tile] as const));
  const flows: PollutionFlow[] = [];
  for (const tile of tiles) {
    if (!isWater(tile)) continue;
    const tier = damageTier(tile);
    if (tier !== 'damaged' && tier !== 'collapsed') continue;
    let sink: TileLike | null = null;
    for (const [dq, dr] of AXIAL_NEIGHBORS) {
      const neighbor = byKey.get(`${tile.q + dq},${tile.r + dr}`);
      if (!neighbor || !isWater(neighbor)) continue;
      if (!sink || tileHealth(neighbor) < tileHealth(sink)) sink = neighbor;
    }
    if (!sink) continue;
    flows.push({
      fromQ: tile.q,
      fromR: tile.r,
      toQ: sink.q,
      toR: sink.r,
      intensity: tier === 'collapsed' ? 1 : 0.66,
    });
  }
  return flows;
}

// A readable diagonal hatch keyed to the damage tier. Shape/density carries the
// severity so a colourblind viewer still reads it; alpha only reinforces.
export function drawDamageHatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  tier: DamageTier,
): void {
  if (tier === 'healthy') return;
  const spacing = tier === 'collapsed' ? radius * 0.2 : radius * 0.3;
  const width = Math.max(1.5, radius * 0.045);
  ctx.save();
  // Engraved hatch: a dark halo stroke under a bright ink stroke, so the
  // pattern reads on any terrain art without relying on colour/desaturation.
  const hatch = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.strokeStyle = 'rgba(8, 5, 4, 0.8)';
    ctx.lineWidth = width * 1.9;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.strokeStyle =
      tier === 'collapsed' ? 'rgba(248, 236, 224, 0.9)' : 'rgba(250, 214, 150, 0.85)';
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  for (let offset = -radius * 1.4; offset < radius * 1.4; offset += spacing) {
    hatch(x - radius + offset, y - radius, x + radius + offset, y + radius);
  }
  if (tier === 'collapsed') {
    // Cross-hatch for the terminal state: unmistakable even at a glance.
    for (let offset = -radius * 1.4; offset < radius * 1.4; offset += spacing) {
      hatch(x - radius + offset, y + radius, x + radius + offset, y - radius);
    }
  }
  ctx.restore();
}

// Directional flow glyph: an arrow from the stricken tile to its downstream
// sink, drawn as an engraved dark/light stroke so it reads on any terrain.
export function drawPollutionFlow(
  ctx: CanvasRenderingContext2D,
  flow: PollutionFlow,
  centerX: number,
  centerY: number,
  size: number,
  phase: number,
): void {
  const from = hexToPixel(flow.fromQ, flow.fromR, centerX, centerY, size);
  const to = hexToPixel(flow.toQ, flow.toR, centerX, centerY, size);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const headX = from.x + Math.cos(angle) * length * 0.62;
  const headY = from.y + Math.sin(angle) * length * 0.62;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const drawShaft = (stroke: string, width: number) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.setLineDash([size * 0.16, size * 0.12]);
    ctx.lineDashOffset = -phase;
    ctx.beginPath();
    ctx.moveTo(from.x + Math.cos(angle) * size * 0.32, from.y + Math.sin(angle) * size * 0.32);
    ctx.lineTo(headX, headY);
    ctx.stroke();
    ctx.setLineDash([]);
    const wing = size * 0.16;
    ctx.beginPath();
    ctx.moveTo(headX, headY);
    ctx.lineTo(headX - Math.cos(angle - 0.5) * wing, headY - Math.sin(angle - 0.5) * wing);
    ctx.moveTo(headX, headY);
    ctx.lineTo(headX - Math.cos(angle + 0.5) * wing, headY - Math.sin(angle + 0.5) * wing);
    ctx.stroke();
  };
  ctx.globalAlpha = 0.5 * flow.intensity + 0.3;
  drawShaft('rgba(6, 12, 18, 0.9)', Math.max(3, size * 0.075));
  drawShaft('rgba(150, 210, 150, 0.95)', Math.max(1.6, size * 0.04));
  ctx.restore();
}
