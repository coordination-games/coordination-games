import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardAccessibilityLayer } from '../original/components/BoardAccessibilityLayer';
import { type DamageTier, damageTier, derivePollutionFlows } from '../original/lib/board-vfx';
import { motifDescription, terrainMotif } from '../original/lib/tile-motifs';
import { type HexTile, initialGameState, useGameStore } from '../original/store';

function tile(partial: Partial<HexTile> & Pick<HexTile, 'q' | 'r' | 'terrain'>): HexTile {
  return { productionNumber: 0, revealed: true, ...partial };
}

afterEach(() => {
  cleanup();
  useGameStore.setState({ gameState: initialGameState, messages: [] });
});

describe('terrain motifs are distinct per terrain', () => {
  it('maps each V2 terrain to a unique motif and description', () => {
    const terrains = ['oil-field', 'river', 'rivers', 'wetland', 'forest', 'mountains'];
    const motifs = terrains.map((terrain) => terrainMotif(terrain));
    expect(terrainMotif('oil-field')).toBe('oil-field');
    expect(terrainMotif('rivers')).toBe('river');
    expect(terrainMotif('wetland')).toBe('wetland');
    // Distinct terrains must not collapse to the same shape (color-independent).
    expect(new Set(motifs.filter((motif) => motif !== 'river')).size).toBeGreaterThan(3);
    expect(motifDescription('oil-field')).not.toBe(motifDescription('wetland'));
  });
});

describe('damageTier follows engine status, not invented bands', () => {
  const cases: Array<[string | undefined, number | undefined, DamageTier]> = [
    ['flourishing', 0.9, 'healthy'],
    ['stable', 0.7, 'healthy'],
    ['strained', 0.4, 'damaged'],
    ['collapsed', 0.1, 'collapsed'],
    [undefined, 0.1, 'collapsed'],
    [undefined, 0.5, 'damaged'],
    [undefined, 0.9, 'healthy'],
  ];
  it.each(cases)('status=%s health=%s -> %s', (status, health, expected) => {
    expect(
      damageTier({
        q: 0,
        r: 0,
        terrain: 'river',
        ...(status !== undefined ? { ecosystemStatus: status } : {}),
        ...(health !== undefined ? { ecosystemHealth: health } : {}),
      }),
    ).toBe(expected);
  });
});

describe('derivePollutionFlows is directional and state-driven', () => {
  it('flows from a collapsed water tile to its lowest-health water neighbour', () => {
    const tiles: HexTile[] = [
      tile({ q: 0, r: 0, terrain: 'rivers', ecosystemStatus: 'collapsed', ecosystemHealth: 0.1 }),
      tile({ q: 1, r: 0, terrain: 'rivers', ecosystemStatus: 'strained', ecosystemHealth: 0.3 }),
      tile({ q: -1, r: 0, terrain: 'rivers', ecosystemStatus: 'stable', ecosystemHealth: 0.8 }),
    ];
    const flows = derivePollutionFlows(tiles);
    expect(flows).toHaveLength(2); // collapsed (0,0) and strained (1,0) both emit
    const fromOrigin = flows.find((flow) => flow.fromQ === 0 && flow.fromR === 0);
    expect(fromOrigin).toBeDefined();
    // Lowest-health water neighbour is (1,0) at 0.3, not the healthier (-1,0).
    expect(fromOrigin?.toQ).toBe(1);
    expect(fromOrigin?.toR).toBe(0);
  });

  it('emits nothing when water tiles are healthy', () => {
    const tiles: HexTile[] = [
      tile({ q: 0, r: 0, terrain: 'rivers', ecosystemStatus: 'stable', ecosystemHealth: 0.8 }),
      tile({
        q: 1,
        r: 0,
        terrain: 'rivers',
        ecosystemStatus: 'flourishing',
        ecosystemHealth: 0.95,
      }),
    ];
    expect(derivePollutionFlows(tiles)).toHaveLength(0);
  });

  it('does not route pollution into non-water terrain', () => {
    const tiles: HexTile[] = [
      tile({ q: 0, r: 0, terrain: 'rivers', ecosystemStatus: 'collapsed', ecosystemHealth: 0.1 }),
      tile({ q: 1, r: 0, terrain: 'oil-field', ecosystemStatus: 'strained', ecosystemHealth: 0.2 }),
    ];
    // Only neighbour is oil-field (non-water) -> no downstream sink.
    expect(derivePollutionFlows(tiles)).toHaveLength(0);
  });
});

describe('BoardAccessibilityLayer publishes every visual-only signal as text', () => {
  it('describes terrain, damage tier, pollution and conversions without color', () => {
    useGameStore.setState({
      gameState: {
        ...initialGameState,
        hexGrid: [
          tile({
            q: 0,
            r: 0,
            terrain: 'oil-field',
            ecosystemStatus: 'strained',
            ecosystemHealth: 0.4,
            ecosystemName: 'East Oil Field',
          }),
          tile({
            q: 0,
            r: 1,
            terrain: 'rivers',
            ecosystemStatus: 'collapsed',
            ecosystemHealth: 0.1,
            ecosystemName: 'Lower River',
          }),
          tile({
            q: 1,
            r: 0,
            terrain: 'rivers',
            ecosystemStatus: 'strained',
            ecosystemHealth: 0.3,
            ecosystemName: 'Middle River',
          }),
          tile({
            q: -1,
            r: 0,
            terrain: 'wetland',
            ecosystemStatus: 'flourishing',
            ecosystemHealth: 0.9,
            ecosystemName: 'West Wetland',
          }),
        ],
        pendingAgentInfo: { delta: { name: 'Dax' } },
        lastResolvedActions: [
          {
            playerId: 'delta',
            type: 'convert_timber_to_energy',
            description: 'converted timber into energy',
          },
        ],
      },
    });

    render(<BoardAccessibilityLayer />);

    // Terrain identified by name AND by shape description (not color).
    expect(screen.getByText(/Oil field at column 0, row 0/i)).toBeTruthy();
    expect(screen.getByText(/derrick triangle over a fuel droplet/i)).toBeTruthy();
    // Damage tiers spelled out.
    expect(screen.getByText(/Collapsed, 10% health/i)).toBeTruthy();
    expect(screen.getByText(/Damaged, 40% health/i)).toBeTruthy();
    // Directional downstream pollution as a sentence.
    expect(screen.getAllByText(/Pollution flows from/i).length).toBeGreaterThan(0);
    // Timber-to-energy conversion surfaced with an accessible name (no emoji).
    expect(screen.getByLabelText(/Dax converted timber into energy/i)).toBeTruthy();
  });

  it('renders nothing when the board is empty', () => {
    const { container } = render(<BoardAccessibilityLayer />);
    expect(container.childElementCount).toBe(0);
  });
});
