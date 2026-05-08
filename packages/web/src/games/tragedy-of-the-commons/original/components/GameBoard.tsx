import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addAlpha, lightenHex, RESOURCE_PALETTE, TERRAIN } from '../lib/colors';
import { drawHexPath, hexToPixel } from '../lib/hex-math';
import {
  getRoadImage,
  getSettlementImage,
  getTerrainImage,
  getVfxFrame,
  preloadTragedyAssets,
  setTragedyAssetRedrawCallback,
} from '../lib/terrain-images';
import { clearPatternCache, getCachedPattern } from '../lib/terrain-textures';
import { useGameStore } from '../store';

interface BoardLayout {
  centerX: number;
  centerY: number;
  size: number;
  inner: number;
}

interface BoardMarker {
  agentId: string;
  color: string;
  type: string;
  hexes: Array<{ q: number; r: number }>;
}

const HEALTH_COPY: Record<string, { label: string; tone: string; explanation: string }> = {
  flourishing: {
    label: 'Flourishing',
    tone: '#8fcf86',
    explanation: 'Healthy ecosystem art is used; no extra warning animation is applied.',
  },
  stable: {
    label: 'Stable',
    tone: '#ddb469',
    explanation: 'Baseline ecosystem art is used with only normal board lighting.',
  },
  strained: {
    label: 'Strained',
    tone: '#dba15d',
    explanation: 'The tile uses strained terrain art plus a subtle damage or pollution overlay.',
  },
  collapsed: {
    label: 'Collapsed',
    tone: '#d47c61',
    explanation: 'The tile uses collapsed terrain art without a continuous warning overlay.',
  },
};

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  ctx.drawImage(image, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
}

function drawContainImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function markerKey(q: number, r: number): string {
  return `${q},${r}`;
}

function settlementAssetType(type: string): string {
  if (type === 'solar-farm' || type === 'solar-array') return type;
  if (type === 'city' || type === 'cities') return 'city';
  if (type === 'township' || type === 'townships') return 'township';
  if (type === 'camp') return 'camp';
  return 'village';
}

function titleCase(value: string | undefined): string {
  if (!value) return 'Unknown';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function tileTitle(tile: {
  regionName?: string;
  ecosystemName?: string;
  terrain?: string;
}): string {
  if (tile.regionName) return tile.regionName;
  if (tile.ecosystemName) return tile.ecosystemName;
  return titleCase(tile.terrain);
}

function productiveResources(tile: {
  terrain?: string;
  primaryResource?: string;
  ecosystemResource?: string;
}): string[] {
  const resources = new Set<string>();
  if (tile.terrain === 'rivers' || tile.terrain === 'wetland') {
    resources.add('water');
    resources.add('fish');
  } else if (tile.primaryResource) {
    resources.add(tile.primaryResource);
  }
  if (tile.ecosystemResource) resources.add(tile.ecosystemResource);
  return [...resources];
}

function resourceLabel(resource: string): string {
  if (resource === 'fish') return 'Fish/Food';
  return titleCase(resource);
}

function tileResourceFocus(tile: {
  terrain?: string;
  primaryResource?: string;
  ecosystemResource?: string;
}): string {
  const resources = productiveResources(tile).map(resourceLabel);
  if (resources.length > 0) return `Produces ${resources.join(' + ')}`;
  return 'Scenery only';
}

function tileFeature(tile: {
  regionName?: string;
  ecosystemName?: string;
  terrain?: string;
}): string {
  if (tile.ecosystemName) return `${tile.ecosystemName} resource tile`;
  if (tile.regionName) return `${tile.regionName} resource tile`;
  return `${titleCase(tile.terrain)} resource tile`;
}

function structureLabel(type: string): string {
  if (type === 'solar-farm') return 'Solar Farm';
  if (type === 'solar-array') return 'Solar Array';
  return titleCase(type);
}

function terrainLegendLabel(label: string): string {
  if (label === 'oil') return 'Oil Field';
  if (label === 'rivers') return 'River';
  return titleCase(label);
}

function intersectionPixel(
  hexes: Array<{ q: number; r: number }>,
  centerX: number,
  centerY: number,
  size: number,
): { x: number; y: number } | null {
  if (hexes.length === 0) return null;
  const points = hexes.map((hex) => hexToPixel(hex.q, hex.r, centerX, centerY, size));
  if (points.length === 1) {
    const point = points[0];
    if (!point) return null;
    return { x: point.x + size * 0.42, y: point.y - size * 0.46 };
  }
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function drawRoadSegment(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  size: number,
  index: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const offset = (index - 0.5) * size * 0.018;
  const normalX = Math.cos(angle + Math.PI / 2) * offset;
  const normalY = Math.sin(angle + Math.PI / 2) * offset;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const midpointX = (from.x + to.x) / 2 + normalX;
  const midpointY = (from.y + to.y) / 2 + normalY;
  const roadImage = getRoadImage('straight');

  if (length > size * 1.18) return;

  if (roadImage) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = size * 0.04;
    ctx.strokeStyle = 'rgba(116, 84, 44, 0.78)';
    ctx.lineWidth = Math.max(4, size * 0.075);
    ctx.beginPath();
    ctx.moveTo(from.x + normalX, from.y + normalY);
    ctx.lineTo(to.x + normalX, to.y + normalY);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(midpointX, midpointY);
    ctx.rotate(angle);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = size * 0.035;
    ctx.globalAlpha = 1;
    ctx.drawImage(roadImage, 0, 52, 109, 14, -length * 0.5, -size * 0.075, length, size * 0.15);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = size * 0.08;
  ctx.strokeStyle = 'rgba(34, 24, 16, 0.92)';
  ctx.lineWidth = Math.max(4, size * 0.07);
  ctx.beginPath();
  ctx.moveTo(from.x + normalX, from.y + normalY);
  ctx.lineTo(to.x + normalX, to.y + normalY);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(156, 120, 69, 0.92)';
  ctx.lineWidth = Math.max(2.5, size * 0.045);
  ctx.beginPath();
  ctx.moveTo(from.x + normalX, from.y + normalY);
  ctx.lineTo(to.x + normalX, to.y + normalY);
  ctx.stroke();
  ctx.setLineDash([size * 0.11, size * 0.07]);
  ctx.strokeStyle = 'rgba(255, 226, 164, 0.34)';
  ctx.lineWidth = Math.max(1, size * 0.012);
  ctx.beginPath();
  ctx.moveTo(from.x + normalX, from.y + normalY);
  ctx.lineTo(to.x + normalX, to.y + normalY);
  ctx.stroke();
  ctx.restore();
}

function healthPercent(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function visualEffectLabel(status: string | undefined): string {
  if (status === 'collapsed') return 'Collapsed ecosystem: collapsed terrain art only.';
  if (status === 'strained') return 'Strained ecosystem: subtle damage or pollution overlay.';
  return 'No continuous warning animation.';
}

function drawSettlementMarker(
  ctx: CanvasRenderingContext2D,
  marker: BoardMarker,
  x: number,
  y: number,
  size: number,
  index: number,
): void {
  const token = getSettlementImage(settlementAssetType(marker.type));
  const offsetX = (index - 0.5) * size * 0.24;
  const tokenSize = size * 0.88;
  ctx.save();
  ctx.translate(x + offsetX, y - size * 0.02);
  ctx.shadowColor = marker.color;
  ctx.shadowBlur = size * 0.18;
  ctx.beginPath();
  ctx.arc(0, tokenSize * 0.03, tokenSize * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(5, 10, 15, 0.58)';
  ctx.fill();
  ctx.strokeStyle = marker.color;
  ctx.lineWidth = Math.max(2.4, size * 0.035);
  ctx.stroke();
  if (token) {
    drawContainImage(ctx, token, -tokenSize * 0.42, -tokenSize * 0.62, tokenSize * 0.84, tokenSize);
  } else {
    ctx.fillStyle = marker.color;
    ctx.beginPath();
    ctx.moveTo(0, -tokenSize * 0.35);
    ctx.lineTo(tokenSize * 0.24, tokenSize * 0.1);
    ctx.lineTo(-tokenSize * 0.24, tokenSize * 0.1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function getBoardLayout(
  hexes: Array<{ q: number; r: number }>,
  width: number,
  height: number,
): BoardLayout {
  const unitPositions = hexes.map((hex) => hexToPixel(hex.q, hex.r, 0, 0, 1));
  const minX = Math.min(...unitPositions.map((position) => position.x));
  const maxX = Math.max(...unitPositions.map((position) => position.x));
  const minY = Math.min(...unitPositions.map((position) => position.y));
  const maxY = Math.max(...unitPositions.map((position) => position.y));
  const unitRadius = 0.92;
  const unitWidth = maxX - minX + unitRadius * 2;
  const unitHeight = maxY - minY + unitRadius * 2;
  const paddingX = Math.min(96, Math.max(36, width * 0.08));
  const paddingY = Math.min(96, Math.max(42, height * 0.1));
  const fittedSize = Math.min(
    (width - paddingX * 2) / Math.max(unitWidth, 1),
    (height - paddingY * 2) / Math.max(unitHeight, 1),
  );
  const size = Math.max(46, Math.min(fittedSize, Math.min(width, height) / 5.1));
  const centerX = width / 2 - ((minX + maxX) / 2) * size;
  const centerY = height / 2 + 6 - ((minY + maxY) / 2) * size;

  return {
    centerX,
    centerY,
    size,
    inner: size * 0.99,
  };
}

export function GameBoard() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLButtonElement | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const hexGrid = useGameStore((state) => state.gameState.hexGrid);
  const agents = useGameStore((state) => state.gameState.agents);
  const selectedHex = useGameStore((state) => state.selectedHex);
  const setSelectedHex = useGameStore((state) => state.setSelectedHex);

  const sortedHexes = useMemo(() => [...hexGrid].sort((a, b) => a.r - b.r || a.q - b.q), [hexGrid]);
  const visibleTerrainLegend = useMemo(() => {
    const terrainByLabel = new Map<string, (typeof TERRAIN)[keyof typeof TERRAIN]>();
    sortedHexes.forEach((hex) => {
      const terrain = TERRAIN[hex.terrain as keyof typeof TERRAIN];
      if (terrain) terrainByLabel.set(terrain.label, terrain);
    });
    return [...terrainByLabel.values()];
  }, [sortedHexes]);
  const markersByHex = useMemo(() => {
    const markers = new Map<string, BoardMarker[]>();
    Object.values(agents).forEach((agent) => {
      const agentId = agent.id ?? agent.name ?? 'agent';
      const color = agent.color ?? '#ddb469';
      agent.structureLocations?.forEach((location) => {
        location.hexes.forEach((hex) => {
          const key = markerKey(hex.q, hex.r);
          const current = markers.get(key) ?? [];
          current.push({ agentId, color, type: location.type, hexes: location.hexes });
          markers.set(key, current);
        });
      });
    });
    return markers;
  }, [agents]);

  const intersectionMarkers = useMemo(() => {
    return Object.values(agents).flatMap((agent) => {
      const agentId = agent.id ?? agent.name ?? 'agent';
      const color = agent.color ?? '#ddb469';
      return (agent.structureLocations ?? []).map((location) => ({
        agentId,
        color,
        type: location.type,
        hexes: location.hexes,
      }));
    });
  }, [agents]);

  const roadSegments = useMemo(() => {
    return Object.values(agents).flatMap((agent) => {
      const agentId = agent.id ?? agent.name ?? 'agent';
      const color = agent.color ?? '#ddb469';
      return (agent.roadLocations ?? []).map((road) => ({
        agentId,
        color,
        type: road.type ?? 'road',
        from: road.from,
        to: road.to,
      }));
    });
  }, [agents]);

  const selectedTile = useMemo(() => {
    if (!selectedHex) return null;
    return sortedHexes.find((hex) => hex.q === selectedHex.q && hex.r === selectedHex.r) ?? null;
  }, [selectedHex, sortedHexes]);

  const selectedTileMarkers = useMemo(() => {
    if (!selectedTile) return [];
    return markersByHex.get(markerKey(selectedTile.q, selectedTile.r)) ?? [];
  }, [markersByHex, selectedTile]);

  const drawBoard = useCallback(() => {
    if (document.hidden) return;

    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = shell.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.floor(rect.width * dpr);
    const nextHeight = Math.floor(rect.height * dpr);
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      clearPatternCache();
    }

    const now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (sortedHexes.length === 0) {
      ctx.fillStyle = 'rgba(247,238,220,0.56)';
      ctx.font = '600 14px SFMono-Regular, Menlo, Monaco, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Waiting for world data...', rect.width / 2, rect.height / 2);
      return;
    }

    const { centerX, centerY, size, inner } = getBoardLayout(sortedHexes, rect.width, rect.height);

    for (const hex of sortedHexes) {
      const terrain = TERRAIN[hex.terrain as keyof typeof TERRAIN] ?? TERRAIN.forest;
      const position = hexToPixel(hex.q, hex.r, centerX, centerY, size);
      const key = `${hex.q},${hex.r}`;
      const pulse = 0.55 + 0.45 * Math.sin(now / 420 + (hex.q + hex.r) * 0.3);
      const selected = selectedHex?.q === hex.q && selectedHex?.r === hex.r;
      const hovered = hoveredKey === key;

      const hexSeed = `${hex.q},${hex.r}`;

      ctx.save();

      drawHexPath(ctx, position.x, position.y, inner);
      let usedTerrainImage = false;
      const terrainImage = getTerrainImage(hex.terrain, hex.ecosystemStatus);
      if (terrainImage) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.clip();
        const overscan = inner * 0.2;
        drawCoverImage(
          ctx,
          terrainImage,
          position.x - inner - overscan,
          position.y - inner - overscan,
          inner * 2 + overscan * 2,
          inner * 2 + overscan * 2,
        );
        const imageTint = ctx.createRadialGradient(
          position.x - inner * 0.18,
          position.y - inner * 0.35,
          inner * 0.05,
          position.x,
          position.y,
          inner * 1.15,
        );
        imageTint.addColorStop(0, addAlpha(lightenHex(terrain.fill, 32), 0.16));
        imageTint.addColorStop(1, addAlpha(terrain.dark, 0.12));
        ctx.globalCompositeOperation = 'soft-light';
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = imageTint;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
        usedTerrainImage = true;
      } else {
        const pattern = getCachedPattern(hex.terrain, ctx, size, hexSeed, now);
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fill();

          const fill = ctx.createRadialGradient(
            position.x - inner * 0.18,
            position.y - inner * 0.35,
            inner * 0.05,
            position.x,
            position.y,
            inner * 1.15,
          );
          fill.addColorStop(0, addAlpha(lightenHex(terrain.fill, 32), 0.4));
          fill.addColorStop(0.5, addAlpha(terrain.fill, 0.3));
          fill.addColorStop(1, addAlpha(terrain.dark, 0.5));
          ctx.fillStyle = fill;
          ctx.fill();
        } else {
          const fill = ctx.createRadialGradient(
            position.x - inner * 0.18,
            position.y - inner * 0.35,
            inner * 0.05,
            position.x,
            position.y,
            inner * 1.15,
          );
          fill.addColorStop(0, lightenHex(terrain.fill, 32));
          fill.addColorStop(0.38, terrain.fill);
          fill.addColorStop(1, terrain.dark);
          ctx.fillStyle = fill;
          ctx.fill();
        }
      }

      if (!usedTerrainImage) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.clip();
        ctx.strokeStyle = terrain.highlight;
        ctx.lineWidth = 1.2;
        const spacing = size * 0.18;
        for (let offset = -inner * 1.5; offset < inner * 1.5; offset += spacing) {
          ctx.beginPath();
          ctx.moveTo(position.x - inner + offset, position.y - inner);
          ctx.lineTo(position.x + inner + offset, position.y + inner);
          ctx.stroke();
        }
        ctx.restore();
      }

      if (!usedTerrainImage) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.clip();
        ctx.strokeStyle = 'rgba(0,0,0,0.06)';
        ctx.lineWidth = 0.6;
        const vSpacing = size * 0.22;
        for (let offset = -inner * 1.5; offset < inner * 1.5; offset += vSpacing) {
          ctx.beginPath();
          ctx.moveTo(position.x - inner, position.y - inner + offset);
          ctx.lineTo(position.x + inner, position.y - inner + offset);
          ctx.stroke();
        }
        ctx.restore();
      }

      const ecosystemHealth = Math.max(0, Math.min(1, hex.ecosystemHealth ?? 1));
      if (ecosystemHealth < 0.92 || hex.ecosystemStatus === 'collapsed') {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.clip();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = addAlpha('#2f2b24', Math.min(0.22, (1 - ecosystemHealth) * 0.34));
        ctx.fill();
        ctx.restore();
      }

      drawHexPath(ctx, position.x, position.y, inner);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.stroke();

      if (hovered || selected) {
        const glowAlpha = hovered ? 0.1 : 0.08;
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.fillStyle = terrain.glow;
        ctx.globalAlpha = glowAlpha;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.save();
      drawHexPath(ctx, position.x, position.y, inner + 3);
      ctx.strokeStyle = addAlpha(lightenHex(terrain.fill, 45), 0.58);
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.restore();

      if (hovered || selected) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner + 5);
        ctx.strokeStyle = selected
          ? addAlpha(terrain.fill, 0.92)
          : addAlpha(terrain.fill, 0.5 + pulse * 0.18);
        ctx.lineWidth = selected ? 3.2 : 2.4;
        ctx.shadowColor = terrain.fill;
        ctx.shadowBlur = selected ? 20 : 14 * pulse;
        ctx.stroke();
        ctx.restore();
      }

      drawHexPath(ctx, position.x, position.y, inner);
      ctx.strokeStyle = addAlpha(lightenHex(terrain.fill, 45), hovered ? 0.82 : 0.62);
      ctx.lineWidth = hovered ? 2.2 : 1.6;
      ctx.stroke();

      if (hovered || selected) {
        ctx.save();
        ctx.fillStyle = 'rgba(247, 238, 220, 0.78)';
        ctx.shadowColor = 'rgba(0,0,0,0.75)';
        ctx.shadowBlur = 8;
        ctx.font = `600 ${size * 0.082}px SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          (hex.regionName || terrain.label).toUpperCase(),
          position.x,
          position.y + size * 0.2,
        );
        ctx.restore();
      }

      const vfxFrame = Math.floor(now / 360 + hex.q * 2 + hex.r * 3);
      const vfxKind =
        hex.terrain === 'oil-field' && hex.ecosystemStatus === 'strained'
          ? 'oilSpill'
          : hex.terrain === 'rivers' && hex.ecosystemStatus === 'strained'
            ? 'downstreamPollution'
            : hex.terrain === 'wetland' && hex.ecosystemStatus === 'strained'
              ? 'wetlandAbsorption'
              : hex.ecosystemStatus === 'strained'
                ? 'healthDrain'
                : null;
      const vfxImage = vfxKind ? getVfxFrame(vfxKind, vfxFrame) : null;
      if (vfxImage) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.clip();
        ctx.globalAlpha = 0.12;
        drawCoverImage(
          ctx,
          vfxImage,
          position.x - inner * 0.98,
          position.y - inner * 0.98,
          inner * 1.96,
          inner * 1.96,
        );
        ctx.restore();
      }

      if (hovered || selected) {
        ctx.save();

        const spotlightGrad = ctx.createRadialGradient(
          position.x,
          position.y,
          inner * 0.5,
          position.x,
          position.y,
          inner * 1.3,
        );
        spotlightGrad.addColorStop(0, addAlpha('#ddb469', selected ? 0.15 : 0.08));
        spotlightGrad.addColorStop(0.7, addAlpha('#ddb469', selected ? 0.05 : 0.02));
        spotlightGrad.addColorStop(1, 'transparent');

        ctx.fillStyle = spotlightGrad;
        ctx.fillRect(position.x - inner * 1.5, position.y - inner * 1.5, inner * 3, inner * 3);

        if (selected) {
          const cornerSize = size * 0.15;
          ctx.strokeStyle = '#ddb469';
          ctx.lineWidth = 2;

          ctx.beginPath();
          ctx.moveTo(position.x - inner + cornerSize, position.y - inner * 0.87);
          ctx.lineTo(position.x - inner + 5, position.y - inner * 0.87);
          ctx.lineTo(position.x - inner + 5, position.y - inner * 0.87 + cornerSize);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(position.x + inner - cornerSize, position.y - inner * 0.87);
          ctx.lineTo(position.x + inner - 5, position.y - inner * 0.87);
          ctx.lineTo(position.x + inner - 5, position.y - inner * 0.87 + cornerSize);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(position.x - inner + cornerSize, position.y + inner * 0.87);
          ctx.lineTo(position.x - inner + 5, position.y + inner * 0.87);
          ctx.lineTo(position.x - inner + 5, position.y + inner * 0.87 - cornerSize);
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(position.x + inner - cornerSize, position.y + inner * 0.87);
          ctx.lineTo(position.x + inner - 5, position.y + inner * 0.87);
          ctx.lineTo(position.x + inner - 5, position.y + inner * 0.87 - cornerSize);
          ctx.stroke();
        }

        ctx.restore();
      }

      ctx.restore();
    }

    roadSegments.forEach((road, roadIndex) => {
      const from = intersectionPixel(road.from.hexes, centerX, centerY, size);
      const to = intersectionPixel(road.to.hexes, centerX, centerY, size);
      if (!from || !to) return;
      drawRoadSegment(ctx, from, to, size, roadIndex);
    });

    intersectionMarkers.forEach((marker, markerIndex) => {
      const point = intersectionPixel(marker.hexes, centerX, centerY, size);
      if (!point) return;
      drawSettlementMarker(ctx, marker, point.x, point.y, size, markerIndex % 2);
    });
  }, [hoveredKey, intersectionMarkers, roadSegments, selectedHex, sortedHexes]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const redraw = () => {
      const draw = drawRef.current;
      if (draw) draw();
    };

    const observer = new ResizeObserver(redraw);
    observer.observe(shell);
    setTragedyAssetRedrawCallback(redraw);
    preloadTragedyAssets();
    redraw();

    const handleVisibilityChange = () => {
      if (!document.hidden) redraw();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      setTragedyAssetRedrawCallback(null);
      clearPatternCache();
    };
  }, []);

  useEffect(() => {
    drawRef.current = drawBoard;
    drawBoard();
  }, [drawBoard]);

  useEffect(() => {
    let frame = 0;
    const animate = () => {
      const draw = drawRef.current;
      if (draw) draw();
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const updateHover = (clientX: number, clientY: number) => {
    const shell = shellRef.current;
    if (!shell || sortedHexes.length === 0) return;
    const rect = shell.getBoundingClientRect();
    const { centerX, centerY, size, inner } = getBoardLayout(sortedHexes, rect.width, rect.height);

    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let nextHover: string | null = null;

    for (const hex of sortedHexes) {
      const p = hexToPixel(hex.q, hex.r, centerX, centerY, size);
      const distance = Math.hypot(x - p.x, y - p.y);
      if (distance <= inner * 0.95) {
        nextHover = `${hex.q},${hex.r}`;
        break;
      }
    }

    if (nextHover !== hoveredKey) {
      setHoveredKey(nextHover);
    }
  };

  const onClick = () => {
    if (!hoveredKey) return;
    const coords = hoveredKey.split(',').map(Number);
    const q = coords[0];
    const r = coords[1];
    if (
      typeof q === 'number' &&
      Number.isFinite(q) &&
      typeof r === 'number' &&
      Number.isFinite(r)
    ) {
      setSelectedHex({ q, r });
    }
  };

  const selectedTerrain = selectedTile
    ? (TERRAIN[selectedTile.terrain as keyof typeof TERRAIN] ?? TERRAIN.forest)
    : null;
  const selectedHealth = healthPercent(selectedTile?.ecosystemHealth);
  const selectedHealthCopy = selectedTile
    ? (HEALTH_COPY[selectedTile.ecosystemStatus ?? 'stable'] ?? HEALTH_COPY.stable)
    : null;
  return (
    <div className="relative min-h-[560px] flex flex-col rounded-[18px] border border-[var(--color-line)] overflow-hidden bg-[radial-gradient(circle_at_50%_18%,rgba(221,180,105,0.12),transparent_22%),radial-gradient(circle_at_50%_50%,rgba(114,169,181,0.12),transparent_34%),linear-gradient(180deg,#08131f_0%,#0a1623_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_24px_70px_rgba(0,0,0,0.28)]">
      <button
        type="button"
        ref={shellRef}
        className="flex-1 min-h-0 block border-0 bg-transparent p-0 text-left"
        onMouseMove={(event) => updateHover(event.clientX, event.clientY)}
        onMouseLeave={() => {
          setHoveredKey(null);
        }}
        onClick={onClick}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
      </button>

      {selectedTile && selectedTerrain && selectedHealthCopy ? (
        <aside className="absolute right-5 top-5 z-10 w-[min(340px,calc(100%-2.5rem))] rounded-2xl border border-[rgba(233,220,190,0.18)] bg-[rgba(7,17,27,0.9)] p-4 text-[var(--color-text)] shadow-[0_18px_46px_rgba(0,0,0,0.45)] backdrop-blur-md">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-soft)]">
                Selected tile · q{selectedTile.q}, r{selectedTile.r}
              </div>
              <h3 className="mt-1 font-serif text-lg font-semibold">{tileTitle(selectedTile)}</h3>
            </div>
            <button
              type="button"
              className="rounded-full border border-[rgba(233,220,190,0.18)] px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={() => setSelectedHex(null)}
            >
              Close
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl border border-[rgba(233,220,190,0.1)] bg-[rgba(255,255,255,0.04)] p-3">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
                Terrain
              </div>
              <div className="mt-1 font-semibold">{titleCase(selectedTile.terrain)}</div>
            </div>
            <div className="rounded-xl border border-[rgba(233,220,190,0.1)] bg-[rgba(255,255,255,0.04)] p-3">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
                Produces
              </div>
              <div className="mt-1 font-semibold">{tileResourceFocus(selectedTile)}</div>
            </div>
            <div className="rounded-xl border border-[rgba(233,220,190,0.1)] bg-[rgba(255,255,255,0.04)] p-3">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
                Tile role
              </div>
              <div className="mt-1 font-semibold">
                {selectedTile.ecosystemIds && selectedTile.ecosystemIds.length > 0
                  ? 'Harvestable resource tile'
                  : 'Visual terrain only'}
              </div>
            </div>
            <div className="rounded-xl border border-[rgba(233,220,190,0.1)] bg-[rgba(255,255,255,0.04)] p-3">
              <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
                Adjacent structures
              </div>
              <div className="mt-1 font-semibold">
                {selectedTileMarkers.length > 0
                  ? selectedTileMarkers
                      .map((marker) => `${marker.agentId} ${structureLabel(marker.type)}`)
                      .join(', ')
                  : 'No building touches this tile'}
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-xl border border-[rgba(233,220,190,0.12)] bg-[rgba(255,255,255,0.04)] p-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
              Tile feature
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {tileFeature(selectedTile)}. Buildings sit on the shared intersections around the
              tile; roads are the lines connecting those intersections.
            </p>
          </div>

          <div className="mt-3 rounded-xl border border-[rgba(233,220,190,0.12)] bg-[rgba(255,255,255,0.04)] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
                  Ecosystem health
                </div>
                <div className="mt-1 font-semibold" style={{ color: selectedHealthCopy.tone }}>
                  {selectedHealthCopy.label}
                  {selectedHealth != null ? ` · ${selectedHealth}%` : ''}
                </div>
              </div>
              <div className="h-2 w-24 overflow-hidden rounded-full bg-[rgba(255,255,255,0.1)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${selectedHealth ?? 100}%`,
                    backgroundColor: selectedHealthCopy.tone,
                  }}
                />
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {selectedHealthCopy.explanation}
            </p>
            {selectedTile.ecosystemIds && selectedTile.ecosystemIds.length > 0 ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-text-soft)]">
                Ecosystem IDs: {selectedTile.ecosystemIds.join(', ')}
              </p>
            ) : null}
          </div>

          <div className="mt-3 rounded-xl border border-[rgba(233,220,190,0.12)] bg-[rgba(255,255,255,0.04)] p-3">
            <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
              Animation / overlay
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {visualEffectLabel(selectedTile.ecosystemStatus)}
            </p>
          </div>
        </aside>
      ) : null}

      <div className="shrink-0 flex flex-wrap gap-3 px-5 py-4 border-t border-[rgba(233,220,190,0.1)] bg-[rgba(8,16,24,0.6)]">
        {visibleTerrainLegend.map((terrain) => (
          <span
            key={terrain.label}
            className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-[rgba(10,20,31,0.7)] border border-[rgba(233,220,190,0.16)] text-[11px] text-[var(--color-text-muted)]"
          >
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{
                backgroundColor:
                  RESOURCE_PALETTE[terrain.label as keyof typeof RESOURCE_PALETTE] ?? terrain.fill,
              }}
            />
            {terrainLegendLabel(terrain.label)}
          </span>
        ))}
      </div>
    </div>
  );
}
