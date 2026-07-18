import type { RunSpec } from './types.js';

export function parseAnalysis(raw: unknown): RunSpec['analysis'] {
  if (!isRecord(raw)) return undefined;
  const enabled = raw.enabled !== false;
  const model =
    typeof raw.model === 'string' && raw.model.trim()
      ? raw.model.trim()
      : 'anthropic/claude-sonnet';
  return { enabled, model };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
