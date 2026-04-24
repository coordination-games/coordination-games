export const TERRAIN = {
  plains: {
    fill: '#c4a85a',
    dark: '#5c4b22',
    glow: 'rgba(217, 178, 95, 0.45)',
    highlight: 'rgba(255, 235, 180, 0.12)',
    label: 'grain',
    symbol: 'GR',
  },
  forest: {
    fill: '#5e8a4e',
    dark: '#2a4228',
    glow: 'rgba(126, 172, 115, 0.48)',
    highlight: 'rgba(160, 220, 140, 0.10)',
    label: 'timber',
    symbol: 'TI',
  },
  mountains: {
    fill: '#7870a8',
    dark: '#3a3655',
    glow: 'rgba(143, 132, 190, 0.44)',
    highlight: 'rgba(180, 170, 220, 0.12)',
    label: 'ore',
    symbol: 'OR',
  },
  rivers: {
    fill: '#4a8a8c',
    dark: '#1c4448',
    glow: 'rgba(99, 165, 167, 0.48)',
    highlight: 'rgba(140, 200, 205, 0.12)',
    label: 'energy',
    symbol: 'EN',
  },
  wasteland: {
    fill: '#7a7562',
    dark: '#2e2c24',
    glow: 'rgba(154, 152, 136, 0.20)',
    highlight: 'rgba(180, 175, 155, 0.08)',
    label: 'waste',
    symbol: 'WA',
  },
  commons: {
    fill: '#a86540',
    dark: '#522a18',
    glow: 'rgba(183, 114, 73, 0.50)',
    highlight: 'rgba(220, 160, 110, 0.12)',
    label: 'core',
    symbol: 'CO',
  },
} as const;

export const RESOURCE_PALETTE = {
  grain: '#c3a75a',
  timber: '#74a56b',
  ore: '#8a82b6',
  fish: '#63a5a7',
  water: '#7ec0cf',
  energy: '#d9b25f',
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function parseColor(color: string | undefined | null): [number, number, number] | null {
  if (typeof color !== 'string') return null;
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const value =
      hex.length === 3
        ? hex
            .split('')
            .map((piece) => piece + piece)
            .join('')
        : hex;
    const num = Number.parseInt(value, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
  }
  const match = color.match(/(\d+)[^\d]+(\d+)[^\d]+(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function lightenHex(color: string, amount: number) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const next = rgb.map((channel) => clamp(channel + amount, 0, 255));
  return `rgb(${next[0]}, ${next[1]}, ${next[2]})`;
}

export function addAlpha(color: string, alpha: number) {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
