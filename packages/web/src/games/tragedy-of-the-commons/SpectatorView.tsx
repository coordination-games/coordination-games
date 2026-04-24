import type { CSSProperties } from 'react';
import type { SpectatorViewProps } from '../types';
import { GameBoard, type HexTile } from './legacy/GameBoard';

type ResourceType = 'grain' | 'timber' | 'ore' | 'fish' | 'water' | 'energy';

interface ResourceInventory {
  grain: number;
  timber: number;
  ore: number;
  fish: number;
  water: number;
  energy: number;
}

interface TragedyPlayer {
  id: string;
  vp: number;
  influence: number;
  totalResources: number;
  regionsControlled: string[];
  resources: ResourceInventory;
}

interface TragedyRegion {
  id: string;
  name: string;
  primaryResource: ResourceType;
  secondaryResources: ResourceType[];
  ecosystemIds: string[];
}

interface TragedyEcosystem {
  id: string;
  name: string;
  kind: string;
  resource: ResourceType;
  regionIds: string[];
  health: number;
  maxHealth: number;
  status: 'flourishing' | 'stable' | 'strained' | 'collapsed';
}

interface TragedySpectatorState {
  round: number;
  maxRounds: number;
  phase: 'waiting' | 'playing' | 'finished';
  players: TragedyPlayer[];
  regions: TragedyRegion[];
  ecosystems: TragedyEcosystem[];
  activeTrades: unknown[];
  winner: string | null;
  handles: Record<string, string>;
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

const REGION_COORDS: Record<string, { q: number; r: number }> = {
  mistbarrow: { q: -2, r: 0 },
  riverwake: { q: -2, r: 1 },
  'commons-heart': { q: -1, r: 1 },
  'sunspine-basin': { q: 0, r: 0 },
  ironcrest: { q: 1, r: -2 },
  'monsoon-reach': { q: 0, r: 2 },
};

const PRODUCTION_BY_REGION: Record<string, number> = {
  mistbarrow: 5,
  riverwake: 9,
  'commons-heart': 6,
  'sunspine-basin': 10,
  ironcrest: 8,
  'monsoon-reach': 11,
};

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
  '--color-violet': '#8b83ae',
  '--shadow': '0 28px 90px rgba(0, 0, 0, 0.42)',
  '--radius-xl': '26px',
} as CSSProperties;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
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

function parseHandles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function parsePlayer(value: unknown): TragedyPlayer | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const resources = parseResources(value.resources);
  const totalResources = RESOURCE_TYPES.reduce((total, resource) => total + resources[resource], 0);
  return {
    id,
    vp: numberValue(value.vp),
    influence: numberValue(value.influence),
    totalResources: numberValue(value.totalResources, totalResources),
    regionsControlled: stringArray(value.regionsControlled),
    resources,
  };
}

function parseRegion(value: unknown): TragedyRegion | null {
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

function parseEcosystem(value: unknown): TragedyEcosystem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const status = text(value.status, 'stable');
  return {
    id,
    name: text(value.name, id),
    kind: text(value.kind, 'commons'),
    resource: resourceType(value.resource),
    regionIds: stringArray(value.regionIds),
    health: numberValue(value.health),
    maxHealth: numberValue(value.maxHealth, 20),
    status:
      status === 'flourishing' ||
      status === 'stable' ||
      status === 'strained' ||
      status === 'collapsed'
        ? status
        : 'stable',
  };
}

function mapServerState(raw: unknown): TragedySpectatorState | null {
  if (!isRecord(raw)) return null;
  const candidate = raw.type === 'state_update' ? raw.state : (raw.data ?? raw);
  if (!isRecord(candidate)) return null;
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const players = Array.isArray(candidate.players)
    ? candidate.players
        .map(parsePlayer)
        .filter((player): player is TragedyPlayer => Boolean(player))
    : [];
  const ecosystems = Array.isArray(candidate.ecosystems)
    ? candidate.ecosystems
        .map(parseEcosystem)
        .filter((ecosystem): ecosystem is TragedyEcosystem => Boolean(ecosystem))
    : [];
  if (players.length === 0 && ecosystems.length === 0) return null;
  return {
    round: numberValue(candidate.round),
    maxRounds: numberValue(candidate.maxRounds, 12),
    phase:
      meta.finished === true
        ? 'finished'
        : candidate.phase === 'waiting' || candidate.phase === 'finished'
          ? candidate.phase
          : 'playing',
    players,
    regions: Array.isArray(candidate.regions)
      ? candidate.regions
          .map(parseRegion)
          .filter((region): region is TragedyRegion => Boolean(region))
      : [],
    ecosystems,
    activeTrades: Array.isArray(candidate.activeTrades) ? candidate.activeTrades : [],
    winner: typeof candidate.winner === 'string' ? candidate.winner : null,
    handles: parseHandles(candidate.handles),
  };
}

function terrainForRegion(region: TragedyRegion): HexTile['terrain'] {
  if (region.id === 'commons-heart') return 'commons';
  switch (region.primaryResource) {
    case 'grain':
      return 'plains';
    case 'timber':
      return 'forest';
    case 'ore':
      return 'mountains';
    case 'fish':
    case 'water':
    case 'energy':
      return 'rivers';
  }
}

function buildHexGrid(regions: TragedyRegion[]): HexTile[] {
  return regions.flatMap((region) => {
    const coord = REGION_COORDS[region.id];
    if (!coord) return [];
    return [
      {
        q: coord.q,
        r: coord.r,
        terrain: terrainForRegion(region),
        productionNumber: PRODUCTION_BY_REGION[region.id] ?? 0,
        revealed: true,
        regionId: region.id,
        regionName: region.name,
        primaryResource: region.primaryResource,
        ecosystemIds: region.ecosystemIds,
      },
    ];
  });
}

function handleFor(id: string, handles: Record<string, string>): string {
  return handles[id] ?? id;
}

function sortedPlayers(players: TragedyPlayer[]): TragedyPlayer[] {
  return [...players].sort((left, right) => {
    if (right.vp !== left.vp) return right.vp - left.vp;
    if (right.influence !== left.influence) return right.influence - left.influence;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function commonsScore(ecosystems: TragedyEcosystem[]): number {
  if (ecosystems.length === 0) return 100;
  const pct = ecosystems.reduce((sum, ecosystem) => {
    const max = ecosystem.maxHealth || 20;
    return sum + Math.max(0, Math.min(100, (ecosystem.health / max) * 100));
  }, 0);
  return Math.round(pct / ecosystems.length);
}

function TopBar({ state }: { state: TragedySpectatorState }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-[var(--color-line)] bg-gradient-to-b from-[rgba(12,24,37,0.92)] to-[rgba(8,16,24,0.86)] px-7 py-5 shadow-[var(--shadow)]">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-soft)]">
          Tragedy of the Commons Observatory
        </div>
        <h1 className="mt-1 font-serif text-2xl font-semibold text-[var(--color-text)]">
          Living Commons
        </h1>
      </div>
      <div className="text-right font-mono text-xs uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
        Round {state.round}/{state.maxRounds} · {state.phase}
      </div>
    </div>
  );
}

function CommonsPressure({ state }: { state: TragedySpectatorState }) {
  const score = commonsScore(state.ecosystems);
  const ecosystems = [...state.ecosystems].sort((a, b) => a.health - b.health);
  return (
    <aside className="grid max-h-[600px] w-full min-w-0 gap-5 overflow-y-auto">
      <div className="rounded-[14px] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(14,28,41,0.97)] to-[rgba(9,18,28,0.95)] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
          Commons Pressure
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full border border-[var(--color-line)] bg-[rgba(0,0,0,0.22)]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[var(--color-rose)] via-[var(--color-gold)] to-[var(--color-moss)]"
            style={{ width: `${score}%` }}
          />
        </div>
        <div className="mt-2 font-serif text-[22px] leading-none text-[var(--color-text)]">
          {score} / 100
        </div>
        <div className="mt-2 text-xs leading-[1.4] text-[var(--color-text-muted)]">
          Payout-adjusted commons health is approximated from visible ecosystem health in Lucian’s
          spectator state.
        </div>
        <div className="mt-4 grid gap-4">
          {ecosystems.map((eco) => {
            const max = eco.maxHealth || 20;
            const width = Math.max(0, Math.min(100, (eco.health / max) * 100));
            return (
              <article
                key={eco.id}
                className="rounded-[14px] border border-[rgba(233,220,190,0.1)] bg-[rgba(10,14,10,0.4)] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-serif text-base text-[var(--color-text)]">{eco.name}</div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-soft)]">
                    {eco.status}
                  </div>
                </div>
                <div className="mt-2 h-2.5 overflow-hidden rounded-full border border-[rgba(233,220,190,0.12)] bg-[rgba(0,0,0,0.24)]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[var(--color-rose)] via-[var(--color-gold)] to-[var(--color-moss)]"
                    style={{ width: `${width}%` }}
                  />
                </div>
                <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  Raw ecosystem health: {Math.round(eco.health)} / {Math.round(max)}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function PowerTable({
  state,
  handles,
}: {
  state: TragedySpectatorState;
  handles: Record<string, string>;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px]">
      <div className="flex items-start justify-between gap-5 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] p-6 px-7">
        <div>
          <div className="pl-1 font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-soft)]">
            Competitive Field
          </div>
          <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
            Power Table
          </h2>
        </div>
      </div>
      <div className="custom-scrollbar flex flex-1 flex-col gap-5 overflow-y-auto p-6">
        {sortedPlayers(state.players).map((agent, index) => {
          const isWinner = state.winner === agent.id;
          return (
            <div
              key={agent.id}
              className={`rounded-[14px] border bg-gradient-to-br from-[rgba(18,33,48,0.96)] to-[rgba(10,18,28,0.9)] p-5 px-6 ${isWinner ? 'border-[rgba(217,178,95,0.38)]' : 'border-[rgba(233,220,190,0.12)]'}`}
            >
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2 overflow-hidden text-ellipsis whitespace-nowrap font-serif text-[17px] leading-none text-[var(--color-text)]">
                    {handleFor(agent.id, handles)}
                    {isWinner ? (
                      <span className="rounded-full border border-[rgba(217,178,95,0.4)] bg-[rgba(217,178,95,0.2)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-gold)]">
                        Winner
                      </span>
                    ) : null}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-soft)]">
                    Agent
                  </div>
                </div>
                <div className="shrink-0 rounded-full border border-[rgba(217,178,95,0.2)] bg-[rgba(217,178,95,0.14)] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-gold)]">
                  Rank {index + 1}
                </div>
              </div>
              <div className="mt-3.5 flex items-baseline gap-4">
                <Metric label="VP" value={agent.vp} />
                <Metric label="INF" value={agent.influence} />
                <Metric label="RES" value={agent.totalResources} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3.5">
                {RESOURCE_TYPES.map((resource) => (
                  <div
                    key={resource}
                    className="flex flex-col items-center gap-1.5 rounded-xl border border-[rgba(233,220,190,0.1)] bg-[rgba(8,12,8,0.26)] p-3 text-center"
                  >
                    <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-soft)]">
                      {resource.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="text-sm text-[var(--color-text)]">
                      {agent.resources[resource]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-soft)]">
        {label}
      </div>
      <div className="font-serif text-xl leading-none text-[var(--color-text)]">{value}</div>
    </div>
  );
}

export function TragedyOfTheCommonsSpectatorView(props: SpectatorViewProps) {
  const { handles, gameState, liveSnapshot, liveError, replaySnapshots } = props;
  const isReplay = replaySnapshots != null;
  const state = mapServerState(isReplay ? gameState : liveSnapshot) ?? mapServerState(gameState);

  if (!state) {
    return (
      <div
        className="flex h-full items-center justify-center p-8"
        style={{ color: 'var(--color-ink)' }}
      >
        <div className="parchment-strong max-w-md rounded-2xl p-8 text-center shadow-lg">
          <div className="mb-3 text-4xl">🌾</div>
          <h2 className="font-heading text-xl tracking-wide">Tragedy of the Commons</h2>
          <p className="mt-3 text-sm" style={{ color: 'var(--color-ink-light)' }}>
            {liveError ?? 'Waiting for commons telemetry...'}
          </p>
        </div>
      </div>
    );
  }

  const mergedHandles = { ...state.handles, ...handles };
  const hexGrid = buildHexGrid(state.regions);

  return (
    <div
      className="-mx-4 min-h-screen overflow-y-auto bg-[var(--color-bg)] px-5 py-5 font-sans text-[var(--color-text)] sm:-mx-6 lg:px-10 lg:py-8"
      style={OBSERVATORY_STYLE}
    >
      <TopBar state={state} />
      <div className="mt-5 grid grid-cols-12 items-start gap-8 max-[1500px]:grid-cols-1">
        <section className="col-span-9 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-gradient-to-b from-[rgba(12,24,36,0.92)] to-[rgba(8,16,24,0.86)] shadow-[var(--shadow)] backdrop-blur-[16px] max-[1500px]:col-auto">
          <div className="flex items-start justify-between gap-5 border-b border-[var(--color-line)] bg-gradient-to-b from-[rgba(24,40,56,0.86)] to-[rgba(10,18,28,0.48)] p-6 px-7 max-[1500px]:flex-col">
            <div>
              <div className="pl-1 font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-soft)]">
                Living Board
              </div>
              <h2 className="mt-1 font-serif text-xl font-semibold text-[var(--color-text)]">
                The Shared World
              </h2>
            </div>
            <div className="mt-1 max-w-[420px] text-right text-[13px] leading-[1.55] text-[var(--color-text-muted)] max-[1500px]:text-left">
              The existing Tragedy canvas board, adapted to Lucian’s spectator stream.
            </div>
          </div>
          <div className="grid items-start gap-7 p-7 min-[1500px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
            <div className="relative flex min-h-[640px] flex-col gap-4">
              <GameBoard hexGrid={hexGrid} productionNumber={state.round} />
            </div>
            <CommonsPressure state={state} />
          </div>
        </section>
        <div className="col-span-3 h-[640px] max-[1500px]:col-auto">
          <PowerTable state={state} handles={mergedHandles} />
        </div>
      </div>
    </div>
  );
}
