import { TERRAIN } from './colors';

// Seeded random number generator for consistent terrain patterns
export class SeededRandom {
  private seed: number;

  constructor(seed: number | string) {
    this.seed = typeof seed === 'string' ? this.hashString(seed) : seed;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  next(): number {
    // Simple LCG
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

// Ecosystem colors for overlay washes
export const ECOSYSTEM_COLORS = [
  'rgba(217, 180, 105, 0.15)', // Gold
  'rgba(114, 169, 181, 0.15)', // Sea
  'rgba(186, 115, 87, 0.15)', // Clay
  'rgba(127, 158, 115, 0.15)', // Moss
  'rgba(212, 124, 97, 0.15)', // Rose
  'rgba(139, 131, 174, 0.15)', // Violet
  'rgba(99, 165, 167, 0.15)', // Teal
  'rgba(198, 138, 88, 0.15)', // Copper
];

export function getEcosystemColor(index: number): string {
  return (
    ECOSYSTEM_COLORS[index % ECOSYSTEM_COLORS.length] ??
    ECOSYSTEM_COLORS[0] ??
    'rgba(217, 180, 105, 0.15)'
  );
}

// Resource icon definitions - procedural canvas drawing functions
export const RESOURCE_ICONS: Record<
  string,
  (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void
> = {
  grain: (ctx, x, y, size) => {
    // Wheat stalk icon
    ctx.save();
    ctx.strokeStyle = '#f2e4c7';
    ctx.lineWidth = size * 0.08;
    ctx.lineCap = 'round';

    // Main stem
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.3);
    ctx.quadraticCurveTo(x + size * 0.1, y, x, y - size * 0.2);
    ctx.stroke();

    // Grain heads
    for (let i = 0; i < 5; i++) {
      const angle = (i - 2) * 0.3;
      const hx = x + Math.sin(angle) * size * 0.15;
      const hy = y - size * 0.2 + Math.cos(angle) * size * 0.08;
      ctx.beginPath();
      ctx.arc(hx, hy, size * 0.06, 0, Math.PI * 2);
      ctx.fillStyle = '#f2e4c7';
      ctx.fill();
    }
    ctx.restore();
  },

  timber: (ctx, x, y, size) => {
    // Tree icon
    ctx.save();
    ctx.fillStyle = '#7f9e73';

    // Tree top (triangle)
    ctx.beginPath();
    ctx.moveTo(x, y - size * 0.35);
    ctx.lineTo(x - size * 0.25, y + size * 0.1);
    ctx.lineTo(x + size * 0.25, y + size * 0.1);
    ctx.closePath();
    ctx.fill();

    // Trunk
    ctx.fillStyle = '#5c4b22';
    ctx.fillRect(x - size * 0.08, y + size * 0.1, size * 0.16, size * 0.25);
    ctx.restore();
  },

  ore: (ctx, x, y, size) => {
    // Mountain/pickaxe icon
    ctx.save();
    ctx.strokeStyle = '#8b83ae';
    ctx.lineWidth = size * 0.1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Mountain peaks
    ctx.beginPath();
    ctx.moveTo(x - size * 0.3, y + size * 0.25);
    ctx.lineTo(x - size * 0.1, y - size * 0.15);
    ctx.lineTo(x + size * 0.1, y + size * 0.05);
    ctx.lineTo(x + size * 0.3, y - size * 0.25);
    ctx.stroke();
    ctx.restore();
  },

  fish: (ctx, x, y, size) => {
    // Fish icon
    ctx.save();
    ctx.fillStyle = '#72a9b5';

    // Fish body
    ctx.beginPath();
    ctx.ellipse(x, y, size * 0.25, size * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Tail
    ctx.beginPath();
    ctx.moveTo(x + size * 0.2, y);
    ctx.lineTo(x + size * 0.4, y - size * 0.15);
    ctx.lineTo(x + size * 0.4, y + size * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  energy: (ctx, x, y, size) => {
    // Lightning bolt icon
    ctx.save();
    ctx.fillStyle = '#d9b25f';

    ctx.beginPath();
    ctx.moveTo(x + size * 0.05, y - size * 0.35);
    ctx.lineTo(x - size * 0.15, y - size * 0.05);
    ctx.lineTo(x + size * 0.05, y - size * 0.05);
    ctx.lineTo(x - size * 0.05, y + size * 0.35);
    ctx.lineTo(x + size * 0.2, y + size * 0.05);
    ctx.lineTo(x, y + size * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  water: (ctx, x, y, size) => {
    // Water droplet icon
    ctx.save();
    ctx.fillStyle = '#72a9b5';

    ctx.beginPath();
    ctx.moveTo(x, y - size * 0.3);
    ctx.bezierCurveTo(
      x - size * 0.25,
      y - size * 0.1,
      x - size * 0.25,
      y + size * 0.2,
      x,
      y + size * 0.3,
    );
    ctx.bezierCurveTo(
      x + size * 0.25,
      y + size * 0.2,
      x + size * 0.25,
      y - size * 0.1,
      x,
      y - size * 0.3,
    );
    ctx.fill();
    ctx.restore();
  },
};

// Structure sprite drawing functions
export function drawFarmSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();

  // Farm house
  ctx.fillStyle = '#c4b59a';
  ctx.fillRect(x - size * 0.15, y - size * 0.1, size * 0.3, size * 0.2);

  // Roof
  ctx.fillStyle = '#8f8474';
  ctx.beginPath();
  ctx.moveTo(x - size * 0.2, y - size * 0.1);
  ctx.lineTo(x, y - size * 0.3);
  ctx.lineTo(x + size * 0.2, y - size * 0.1);
  ctx.closePath();
  ctx.fill();

  // Silo
  ctx.fillStyle = '#d9b25f';
  ctx.fillRect(x + size * 0.12, y - size * 0.2, size * 0.12, size * 0.3);
  ctx.beginPath();
  ctx.arc(x + size * 0.18, y - size * 0.2, size * 0.06, Math.PI, 0);
  ctx.fill();

  // Crop rows in foreground
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(x + i * size * 0.08, y + size * 0.15);
    ctx.lineTo(x + i * size * 0.08, y + size * 0.35);
    ctx.stroke();
  }

  ctx.restore();
}

export function drawMineSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();

  // Mine entrance (dark arch)
  ctx.fillStyle = '#2e2c24';
  ctx.beginPath();
  ctx.arc(x, y + size * 0.1, size * 0.2, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(x - size * 0.2, y + size * 0.1, size * 0.4, size * 0.15);

  // Wooden supports
  ctx.strokeStyle = '#5c4b22';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.15, y + size * 0.1);
  ctx.lineTo(x - size * 0.15, y - size * 0.15);
  ctx.moveTo(x + size * 0.15, y + size * 0.1);
  ctx.lineTo(x + size * 0.15, y - size * 0.15);
  ctx.stroke();

  // Cross beam
  ctx.beginPath();
  ctx.moveTo(x - size * 0.18, y - size * 0.1);
  ctx.lineTo(x + size * 0.18, y - size * 0.1);
  ctx.stroke();

  // Ore cart
  ctx.fillStyle = '#3a3655';
  ctx.fillRect(x - size * 0.25, y + size * 0.25, size * 0.18, size * 0.12);
  ctx.beginPath();
  ctx.arc(x - size * 0.21, y + size * 0.37, size * 0.04, 0, Math.PI * 2);
  ctx.arc(x - size * 0.13, y + size * 0.37, size * 0.04, 0, Math.PI * 2);
  ctx.fill();

  // Track
  ctx.strokeStyle = '#4a4a4a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.35, y + size * 0.42);
  ctx.lineTo(x + size * 0.1, y + size * 0.42);
  ctx.stroke();

  ctx.restore();
}

export function drawPortSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();

  // Dock/pier
  ctx.fillStyle = '#5c4b22';
  ctx.fillRect(x - size * 0.08, y - size * 0.25, size * 0.16, size * 0.5);

  // Pilings
  ctx.fillStyle = '#3a2a1a';
  for (let i = 0; i < 4; i++) {
    const py = y - size * 0.2 + i * size * 0.12;
    ctx.fillRect(x - size * 0.06, py, size * 0.04, size * 0.08);
    ctx.fillRect(x + size * 0.02, py, size * 0.04, size * 0.08);
  }

  // Small boat
  ctx.fillStyle = '#8f8474';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.15, y + size * 0.15);
  ctx.lineTo(x + size * 0.35, y + size * 0.15);
  ctx.lineTo(x + size * 0.32, y + size * 0.28);
  ctx.lineTo(x + size * 0.18, y + size * 0.28);
  ctx.closePath();
  ctx.fill();

  // Mast
  ctx.strokeStyle = '#c4b59a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + size * 0.25, y + size * 0.15);
  ctx.lineTo(x + size * 0.25, y - size * 0.15);
  ctx.stroke();

  // Sail
  ctx.fillStyle = 'rgba(242, 228, 199, 0.8)';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.27, y - size * 0.12);
  ctx.lineTo(x + size * 0.27, y + size * 0.05);
  ctx.quadraticCurveTo(x + size * 0.35, y - size * 0.02, x + size * 0.27, y - size * 0.12);
  ctx.fill();

  ctx.restore();
}

export function drawTowerSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();

  // Tower base
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(x - size * 0.12, y - size * 0.05, size * 0.24, size * 0.25);

  // Crenellations
  ctx.fillStyle = '#8a8a8a';
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(x - size * 0.12 + i * size * 0.1, y - size * 0.12, size * 0.06, size * 0.1);
  }

  // Roof cone
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.15, y - size * 0.1);
  ctx.lineTo(x, y - size * 0.4);
  ctx.lineTo(x + size * 0.15, y - size * 0.1);
  ctx.closePath();
  ctx.fill();

  // Flag
  ctx.strokeStyle = '#c4b59a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - size * 0.4);
  ctx.lineTo(x, y - size * 0.55);
  ctx.stroke();

  ctx.fillStyle = '#d97163';
  ctx.beginPath();
  ctx.moveTo(x, y - size * 0.55);
  ctx.lineTo(x + size * 0.15, y - size * 0.48);
  ctx.lineTo(x, y - size * 0.42);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// Terrain texture pattern generators
export function createForestPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: string,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = size * 0.6;
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;

  const rng = new SeededRandom(seed);

  // Background
  pCtx.fillStyle = TERRAIN.forest.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);

  // Tree canopy circles
  for (let i = 0; i < 8; i++) {
    const cx = rng.nextRange(0, patternSize);
    const cy = rng.nextRange(0, patternSize);
    const r = rng.nextRange(patternSize * 0.08, patternSize * 0.18);

    const gradient = pCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
    gradient.addColorStop(0, TERRAIN.forest.fill);
    gradient.addColorStop(1, TERRAIN.forest.dark);

    pCtx.fillStyle = gradient;
    pCtx.beginPath();
    pCtx.arc(cx, cy, r, 0, Math.PI * 2);
    pCtx.fill();
  }

  // Tree trunks
  pCtx.strokeStyle = '#2a4228';
  pCtx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const x = rng.nextRange(0, patternSize);
    const y = rng.nextRange(0, patternSize);
    pCtx.beginPath();
    pCtx.moveTo(x, y);
    pCtx.lineTo(x + rng.nextRange(-3, 3), y + rng.nextRange(8, 15));
    pCtx.stroke();
  }

  return ctx.createPattern(patternCanvas, 'repeat');
}

export function createFarmlandPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = size * 0.5;
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;

  // Background
  pCtx.fillStyle = TERRAIN.plains.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);

  // Crop rows
  const rowHeight = patternSize / 6;
  for (let i = 0; i < 6; i++) {
    const y = i * rowHeight;
    const gradient = pCtx.createLinearGradient(0, y, 0, y + rowHeight * 0.8);
    gradient.addColorStop(0, TERRAIN.plains.fill);
    gradient.addColorStop(0.5, lightenHex(TERRAIN.plains.fill, 15));
    gradient.addColorStop(1, TERRAIN.plains.dark);

    pCtx.fillStyle = gradient;
    pCtx.fillRect(0, y + 1, patternSize, rowHeight - 2);
  }

  // Furrow lines
  pCtx.strokeStyle = 'rgba(0,0,0,0.15)';
  pCtx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const y = i * rowHeight;
    pCtx.beginPath();
    pCtx.moveTo(0, y);
    pCtx.lineTo(patternSize, y);
    pCtx.stroke();
  }

  return ctx.createPattern(patternCanvas, 'repeat');
}

export function createOceanPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
  now: number,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = size * 0.8;
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;

  // Deep water background
  pCtx.fillStyle = TERRAIN.rivers.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);

  // Wave lines
  pCtx.strokeStyle = TERRAIN.rivers.fill;
  pCtx.lineWidth = 2;
  pCtx.lineCap = 'round';

  for (let i = 0; i < 5; i++) {
    const y = (i / 5) * patternSize + patternSize * 0.1;
    const waveOffset = (now / 1000 + i * 0.5) % (Math.PI * 2);

    pCtx.beginPath();
    pCtx.globalAlpha = 0.4 + 0.2 * Math.sin(waveOffset);
    for (let x = 0; x < patternSize; x += 5) {
      const waveY = y + Math.sin(x * 0.05 + waveOffset) * 3;
      if (x === 0) pCtx.moveTo(x, waveY);
      else pCtx.lineTo(x, waveY);
    }
    pCtx.stroke();
  }

  pCtx.globalAlpha = 1;
  return ctx.createPattern(patternCanvas, 'repeat');
}

export function createMountainPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: string,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = size * 0.7;
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;

  const rng = new SeededRandom(seed);

  // Rock background
  pCtx.fillStyle = TERRAIN.mountains.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);

  // Rock formations
  for (let i = 0; i < 6; i++) {
    const x = rng.nextRange(0, patternSize);
    const y = rng.nextRange(0, patternSize);
    const r = rng.nextRange(patternSize * 0.1, patternSize * 0.2);

    // Rock gradient
    const gradient = pCtx.createRadialGradient(x, y - r * 0.3, 0, x, y, r);
    gradient.addColorStop(0, lightenHex(TERRAIN.mountains.fill, 20));
    gradient.addColorStop(0.5, TERRAIN.mountains.fill);
    gradient.addColorStop(1, TERRAIN.mountains.dark);

    pCtx.fillStyle = gradient;
    pCtx.beginPath();
    // Irregular rock shape
    const points = 6;
    for (let j = 0; j <= points; j++) {
      const angle = (j / points) * Math.PI * 2;
      const radius = r * (0.7 + rng.next() * 0.3);
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius * 0.7;
      if (j === 0) pCtx.moveTo(px, py);
      else pCtx.lineTo(px, py);
    }
    pCtx.closePath();
    pCtx.fill();
  }

  // Cracks/veins
  pCtx.strokeStyle = 'rgba(20, 20, 30, 0.4)';
  pCtx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const x = rng.nextRange(0, patternSize);
    const y = rng.nextRange(0, patternSize);
    pCtx.beginPath();
    pCtx.moveTo(x, y);
    for (let j = 0; j < 3; j++) {
      pCtx.lineTo(x + rng.nextRange(-15, 15), y + rng.nextRange(-15, 15));
    }
    pCtx.stroke();
  }

  return ctx.createPattern(patternCanvas, 'repeat');
}

export function createWastelandPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: string,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = size * 0.6;
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;

  const rng = new SeededRandom(seed);

  // Dark wasteland background
  pCtx.fillStyle = TERRAIN.wasteland.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);

  // Dead earth patches
  for (let i = 0; i < 12; i++) {
    const x = rng.nextRange(0, patternSize);
    const y = rng.nextRange(0, patternSize);
    const r = rng.nextRange(2, 8);

    pCtx.fillStyle =
      Math.random() > 0.5 ? TERRAIN.wasteland.fill : lightenHex(TERRAIN.wasteland.fill, -10);
    pCtx.globalAlpha = 0.3;
    pCtx.beginPath();
    pCtx.arc(x, y, r, 0, Math.PI * 2);
    pCtx.fill();
  }

  // Cracks
  pCtx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  pCtx.lineWidth = 1;
  pCtx.globalAlpha = 0.5;
  for (let i = 0; i < 5; i++) {
    const x = rng.nextRange(0, patternSize);
    const y = rng.nextRange(0, patternSize);
    pCtx.beginPath();
    pCtx.moveTo(x, y);
    pCtx.lineTo(x + rng.nextRange(-20, 20), y + rng.nextRange(-20, 20));
    pCtx.stroke();
  }

  pCtx.globalAlpha = 1;
  return ctx.createPattern(patternCanvas, 'repeat');
}

export function createCommonsPattern(
  ctx: CanvasRenderingContext2D,
  size: number,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = size * 0.5;
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;

  // Rich commons background
  pCtx.fillStyle = TERRAIN.commons.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);

  // Decorative pattern (geometric symbols)
  pCtx.strokeStyle = TERRAIN.commons.fill;
  pCtx.lineWidth = 1.5;
  pCtx.globalAlpha = 0.3;

  const cx = patternSize / 2;
  const cy = patternSize / 2;

  // Central emblem
  pCtx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const r = patternSize * 0.15;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) pCtx.moveTo(x, y);
    else pCtx.lineTo(x, y);
  }
  pCtx.closePath();
  pCtx.stroke();

  // Radiating lines
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    pCtx.beginPath();
    pCtx.moveTo(cx, cy);
    pCtx.lineTo(cx + Math.cos(angle) * patternSize * 0.4, cy + Math.sin(angle) * patternSize * 0.4);
    pCtx.stroke();
  }

  pCtx.globalAlpha = 1;
  return ctx.createPattern(patternCanvas, 'repeat');
}

// Helper to lighten/darken hex colors
function lightenHex(color: string, amount: number): string {
  const num = parseInt(color.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Pattern cache to avoid recreating patterns every frame
const patternCache = new Map<string, CanvasPattern | null>();

export function getCachedPattern(
  terrain: string,
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: string,
  now: number,
): CanvasPattern | null {
  const cacheKey = `${terrain}-${seed}-${Math.floor(now / 500) % 10}`; // Cache for ocean waves animation

  if (patternCache.has(cacheKey)) {
    return patternCache.get(cacheKey) ?? null;
  }

  let pattern: CanvasPattern | null = null;

  switch (terrain) {
    case 'forest':
      pattern = createForestPattern(ctx, size, seed);
      break;
    case 'plains':
      pattern = createFarmlandPattern(ctx, size);
      break;
    case 'rivers':
      pattern = createOceanPattern(ctx, size, now);
      break;
    case 'mountains':
      pattern = createMountainPattern(ctx, size, seed);
      break;
    case 'wasteland':
      pattern = createWastelandPattern(ctx, size, seed);
      break;
    case 'commons':
      pattern = createCommonsPattern(ctx, size);
      break;
  }

  patternCache.set(cacheKey, pattern);
  return pattern;
}

// Clear pattern cache periodically to prevent memory bloat
export function clearPatternCache(): void {
  patternCache.clear();
}
