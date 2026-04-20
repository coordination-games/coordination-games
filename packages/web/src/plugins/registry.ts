import type { WebToolPlugin } from './types';

const plugins = new Map<string, WebToolPlugin>();

export function registerWebPlugin(p: WebToolPlugin): void {
  if (plugins.has(p.id)) {
    throw new Error(`WebToolPlugin already registered: ${p.id}`);
  }
  plugins.set(p.id, p);
}

export function getRegisteredWebPlugins(): WebToolPlugin[] {
  return Array.from(plugins.values());
}

/** For tests / Phase 6 sweep. */
export function clearWebPluginRegistry(): void {
  plugins.clear();
}
