import { type CSSProperties, useEffect, useMemo } from 'react';
import { ChatFeed } from './components/ChatFeed';
import { CommitmentLedger } from './components/CommitmentLedger';
import { CrisisBanner } from './components/CrisisBanner';
import { GameBoard } from './components/GameBoard';
import { PowerTable } from './components/PowerTable';
import { TopBar } from './components/TopBar';
import { TrustGraph } from './components/TrustGraph';
import { WorldHealthSidebar } from './components/WorldHealthSidebar';
import { AGENT_COLORS } from './lib/colors';
import { cleanAgentDisplayName } from './lib/format';
import {
  type AgentIdentity,
  type AgentParticipationReadiness,
  type AgentState,
  type Attestation,
  type AttestationReadiness,
  type ChatMessage,
  type Commitment,
  type GameState,
  type HexTile,
  initialGameState,
  type ResolvedActionSummary,
  type TrustCard,
  type TrustEvidenceRef,
  type TrustSignal,
  useGameStore,
  type VisibleBehaviorTag,
} from './store';

type ResourceType = 'grain' | 'timber' | 'ore' | 'fish' | 'water' | 'energy';

interface ResourceInventory extends Record<string, number> {
  grain: number;
  timber: number;
  ore: number;
  fish: number;
  water: number;
  energy: number;
}

interface CommonsPlayer {
  id: string;
  resources: ResourceInventory;
  influence: number;
  vp: number;
  totalResources: number;
  regionsControlled: string[];
  ownedStructureIds: string[];
  ownedRoadIds: string[];
  structureLocations?: AgentState['structureLocations'];
  roadLocations?: AgentState['roadLocations'];
}

interface CommonsRegion {
  id: string;
  name: string;
  primaryResource: ResourceType;
  secondaryResources: ResourceType[];
  ecosystemIds: string[];
}

interface CommonsBoardTile {
  id?: string;
  q: number;
  r: number;
  terrain: string;
  productionNumber: number;
  revealed: boolean;
  revealedBy: string[];
  regionId?: string;
  regionName?: string;
  primaryResource?: string;
  ecosystemIds?: string[];
  health?: number;
  maxHealth?: number;
  status?: string;
}

interface CommonsEcosystem {
  id: string;
  name: string;
  kind: string;
  resource: ResourceType;
  regionIds: string[];
  health: number;
  maxHealth: number;
  status: string;
}

interface CommonsResolvedAction {
  playerId: string;
  type: string;
  level?: string;
  ecosystemId?: string;
  regionId?: string;
  tileId?: string;
  resource?: string;
  intersectionId?: string;
  structureId?: string;
  structureType?: string;
  fromIntersectionId?: string;
  toIntersectionId?: string;
}

interface ObservatoryProps {
  gameId: string;
  source: unknown;
  handles: Record<string, string>;
  isLive: boolean;
}

const RESOURCE_TYPES: readonly ResourceType[] = [
  'grain',
  'timber',
  'ore',
  'fish',
  'water',
  'energy',
];

const EMPTY_RESOURCES: ResourceInventory = {
  grain: 0,
  timber: 0,
  ore: 0,
  fish: 0,
  water: 0,
  energy: 0,
};

const DEFAULT_PRODUCTION_WHEEL = [5, 8, 10, 6, 11, 9, 4, 3, 12, 2, 5, 8, 10, 6, 11, 9, 4, 3, 12];

const OBSERVATORY_STYLE = {
  '--color-bg': '#07111b',
  '--color-bg-soft': '#0c1a28',
  '--color-bg-panel': 'rgba(9, 20, 31, 0.82)',
  '--color-bg-panel-strong': 'rgba(12, 24, 37, 0.92)',
  '--color-bg-panel-alt': 'rgba(18, 30, 44, 0.88)',
  '--color-line': 'rgba(239, 223, 192, 0.13)',
  '--color-line-strong': 'rgba(239, 223, 192, 0.24)',
  '--color-text': '#f2e4c7',
  '--color-text-muted': '#c4b59a',
  '--color-text-soft': '#8f8474',
  '--color-gold': '#ddb469',
  '--color-moss': '#7f9e73',
  '--color-sea': '#72a9b5',
  '--color-clay': '#ba7357',
  '--color-rose': '#d47c61',
  '--color-ash': '#90979f',
  '--color-violet': '#8b83ae',
  '--shadow': '0 28px 90px rgba(0, 0, 0, 0.42)',
  '--radius-xl': '26px',
  '--radius-lg': '18px',
  '--radius-md': '14px',
  '--radius-sm': '10px',
  '--mono': 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  '--serif': 'Baskerville, Iowan Old Style, Palatino Linotype, Book Antiqua, Georgia, serif',
  '--sans': 'Avenir Next, Gill Sans, Segoe UI, sans-serif',
} as CSSProperties;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resourceType(value: unknown, fallback: ResourceType = 'grain'): ResourceType {
  return RESOURCE_TYPES.includes(value as ResourceType) ? (value as ResourceType) : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseTrustEvidenceRef(value: unknown): TrustEvidenceRef | null {
  if (!isRecord(value)) return null;
  const kind = text(value.kind);
  const id = text(value.id);
  const visibility = text(value.visibility);
  if (!kind || !id || (visibility !== 'public' && visibility !== 'viewer-visible')) return null;
  const ref: TrustEvidenceRef = { kind, id, visibility };
  if (typeof value.round === 'number' && Number.isFinite(value.round)) ref.round = value.round;
  if (typeof value.relayIndex === 'number' && Number.isFinite(value.relayIndex)) {
    ref.relayIndex = value.relayIndex;
  }
  const summary = text(value.summary);
  if (summary) ref.summary = summary;
  return ref;
}

function parseTrustSignal(value: unknown): TrustSignal | null {
  if (!isRecord(value)) return null;
  const label = text(value.label);
  const stance = text(value.stance);
  const summary = text(value.summary);
  if (!label || !summary) return null;
  if (
    stance !== 'positive' &&
    stance !== 'negative' &&
    stance !== 'informational' &&
    stance !== 'unknown'
  ) {
    return null;
  }
  const refs = Array.isArray(value.evidenceRefs)
    ? value.evidenceRefs
        .map(parseTrustEvidenceRef)
        .filter((ref): ref is TrustEvidenceRef => Boolean(ref))
    : [];
  const signal: TrustSignal = { label, stance, summary };
  if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) {
    signal.confidence = value.confidence;
  }
  if (refs.length > 0) signal.evidenceRefs = refs;
  return signal;
}

function parseTrustCard(value: unknown): TrustCard | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 'trust-card/v1') return null;
  const agentId = text(value.agentId);
  const subjectId = text(value.subjectId, agentId);
  const headline = text(value.headline);
  const summary = text(value.summary);
  if (!agentId || !subjectId || !headline || !summary) return null;
  const signals = Array.isArray(value.signals)
    ? value.signals.map(parseTrustSignal).filter((signal): signal is TrustSignal => Boolean(signal))
    : [];
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? value.evidenceRefs
        .map(parseTrustEvidenceRef)
        .filter((ref): ref is TrustEvidenceRef => Boolean(ref))
    : [];
  const card: TrustCard = {
    schemaVersion: 'trust-card/v1',
    agentId,
    subjectId,
    headline,
    summary,
    signals,
    caveats: stringArray(value.caveats),
    evidenceRefs,
  };
  if (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)) {
    card.updatedAt = value.updatedAt;
  }
  return card;
}

function parseTrustCards(value: unknown): TrustCard[] {
  return Array.isArray(value)
    ? value.map(parseTrustCard).filter((card): card is TrustCard => Boolean(card))
    : [];
}

function resourceArray(value: unknown): ResourceType[] {
  return Array.isArray(value)
    ? value.filter((item): item is ResourceType => RESOURCE_TYPES.includes(item as ResourceType))
    : [];
}

function parseResources(value: unknown): ResourceInventory {
  if (!isRecord(value)) return { ...EMPTY_RESOURCES };
  return {
    grain: numberValue(value.grain),
    timber: numberValue(value.timber),
    ore: numberValue(value.ore),
    fish: numberValue(value.fish),
    water: numberValue(value.water),
    energy: numberValue(value.energy),
  };
}

function totalResources(resources: ResourceInventory): number {
  return RESOURCE_TYPES.reduce((total, resource) => total + resources[resource], 0);
}

function parseHandles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function parsePlayer(value: unknown): CommonsPlayer | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const resources = parseResources(value.resources);
  const structureLocations =
    parseStructureLocations(value.structureLocations) ?? parseV2StructureLocations(value);
  const roadLocations = parseRoadLocations(value.roadLocations) ?? parseV2RoadLocations(value);
  return {
    id,
    resources,
    influence: numberValue(value.influence),
    vp: numberValue(value.vp),
    totalResources: numberValue(value.totalResources, totalResources(resources)),
    regionsControlled: stringArray(value.regionsControlled),
    ownedStructureIds: stringArray(value.ownedStructureIds),
    ownedRoadIds: stringArray(value.ownedRoadIds),
    structureLocations,
    roadLocations,
  };
}

function parseHexList(value: unknown): Array<{ q: number; r: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((hex) => {
    if (!isRecord(hex)) return [];
    const q = numberValue(hex.q, Number.NaN);
    const r = numberValue(hex.r, Number.NaN);
    return Number.isFinite(q) && Number.isFinite(r) ? [{ q, r }] : [];
  });
}

function parseStructureLocations(value: unknown): AgentState['structureLocations'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = text(item.type);
    const hexes = parseHexList(item.hexes);
    if (!type || hexes.length === 0) return [];
    return [{ type, hexes }];
  });
}

function intersectionHexMap(value: unknown): Map<string, Array<{ q: number; r: number }>> {
  return new Map(
    recordArray(value).flatMap((intersection) => {
      const id = text(intersection.id);
      const hexes = parseHexList(intersection.hexes);
      return id && hexes.length > 0 ? [[id, hexes] as const] : [];
    }),
  );
}

function parseV2StructureLocations(
  player: Record<string, unknown>,
): AgentState['structureLocations'] {
  const playerId = text(player.id);
  const ownedIds = new Set(stringArray(player.ownedStructureIds));
  const hexesByIntersection = intersectionHexMap(player.intersections);
  const locations = recordArray(player.structures).flatMap((structure) => {
    const structureId = text(structure.id);
    const ownerId = text(structure.ownerId);
    if (ownerId !== playerId && !ownedIds.has(structureId)) return [];
    const type = text(structure.type);
    const hexes =
      hexesByIntersection.get(text(structure.intersectionId)) ?? parseHexList(structure.hexes);
    return type && hexes.length > 0 ? [{ type, hexes }] : [];
  });
  return locations.length > 0 ? locations : undefined;
}

function parseRoadLocations(value: unknown): AgentState['roadLocations'] {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const from = isRecord(item.from) ? parseHexList(item.from.hexes) : [];
    const to = isRecord(item.to) ? parseHexList(item.to.hexes) : [];
    if (from.length === 0 || to.length === 0) return [];
    const road: NonNullable<AgentState['roadLocations']>[number] = {
      from: { hexes: from },
      to: { hexes: to },
    };
    const type = text(item.type);
    const regionIds = stringArray(item.regionIds);
    if (type) road.type = type;
    if (regionIds.length > 0) road.regionIds = regionIds;
    return [road];
  });
}

function parseV2RoadLocations(player: Record<string, unknown>): AgentState['roadLocations'] {
  const playerId = text(player.id);
  const ownedIds = new Set(stringArray(player.ownedRoadIds));
  const hexesByIntersection = intersectionHexMap(player.intersections);
  const locations = recordArray(player.roads).flatMap((road) => {
    const roadId = text(road.id);
    const ownerId = text(road.ownerId);
    if (ownerId !== playerId && !ownedIds.has(roadId)) return [];
    const from = hexesByIntersection.get(text(road.fromIntersectionId)) ?? [];
    const to = hexesByIntersection.get(text(road.toIntersectionId)) ?? [];
    if (from.length === 0 || to.length === 0) return [];
    const location: NonNullable<AgentState['roadLocations']>[number] = {
      from: { hexes: from },
      to: { hexes: to },
    };
    const type = text(road.type);
    if (type) location.type = type;
    return [location];
  });
  return locations.length > 0 ? locations : undefined;
}

function parseRegion(value: unknown): CommonsRegion | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  return {
    id,
    name: text(value.name, id),
    primaryResource: resourceType(value.primaryResource),
    secondaryResources: resourceArray(value.secondaryResources),
    ecosystemIds: stringArray(value.ecosystemIds),
  };
}

function parseEcosystem(value: unknown): CommonsEcosystem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  return {
    id,
    name: text(value.name, id),
    kind: text(value.kind, 'river'),
    resource: resourceType(value.resource),
    regionIds: stringArray(value.regionIds),
    health: numberValue(value.health, 100),
    maxHealth: numberValue(value.maxHealth, 100),
    status: text(value.status, 'stable'),
  };
}

function parseBoardTile(value: unknown): CommonsBoardTile | null {
  if (!isRecord(value)) return null;
  const q = numberValue(value.q, Number.NaN);
  const r = numberValue(value.r, Number.NaN);
  if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
  const regionId = text(value.regionId);
  const regionName = text(value.regionName);
  const primaryResource = text(value.primaryResource);
  const ecosystemIds = stringArray(value.ecosystemIds);
  const health = numberValue(value.health, Number.NaN);
  const maxHealth = numberValue(value.maxHealth, Number.NaN);
  const status = text(value.status);
  return {
    ...(text(value.id) ? { id: text(value.id) } : {}),
    q,
    r,
    terrain: text(value.terrain, 'forest'),
    productionNumber: numberValue(value.productionNumber),
    revealed: value.revealed !== false,
    revealedBy: stringArray(value.revealedBy),
    ...(regionId ? { regionId } : {}),
    ...(regionName ? { regionName } : {}),
    ...(primaryResource ? { primaryResource } : {}),
    ...(ecosystemIds.length > 0 ? { ecosystemIds } : {}),
    ...(Number.isFinite(health) ? { health } : {}),
    ...(Number.isFinite(maxHealth) ? { maxHealth } : {}),
    ...(status ? { status } : {}),
  };
}

function parseResolvedAction(value: unknown): CommonsResolvedAction | null {
  if (!isRecord(value)) return null;
  const playerId = text(value.playerId);
  const action = isRecord(value.action) ? value.action : null;
  const type = action ? text(action.type) : '';
  if (!playerId || !type) return null;
  const resolved: CommonsResolvedAction = { playerId, type };
  if (action) {
    const level = text(action.level);
    const ecosystemId = text(action.ecosystemId);
    const regionId = text(action.regionId);
    const tileId = text(action.tileId);
    const resource = text(action.resource);
    const intersectionId = text(action.intersectionId);
    const structureId = text(action.structureId);
    const structureType = text(action.structureType);
    const fromIntersectionId = text(action.fromIntersectionId);
    const toIntersectionId = text(action.toIntersectionId);
    if (level) resolved.level = level;
    if (ecosystemId) resolved.ecosystemId = ecosystemId;
    if (regionId) resolved.regionId = regionId;
    if (tileId) resolved.tileId = tileId;
    if (resource) resolved.resource = resource;
    if (intersectionId) resolved.intersectionId = intersectionId;
    if (structureId) resolved.structureId = structureId;
    if (structureType) resolved.structureType = structureType;
    if (fromIntersectionId) resolved.fromIntersectionId = fromIntersectionId;
    if (toIntersectionId) resolved.toIntersectionId = toIntersectionId;
  }
  return resolved;
}

function extractPayload(source: unknown) {
  if (!isRecord(source)) return null;
  const state = source.type === 'state_update' ? source.state : (source.data ?? source);
  if (!isRecord(state)) return null;
  const meta = isRecord(source.meta) ? source.meta : {};
  return {
    state,
    meta,
    relay: Array.isArray(source.relay) ? source.relay : [],
  };
}

function buildHexGrid(
  boardTiles: CommonsBoardTile[],
  ecosystemById: Map<string, CommonsEcosystem>,
): HexTile[] {
  return boardTiles.map((tile) => {
    const maxHealth = tile.maxHealth ?? 100;
    const health = tile.health;
    const tileHealth =
      typeof health === 'number' && Number.isFinite(health)
        ? Math.max(0, Math.min(1, health / maxHealth))
        : undefined;
    return {
      q: tile.q,
      r: tile.r,
      terrain: tile.terrain,
      productionNumber: tile.productionNumber,
      revealed: tile.revealed,
      revealedBy: tile.revealedBy,
      ...(tile.regionId ? { regionId: tile.regionId } : {}),
      ...(tile.regionName ? { regionName: tile.regionName } : {}),
      ...(tile.primaryResource ? { primaryResource: tile.primaryResource } : {}),
      ...(tile.ecosystemIds ? { ecosystemIds: tile.ecosystemIds } : {}),
      ...ecosystemVisualState(tile.ecosystemIds ?? [], ecosystemById),
      ...(tileHealth != null ? { ecosystemHealth: tileHealth } : {}),
      ...(tile.status ? { ecosystemStatus: tile.status } : {}),
      ...(tile.primaryResource ? { ecosystemResource: tile.primaryResource } : {}),
    };
  });
}

function ecosystemVisualState(
  ecosystemIds: string[],
  ecosystemById: Map<string, CommonsEcosystem>,
): Pick<HexTile, 'ecosystemHealth' | 'ecosystemStatus' | 'ecosystemResource' | 'ecosystemName'> {
  const ecosystems = ecosystemIds
    .map((id) => ecosystemById.get(id))
    .filter((ecosystem): ecosystem is CommonsEcosystem => Boolean(ecosystem));
  if (ecosystems.length === 0) return {};
  const weakest = ecosystems
    .slice()
    .sort((left, right) => healthPercent(left) - healthPercent(right))[0];
  if (!weakest) return {};
  return {
    ecosystemHealth: healthPercent(weakest) / 100,
    ecosystemStatus: weakest.status,
    ecosystemResource: weakest.resource,
    ecosystemName: weakest.name,
  };
}

function healthPercent(ecosystem: CommonsEcosystem): number {
  const max = ecosystem.maxHealth || 100;
  return Math.round(Math.max(0, Math.min(100, (ecosystem.health / max) * 100)));
}

function commonsScore(ecosystems: CommonsEcosystem[]): number {
  if (ecosystems.length === 0) return 100;
  const total = ecosystems.reduce((sum, ecosystem) => sum + healthPercent(ecosystem), 0);
  return Math.round(total / ecosystems.length);
}

function pseudoWallet(agentId: string): string {
  const chars = Array.from(agentId);
  const hex = chars
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(40, '0')
    .slice(0, 40);
  return `0x${hex}`;
}

function actionStewardshipDelta(action: CommonsResolvedAction | undefined): number {
  if (!action) return 0;
  if (action.type === 'extract_commons' || action.type === 'extract_tile') {
    if (action.level === 'high') return -0.24;
    if (action.level === 'medium') return -0.08;
    return 0.16;
  }
  if (
    action.type === 'offer_trade' ||
    action.type === 'build_settlement' ||
    action.type === 'build_structure' ||
    action.type === 'build_road' ||
    action.type === 'upgrade_structure' ||
    action.type === 'convert_timber_to_energy'
  )
    return 0.08;
  if (action.type === 'pass') return 0.04;
  return 0;
}

function describeResolvedAction(
  action: CommonsResolvedAction,
  ecosystems: CommonsEcosystem[],
): string {
  if (action.type === 'extract_commons') {
    const ecosystem = ecosystems.find((item) => item.id === action.ecosystemId);
    const target = ecosystem?.name ?? action.ecosystemId ?? 'the commons';
    return `${action.level ?? 'unknown'} extraction from ${target}`;
  }
  if (action.type === 'extract_tile') {
    const resource = action.resource ? `${action.resource} ` : '';
    return `${action.level ?? 'unknown'} extraction of ${resource}from ${action.tileId ?? 'a tile'}`;
  }
  if (action.type === 'build_settlement') return `built toward ${action.regionId ?? 'a region'}`;
  if (action.type === 'build_structure') {
    return `built ${action.structureType ?? 'structure'} at ${action.intersectionId ?? 'an intersection'}`;
  }
  if (action.type === 'upgrade_structure') return `upgraded ${action.structureId ?? 'a structure'}`;
  if (action.type === 'build_road') {
    return `built road ${action.fromIntersectionId ?? 'from an intersection'} → ${action.toIntersectionId ?? 'to an intersection'}`;
  }
  if (action.type === 'convert_timber_to_energy') return 'converted timber into energy';
  if (action.type === 'offer_trade') return 'offered a resource trade';
  if (action.type === 'pass') return 'passed / rested the commons';
  return action.type.replace(/_/g, ' ');
}

function summarizeResolvedActions(
  actions: CommonsResolvedAction[],
  ecosystems: CommonsEcosystem[],
): ResolvedActionSummary[] {
  return actions.map((action) => ({
    playerId: action.playerId,
    type: action.type,
    ...(action.level ? { level: action.level } : {}),
    ...(action.ecosystemId ? { ecosystemId: action.ecosystemId } : {}),
    ...(action.regionId ? { regionId: action.regionId } : {}),
    ...(action.tileId ? { tileId: action.tileId } : {}),
    ...(action.resource ? { resource: action.resource } : {}),
    ...(action.intersectionId ? { intersectionId: action.intersectionId } : {}),
    ...(action.structureId ? { structureId: action.structureId } : {}),
    ...(action.fromIntersectionId ? { fromIntersectionId: action.fromIntersectionId } : {}),
    ...(action.toIntersectionId ? { toIntersectionId: action.toIntersectionId } : {}),
    description: describeResolvedAction(action, ecosystems),
  }));
}

function buildAgents(
  players: CommonsPlayer[],
  regions: CommonsRegion[],
  handles: Record<string, string>,
  tileByRegionId: Map<string, CommonsBoardTile>,
  lastActionByPlayer: Map<string, CommonsResolvedAction>,
): Record<string, AgentState> {
  const regionById = new Map(regions.map((region) => [region.id, region]));
  return Object.fromEntries(
    players.map((player, index) => {
      const displayName = cleanAgentDisplayName(handles[player.id] ?? `Player ${index + 1}`);
      const lastAction = lastActionByPlayer.get(player.id);
      const trust = Math.max(
        0,
        Math.min(1, 0.5 + player.influence * 0.06 + actionStewardshipDelta(lastAction)),
      );
      const locations =
        player.structureLocations ??
        player.regionsControlled.flatMap((regionId) => {
          const tile = tileByRegionId.get(regionId);
          if (!tile) return [];
          return [
            {
              type: 'village',
              hexes: [{ q: tile.q, r: tile.r }],
              regionId,
              regionIds: [regionId],
            },
          ];
        });
      const roadCount =
        player.roadLocations?.length ?? Math.max(0, player.regionsControlled.length - 1);
      const solarCount = locations.filter(
        (location) => location.type === 'solar-farm' || location.type === 'solar-array',
      ).length;
      const settlementCount = Math.max(0, locations.length - solarCount);
      const agent: AgentState = {
        id: player.id,
        name: displayName,
        strategy:
          locations[0]?.type != null
            ? `${locations[0].type.replace(/-/g, ' ')} network`
            : (regionById.get(player.regionsControlled[0] ?? '')?.name ?? 'commons steward'),
        color: AGENT_COLORS[index % AGENT_COLORS.length] ?? AGENT_COLORS[0] ?? '#ddb469',
        resources: player.resources,
        vp: player.vp,
        influence: player.influence,
        trust,
        longestRoad: roadCount,
        structures: {
          villages: Math.max(1, settlementCount),
          townships: Math.floor(player.vp / 3),
          cities: Math.floor(player.vp / 5),
          beacons: player.influence,
          tradePosts: solarCount || (player.totalResources > 8 ? 1 : 0),
          roads: roadCount,
        },
        structureLocations: locations,
      };
      if (player.roadLocations) agent.roadLocations = player.roadLocations;
      return [player.id, agent];
    }),
  );
}

function buildTrustMatrix(
  players: CommonsPlayer[],
  lastActionByPlayer: Map<string, CommonsResolvedAction>,
): { agents: string[]; matrix: number[][] } | null {
  if (players.length === 0) return null;
  const maxInfluence = Math.max(1, ...players.map((player) => player.influence));
  const maxVp = Math.max(1, ...players.map((player) => player.vp));
  const agents = players.map((player) => player.id);
  const matrix = players.map((viewer) =>
    players.map((target) => {
      if (viewer.id === target.id) return 1;
      const cooperation = target.influence / maxInfluence;
      const visibleSuccess = target.vp / maxVp;
      const scarcityPenalty = Math.max(0, 1 - target.totalResources / 14) * 0.18;
      const actionDelta = actionStewardshipDelta(lastActionByPlayer.get(target.id));
      return Math.max(
        0.05,
        Math.min(
          0.95,
          0.35 + cooperation * 0.34 + visibleSuccess * 0.14 - scarcityPenalty + actionDelta,
        ),
      );
    }),
  );
  return { agents, matrix };
}

function buildBehaviorTags(
  players: CommonsPlayer[],
  ecosystems: CommonsEcosystem[],
  lastActionByPlayer: Map<string, CommonsResolvedAction>,
  round: number,
): VisibleBehaviorTag[] {
  const weakest = ecosystems
    .slice()
    .sort((left, right) => healthPercent(left) - healthPercent(right))[0];
  return players.flatMap((player) => {
    if (!weakest) return [];
    const lastAction = lastActionByPlayer.get(player.id);
    const isExtraction =
      lastAction?.type === 'extract_commons' || lastAction?.type === 'extract_tile';
    const highExtraction = isExtraction && lastAction?.level === 'high';
    const mediumExtraction = isExtraction && lastAction?.level === 'medium';
    const lowExtraction = isExtraction && lastAction?.level === 'low';
    const cooperative = lowExtraction || lastAction?.type === 'pass' || player.influence > 0;
    return [
      {
        id: `${player.id}-round-${round}-commons-signal`,
        round,
        actor: player.id,
        kind: highExtraction || mediumExtraction ? 'extractive' : 'stewardship',
        severity: highExtraction
          ? 'high'
          : mediumExtraction
            ? 'medium'
            : cooperative
              ? 'positive'
              : 'low',
        description: cooperative
          ? `${describeResolvedAction(lastAction ?? { playerId: player.id, type: 'pass' }, ecosystems)}; restraint supports ${weakest.name}.`
          : `${describeResolvedAction(lastAction ?? { playerId: player.id, type: 'pass' }, ecosystems)} while ${weakest.name} is under pressure.`,
      },
    ];
  });
}

function relayToMessage(
  relay: unknown,
  fallbackRound: number,
  fallbackPhase: string,
): ChatMessage | null {
  if (!isRecord(relay)) return null;
  if (text(relay.type) !== 'messaging') return null;
  const data = isRecord(relay.data) ? relay.data : {};
  const nestedMessage = isRecord(data.message) ? data.message : {};
  const content =
    text(nestedMessage.content) || text(data.body) || text(data.content) || text(data.text);
  if (!content) return null;
  const scope = isRecord(relay.scope) ? relay.scope : {};
  const kind = isRecord(relay.scope) ? text(scope.kind, 'all') : text(relay.scope, 'all');
  const recipient = text(scope.recipientHandle) || text(nestedMessage.recipient);
  const sender = text(nestedMessage.sender, text(data.sender, text(relay.sender, 'table')));
  if (sender === 'system') return null;
  const withoutDmPrefix = recipient
    ? content.replace(
        new RegExp(`^DM to ${recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`),
        '',
      )
    : content;
  const cleanContent = withoutDmPrefix.replace(
    new RegExp(`^${sender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`),
    '',
  );
  return {
    id: `relay-${numberValue(relay.index, Date.now())}`,
    sender,
    ...(recipient ? { recipient } : {}),
    content: cleanContent,
    type: kind === 'dm' ? 'private' : 'public',
    round: numberValue(relay.turn, fallbackRound),
    phase: fallbackPhase,
    timestamp: numberValue(relay.timestamp, Date.now()),
  };
}

function buildCommitments(
  players: CommonsPlayer[],
  activeTrades: unknown[],
  round: number,
  _handles: Record<string, string>,
): Commitment[] {
  const tradeCommitments = activeTrades.flatMap((trade, index) => {
    if (!isRecord(trade)) return [];
    return [
      {
        id: `trade-${round}-${index + 1}`,
        type: 'trade_offer',
        promisor: players[index % Math.max(1, players.length)]?.id ?? 'commons-table',
        counterparties: text(trade.to) ? [text(trade.to)] : [],
        resolutionStatus: 'pending',
        summary: 'Open resource exchange visible in Lucian spectator state.',
        dueByRound: round + 1,
      },
    ];
  });
  if (tradeCommitments.length > 0) return tradeCommitments;
  return [];
}

function buildAttestations(commitments: Commitment[], round: number): Attestation[] {
  return commitments.slice(0, 10).map((commitment, index) => ({
    id: `attestation-${commitment.id}`,
    commitmentId: commitment.id,
    actor: commitment.promisor ?? 'observatory',
    phase: `round_${round}`,
    verdict:
      commitment.resolutionStatus === 'fulfilled'
        ? 'fulfilled'
        : index % 3 === 0
          ? 'pending'
          : 'attested',
    weight: commitment.resolutionStatus === 'fulfilled' ? 1 : 0.5,
  }));
}

function buildIdentities(
  players: CommonsPlayer[],
  handles: Record<string, string>,
  gameId: string,
): Record<string, AgentIdentity> {
  return Object.fromEntries(
    players.map((player, index) => [
      player.id,
      {
        agentId: player.id,
        walletAddress: pseudoWallet(player.id),
        name: cleanAgentDisplayName(handles[player.id] ?? `Player ${index + 1}`),
        mcpEndpoint: `games.coop/${gameId}/agents/${player.id}`,
        capabilities: ['trade', 'extract_tile', 'build_structure', 'build_road', 'attest'],
        registeredAt: Date.now() - index * 1000,
        chainId: 11155420,
      },
    ]),
  );
}

function buildAttestationReadiness(
  players: CommonsPlayer[],
  round: number,
  score: number,
): AttestationReadiness[] {
  return players.map((player, index) => ({
    uid: `ready-${player.id}-${round}`,
    schema: 'tragedy.commons.round.v1',
    gameId: 'lucian-live-game',
    agentId: player.id,
    placement: index + 1,
    score: player.vp,
    trustDelta: player.influence,
    cooperationRate: Math.max(0, Math.min(1, score / 100)),
    betrayalCount: 0,
    ecosystemImpact: score - 100,
    attestedAt: Date.now(),
  }));
}

function buildParticipationReadiness(
  players: CommonsPlayer[],
  lastActionByPlayer: Map<string, CommonsResolvedAction>,
): AgentParticipationReadiness[] {
  return players.map((player) => ({
    agentId: player.id,
    status: 'active',
    mcpConnected: true,
    lastSeenAt: Date.now(),
    gamesPlayed: 1,
    trustScore: Math.max(
      0,
      Math.min(
        1,
        0.5 + player.influence * 0.06 + actionStewardshipDelta(lastActionByPlayer.get(player.id)),
      ),
    ),
  }));
}

function buildWorldMap(
  boardTiles: CommonsBoardTile[],
  ecosystems: CommonsEcosystem[],
): Record<string, unknown> {
  return {
    tiles: boardTiles.map((tile) => ({ ...tile, coord: { q: tile.q, r: tile.r } })),
    ecosystems,
  };
}

function buildOriginalState(
  gameId: string,
  source: unknown,
  shellHandles: Record<string, string>,
): { gameState: GameState; messages: ChatMessage[] } | null {
  const payload = extractPayload(source);
  if (!payload) return null;
  const state = payload.state;
  const players = Array.isArray(state.players)
    ? state.players.map(parsePlayer).filter((player): player is CommonsPlayer => Boolean(player))
    : [];
  const regions = Array.isArray(state.regions)
    ? state.regions.map(parseRegion).filter((region): region is CommonsRegion => Boolean(region))
    : [];
  const ecosystems = Array.isArray(state.ecosystems)
    ? state.ecosystems
        .map(parseEcosystem)
        .filter((ecosystem): ecosystem is CommonsEcosystem => Boolean(ecosystem))
    : [];
  const rawBoardTiles = Array.isArray(state.boardTiles) ? state.boardTiles : state.tiles;
  const boardTiles = Array.isArray(rawBoardTiles)
    ? rawBoardTiles.map(parseBoardTile).filter((tile): tile is CommonsBoardTile => Boolean(tile))
    : [];
  if (boardTiles.length === 0 || (players.length === 0 && ecosystems.length === 0)) return null;

  const handles = Object.fromEntries(
    Object.entries({
      ...parseHandles(state.handles),
      ...parseHandles(payload.meta.handles),
      ...shellHandles,
    }).map(([id, name]) => [id, cleanAgentDisplayName(name)]),
  );
  const round = numberValue(state.round);
  const phase = text(state.phase, text(payload.meta.finished) === 'true' ? 'finished' : 'playing');
  const score = Math.round(
    Math.max(0, Math.min(100, numberValue(state.commonsHealthPercent, commonsScore(ecosystems)))),
  );
  const tileByRegionId = new Map(
    boardTiles.flatMap((tile) => (tile.regionId ? [[tile.regionId, tile] as const] : [])),
  );
  const ecosystemById = new Map(ecosystems.map((ecosystem) => [ecosystem.id, ecosystem]));
  const activeTrades = Array.isArray(state.activeTrades) ? state.activeTrades : [];
  const resolvedActions = Array.isArray(state.lastResolvedActions)
    ? state.lastResolvedActions
        .map(parseResolvedAction)
        .filter((action): action is CommonsResolvedAction => Boolean(action))
    : [];
  const lastActionByPlayer = new Map(
    resolvedActions.map((action) => [action.playerId, action] as const),
  );
  const commitments = buildCommitments(players, activeTrades, round, handles);
  const attestations = buildAttestations(commitments, round);
  const messages = payload.relay
    .map((relay) => relayToMessage(relay, round, phase))
    .filter((message): message is ChatMessage => Boolean(message));
  const hexGrid = buildHexGrid(boardTiles, ecosystemById);
  const productionWheel =
    hexGrid.length > 0 ? hexGrid.map((tile) => tile.productionNumber) : DEFAULT_PRODUCTION_WHEEL;
  const productionNumber = productionWheel[Math.max(0, round - 1) % productionWheel.length] ?? 0;
  const ecosystemStates = ecosystems.map((ecosystem) => ({
    ...ecosystem,
    health: healthPercent(ecosystem),
    maxHealth: 100,
  }));
  const weakest = ecosystems
    .slice()
    .sort((left, right) => healthPercent(left) - healthPercent(right))[0];

  return {
    gameState: {
      ...initialGameState,
      gameId,
      round,
      phase,
      prizePoolWei: String(BigInt(Math.max(1, players.length)) * 1000000000000000000n),
      payablePrizePoolWei: String(BigInt(Math.max(1, players.length) * score) * 10000000000000000n),
      slashedPrizePoolWei: String(
        BigInt(Math.max(1, players.length) * (100 - score)) * 10000000000000000n,
      ),
      carryoverPrizePoolWei: String(
        BigInt(Math.max(1, players.length) * (100 - score)) * 10000000000000000n,
      ),
      commonsHealth: {
        score,
        payableFraction: score / 100,
        reasons: weakest
          ? [
              `${weakest.name} is ${weakest.status}; payout pressure follows visible ecosystem health.`,
            ]
          : ['No ecosystem pressure currently visible.'],
      },
      activeCrisis:
        weakest && healthPercent(weakest) < 80
          ? {
              name: `${weakest.name} under pressure`,
              type: weakest.kind,
              description: `Visible ${weakest.resource} commons health is ${healthPercent(weakest)} / 100.`,
            }
          : null,
      productionNumber,
      wheelPosition: Math.max(0, round - 1) % productionWheel.length,
      productionWheel,
      hexGrid,
      worldMap: buildWorldMap(boardTiles, ecosystems),
      agents: buildAgents(players, regions, handles, tileByRegionId, lastActionByPlayer),
      pendingAgentInfo: Object.fromEntries(
        players.map((player) => [
          player.id,
          {
            name:
              cleanAgentDisplayName(handles[player.id] ?? '') ||
              `Player ${players.findIndex((candidate) => candidate.id === player.id) + 1}`,
            strategy: 'commons steward',
          },
        ]),
      ),
      agentOrder: players.map((player) => player.id),
      ecosystemStates,
      commitments,
      attestations,
      lastResolvedActions: summarizeResolvedActions(resolvedActions, ecosystems),
      behaviorTags: buildBehaviorTags(players, ecosystems, lastActionByPlayer, round),
      trustCards: parseTrustCards(state.trustCards),
      trustMatrix: buildTrustMatrix(players, lastActionByPlayer),
      winnerId: text(state.winner) || null,
      agentIdentities: buildIdentities(players, handles, gameId),
      attestationReadiness: buildAttestationReadiness(players, round, score),
      participationReadiness: buildParticipationReadiness(players, lastActionByPlayer),
    },
    messages,
  };
}

export function OriginalObservatory({ gameId, source, handles, isLive }: ObservatoryProps) {
  const hydrated = useMemo(
    () => buildOriginalState(gameId, source, handles),
    [gameId, source, handles],
  );

  useEffect(() => {
    const store = useGameStore.getState();
    store.setConnectionStatus(isLive ? 'connected' : 'disconnected');
    if (hydrated) {
      store.replaceGameState(hydrated.gameState, hydrated.messages);
    }
  }, [hydrated, isLive]);

  return (
    <div
      className="w-full min-h-screen overflow-y-auto bg-[var(--color-bg)] px-4 py-5 font-sans text-[var(--color-text)] sm:px-6 lg:px-10 lg:py-8"
      style={OBSERVATORY_STYLE}
    >
      <TopBar />
      <div className="mt-5 grid grid-cols-12 gap-8 items-start max-[1500px]:grid-cols-1">
        <section className="col-span-9 max-[1500px]:col-auto border border-[var(--color-line)] rounded-[var(--radius-xl)] overflow-hidden bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px]">
          <div className="flex justify-between items-start gap-5 p-6 px-7 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] max-[1500px]:flex-col max-[1500px]:items-start">
            <div>
              <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--color-text-soft)] pl-1">
                Living Board
              </div>
              <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
                The Shared World
              </h2>
            </div>
            <div className="mt-1 text-[13px] leading-[1.55] text-[var(--color-text-muted)] text-right max-w-[420px] max-[1500px]:text-left">
              A deterministic board with public memory and hidden horizons.
            </div>
          </div>

          <div className="p-7 grid grid-cols-[minmax(0,1fr)_minmax(280px,320px)] gap-7 max-[1500px]:grid-cols-1 items-start">
            <div className="relative min-h-[640px] flex flex-col gap-4">
              <GameBoard />
              <CrisisBanner />
            </div>
            <WorldHealthSidebar />
          </div>
        </section>

        <div className="col-span-3 max-[1500px]:col-auto h-[640px]">
          <PowerTable />
        </div>
      </div>

      <div className="mt-8 grid grid-cols-12 gap-8 items-start max-[1500px]:grid-cols-1 pb-12">
        <div className="col-span-4 max-[1500px]:col-auto h-[580px] max-[1500px]:h-auto max-[1500px]:min-h-[380px]">
          <ChatFeed />
        </div>
        <div className="col-span-5 max-[1500px]:col-auto h-[580px] max-[1500px]:h-auto max-[1500px]:min-h-[380px]">
          <CommitmentLedger />
        </div>
        <div className="col-span-3 max-[1500px]:col-auto h-[580px] max-[1500px]:h-auto max-[1500px]:min-h-[380px]">
          <TrustGraph />
        </div>
      </div>
    </div>
  );
}
