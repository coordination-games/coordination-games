import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TragedyOfTheCommonsSpectatorView } from '../SpectatorView';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const tiles = [
  ['0,-2', 0, -2, 'mountains', 'ore', 16, 20, 'flourishing'],
  ['1,-2', 1, -2, 'mountains', 'ore', 15, 20, 'stable'],
  ['2,-2', 2, -2, 'oil-field', 'energy', 12, 20, 'stable'],
  ['-1,-1', -1, -1, 'forest', 'timber', 16, 20, 'flourishing'],
  ['0,-1', 0, -1, 'mountains', 'ore', 12, 20, 'stable'],
  ['1,-1', 1, -1, 'mountains', 'energy', 12, 20, 'stable'],
  ['2,-1', 2, -1, 'rivers', 'water', 15, 20, 'stable'],
  ['-2,0', -2, 0, 'forest', 'timber', 16, 20, 'flourishing'],
  ['-1,0', -1, 0, 'forest', 'timber', 16, 20, 'flourishing'],
  ['0,0', 0, 0, 'rivers', 'water', 15, 20, 'stable'],
  ['1,0', 1, 0, 'wetland', 'fish', 14, 20, 'stable'],
  ['2,0', 2, 0, 'wetland', 'fish', 14, 20, 'stable'],
  ['-2,1', -2, 1, 'forest', 'timber', 16, 20, 'flourishing'],
  ['-1,1', -1, 1, 'rivers', 'water', 15, 20, 'stable'],
  ['0,1', 0, 1, 'rivers', 'water', 15, 20, 'stable'],
  ['1,1', 1, 1, 'rivers', 'water', 15, 20, 'stable'],
  ['-2,2', -2, 2, 'wetland', 'fish', 14, 20, 'stable'],
  ['-1,2', -1, 2, 'wetland', 'fish', 14, 20, 'stable'],
  ['0,2', 0, 2, 'rivers', 'water', 15, 20, 'stable'],
].map(([id, q, r, terrain, primaryResource, health, maxHealth, status], index) => ({
  id,
  q,
  r,
  terrain,
  productionNumber: [5, 8, 10, 6, 11, 9, 4, 3, 12, 2, 5, 8, 10, 6, 11, 9, 4, 3, 12][index],
  revealed: true,
  ecosystemIds:
    typeof id === 'string' && ['0,-2', '0,-1', '1,-2'].includes(id) ? ['ironcrest-vein'] : [],
  ...(typeof primaryResource === 'string' ? { primaryResource } : {}),
  ...(typeof health === 'number' ? { health } : {}),
  ...(typeof maxHealth === 'number' ? { maxHealth } : {}),
  ...(typeof status === 'string' ? { status } : {}),
}));

const intersections = [
  {
    id: 'alpha-camp',
    hexes: [
      { q: -1, r: 0 },
      { q: 0, r: 0 },
      { q: -1, r: 1 },
    ],
  },
  {
    id: 'beta-camp',
    hexes: [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 0, r: 1 },
    ],
  },
  {
    id: 'gamma-camp',
    hexes: [
      { q: -1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
    ],
  },
  {
    id: 'delta-camp',
    hexes: [
      { q: 1, r: -1 },
      { q: 1, r: 0 },
      { q: 0, r: 0 },
    ],
  },
  {
    id: 'alpha-solar',
    hexes: [
      { q: -2, r: 0 },
      { q: -1, r: 0 },
      { q: -2, r: 1 },
    ],
  },
];

const structures = [
  {
    id: 'alpha-structure',
    ownerId: 'alpha',
    intersectionId: 'alpha-camp',
    type: 'camp',
    extractionsThisRound: 0,
  },
  {
    id: 'alpha-solar-structure',
    ownerId: 'alpha',
    intersectionId: 'alpha-solar',
    type: 'solar-farm',
    extractionsThisRound: 0,
  },
  {
    id: 'beta-structure',
    ownerId: 'beta',
    intersectionId: 'beta-camp',
    type: 'camp',
    extractionsThisRound: 1,
  },
  {
    id: 'gamma-structure',
    ownerId: 'gamma',
    intersectionId: 'gamma-camp',
    type: 'camp',
    extractionsThisRound: 0,
  },
  {
    id: 'delta-structure',
    ownerId: 'delta',
    intersectionId: 'delta-camp',
    type: 'camp',
    extractionsThisRound: 1,
  },
];

const roads = [
  {
    id: 'alpha-road',
    ownerId: 'alpha',
    fromIntersectionId: 'alpha-camp',
    toIntersectionId: 'alpha-solar',
  },
];

const nativeSpectatorSnapshot = {
  type: 'state_update',
  meta: {
    gameId: 'game-1',
    gameType: 'tragedy-of-the-commons',
    handles: { alpha: 'Alice', beta: 'Bob', gamma: 'Cyra', delta: 'Dax' },
    progressCounter: 1,
    finished: false,
    sinceIdx: 0,
    lastUpdate: 1_700_000_000_000,
  },
  state: {
    round: 1,
    maxRounds: 12,
    phase: 'playing',
    players: [
      {
        id: 'alpha',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        ownedStructureIds: ['alpha-structure', 'alpha-solar-structure'],
        ownedRoadIds: ['alpha-road'],
        structures,
        roads,
        intersections,
        tiles,
      },
      {
        id: 'beta',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        ownedStructureIds: ['beta-structure'],
        ownedRoadIds: [],
        structures,
        roads,
        intersections,
        tiles,
      },
      {
        id: 'gamma',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        ownedStructureIds: ['gamma-structure'],
        ownedRoadIds: [],
        structures,
        roads,
        intersections,
        tiles,
      },
      {
        id: 'delta',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        ownedStructureIds: ['delta-structure'],
        ownedRoadIds: [],
        structures,
        roads,
        intersections,
        tiles,
      },
    ],
    tiles,
    intersections,
    structures,
    roads,
    ecosystems: [
      {
        id: 'old-growth-ring',
        name: 'Old Growth Ring',
        kind: 'forest',
        resource: 'timber',
        health: 16,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'flourishing',
      },
      {
        id: 'sunspine-river',
        name: 'Sunspine River',
        kind: 'river',
        resource: 'water',
        health: 15,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'stable',
      },
      {
        id: 'silver-tide-wetland',
        name: 'Silver Tide Wetland',
        kind: 'wetland',
        resource: 'fish',
        health: 14,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'stable',
      },
      {
        id: 'east-oil-field',
        name: 'East Oil Field',
        kind: 'oil-field',
        resource: 'energy',
        health: 12,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'stable',
      },
      {
        id: 'ironcrest-vein',
        name: 'Ironcrest Vein',
        kind: 'mineral',
        resource: 'ore',
        health: 12,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'stable',
      },
    ],
    commonsHealthPercent: 75,
    lastResolvedActions: [
      {
        playerId: 'alpha',
        action: {
          type: 'build_road',
          fromIntersectionId: 'alpha-camp',
          toIntersectionId: 'alpha-solar',
        },
      },
      {
        playerId: 'beta',
        action: { type: 'extract_tile', tileId: '0,0', resource: 'water', level: 'high' },
      },
      {
        playerId: 'gamma',
        action: { type: 'build_structure', intersectionId: 'gamma-camp', structureType: 'camp' },
      },
      {
        playerId: 'delta',
        action: { type: 'extract_tile', tileId: '-1,0', resource: 'timber', level: 'low' },
      },
    ],
    activeTrades: [],
    winner: null,
    handles: { alpha: 'Alice', beta: 'Bob', gamma: 'Cyra', delta: 'Dax' },
  },
  relay: [],
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TragedyOfTheCommonsSpectatorView', () => {
  it('renders the original observatory from a native spectator payload with a complete board', async () => {
    render(
      <TragedyOfTheCommonsSpectatorView
        gameState={null}
        chatMessages={[]}
        handles={{ alpha: 'Alice', beta: 'Bob', gamma: 'Cyra', delta: 'Dax' }}
        gameId="game-1"
        gameType="tragedy-of-the-commons"
        phase="in_progress"
        liveSnapshot={nativeSpectatorSnapshot}
        liveIsLive={true}
        liveError={null}
      />,
    );

    expect(tiles).toHaveLength(19);
    expect(screen.getByText('Living Board')).toBeTruthy();
    expect(screen.getByText('The Shared World')).toBeTruthy();
    expect(screen.getAllByText('Commons Pressure').length).toBeGreaterThan(0);
    expect(screen.getByText('Last Extraction Reveal')).toBeTruthy();
    expect(screen.getByText('high extraction of water from 0,0')).toBeTruthy();
    expect(screen.getByText('Winner Pool')).toBeTruthy();
    expect(screen.getByText('Power Table')).toBeTruthy();
    expect(screen.getByText('Dialogue')).toBeTruthy();
    expect(screen.getByText('Promises')).toBeTruthy();
    expect(screen.getByText('Trust Spectrum')).toBeTruthy();
    expect(screen.queryByText('Agent Identities')).toBeNull();
    expect(screen.queryByText('Attestation Status')).toBeNull();
    expect(screen.queryByText('Agent Participation')).toBeNull();
    expect(screen.queryByText('Bot Demo')).toBeNull();
    expect(screen.queryByText('AI Demo')).toBeNull();

    await waitFor(() => {
      expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    });
  });
});
