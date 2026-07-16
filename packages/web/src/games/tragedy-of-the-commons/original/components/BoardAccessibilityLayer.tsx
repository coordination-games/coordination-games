import { useMemo } from 'react';
import { damageTier, damageTierLabel, derivePollutionFlows } from '../lib/board-vfx';
import { motifDescription, terrainMotif } from '../lib/tile-motifs';
import { useGameStore } from '../store';
import { TimberEnergyIcon } from './TimberEnergyIcon';

const TERRAIN_LABEL: Record<string, string> = {
  'oil-field': 'Oil field',
  river: 'River',
  rivers: 'River',
  wetland: 'Wetland',
  wetlands: 'Wetland',
  forest: 'Forest',
  mountains: 'Mountains',
  commons: 'Commons',
  plains: 'Plains',
  wasteland: 'Wasteland',
};

function terrainLabel(terrain: string | undefined): string {
  return TERRAIN_LABEL[terrain ?? ''] ?? TERRAIN_LABEL[terrainMotif(terrain)] ?? 'Unknown terrain';
}

function healthText(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'health unknown';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% health`;
}

// The board is painted to a <canvas>, which is opaque to assistive tech. This
// layer republishes every visual-only signal (terrain by shape, damage tier,
// downstream pollution direction, timber-to-energy conversions) as semantic
// text and a visible legend, so nothing depends on colour or animation.
export function BoardAccessibilityLayer() {
  const hexGrid = useGameStore((state) => state.gameState.hexGrid);
  const actions = useGameStore((state) => state.gameState.lastResolvedActions);
  const handles = useGameStore((state) => state.gameState.pendingAgentInfo);

  const tiles = useMemo(
    () => [...hexGrid].sort((left, right) => left.r - right.r || left.q - right.q),
    [hexGrid],
  );
  const pollutionFlows = useMemo(() => derivePollutionFlows(tiles), [tiles]);
  const conversions = useMemo(
    () => actions.filter((action) => action.type === 'convert_timber_to_energy'),
    [actions],
  );

  const tileByKey = useMemo(
    () => new Map(tiles.map((tile) => [`${tile.q},${tile.r}`, tile] as const)),
    [tiles],
  );

  if (tiles.length === 0) return null;

  return (
    <section aria-label="Board state described in text" className="mt-3">
      <h3 className="sr-only">Tile-by-tile board description</h3>
      <ul className="sr-only">
        {tiles.map((tile) => {
          const tier = damageTier(tile);
          return (
            <li key={`${tile.q},${tile.r}`}>
              {terrainLabel(tile.terrain)} at column {tile.q}, row {tile.r}. Shown as{' '}
              {motifDescription(tile.terrain)}. {damageTierLabel(tier)},{' '}
              {healthText(tile.ecosystemHealth)}.
              {tile.ecosystemName ? ` Ecosystem: ${tile.ecosystemName}.` : ''}
            </li>
          );
        })}
      </ul>

      {pollutionFlows.length > 0 ? (
        <div className="sr-only">
          <h3>Downstream pollution</h3>
          <ul>
            {pollutionFlows.map((flow) => {
              const from = tileByKey.get(`${flow.fromQ},${flow.fromR}`);
              const to = tileByKey.get(`${flow.toQ},${flow.toR}`);
              return (
                <li key={`${flow.fromQ},${flow.fromR}->${flow.toQ},${flow.toR}`}>
                  Pollution flows from {terrainLabel(from?.terrain)} ({flow.fromQ}, {flow.fromR})
                  downstream into {terrainLabel(to?.terrain)} ({flow.toQ}, {flow.toR}).
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {conversions.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-soft)]">
            Conversions
          </span>
          {conversions.map((action) => {
            const name = handles[action.playerId]?.name ?? action.playerId;
            return (
              <span
                key={`conversion-${action.playerId}-${action.description}`}
                className="inline-flex items-center gap-1 rounded-full border border-[rgba(233,220,190,0.16)] bg-[rgba(255,255,255,0.04)] px-2 py-1"
              >
                <span className="text-[color:var(--color-energy,#e4b45a)]">
                  <TimberEnergyIcon size={16} title={`${name} converted timber into energy`} />
                </span>
                <span>{name}: timber to energy</span>
              </span>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
