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
        .map((p) => {
          const Comp = p.slots[name];
          if (!Comp) return null;
          return <Fragment key={p.id}>{<Comp {...rest} />}</Fragment>;
        })}
    </>
  );
}
