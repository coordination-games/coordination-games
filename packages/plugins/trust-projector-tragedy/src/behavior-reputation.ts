import { keccak256CanonicalJson } from '@coordination-games/engine';
import {
  type PublicTragedyArtifact,
  TRAGEDY_BEHAVIOR_REPUTATION_VERSION,
  type TragedyBehaviorEvent,
  type TragedyBehaviorReputation,
  type TragedyBehaviorReputationInput,
} from './behavior-reputation-types.js';

type RecordValue = Readonly<Record<string, unknown>>;
type Tile = Readonly<{ readonly id: string; readonly health: number }>;
type Structure = Readonly<{
  readonly id: string;
  readonly ownerId: string;
  readonly intersectionId: string;
  readonly type: string;
}>;
type Snapshot = Readonly<{
  readonly tiles: readonly Tile[];
  readonly structures: readonly Structure[];
}>;
type RevealedAction = Readonly<{ readonly playerId: string; readonly action: RecordValue }>;
type Reveal = Readonly<{ readonly round: number; readonly actions: readonly RevealedAction[] }>;

export const TRAGEDY_BEHAVIOR_REPUTATION_POLICY =
  'Only a post-reveal solar structure proven newly present is positive; only a sole revealed extraction followed by an observed decline on its tile is negative. Passes, conversions, unknown actions, malformed data, duplicate actors, and pre-reveal submissions are neutral.' as const;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDigest(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
}

function isInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(timestamp) &&
    new Date(value).toISOString() === value
  );
}

function parseArtifact(value: unknown, source: unknown): PublicTragedyArtifact | null {
  if (!isRecord(value) || !text(value.id) || !text(value.digest) || !text(value.observedAt))
    return null;
  if (!isDigest(value.digest) || !isInstant(value.observedAt)) return null;
  const digest = keccak256CanonicalJson(source);
  if (value.digest !== digest) return null;
  return { id: value.id, digest, observedAt: value.observedAt };
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (!isRecord(value) || !Array.isArray(value.tiles) || !Array.isArray(value.structures))
    return null;
  const tiles: Tile[] = [];
  const structures: Structure[] = [];
  for (const tile of value.tiles) {
    if (!isRecord(tile) || !text(tile.id) || !finite(tile.health)) return null;
    tiles.push({ id: tile.id, health: tile.health });
  }
  for (const structure of value.structures) {
    if (
      !isRecord(structure) ||
      !text(structure.id) ||
      !text(structure.ownerId) ||
      !text(structure.intersectionId) ||
      !text(structure.type)
    )
      return null;
    structures.push({
      id: structure.id,
      ownerId: structure.ownerId,
      intersectionId: structure.intersectionId,
      type: structure.type,
    });
  }
  if (new Set(tiles.map((tile) => tile.id)).size !== tiles.length) return null;
  if (new Set(structures.map((structure) => structure.id)).size !== structures.length) return null;
  return { tiles, structures };
}

function parseReveal(value: unknown): Reveal | null {
  if (
    !isRecord(value) ||
    !finite(value.round) ||
    !Number.isSafeInteger(value.round) ||
    value.round < 1 ||
    !Array.isArray(value.actions)
  )
    return null;
  const actions: RevealedAction[] = [];
  for (const entry of value.actions) {
    if (
      !isRecord(entry) ||
      !text(entry.playerId) ||
      !isRecord(entry.action) ||
      !text(entry.action.type)
    )
      return null;
    actions.push({ playerId: entry.playerId, action: entry.action });
  }
  if (new Set(actions.map((entry) => entry.playerId)).size !== actions.length) return null;
  return { round: value.round, actions };
}

function empty(): TragedyBehaviorReputation {
  return { version: TRAGEDY_BEHAVIOR_REPUTATION_VERSION, events: [] };
}

function solarEffect(action: RevealedAction, previous: Snapshot, current: Snapshot): boolean {
  if (action.action.type !== 'build_structure') return false;
  if (!text(action.action.intersectionId) || !text(action.action.structureType)) return false;
  if (action.action.structureType !== 'solar-farm' && action.action.structureType !== 'solar-array')
    return false;
  return current.structures.some(
    (structure) =>
      structure.ownerId === action.playerId &&
      structure.intersectionId === action.action.intersectionId &&
      structure.type === action.action.structureType &&
      !previous.structures.some(
        (prior) =>
          prior.ownerId === structure.ownerId &&
          prior.intersectionId === structure.intersectionId &&
          prior.type === structure.type,
      ),
  );
}

function extractionEffect(
  action: RevealedAction,
  actions: readonly RevealedAction[],
  previous: Snapshot,
  current: Snapshot,
): boolean {
  if (
    action.action.type !== 'extract_tile' ||
    !text(action.action.tileId) ||
    !text(action.action.level)
  )
    return false;
  if (actions.filter((entry) => entry.action.type === 'extract_tile').length !== 1) return false;
  const before = previous.tiles.find((tile) => tile.id === action.action.tileId);
  const after = current.tiles.find((tile) => tile.id === action.action.tileId);
  return before !== undefined && after !== undefined && after.health < before.health;
}

function event(
  gameId: string,
  reveal: Reveal,
  action: RevealedAction,
  outcome: TragedyBehaviorEvent['outcome'],
  behavior: TragedyBehaviorEvent['behavior'],
  evidence: TragedyBehaviorEvent['evidence'],
): TragedyBehaviorEvent {
  return {
    version: TRAGEDY_BEHAVIOR_REPUTATION_VERSION,
    id: `${gameId}:${reveal.round}:${action.playerId}:${behavior}`,
    gameId,
    round: reveal.round,
    subjectPlayerId: action.playerId,
    outcome,
    behavior,
    evidence,
  };
}

export function deriveTragedyBehaviorReputation(
  input: TragedyBehaviorReputationInput,
): TragedyBehaviorReputation {
  if (!text(input.gameId)) return empty();
  const reveal = parseReveal(input.reveal);
  const previous = parseSnapshot(input.previousPublicSnapshot);
  const current = parseSnapshot(input.postRevealSnapshot);
  if (!reveal || !previous || !current) return empty();
  const canonicalReveal = {
    round: reveal.round,
    actions: [...reveal.actions].sort((left, right) => left.playerId.localeCompare(right.playerId)),
  };
  const revealArtifact = parseArtifact(input.revealArtifact, canonicalReveal);
  const postRevealArtifact = parseArtifact(input.postRevealArtifact, input.postRevealSnapshot);
  const previousArtifact = parseArtifact(
    input.previousSnapshotArtifact,
    input.previousPublicSnapshot,
  );
  if (!revealArtifact || !postRevealArtifact || !previousArtifact) return empty();
  const evidence = {
    reveal: revealArtifact,
    postRevealSnapshot: postRevealArtifact,
    previousPublicSnapshot: previousArtifact,
  };
  const events = reveal.actions.flatMap((action) => {
    if (solarEffect(action, previous, current))
      return [
        event(input.gameId, reveal, action, 'positive', 'renewable-infrastructure', evidence),
      ];
    if (extractionEffect(action, reveal.actions, previous, current))
      return [event(input.gameId, reveal, action, 'negative', 'ecological-decline', evidence)];
    return [];
  });
  return {
    version: TRAGEDY_BEHAVIOR_REPUTATION_VERSION,
    events: events.sort((left, right) => left.id.localeCompare(right.id)),
  };
}
