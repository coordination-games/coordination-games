/**
 * Narrated feed for one game — the Watch page's "playing" phase. Proxies the
 * game server's admin-inspect endpoint (X-Admin-Token stays server-side, the
 * browser never sees it) and reduces its relay to a flat, chronological,
 * human-narratable event list plus a headline health meter.
 *
 * This is a narrowed port of buildEvents() in the reference InspectorPage
 * (packages/web/src/pages/InspectorPage.tsx, main checkout, ~lines 164-273):
 * same type→category mapping and handle resolution, restricted to
 * gameInspect.relayMessages (the Watch page doesn't need the reference's
 * extra synthetic state/action events) and reshaped to the wire shape below.
 */

import { HttpError } from './paths.js';
import { inspectorToken } from './secrets.js';

const GAME_SERVER = 'http://localhost:8787';

/** Loose but safe: game ids are UUIDs; reject anything else before it reaches a URL. */
const GAME_ID_RE = /^[0-9a-f-]{8,64}$/i;

export type NarratedKind = 'chat' | 'action' | 'reasoning' | 'trust' | 'system';

export interface NarratedEvent {
  i: number;
  t: number;
  kind: NarratedKind;
  actor: string | null;
  body: string;
  scope: string;
}

export interface LiveMeter {
  label: string;
  percent: number;
}

export interface LiveFeed {
  events: NarratedEvent[];
  meter: LiveMeter | null;
}

// --- payload shape helpers (the inspect payload is untyped JSON over the wire) --

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function handleFor(id: string, handles: Record<string, string>): string {
  const handle = handles[id] ?? id;
  const cleaned = handle.replace(/_/g, ' ').trim();
  return cleaned || id;
}

/** Mirrors summarizeRelayScope() in the reference InspectorPage. */
function summarizeScope(scope: unknown): string {
  if (typeof scope === 'string') return scope === 'all' ? 'public' : `dm → ${scope}`;
  const s = toRecord(scope);
  const kind = typeof s.kind === 'string' ? s.kind : 'all';
  if (kind === 'dm') return `dm → ${String(s.recipientHandle ?? 'unknown')}`;
  if (kind === 'team') return `team ${String(s.teamId ?? '')}`.trim();
  return 'public';
}

/** Attestations are the trust-projector plugin's per-action commitments — narrate
 * the subject's action rather than dumping the claim envelope. */
function summarizeAttestation(
  data: Record<string, unknown>,
  handles: Record<string, string>,
): { actor: string | null; body: string } {
  const claim = toRecord(data.claim);
  const claimData = toRecord(claim.data);
  const subject = typeof data.subject === 'string' ? data.subject : undefined;
  const actor = subject ? handleFor(subject, handles) : null;
  const actionType =
    typeof claimData.actionType === 'string' ? claimData.actionType.replace(/_/g, ' ') : null;
  const round = typeof claimData.round === 'number' ? ` (round ${claimData.round})` : '';
  return { actor, body: actionType ? `committed to ${actionType}${round}` : 'made a commitment' };
}

function buildNarratedEvents(relay: unknown[], handles: Record<string, string>): NarratedEvent[] {
  const events: NarratedEvent[] = [];
  for (const [fallbackIndex, raw] of relay.entries()) {
    const msg = toRecord(raw);
    const type = typeof msg.type === 'string' ? msg.type : 'unknown';
    const i = typeof msg.index === 'number' ? msg.index : fallbackIndex;
    const t = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
    const sender = typeof msg.sender === 'string' ? msg.sender : 'system';
    const data = toRecord(msg.data);
    const scope = summarizeScope(msg.scope);

    if (type === 'reasoning') {
      events.push({
        i,
        t,
        kind: 'reasoning',
        actor: handleFor(sender, handles),
        body: typeof data.body === 'string' ? data.body : '',
        scope,
      });
      continue;
    }
    if (type === 'attestation') {
      const { actor, body } = summarizeAttestation(data, handles);
      events.push({ i, t, kind: 'trust', actor, body, scope });
      continue;
    }
    if (type === 'messaging') {
      const body = typeof data.body === 'string' ? data.body : '';
      events.push(
        sender === 'system'
          ? { i, t, kind: 'system', actor: null, body, scope }
          : { i, t, kind: 'chat', actor: handleFor(sender, handles), body, scope },
      );
      continue;
    }
    // Any other plugin-published relay type: narrate as a quiet action line
    // rather than dropping it silently.
    events.push({
      i,
      t,
      kind: 'action',
      actor: sender === 'system' ? null : handleFor(sender, handles),
      body: typeof data.body === 'string' ? data.body : type.replace(/[._]/g, ' '),
      scope,
    });
  }
  return events;
}

/** The harness's buildOutcome() computes commonsHealthPercent from the same
 * tile data every game-agnostic consumer (findings.ts) reads; gameInspect
 * carries the live equivalent at summary/outcome.commonsHealthPercent while
 * the game is still in progress. Fall back to averaging tile health directly
 * for any game type that doesn't publish that summary field. */
function extractMeter(gameInspect: Record<string, unknown>): LiveMeter | null {
  const summaryPercent = toRecord(gameInspect.summary).commonsHealthPercent;
  if (typeof summaryPercent === 'number') {
    return { label: 'commons health', percent: Math.round(summaryPercent) };
  }
  const outcomePercent = toRecord(gameInspect.outcome).commonsHealthPercent;
  if (typeof outcomePercent === 'number') {
    return { label: 'commons health', percent: Math.round(outcomePercent) };
  }
  const tiles = toRecord(gameInspect.gameState).tiles;
  if (Array.isArray(tiles) && tiles.length > 0) {
    let health = 0;
    let max = 0;
    for (const raw of tiles) {
      const tile = toRecord(raw);
      if (typeof tile.health === 'number' && typeof tile.maxHealth === 'number') {
        health += tile.health;
        max += tile.maxHealth;
      }
    }
    if (max > 0) return { label: 'commons health', percent: Math.round((health / max) * 100) };
  }
  return null;
}

/** Fetch + transform one game's narrated feed. `since` filters to events with
 * index > since (pass -1 for the full history). Never throws a raw fetch/JSON
 * error — every failure path becomes a plain-English HttpError. */
export async function fetchLiveFeed(gameId: string, since: number): Promise<LiveFeed> {
  if (!GAME_ID_RE.test(gameId))
    throw new HttpError(400, `invalid game id: ${JSON.stringify(gameId)}`);

  const token = await inspectorToken();
  let res: Response;
  try {
    res = await fetch(`${GAME_SERVER}/api/admin/session/${encodeURIComponent(gameId)}/inspect`, {
      headers: { 'X-Admin-Token': token },
    });
  } catch {
    throw new HttpError(503, 'The game server is not reachable — is it running?');
  }
  if (res.status === 401 || res.status === 503) {
    throw new HttpError(
      503,
      'The console and the game server disagree on the inspector token — check settings.',
    );
  }
  if (res.status === 404) throw new HttpError(404, `game not found: ${gameId}`);
  if (!res.ok) throw new HttpError(502, 'The game server returned an unexpected error.');

  const payload = toRecord(await res.json().catch(() => null));
  const gameInspect = payload.gameInspect;
  if (!isRecord(gameInspect) || typeof gameInspect.error === 'string') {
    throw new HttpError(404, `game not found: ${gameId}`);
  }

  const handles: Record<string, string> = {};
  const handleMap = toRecord(toRecord(gameInspect.meta).handleMap);
  for (const [id, handle] of Object.entries(handleMap)) {
    if (typeof handle === 'string') handles[id] = handle;
  }

  const relay = Array.isArray(gameInspect.relayMessages) ? gameInspect.relayMessages : [];
  const events = buildNarratedEvents(relay, handles).filter((e) => e.i > since);
  return { events, meter: extractMeter(gameInspect) };
}
