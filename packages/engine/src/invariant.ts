/**
 * Small runtime-assertion helpers used to avoid `!` non-null assertions.
 *
 * These throw on failure with a useful message so that broken invariants
 * surface as clear errors rather than silent `undefined` propagation.
 */

/**
 * Look up a key in a Map, throwing if the entry is missing.
 *
 * Replacement for `map.get(key)!` where the caller genuinely knows the key
 * must be present but TypeScript can't prove it.
 */
export function mustGet<K, V>(map: Map<K, V> | ReadonlyMap<K, V>, key: K, ctx?: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`mustGet: missing ${String(key)}${ctx ? ` (${ctx})` : ''}`);
  }
  return value;
}

/**
 * Find the first matching element in an array, throwing if none match.
 *
 * Replacement for `arr.find(pred)!`.
 */
export function mustFind<T>(arr: ReadonlyArray<T>, pred: (x: T) => boolean, ctx?: string): T {
  const found = arr.find(pred);
  if (found === undefined) {
    throw new Error(`mustFind: no match${ctx ? ` (${ctx})` : ''}`);
  }
  return found;
}

/**
 * Assert a condition at runtime. Throws with the provided message if falsy.
 * Narrows the condition's type via `asserts cond`.
 */
export function invariant(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`invariant: ${msg}`);
  }
}
