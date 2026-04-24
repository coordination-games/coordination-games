import { Fragment } from 'react';
import { getRegisteredWebPlugins } from './registry';
import type { SlotName, SlotProps } from './types';

/**
 * Render every plugin's component for a named slot. Plugins are rendered in
 * registration order; each receives the same {@link SlotProps}.
 *
 * Shells call this at well-known locations (e.g. <SlotHost name="lobby:panel"
 * lobbyId={id} />) and stay agnostic of which plugins exist.
 */
export function SlotHost(props: { name: SlotName } & SlotProps) {
  const { name, ...rest } = props;
  const all = getRegisteredWebPlugins();
  return (
    <>
      {all
        .filter((p) => p.slots[name])
        // gameType filter: universal plugins (no gameType) always pass.
        // Game-specific plugins only render when the slot's gameType matches.
        // If the slot has no gameType, treat game-specific plugins as
        // unconditional too — universal slots like `lobby:panel` should still
        // get every plugin's panel.
        .filter((p) => !p.gameType || !rest.gameType || p.gameType === rest.gameType)
        .map((p) => {
          const Comp = p.slots[name];
          if (!Comp) return null;
          return <Fragment key={p.id}>{<Comp {...rest} />}</Fragment>;
        })}
    </>
  );
}
