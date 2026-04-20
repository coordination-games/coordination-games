export interface VisibleTile {
  q: number;
  r: number;
  type: 'ground' | 'wall' | 'base_a' | 'base_b';
  unit?: {
    id?: string;
    team: 'A' | 'B';
    unitClass: 'rogue' | 'knight' | 'mage';
    carryingFlag?: boolean;
    alive?: boolean;
    respawnTurn?: number;
  };
  flag?: { team: 'A' | 'B' };
}

export interface KillEvent {
  killerId: string;
  killerClass: string;
  killerTeam: 'A' | 'B';
  victimId: string;
  victimClass: string;
  victimTeam: 'A' | 'B';
  reason: string;
  turn: number;
}

export interface ChatMessage {
  from: string;
  message: string;
  turn: number;
  team?: 'A' | 'B';
}

export interface SpectatorGameState {
  turn: number;
  maxTurns: number;
  phase: 'pre_game' | 'in_progress' | 'finished';
  timeRemaining: number;
  tiles: VisibleTile[];
  kills: KillEvent[];
  chatA: ChatMessage[];
  chatB: ChatMessage[];
  flagA: { status: string };
  flagB: { status: string };
  winner?: 'A' | 'B' | null;
  mapRadius: number;
  /** Maps agent IDs to display names */
  handles?: Record<string, string>;
  /** Per-unit vision for spectator drill-down */
  visibleByUnit?: Record<string, Set<string>>;
  /** Team A visible hex keys */
  visibleA?: Set<string>;
  /** Team B visible hex keys */
  visibleB?: Set<string>;
  /** Post-move positions for units killed this turn (unitId → {q, r} where they died) */
  deathPositions?: Record<string, { q: number; r: number }>;
}
