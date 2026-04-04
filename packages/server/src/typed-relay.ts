/**
 * Typed Relay — scope-based message routing between agents.
 *
 * The relay is a dumb pipe. It routes by scope only (team/all/agentId).
 * It does NOT filter by pluginId or type. Agents receive ALL scoped data.
 * Client-side pipelines match messages to plugins by capability type.
 *
 * Messages are stored in an append-only log for:
 * - Cursor-based delivery to agents (fetch since last cursor)
 * - Delayed delivery to spectators
 * - Replay/verification
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A message flowing through the relay. */
export interface RelayMessage {
  /** Capability type from schema registry (e.g. "messaging", "vision-update") */
  type: string;
  /** Payload — opaque to the relay */
  data: unknown;
  /** Routing scope: team, all, or specific agentId */
  scope: 'team' | 'all' | string;
  /** Which plugin sent this — provenance metadata, NOT used for routing */
  pluginId: string;

  // --- Stamped by the relay (server-authoritative) ---
  /** agentId of sender */
  sender: string;
  /** Turn number when sent */
  turn: number;
  /** Server timestamp (epoch ms) */
  timestamp: number;
  /** Sequential message index in the log */
  index: number;
}

/** Input from client when sending a relay message. */
export interface RelaySendInput {
  type: string;
  data: unknown;
  scope: 'team' | 'all' | string;
  pluginId: string;
}

// ---------------------------------------------------------------------------
// GameRelay — one per game room
// ---------------------------------------------------------------------------

export class GameRelay {
  private log: RelayMessage[] = [];
  /** agentId -> team mapping for scope routing */
  private teams: Map<string, string> = new Map();
  /** All agentIds in this game */
  private agents: Set<string> = new Set();
  /** Per-agent cursor: last message index delivered */
  private cursors: Map<string, number> = new Map();

  constructor(
    agents: { id: string; team: string }[],
  ) {
    for (const agent of agents) {
      this.teams.set(agent.id, agent.team);
      this.agents.add(agent.id);
      this.cursors.set(agent.id, 0);
    }
  }

  /**
   * Send a message through the relay.
   * Stamps sender, turn, timestamp, and index. Routes by scope only.
   */
  send(
    sender: string,
    turn: number,
    input: RelaySendInput,
  ): RelayMessage {
    const msg: RelayMessage = {
      type: input.type,
      data: input.data,
      scope: input.scope,
      pluginId: input.pluginId,
      sender,
      turn,
      timestamp: Date.now(),
      index: this.log.length,
    };
    this.log.push(msg);
    return msg;
  }

  /**
   * Get new messages for an agent since their cursor.
   * Advances the cursor. Filters by scope:
   * - 'all' messages are always included
   * - 'team' messages only if sender is on the same team
   * - agentId-scoped messages only if they match this agent
   */
  receive(agentId: string): RelayMessage[] {
    const cursor = this.cursors.get(agentId) ?? 0;
    const agentTeam = this.teams.get(agentId);
    const messages: RelayMessage[] = [];

    for (let i = cursor; i < this.log.length; i++) {
      const msg = this.log[i];

      // Don't deliver your own messages back to you
      if (msg.sender === agentId) continue;

      if (msg.scope === 'all') {
        messages.push(msg);
      } else if (msg.scope === 'team') {
        const senderTeam = this.teams.get(msg.sender);
        if (senderTeam === agentTeam) {
          messages.push(msg);
        }
      } else {
        // DM — scope is a specific agentId
        if (msg.scope === agentId) {
          messages.push(msg);
        }
      }
    }

    // Advance cursor
    this.cursors.set(agentId, this.log.length);
    return messages;
  }

  /**
   * Peek at messages without advancing cursor (for polling checks).
   */
  hasNewMessages(agentId: string): boolean {
    const cursor = this.cursors.get(agentId) ?? 0;
    const agentTeam = this.teams.get(agentId);

    for (let i = cursor; i < this.log.length; i++) {
      const msg = this.log[i];
      if (msg.sender === agentId) continue;

      if (msg.scope === 'all') return true;
      if (msg.scope === 'team' && this.teams.get(msg.sender) === agentTeam) return true;
      if (msg.scope === agentId) return true;
    }
    return false;
  }

  /**
   * Get all messages for spectators, up to a given turn (for delayed view).
   * No scope filtering — spectators see everything.
   */
  getSpectatorMessages(upToTurn: number): RelayMessage[] {
    return this.log.filter((msg) => msg.turn <= upToTurn);
  }

  /**
   * Get all messages (no filtering). For replay/verification.
   */
  getAllMessages(): RelayMessage[] {
    return [...this.log];
  }

  /** Get the total message count. */
  get length(): number {
    return this.log.length;
  }
}
