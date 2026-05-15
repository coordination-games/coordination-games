type AssetState = 'pending' | 'loaded' | 'failed';

interface AssetRecord {
  image: HTMLImageElement;
  state: AssetState;
}

export type EcosystemVisualState = 'flourishing' | 'stable' | 'strained' | 'collapsed';

const ASSET_BASE = '/assets/tragedy';
const assetCache = new Map<string, AssetRecord>();
let redrawCallback: (() => void) | null = null;

const TERRAIN_ALIASES: Record<string, string> = {
  plains: 'plains',
  forest: 'forest',
  mountains: 'mountains',
  river: 'river',
  rivers: 'river',
  wetlands: 'wetland',
  wetland: 'wetland',
  'oil-field': 'oil-field',
  oil: 'oil-field',
  commons: 'commons',
  wasteland: 'wasteland',
};

const V2_TERRAIN_KEYS = new Set(['oil-field', 'river', 'wetland']);

const RESOURCE_ASSETS: Record<string, string> = {
  grain: `${ASSET_BASE}/icons/resources/tragedy-resource-grain.png`,
  timber: `${ASSET_BASE}/icons/resources/tragedy-resource-timber.png`,
  ore: `${ASSET_BASE}/icons/resources/tragedy-resource-ore.png`,
  fish: `${ASSET_BASE}/icons/resources/tragedy-resource-fish.png`,
  water: `${ASSET_BASE}/icons/resources/tragedy-resource-water.png`,
  energy: `${ASSET_BASE}/icons/resources/tragedy-resource-energy.png`,
};

const STRUCTURE_ASSETS: Record<string, string> = {
  commons: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-commons-tower.png`,
  energy: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-energy-turbine.png`,
  fish: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-fishing-dock.png`,
  grain: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-grain-mill.png`,
  timber: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-logging-camp.png`,
  ore: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-mine-rig.png`,
  water: `${ASSET_BASE}/tokens/extraction-structures/tragedy-structure-water-pump.png`,
};

const SETTLEMENT_ASSETS: Record<string, string> = {
  camp: `${ASSET_BASE}/tokens/settlements/tragedy-settlement-camp.png`,
  village: `${ASSET_BASE}/tokens/settlements/tragedy-settlement-village.png`,
  township: `${ASSET_BASE}/tokens/settlements/tragedy-settlement-township.png`,
  city: `${ASSET_BASE}/tokens/settlements/tragedy-settlement-city.png`,
  'solar-farm': `${ASSET_BASE}/tokens/solar/tragedy-solar-farm.png`,
  'solar-array': `${ASSET_BASE}/tokens/solar/tragedy-solar-array.png`,
};

const ROAD_ASSETS: Record<string, string> = {
  straight: `${ASSET_BASE}/tokens/roads/tragedy-road-straight-large.png`,
  curve: `${ASSET_BASE}/tokens/roads/tragedy-road-curve-medium.png`,
  terminal: `${ASSET_BASE}/tokens/roads/tragedy-road-terminal-cap-medium.png`,
};

const VFX_ASSETS: Record<string, string[]> = {
  build: framePaths('build', 'build'),
  collapse: framePaths('collapse', 'collapse'),
  extraction: framePaths('extraction', 'extraction'),
  healthDrain: framePaths('health-drain', 'health-drain'),
  warning: framePaths('over-extraction-warning', 'over-extraction-warning'),
  regeneration: framePaths('regeneration', 'regeneration'),
  redDamage: framePaths('red-damage-overlay', 'red-damage-overlay'),
  downstreamPollution: framePaths('downstream-pollution', 'downstream-pollution'),
  wetlandAbsorption: framePaths('wetland-absorption', 'wetland-absorption'),
  oilSpill: framePaths('oil-spill', 'oil-spill'),
  timberEnergy: framePaths('timber-energy-conversion', 'timber-energy-conversion'),
  tradeRoute: framePaths('trade-route', 'trade-route'),
  winner: framePaths('winner-endgame', 'winner-endgame'),
};

function framePaths(folder: string, name: string): string[] {
  return Array.from(
    { length: 6 },
    (_, index) => `${ASSET_BASE}/vfx/${folder}/tragedy-vfx-${name}-frame-${index + 1}.png`,
  );
}

function queueRedraw(): void {
  if (!redrawCallback) return;
  window.requestAnimationFrame(redrawCallback);
}

function getImage(path: string | undefined): HTMLImageElement | null {
  if (!path || typeof Image === 'undefined') return null;
  const cached = assetCache.get(path);
  if (cached) return cached.state === 'loaded' ? cached.image : null;

  const image = new Image();
  image.decoding = 'async';
  const record: AssetRecord = { image, state: 'pending' };
  assetCache.set(path, record);
  image.onload = () => {
    record.state = 'loaded';
    queueRedraw();
  };
  image.onerror = () => {
    record.state = 'failed';
  };
  image.src = path;
  return null;
}

export function setTragedyAssetRedrawCallback(callback: (() => void) | null): void {
  redrawCallback = callback;
}

export function terrainAssetKey(terrain: string | undefined): string {
  return TERRAIN_ALIASES[terrain ?? ''] ?? 'wasteland';
}

export function normalizeEcosystemState(status: string | undefined): EcosystemVisualState {
  if (status === 'flourishing' || status === 'strained' || status === 'collapsed') return status;
  return 'stable';
}

export function getTerrainImage(
  terrain: string | undefined,
  status: string | undefined,
): HTMLImageElement | null {
  const key = terrainAssetKey(terrain);
  const state = normalizeEcosystemState(status);
  if (V2_TERRAIN_KEYS.has(key)) {
    return getImage(`${ASSET_BASE}/terrain/v2-health-states/tragedy-terrain-${key}-${state}.png`);
  }
  return (
    getImage(`${ASSET_BASE}/terrain/health-states/tragedy-terrain-${key}-${state}.png`) ??
    getImage(`${ASSET_BASE}/terrain/base/tragedy-terrain-base-${key}.png`)
  );
}

export function getResourceImage(resource: string | undefined): HTMLImageElement | null {
  return getImage(RESOURCE_ASSETS[resource ?? '']);
}

export function getStructureImage(kind: string | undefined): HTMLImageElement | null {
  return getImage(STRUCTURE_ASSETS[kind ?? '']);
}

export function getSettlementImage(kind: string | undefined): HTMLImageElement | null {
  return getImage(SETTLEMENT_ASSETS[kind ?? ''] ?? SETTLEMENT_ASSETS.village);
}

export function getRoadImage(kind: string | undefined): HTMLImageElement | null {
  return getImage(ROAD_ASSETS[kind ?? ''] ?? ROAD_ASSETS.straight);
}

export function getVfxFrame(kind: string, frame: number): HTMLImageElement | null {
  const frames = VFX_ASSETS[kind];
  if (!frames || frames.length === 0) return null;
  return getImage(frames[Math.abs(frame) % frames.length]);
}

export function preloadTragedyAssets(): void {
  const terrainStates: EcosystemVisualState[] = ['flourishing', 'stable', 'strained', 'collapsed'];
  Object.values(TERRAIN_ALIASES).forEach((terrain) => {
    if (V2_TERRAIN_KEYS.has(terrain)) {
      terrainStates.forEach((state) => {
        getImage(`${ASSET_BASE}/terrain/v2-health-states/tragedy-terrain-${terrain}-${state}.png`);
      });
      return;
    }
    getImage(`${ASSET_BASE}/terrain/base/tragedy-terrain-base-${terrain}.png`);
    terrainStates.forEach((state) => {
      getImage(`${ASSET_BASE}/terrain/health-states/tragedy-terrain-${terrain}-${state}.png`);
    });
  });
  Object.values(RESOURCE_ASSETS).forEach(getImage);
  Object.values(STRUCTURE_ASSETS).forEach(getImage);
  Object.values(SETTLEMENT_ASSETS).forEach(getImage);
  Object.values(ROAD_ASSETS).forEach(getImage);
  Object.values(VFX_ASSETS).flat().forEach(getImage);
}
