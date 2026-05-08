import ReactDOM from 'react-dom/client';
import './index.css';
import { TragedyOfTheCommonsSpectatorView } from './games/tragedy-of-the-commons/SpectatorView';

const tileSpecs = [
  ['0,-2', 0, -2, 'mountains', 'north-ore', 'North Ore Ridge', 'ore', ['north-ore']],
  ['1,-2', 1, -2, 'forest', 'upper-forest', 'Upper Forest', 'timber', ['upper-forest']],
  ['2,-2', 2, -2, 'oil-field', 'east-oil', 'East Oil Field', 'energy', ['east-oil']],
  ['-1,-1', -1, -1, 'forest', 'west-forest', 'West Forest', 'timber', ['west-forest']],
  ['0,-1', 0, -1, 'rivers', 'upper-river', 'Upper River', 'water', ['upper-river']],
  ['1,-1', 1, -1, 'rivers', 'middle-river', 'Middle River', 'water', ['middle-river']],
  ['2,-1', 2, -1, 'wetland', 'east-wetland', 'East Wetland', 'fish', ['east-wetland']],
  ['-2,0', -2, 0, 'mountains', 'west-ore', 'West Ore Ridge', 'ore', ['west-ore']],
  ['-1,0', -1, 0, 'rivers', 'west-river', 'West River', 'water', ['west-river']],
  ['0,0', 0, 0, 'rivers', 'central-river', 'Central River', 'water', ['central-river']],
  ['1,0', 1, 0, 'wetland', 'central-wetland', 'Central Wetland', 'fish', ['central-wetland']],
  ['2,0', 2, 0, 'oil-field', 'south-oil', 'South Oil Field', 'energy', ['south-oil']],
  ['-2,1', -2, 1, 'forest', 'lower-forest', 'Lower Forest', 'timber', ['lower-forest']],
  ['-1,1', -1, 1, 'rivers', 'lower-river', 'Lower River', 'water', ['lower-river']],
  ['0,1', 0, 1, 'wetland', 'lower-wetland', 'Lower Wetland', 'fish', ['lower-wetland']],
  ['1,1', 1, 1, 'forest', 'solar-grove', 'Solar Grove', 'timber', ['solar-grove']],
  ['-2,2', -2, 2, 'mountains', 'south-ore', 'South Ore Ridge', 'ore', ['south-ore']],
  ['-1,2', -1, 2, 'wetland', 'south-wetland', 'South Wetland', 'fish', ['south-wetland']],
  ['0,2', 0, 2, 'forest', 'south-forest', 'South Forest', 'timber', ['south-forest']],
] as const;

const intersections = {
  northFord: {
    hexes: [
      { q: 1, r: -1 },
      { q: 0, r: 0 },
      { q: 1, r: 0 },
    ],
  },
  centralFord: {
    hexes: [
      { q: 0, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: 0 },
    ],
  },
  southFord: {
    hexes: [
      { q: 0, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ],
  },
  solarJunction: {
    hexes: [
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: 1 },
    ],
  },
} as const;

const intersectionList = Object.entries(intersections).map(([id, value]) => ({ id, ...value }));

function tileStatus(id: string): 'flourishing' | 'stable' | 'strained' {
  if (id === 'east-oil' || id === 'south-oil' || id === 'middle-river' || id === 'lower-river') {
    return 'strained';
  }
  return id.includes('wetland') ? 'flourishing' : 'stable';
}

function tileHealth(status: 'flourishing' | 'stable' | 'strained'): number {
  return status === 'strained' ? 8 : status === 'flourishing' ? 18 : 14;
}

const tiles = tileSpecs.map(([id, q, r, terrain, , , primaryResource, ecosystemIds]) => {
  const status = tileStatus(id);
  return {
    id,
    q,
    r,
    terrain,
    productionNumber: 0,
    revealed: true,
    ecosystemIds: [...ecosystemIds],
    primaryResource,
    health: tileHealth(status),
    maxHealth: 20,
    status,
  };
});

const ecosystems = tileSpecs.map(([, , , terrain, id, name, primaryResource]) => {
  const status = tileStatus(id);
  const health = tileHealth(status);
  return {
    id,
    name,
    kind: terrain,
    resource: primaryResource,
    health,
    maxHealth: 20,
    collapseThreshold: 4,
    flourishThreshold: 16,
    status,
  };
});

const structures = [
  {
    id: 'alpha-camp',
    ownerId: 'alpha',
    intersectionId: 'northFord',
    type: 'camp',
    extractionsThisRound: 1,
  },
  {
    id: 'beta-village',
    ownerId: 'beta',
    intersectionId: 'southFord',
    type: 'village',
    extractionsThisRound: 1,
  },
  {
    id: 'gamma-city',
    ownerId: 'gamma',
    intersectionId: 'centralFord',
    type: 'city',
    extractionsThisRound: 1,
  },
  {
    id: 'delta-solar',
    ownerId: 'delta',
    intersectionId: 'solarJunction',
    type: 'solar-farm',
    extractionsThisRound: 0,
  },
];

const roads = [
  {
    id: 'alpha-road',
    ownerId: 'alpha',
    fromIntersectionId: 'northFord',
    toIntersectionId: 'centralFord',
  },
  {
    id: 'beta-road',
    ownerId: 'beta',
    fromIntersectionId: 'southFord',
    toIntersectionId: 'centralFord',
  },
  {
    id: 'gamma-road',
    ownerId: 'gamma',
    fromIntersectionId: 'centralFord',
    toIntersectionId: 'solarJunction',
  },
];

const nativeSpectatorSnapshot = {
  type: 'state_update',
  meta: {
    gameId: 'local-preview-tragedy-v2',
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
        resources: { grain: 0, timber: 2, ore: 0, fish: 1, water: 1, energy: 1 },
        influence: 1,
        vp: 1,
        totalResources: 5,
        ownedStructureIds: ['alpha-camp'],
        ownedRoadIds: ['alpha-road'],
        structures,
        roads,
        intersections: intersectionList,
        tiles,
      },
      {
        id: 'beta',
        resources: { grain: 0, timber: 1, ore: 1, fish: 2, water: 1, energy: 2 },
        influence: 1,
        vp: 2,
        totalResources: 7,
        ownedStructureIds: ['beta-village'],
        ownedRoadIds: ['beta-road'],
        structures,
        roads,
        intersections: intersectionList,
        tiles,
      },
      {
        id: 'gamma',
        resources: { grain: 0, timber: 1, ore: 2, fish: 2, water: 1, energy: 3 },
        influence: 0,
        vp: 3,
        totalResources: 9,
        ownedStructureIds: ['gamma-city'],
        ownedRoadIds: ['gamma-road'],
        structures,
        roads,
        intersections: intersectionList,
        tiles,
      },
      {
        id: 'delta',
        resources: { grain: 0, timber: 1, ore: 1, fish: 1, water: 2, energy: 4 },
        influence: 2,
        vp: 1,
        totalResources: 9,
        ownedStructureIds: ['delta-solar'],
        ownedRoadIds: [],
        structures,
        roads,
        intersections: intersectionList,
        tiles,
      },
    ],
    tiles,
    intersections: intersectionList,
    structures,
    roads,
    ecosystems,
    commonsHealthPercent: 67,
    lastResolvedActions: [
      {
        playerId: 'alpha',
        action: { type: 'extract_tile', tileId: '-1,0', resource: 'water', level: 'low' },
      },
      {
        playerId: 'beta',
        action: { type: 'extract_tile', tileId: '1,-1', resource: 'water', level: 'high' },
      },
      {
        playerId: 'gamma',
        action: { type: 'extract_tile', tileId: '2,-2', resource: 'energy', level: 'medium' },
      },
      { playerId: 'delta', action: { type: 'pass' } },
    ],
    activeTrades: [],
    winner: null,
    handles: { alpha: 'Alice', beta: 'Bob', gamma: 'Cyra', delta: 'Dax' },
  },
  relay: [],
};

const root = document.getElementById('root');

if (root) {
  ReactDOM.createRoot(root).render(
    <TragedyOfTheCommonsSpectatorView
      gameState={null}
      chatMessages={[]}
      handles={{ alpha: 'Alice', beta: 'Bob', gamma: 'Cyra', delta: 'Dax' }}
      gameId="local-preview-tragedy-v2"
      gameType="tragedy-of-the-commons"
      phase="in_progress"
      liveSnapshot={nativeSpectatorSnapshot}
      liveIsLive={true}
      liveError={null}
    />,
  );
}
