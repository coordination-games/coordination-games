// Terrain shape motifs drawn as engraved canvas glyphs so each terrain is
// distinguishable by FORM, not color alone (WCAG 1.4.1 use-of-color). Every
// motif is a monochrome ink stroke rendered over the terrain sprite; the shape
// carries the meaning, the underlying art carries the palette.

export type TerrainMotif =
  | 'oil-field'
  | 'river'
  | 'wetland'
  | 'forest'
  | 'mountains'
  | 'commons'
  | 'plains'
  | 'wasteland';

const MOTIF_ALIASES: Record<string, TerrainMotif> = {
  'oil-field': 'oil-field',
  oil: 'oil-field',
  river: 'river',
  rivers: 'river',
  wetland: 'wetland',
  wetlands: 'wetland',
  forest: 'forest',
  mountains: 'mountains',
  mountain: 'mountains',
  commons: 'commons',
  plains: 'plains',
  wasteland: 'wasteland',
};

// Short human phrase for the shape, used verbatim in the accessibility layer so
// the sighted motif and the screen-reader description never drift apart.
const MOTIF_DESCRIPTION: Record<TerrainMotif, string> = {
  'oil-field': 'derrick triangle over a fuel droplet',
  river: 'three stacked flowing waves',
  wetland: 'upright reeds above ripple dots',
  forest: 'clustered conifer triangles',
  mountains: 'stacked peak chevrons',
  commons: 'concentric shared-ground rings',
  plains: 'open horizontal furrows',
  wasteland: 'cracked broken ground',
};

export function terrainMotif(terrain: string | undefined): TerrainMotif {
  return MOTIF_ALIASES[terrain ?? ''] ?? 'wasteland';
}

export function motifDescription(terrain: string | undefined): string {
  return MOTIF_DESCRIPTION[terrainMotif(terrain)];
}

interface MotifStyle {
  ink: string;
  halo: string;
  width: number;
}

function withGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  style: MotifStyle,
  draw: () => void,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Dark halo first, then light ink, so the glyph survives on both bright and
  // dark terrain art without depending on hue contrast.
  ctx.strokeStyle = style.halo;
  ctx.lineWidth = style.width * 1.9;
  ctx.globalAlpha = 0.5;
  draw();
  ctx.strokeStyle = style.ink;
  ctx.lineWidth = style.width;
  ctx.globalAlpha = 0.92;
  draw();
  ctx.restore();
  void size;
}

function drawWaves(ctx: CanvasRenderingContext2D, unit: number, rows: number): void {
  for (let row = 0; row < rows; row += 1) {
    const offsetY = (row - (rows - 1) / 2) * unit * 0.5;
    ctx.beginPath();
    for (let step = 0; step <= 4; step += 1) {
      const px = (step / 4 - 0.5) * unit * 1.6;
      const py = offsetY + Math.sin(step * Math.PI) * unit * 0.16 * (step % 2 === 0 ? 1 : -1);
      if (step === 0) ctx.moveTo(px, py);
      else ctx.quadraticCurveTo(px - unit * 0.2, py + unit * 0.24, px, py);
    }
    ctx.stroke();
  }
}

function drawOilDerrick(ctx: CanvasRenderingContext2D, unit: number): void {
  // Lattice tower: a narrow trapezoid frame with internal cross-braces, so it
  // reads as a rig and never as a solid mountain peak.
  const topHalf = unit * 0.16;
  const baseHalf = unit * 0.44;
  const topY = -unit * 0.62;
  const baseY = unit * 0.4;
  ctx.beginPath();
  ctx.moveTo(-topHalf, topY);
  ctx.lineTo(-baseHalf, baseY);
  ctx.moveTo(topHalf, topY);
  ctx.lineTo(baseHalf, baseY);
  ctx.moveTo(-topHalf, topY);
  ctx.lineTo(topHalf, topY);
  ctx.stroke();
  // Two cross-braces down the tower.
  ctx.beginPath();
  ctx.moveTo(-unit * 0.24, -unit * 0.16);
  ctx.lineTo(unit * 0.24, -unit * 0.16);
  ctx.moveTo(-baseHalf, baseY);
  ctx.lineTo(baseHalf, baseY);
  ctx.stroke();
  // X brace in the lower bay.
  ctx.beginPath();
  ctx.moveTo(-unit * 0.24, -unit * 0.16);
  ctx.lineTo(baseHalf, baseY);
  ctx.moveTo(unit * 0.24, -unit * 0.16);
  ctx.lineTo(-baseHalf, baseY);
  ctx.stroke();
  // Pump arm at the crown.
  ctx.beginPath();
  ctx.moveTo(0, topY);
  ctx.lineTo(unit * 0.34, topY - unit * 0.12);
  ctx.stroke();
}

function drawReeds(ctx: CanvasRenderingContext2D, unit: number): void {
  for (let index = -1; index <= 1; index += 1) {
    const baseX = index * unit * 0.42;
    ctx.beginPath();
    ctx.moveTo(baseX, unit * 0.5);
    ctx.quadraticCurveTo(baseX + index * unit * 0.12, -unit * 0.1, baseX, -unit * 0.55);
    ctx.stroke();
  }
  for (let dot = -1; dot <= 1; dot += 1) {
    ctx.beginPath();
    ctx.arc(dot * unit * 0.42, unit * 0.66, unit * 0.06, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawConifers(ctx: CanvasRenderingContext2D, unit: number): void {
  const trees = [-unit * 0.42, unit * 0.42, 0];
  const tops = [unit * 0.1, unit * 0.1, -unit * 0.35];
  trees.forEach((treeX, treeIndex) => {
    const topY = tops[treeIndex] ?? 0;
    ctx.beginPath();
    ctx.moveTo(treeX - unit * 0.26, topY + unit * 0.5);
    ctx.lineTo(treeX, topY);
    ctx.lineTo(treeX + unit * 0.26, topY + unit * 0.5);
    ctx.stroke();
  });
}

function drawPeaks(ctx: CanvasRenderingContext2D, unit: number): void {
  ctx.beginPath();
  ctx.moveTo(-unit * 0.6, unit * 0.45);
  ctx.lineTo(-unit * 0.2, -unit * 0.5);
  ctx.lineTo(unit * 0.12, unit * 0.08);
  ctx.lineTo(unit * 0.4, -unit * 0.32);
  ctx.lineTo(unit * 0.62, unit * 0.45);
  ctx.stroke();
}

function drawRings(ctx: CanvasRenderingContext2D, unit: number): void {
  for (let ring = 1; ring <= 2; ring += 1) {
    ctx.beginPath();
    ctx.arc(0, 0, unit * 0.28 * ring, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawFurrows(ctx: CanvasRenderingContext2D, unit: number): void {
  for (let row = -1; row <= 1; row += 1) {
    const py = row * unit * 0.34;
    ctx.beginPath();
    ctx.moveTo(-unit * 0.6, py);
    ctx.lineTo(unit * 0.6, py);
    ctx.stroke();
  }
}

function drawCracks(ctx: CanvasRenderingContext2D, unit: number): void {
  ctx.beginPath();
  ctx.moveTo(-unit * 0.55, -unit * 0.3);
  ctx.lineTo(-unit * 0.1, unit * 0.05);
  ctx.lineTo(-unit * 0.3, unit * 0.55);
  ctx.moveTo(-unit * 0.1, unit * 0.05);
  ctx.lineTo(unit * 0.4, -unit * 0.15);
  ctx.lineTo(unit * 0.55, unit * 0.45);
  ctx.stroke();
}

// Paint the terrain's shape motif centered at (x, y). `size` is the hex inner
// radius; the glyph is scaled to sit comfortably inside it.
export function drawTerrainMotif(
  ctx: CanvasRenderingContext2D,
  terrain: string | undefined,
  x: number,
  y: number,
  size: number,
): void {
  const unit = size * 0.42;
  const style: MotifStyle = {
    ink: 'rgba(247, 238, 220, 0.9)',
    halo: 'rgba(6, 12, 18, 0.85)',
    width: Math.max(1.4, size * 0.03),
  };
  const motif = terrainMotif(terrain);
  withGlyph(ctx, x, y, size, style, () => {
    if (motif === 'oil-field') drawOilDerrick(ctx, unit);
    else if (motif === 'river') drawWaves(ctx, unit, 3);
    else if (motif === 'wetland') drawReeds(ctx, unit);
    else if (motif === 'forest') drawConifers(ctx, unit);
    else if (motif === 'mountains') drawPeaks(ctx, unit);
    else if (motif === 'commons') drawRings(ctx, unit);
    else if (motif === 'plains') drawFurrows(ctx, unit);
    else drawCracks(ctx, unit);
  });
}
