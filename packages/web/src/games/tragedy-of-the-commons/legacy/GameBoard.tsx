import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addAlpha, lightenHex, RESOURCE_PALETTE, TERRAIN } from './colors';
import { drawHexPath, hexToPixel } from './hex-math';
import {
  clearPatternCache,
  drawFarmSprite,
  drawMineSprite,
  drawPortSprite,
  drawTowerSprite,
  getCachedPattern,
  getEcosystemColor,
  RESOURCE_ICONS,
} from './terrain-textures';

export interface HexTile {
  q: number;
  r: number;
  terrain: string;
  productionNumber: number;
  revealed: boolean;
  revealedBy?: string[];
  regionId?: string;
  regionName?: string;
  biome?: string;
  primaryResource?: string;
  ecosystemIds?: string[];
}

interface GameBoardProps {
  hexGrid: HexTile[];
  productionNumber: number;
}

export function GameBoard({ hexGrid, productionNumber }: GameBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLButtonElement | null>(null);
  const drawRef = useRef<(() => void) | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [selectedHex, setSelectedHex] = useState<{ q: number; r: number } | null>(null);

  const sortedHexes = useMemo(() => [...hexGrid].sort((a, b) => a.r - b.r || a.q - b.q), [hexGrid]);

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

    const centerX = rect.width / 2;
    const centerY = rect.height / 2 + 6;
    const size = Math.min(rect.width, rect.height) / 7.9;
    const inner = size * 0.92;

    for (const hex of sortedHexes) {
      const terrain = TERRAIN[hex.terrain as keyof typeof TERRAIN] ?? TERRAIN.wasteland;
      const position = hexToPixel(hex.q, hex.r, centerX, centerY, size);
      const key = `${hex.q},${hex.r}`;
      const producing =
        Number(hex.productionNumber || 0) === Number(productionNumber || -1) &&
        Number(hex.productionNumber || 0) > 0;
      const pulse = 0.55 + 0.45 * Math.sin(now / 420 + (hex.q + hex.r) * 0.3);
      const selected = selectedHex?.q === hex.q && selectedHex?.r === hex.r;
      const hovered = hoveredKey === key;
      const hexSeed = `${hex.q},${hex.r}`;

      ctx.save();
      drawHexPath(ctx, position.x, position.y + 5, inner);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fill();

      drawHexPath(ctx, position.x, position.y, inner);
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

      if (hex.ecosystemIds && hex.ecosystemIds.length > 0) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner);
        ctx.clip();
        ctx.fillStyle = getEcosystemColor(hex.ecosystemIds[0]?.charCodeAt(0) ?? 0);
        ctx.globalCompositeOperation = 'overlay';
        ctx.fill();
        ctx.restore();
      }

      const glowAlpha = producing ? 0.28 + 0.12 * pulse : hovered ? 0.18 : 0.06;
      drawHexPath(ctx, position.x, position.y, inner);
      ctx.fillStyle = terrain.glow;
      ctx.globalAlpha = glowAlpha;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (hex.primaryResource) {
        const spriteSize = size * 0.35;
        const spriteY = position.y + size * 0.08;
        switch (hex.terrain) {
          case 'plains':
            drawFarmSprite(ctx, position.x, spriteY, spriteSize, terrain.fill);
            break;
          case 'mountains':
            drawMineSprite(ctx, position.x, spriteY, spriteSize);
            break;
          case 'rivers':
            drawPortSprite(ctx, position.x, spriteY, spriteSize);
            break;
          case 'commons':
            drawTowerSprite(ctx, position.x, spriteY, spriteSize, terrain.fill);
            break;
        }
      }

      drawHexPath(ctx, position.x, position.y, inner + 3);
      ctx.strokeStyle = lightenHex(terrain.fill, 50);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (producing || hovered || selected) {
        ctx.save();
        drawHexPath(ctx, position.x, position.y, inner + 5);
        ctx.strokeStyle = selected
          ? addAlpha(terrain.fill, 0.92)
          : addAlpha(terrain.fill, 0.5 + pulse * 0.18);
        ctx.lineWidth = selected ? 5 : 4.5;
        ctx.shadowColor = terrain.fill;
        ctx.shadowBlur = selected ? 32 : 28 * pulse;
        ctx.stroke();
        ctx.restore();
      }

      drawHexPath(ctx, position.x, position.y, inner);
      ctx.strokeStyle = lightenHex(terrain.fill, 45);
      ctx.lineWidth = hovered ? 3 : 2.4;
      ctx.stroke();

      ctx.fillStyle = 'rgba(252, 244, 225, 0.75)';
      ctx.font = `700 ${size * 0.115}px SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(terrain.symbol, position.x, position.y - size * 0.17);

      ctx.save();
      ctx.fillStyle = 'rgba(247, 238, 220, 0.68)';
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 8;
      ctx.font = `600 ${size * 0.088}px SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.fillText(
        (hex.regionName || terrain.label).toUpperCase(),
        position.x,
        position.y + size * 0.21,
      );
      ctx.restore();

      if (Number(hex.productionNumber || 0) > 0 && hex.terrain !== 'wasteland') {
        const badgeY = position.y - inner * 0.52;
        const badgeRadius = size * 0.18;
        ctx.beginPath();
        ctx.arc(position.x + 2, badgeY + 2, badgeRadius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
        const badgeGrad = ctx.createRadialGradient(
          position.x - badgeRadius * 0.3,
          badgeY - badgeRadius * 0.3,
          0,
          position.x,
          badgeY,
          badgeRadius,
        );
        if (producing) {
          badgeGrad.addColorStop(0, '#fcf4e1');
          badgeGrad.addColorStop(0.5, '#e8d4a0');
          badgeGrad.addColorStop(1, '#c4a85a');
        } else {
          badgeGrad.addColorStop(0, '#1a1a1a');
          badgeGrad.addColorStop(1, '#0d0d0d');
        }
        ctx.fillStyle = badgeGrad;
        ctx.beginPath();
        ctx.arc(position.x, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = producing ? addAlpha('#ddb469', 0.9) : 'rgba(252, 244, 225, 0.25)';
        ctx.lineWidth = producing ? 2.5 : 1.5;
        ctx.stroke();
        ctx.fillStyle = producing ? '#1a1510' : 'rgba(247,238,220,0.85)';
        ctx.font = `800 ${size * 0.16}px SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
        ctx.fillText(String(hex.productionNumber), position.x, badgeY);
      }

      if (hex.primaryResource) {
        const iconSize = size * 0.12;
        const iconOffset = size * 0.55;
        const iconFn = RESOURCE_ICONS[hex.primaryResource] ?? RESOURCE_ICONS.grain;
        for (const pos of [
          { x: position.x - iconOffset, y: position.y },
          { x: position.x + iconOffset, y: position.y },
        ]) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, iconSize * 0.8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(8, 16, 24, 0.7)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(233, 220, 190, 0.2)';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
          iconFn?.(ctx, pos.x, pos.y, iconSize);
        }
      }

      ctx.restore();
    }
  }, [hoveredKey, productionNumber, selectedHex, sortedHexes]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const redraw = () => drawRef.current?.();
    const observer = new ResizeObserver(redraw);
    observer.observe(shell);
    redraw();
    const handleVisibilityChange = () => {
      if (!document.hidden) redraw();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearPatternCache();
    };
  }, []);

  useEffect(() => {
    drawRef.current = drawBoard;
    drawBoard();
  }, [drawBoard]);

  const updateHover = (clientX: number, clientY: number) => {
    const shell = shellRef.current;
    if (!shell || sortedHexes.length === 0) return;
    const rect = shell.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2 + 6;
    const size = Math.min(rect.width, rect.height) / 7.9;
    const inner = size * 0.92;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let nextHover: string | null = null;
    for (const hex of sortedHexes) {
      const p = hexToPixel(hex.q, hex.r, centerX, centerY, size);
      if (Math.hypot(x - p.x, y - p.y) <= inner * 0.95) {
        nextHover = `${hex.q},${hex.r}`;
        break;
      }
    }
    if (nextHover !== hoveredKey) setHoveredKey(nextHover);
  };

  const onClick = () => {
    if (!hoveredKey) return;
    const [qRaw, rRaw] = hoveredKey.split(',').map(Number);
    const q = qRaw ?? Number.NaN;
    const r = rRaw ?? Number.NaN;
    if (Number.isFinite(q) && Number.isFinite(r)) setSelectedHex({ q, r });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div className="relative flex min-h-[560px] flex-col overflow-hidden rounded-[18px] border border-[var(--color-line)] bg-[radial-gradient(circle_at_50%_18%,rgba(221,180,105,0.12),transparent_22%),radial-gradient(circle_at_50%_50%,rgba(114,169,181,0.12),transparent_34%),linear-gradient(180deg,#08131f_0%,#0a1623_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_24px_70px_rgba(0,0,0,0.28)]">
      <button
        type="button"
        ref={shellRef}
        className="min-h-0 flex-1 cursor-crosshair border-0 bg-transparent p-0 text-left"
        onMouseMove={(event) => updateHover(event.clientX, event.clientY)}
        onMouseLeave={() => setHoveredKey(null)}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </button>

      <div className="flex shrink-0 flex-wrap gap-3 border-t border-[rgba(233,220,190,0.1)] bg-[rgba(8,16,24,0.6)] px-5 py-4">
        {Object.values(TERRAIN).map((terrain) => (
          <span
            key={terrain.label}
            className="inline-flex items-center gap-2 rounded-full border border-[rgba(233,220,190,0.16)] bg-[rgba(10,20,31,0.7)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)]"
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{
                backgroundColor:
                  RESOURCE_PALETTE[terrain.label as keyof typeof RESOURCE_PALETTE] ?? terrain.fill,
              }}
            />
            {terrain.label}
          </span>
        ))}
      </div>
    </div>
  );
}
