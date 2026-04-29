import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TragedyOfTheCommonsSpectatorView } from '../SpectatorView';

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const boardTiles = [
  ['0,-2', 0, -2, 'mountains'],
  ['1,-2', 1, -2, 'mountains'],
  ['2,-2', 2, -2, 'wasteland'],
  ['-1,-1', -1, -1, 'forest'],
  ['0,-1', 0, -1, 'mountains', 'ironcrest', 'Ironcrest', 'ore'],
  ['1,-1', 1, -1, 'rivers', 'sunspine-basin', 'Sunspine Basin', 'energy'],
  ['2,-1', 2, -1, 'rivers'],
  ['-2,0', -2, 0, 'forest'],
  ['-1,0', -1, 0, 'forest', 'mistbarrow', 'Mistbarrow', 'timber'],
  ['0,0', 0, 0, 'commons', 'commons-heart', 'Commons Heart', 'grain'],
  ['1,0', 1, 0, 'rivers', 'monsoon-reach', 'Monsoon Reach', 'fish'],
  ['2,0', 2, 0, 'wetland'],
  ['-2,1', -2, 1, 'forest'],
  ['-1,1', -1, 1, 'rivers', 'riverwake', 'Riverwake', 'water'],
  ['0,1', 0, 1, 'commons'],
  ['1,1', 1, 1, 'rivers'],
  ['-2,2', -2, 2, 'wetland'],
  ['-1,2', -1, 2, 'wetland'],
  ['0,2', 0, 2, 'rivers'],
].map(([id, q, r, terrain, regionId, regionName, primaryResource], index) => ({
  id,
  q,
  r,
  terrain,
  productionNumber: [5, 8, 10, 6, 11, 9, 4, 3, 12, 2, 5, 8, 10, 6, 11, 9, 4, 3, 12][index],
  revealed: true,
  ecosystemIds: [],
  ...(typeof regionId === 'string' ? { regionId } : {}),
  ...(typeof regionName === 'string' ? { regionName } : {}),
  ...(typeof primaryResource === 'string' ? { primaryResource } : {}),
}));

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
        regionsControlled: ['mistbarrow'],
      },
      {
        id: 'beta',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        regionsControlled: ['riverwake'],
      },
      {
        id: 'gamma',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        regionsControlled: ['commons-heart'],
      },
      {
        id: 'delta',
        resources: { grain: 2, timber: 2, ore: 1, fish: 1, water: 1, energy: 1 },
        influence: 0,
        vp: 1,
        totalResources: 8,
        regionsControlled: ['sunspine-basin'],
      },
    ],
    regions: [
      {
        id: 'mistbarrow',
        name: 'Mistbarrow',
        primaryResource: 'timber',
        secondaryResources: ['water'],
        ecosystemIds: ['old-growth-ring'],
      },
      {
        id: 'riverwake',
        name: 'Riverwake',
        primaryResource: 'water',
        secondaryResources: ['fish', 'grain'],
        ecosystemIds: ['sunspine-aquifer'],
      },
      {
        id: 'commons-heart',
        name: 'Commons Heart',
        primaryResource: 'grain',
        secondaryResources: ['timber', 'water'],
        ecosystemIds: ['old-growth-ring', 'sunspine-aquifer'],
      },
      {
        id: 'sunspine-basin',
        name: 'Sunspine Basin',
        primaryResource: 'energy',
        secondaryResources: ['ore'],
        ecosystemIds: ['sunspine-aquifer'],
      },
      {
        id: 'ironcrest',
        name: 'Ironcrest',
        primaryResource: 'ore',
        secondaryResources: ['energy'],
        ecosystemIds: [],
      },
      {
        id: 'monsoon-reach',
        name: 'Monsoon Reach',
        primaryResource: 'fish',
        secondaryResources: ['water', 'grain'],
        ecosystemIds: ['silver-tide-fishery'],
      },
    ],
    boardTiles,
    ecosystems: [
      {
        id: 'old-growth-ring',
        name: 'Old Growth Ring',
        kind: 'forest',
        resource: 'timber',
        regionIds: ['mistbarrow', 'commons-heart'],
        health: 16,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'flourishing',
      },
      {
        id: 'sunspine-aquifer',
        name: 'Sunspine Aquifer',
        kind: 'aquifer',
        resource: 'water',
        regionIds: ['riverwake', 'commons-heart', 'sunspine-basin'],
        health: 15,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'stable',
      },
      {
        id: 'silver-tide-fishery',
        name: 'Silver Tide Fishery',
        kind: 'fishery',
        resource: 'fish',
        regionIds: ['monsoon-reach'],
        health: 14,
        maxHealth: 20,
        collapseThreshold: 4,
        flourishThreshold: 16,
        status: 'stable',
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

    expect(boardTiles).toHaveLength(19);
    expect(screen.getByText('Living Board')).toBeTruthy();
    expect(screen.getByText('The Shared World')).toBeTruthy();
    expect(screen.getAllByText('Commons Pressure').length).toBeGreaterThan(0);
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
