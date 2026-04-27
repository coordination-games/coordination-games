import { type CSSProperties, useEffect, useMemo } from 'react';
import AttestationStatusCard from './components/AttestationStatusCard';
import { ChatFeed } from './components/ChatFeed';
import { CommitmentLedger } from './components/CommitmentLedger';
import { CrisisBanner } from './components/CrisisBanner';
import { GameBoard } from './components/GameBoard';
import IdentityCard from './components/IdentityCard';
import ParticipationCard from './components/ParticipationCard';
import { PowerTable } from './components/PowerTable';
import { TopBar } from './components/TopBar';
import { TrustGraph } from './components/TrustGraph';
import { WorldHealthSidebar } from './components/WorldHealthSidebar';
import { AGENT_COLORS } from './lib/colors';
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
}

interface CommonsRegion {
  id: string;
  name: string;
  primaryResource: ResourceType;
  secondaryResources: ResourceType[];
  ecosystemIds: string[];
}

interface CommonsBoardTile {
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
  return {
    id,
    resources,
    influence: numberValue(value.influence),
    vp: numberValue(value.vp),
    totalResources: numberValue(value.totalResources, totalResources(resources)),
    regionsControlled: stringArray(value.regionsControlled),
  };
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
    kind: text(value.kind, 'commons'),
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
  return {
    q,
    r,
    terrain: text(value.terrain, 'wasteland'),
    productionNumber: numberValue(value.productionNumber),
    revealed: value.revealed !== false,
    revealedBy: stringArray(value.revealedBy),
    ...(regionId ? { regionId } : {}),
    ...(regionName ? { regionName } : {}),
    ...(primaryResource ? { primaryResource } : {}),
    ...(ecosystemIds.length > 0 ? { ecosystemIds } : {}),
  };
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

function buildHexGrid(boardTiles: CommonsBoardTile[]): HexTile[] {
  return boardTiles.map((tile) => ({
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
  }));
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

function buildAgents(
  players: CommonsPlayer[],
  regions: CommonsRegion[],
  handles: Record<string, string>,
  tileByRegionId: Map<string, CommonsBoardTile>,
): Record<string, AgentState> {
  const regionById = new Map(regions.map((region) => [region.id, region]));
  return Object.fromEntries(
    players.map((player, index) => {
      const locations = player.regionsControlled.flatMap((regionId) => {
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
      return [
        player.id,
        {
          id: player.id,
          name: handles[player.id] ?? player.id,
          strategy: regionById.get(player.regionsControlled[0] ?? '')?.name ?? 'commons steward',
          color: AGENT_COLORS[index % AGENT_COLORS.length] ?? AGENT_COLORS[0] ?? '#ddb469',
          resources: player.resources,
          vp: player.vp,
          influence: player.influence,
          trust: Math.max(0, Math.min(1, 0.45 + player.influence * 0.08)),
          longestRoad: player.regionsControlled.length,
          structures: {
            villages: Math.max(1, player.regionsControlled.length),
            townships: Math.floor(player.vp / 3),
            cities: Math.floor(player.vp / 5),
            beacons: player.influence,
            tradePosts: player.totalResources > 8 ? 1 : 0,
            roads: Math.max(0, player.regionsControlled.length - 1),
          },
          structureLocations: locations,
        },
      ];
    }),
  );
}

function buildTrustMatrix(
  players: CommonsPlayer[],
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
      return Math.max(
        0.05,
        Math.min(0.95, 0.35 + cooperation * 0.38 + visibleSuccess * 0.18 - scarcityPenalty),
      );
    }),
  );
  return { agents, matrix };
}

function buildBehaviorTags(
  players: CommonsPlayer[],
  ecosystems: CommonsEcosystem[],
  round: number,
): VisibleBehaviorTag[] {
  const weakest = ecosystems
    .slice()
    .sort((left, right) => healthPercent(left) - healthPercent(right))[0];
  return players.flatMap((player, index) => {
    if (!weakest) return [];
    const cooperative = player.influence > 0 || player.vp > 1;
    return [
      {
        id: `${player.id}-round-${round}-commons-signal`,
        round,
        actor: player.id,
        kind: cooperative ? 'stewardship' : 'extractive',
        severity: cooperative ? 'positive' : index % 2 === 0 ? 'medium' : 'low',
        description: cooperative
          ? `Visible influence suggests support for ${weakest.name}.`
          : `${weakest.name} is under visible pressure while this agent accumulates resources.`,
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
  return players.slice(0, 6).map((player) => ({
    id: `commons-memory-${player.id}-${round}`,
    type: 'public_memory',
    promisor: player.id,
    counterparties: players
      .filter((candidate) => candidate.id !== player.id)
      .slice(0, 2)
      .map((candidate) => candidate.id),
    resolutionStatus: player.influence > 0 ? 'fulfilled' : 'pending',
    summary: `${player.id} is publicly accountable for stewardship across ${player.regionsControlled.length || 1} region${player.regionsControlled.length === 1 ? '' : 's'}.`,
    dueByRound: round + 1,
  }));
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
        name: handles[player.id] ?? player.id,
        mcpEndpoint: `games.coop/${gameId}/agents/${player.id}`,
        capabilities: ['trade', 'extract_commons', 'build_settlement', 'attest'],
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

function buildParticipationReadiness(players: CommonsPlayer[]): AgentParticipationReadiness[] {
  return players.map((player) => ({
    agentId: player.id,
    status: 'active',
    mcpConnected: true,
    lastSeenAt: Date.now(),
    gamesPlayed: 1,
    trustScore: Math.max(0, Math.min(1, 0.45 + player.influence * 0.08)),
  }));
}

function buildWorldMap(
  boardTiles: CommonsBoardTile[],
  ecosystems: CommonsEcosystem[],
): Record<string, unknown> {
  return {
    regions: boardTiles.map((tile) => ({ ...tile, coord: { q: tile.q, r: tile.r } })),
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
  const boardTiles = Array.isArray(state.boardTiles)
    ? state.boardTiles.map(parseBoardTile).filter((tile): tile is CommonsBoardTile => Boolean(tile))
    : [];
  if (boardTiles.length === 0 || (players.length === 0 && ecosystems.length === 0)) return null;

  const handles = {
    ...parseHandles(state.handles),
    ...parseHandles(payload.meta.handles),
    ...shellHandles,
  };
  const round = numberValue(state.round);
  const phase = text(state.phase, text(payload.meta.finished) === 'true' ? 'finished' : 'playing');
  const score = commonsScore(ecosystems);
  const tileByRegionId = new Map(
    boardTiles.flatMap((tile) => (tile.regionId ? [[tile.regionId, tile] as const] : [])),
  );
  const activeTrades = Array.isArray(state.activeTrades) ? state.activeTrades : [];
  const commitments = buildCommitments(players, activeTrades, round);
  const attestations = buildAttestations(commitments, round);
  const messages = payload.relay
    .map((relay) => relayToMessage(relay, round, phase))
    .filter((message): message is ChatMessage => Boolean(message));
  const syntheticMessages: ChatMessage[] =
    messages.length > 0
      ? messages
      : [
          {
            id: `system-${gameId}-${round}`,
            sender: 'observatory',
            content: `Lucian spectator stream hydrated the full commons observatory for round ${round}.`,
            type: 'system',
            round,
            phase,
            timestamp: Date.now(),
          },
        ];
  const hexGrid = buildHexGrid(boardTiles);
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
      prizePoolWei: String(
        BigInt(Math.max(1, players.length * Math.max(1, round))) * 10000000000000000n,
      ),
      payablePrizePoolWei: String(
        BigInt(Math.max(1, players.length * Math.max(1, round) * score)) * 100000000000000n,
      ),
      slashedPrizePoolWei: String(
        BigInt(Math.max(0, players.length * Math.max(1, round) * (100 - score))) * 100000000000000n,
      ),
      carryoverPrizePoolWei: String(BigInt(Math.max(0, 100 - score)) * 1000000000000000n),
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
      agents: buildAgents(players, regions, handles, tileByRegionId),
      pendingAgentInfo: Object.fromEntries(
        players.map((player) => [
          player.id,
          { name: handles[player.id] ?? player.id, strategy: 'commons steward' },
        ]),
      ),
      agentOrder: players.map((player) => player.id),
      ecosystemStates,
      commitments,
      attestations,
      behaviorTags: buildBehaviorTags(players, ecosystems, round),
      trustMatrix: buildTrustMatrix(players),
      winnerId: text(state.winner) || null,
      agentIdentities: buildIdentities(players, handles, gameId),
      attestationReadiness: buildAttestationReadiness(players, round, score),
      participationReadiness: buildParticipationReadiness(players),
    },
    messages: syntheticMessages,
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

      <div className="mt-8 grid grid-cols-12 gap-8 items-start max-[1500px]:grid-cols-1 pb-12">
        <div className="col-span-4 max-[1500px]:col-auto">
          <IdentityCard />
        </div>
        <div className="col-span-4 max-[1500px]:col-auto">
          <AttestationStatusCard />
        </div>
        <div className="col-span-4 max-[1500px]:col-auto">
          <ParticipationCard />
        </div>
      </div>
    </div>
  );
}
