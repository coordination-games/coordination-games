import { lightenHex, TERRAIN } from './colors';

export const ECOSYSTEM_COLORS = [
  'rgba(217, 180, 105, 0.15)',
  'rgba(114, 169, 181, 0.15)',
  'rgba(186, 115, 87, 0.15)',
  'rgba(127, 158, 115, 0.15)',
  'rgba(212, 124, 97, 0.15)',
  'rgba(139, 131, 174, 0.15)',
  'rgba(99, 165, 167, 0.15)',
  'rgba(198, 138, 88, 0.15)',
];

export function getEcosystemColor(index: number): string {
  return ECOSYSTEM_COLORS[index % ECOSYSTEM_COLORS.length] ?? 'rgba(217, 180, 105, 0.15)';
}

export const RESOURCE_ICONS: Record<
  string,
  (ctx: CanvasRenderingContext2D, x: number, y: number, size: number) => void
> = {
  grain: (ctx, x, y, size) => {
    ctx.save();
    ctx.strokeStyle = '#f2e4c7';
    ctx.lineWidth = size * 0.08;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.3);
    ctx.quadraticCurveTo(x + size * 0.1, y, x, y - size * 0.2);
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const angle = (i - 2) * 0.3;
      ctx.beginPath();
      ctx.arc(
        x + Math.sin(angle) * size * 0.15,
        y - size * 0.2 + Math.cos(angle) * size * 0.08,
        size * 0.06,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = '#f2e4c7';
      ctx.fill();
    }
    ctx.restore();
  },
  timber: (ctx, x, y, size) => {
    ctx.save();
    ctx.fillStyle = '#7f9e73';
    ctx.beginPath();
    ctx.moveTo(x, y - size * 0.35);
    ctx.lineTo(x - size * 0.25, y + size * 0.1);
    ctx.lineTo(x + size * 0.25, y + size * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#5c4b22';
    ctx.fillRect(x - size * 0.08, y + size * 0.1, size * 0.16, size * 0.25);
    ctx.restore();
  },
  ore: (ctx, x, y, size) => {
    ctx.save();
    ctx.strokeStyle = '#8b83ae';
    ctx.lineWidth = size * 0.1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - size * 0.3, y + size * 0.25);
    ctx.lineTo(x - size * 0.1, y - size * 0.15);
    ctx.lineTo(x + size * 0.1, y + size * 0.05);
    ctx.lineTo(x + size * 0.3, y - size * 0.25);
    ctx.stroke();
    ctx.restore();
  },
  fish: (ctx, x, y, size) => {
    ctx.save();
    ctx.fillStyle = '#72a9b5';
    ctx.beginPath();
    ctx.ellipse(x, y, size * 0.25, size * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + size * 0.2, y);
    ctx.lineTo(x + size * 0.4, y - size * 0.15);
    ctx.lineTo(x + size * 0.4, y + size * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },
  energy: (ctx, x, y, size) => {
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

export function drawFarmSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = '#c4b59a';
  ctx.fillRect(x - size * 0.15, y - size * 0.1, size * 0.3, size * 0.2);
  ctx.fillStyle = '#8f8474';
  ctx.beginPath();
  ctx.moveTo(x - size * 0.2, y - size * 0.1);
  ctx.lineTo(x, y - size * 0.3);
  ctx.lineTo(x + size * 0.2, y - size * 0.1);
  ctx.closePath();
  ctx.fill();
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
  ctx.fillStyle = '#2e2c24';
  ctx.beginPath();
  ctx.arc(x, y + size * 0.1, size * 0.2, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(x - size * 0.2, y + size * 0.1, size * 0.4, size * 0.15);
  ctx.strokeStyle = '#5c4b22';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.15, y + size * 0.1);
  ctx.lineTo(x - size * 0.15, y - size * 0.15);
  ctx.moveTo(x + size * 0.15, y + size * 0.1);
  ctx.lineTo(x + size * 0.15, y - size * 0.15);
  ctx.moveTo(x - size * 0.18, y - size * 0.1);
  ctx.lineTo(x + size * 0.18, y - size * 0.1);
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
  ctx.fillStyle = '#5c4b22';
  ctx.fillRect(x - size * 0.08, y - size * 0.25, size * 0.16, size * 0.5);
  ctx.fillStyle = '#8f8474';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.15, y + size * 0.15);
  ctx.lineTo(x + size * 0.35, y + size * 0.15);
  ctx.lineTo(x + size * 0.32, y + size * 0.28);
  ctx.lineTo(x + size * 0.18, y + size * 0.28);
  ctx.closePath();
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
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(x - size * 0.12, y - size * 0.05, size * 0.24, size * 0.25);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - size * 0.15, y - size * 0.1);
  ctx.lineTo(x, y - size * 0.4);
  ctx.lineTo(x + size * 0.15, y - size * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const patternCache = new Map<string, CanvasPattern | null>();

function createPattern(
  ctx: CanvasRenderingContext2D,
  terrain: keyof typeof TERRAIN,
  size: number,
  seed: string,
  now: number,
): CanvasPattern | null {
  const patternCanvas = document.createElement('canvas');
  const patternSize = Math.max(24, size * 0.65);
  patternCanvas.width = patternSize;
  patternCanvas.height = patternSize;
  const pCtx = patternCanvas.getContext('2d');
  if (!pCtx) return null;
  const palette = TERRAIN[terrain];
  pCtx.fillStyle = palette.dark;
  pCtx.fillRect(0, 0, patternSize, patternSize);
  pCtx.strokeStyle = lightenHex(palette.fill, 20);
  pCtx.globalAlpha = 0.35;
  pCtx.lineWidth = 1;
  const shift = terrain === 'rivers' ? (now / 120) % patternSize : 0;
  for (let i = -patternSize; i < patternSize * 2; i += patternSize / 5) {
    pCtx.beginPath();
    pCtx.moveTo(i + shift, 0);
    pCtx.lineTo(i + patternSize / 2 + shift, patternSize);
    pCtx.stroke();
  }
  pCtx.globalAlpha = 1;
  for (let i = 0; i < 8; i++) {
    const hash = Math.abs((seed.charCodeAt(i % seed.length) ?? 7) * (i + 3));
    pCtx.fillStyle = terrain === 'wasteland' ? 'rgba(0,0,0,0.25)' : palette.fill;
    pCtx.globalAlpha = 0.14;
    pCtx.beginPath();
    pCtx.arc(hash % patternSize, (hash * 7) % patternSize, patternSize * 0.08, 0, Math.PI * 2);
    pCtx.fill();
  }
  pCtx.globalAlpha = 1;
  return ctx.createPattern(patternCanvas, 'repeat');
}

export function getCachedPattern(
  terrain: string,
  ctx: CanvasRenderingContext2D,
  size: number,
  seed: string,
  now: number,
): CanvasPattern | null {
  const key = `${terrain}-${seed}-${Math.floor(now / 500) % 10}`;
  if (patternCache.has(key)) return patternCache.get(key) ?? null;
  const knownTerrain = terrain in TERRAIN ? (terrain as keyof typeof TERRAIN) : 'wasteland';
  const pattern = createPattern(ctx, knownTerrain, size, seed, now);
  patternCache.set(key, pattern);
  return pattern;
}

export function clearPatternCache(): void {
  patternCache.clear();
}
