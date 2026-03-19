import { Hex, Direction, hexEquals, hexToString } from './hex.js';
import { UnitClass, CLASS_SPEED, MoveUnit, MoveSubmission, validatePath, resolveMovements } from './movement.js';
import { GameMap, TileType } from './map.js';
import { VisibleTile, FogUnit, buildVisibleState } from './fog.js';
import { CombatUnit, resolveCombat } from './combat.js';

export interface GameUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
  position: Hex;
  alive: boolean;
  carryingFlag: boolean;
}

export interface FlagState {
  team: 'A' | 'B';
  position: Hex;
  carried: boolean;
  carrierId?: string;
}

export interface TeamMessage {
  from: string;
  message: string;
  turn: number;
}

export interface TurnRecord {
  turn: number;
  moves: Map<string, Direction[]>;
  unitPositionsBefore: Map<string, Hex>;
  unitPositionsAfter: Map<string, Hex>;
  kills: { killerId: string; victimId: string; reason: string }[];
  flagEvents: string[];
  messages: TeamMessage[];
}

export type GamePhase = 'pre_game' | 'in_progress' | 'finished';

export interface GameState {
  turn: number;
  phase: GamePhase;
  yourUnit: {
    id: string;
    unitClass: UnitClass;
    position: Hex;
    carryingFlag: boolean;
    alive: boolean;
  };
  visibleTiles: VisibleTile[];
  yourFlag: { status: 'at_base' | 'carried' | 'unknown' };
  enemyFlag: { status: 'at_base' | 'carried_by_you' | 'carried_by_ally' | 'unknown' };
  messagesSinceLastCheck: TeamMessage[];
  timeRemainingSeconds: number;
  moveSubmitted: boolean;
  score: { yourTeam: number; enemyTeam: number };
}

export interface GameConfig {
  turnLimit?: number;
  turnTimerSeconds?: number;
  teamSize?: number;
}

const DEFAULT_CONFIG: Required<GameConfig> = {
  turnLimit: 30,
  turnTimerSeconds: 30,
  teamSize: 4,
};

export class GameManager {
  readonly gameId: string;
  readonly map: GameMap;
  readonly config: Required<GameConfig>;

  units: GameUnit[];
  flags: { A: FlagState; B: FlagState };
  turn: number;
  phase: GamePhase;
  winner: 'A' | 'B' | null;
  score: { A: number; B: number };

  moveSubmissions: Map<string, Direction[]>;
  teamMessages: { A: TeamMessage[]; B: TeamMessage[] };
  private turnHistory: TurnRecord[];
  private lastCheckedTurn: Map<string, number>;

  // Precomputed sets for performance
  private wallSet: Set<string>;
  private validTiles: Set<string>;

  constructor(
    gameId: string,
    map: GameMap,
    players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[],
    config?: GameConfig,
  ) {
    this.gameId = gameId;
    this.map = map;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Precompute wall set and valid tiles
    this.wallSet = new Set<string>();
    this.validTiles = new Set<string>();
    for (const [key, type] of map.tiles) {
      if (type === 'wall') {
        this.wallSet.add(key);
      } else {
        this.validTiles.add(key);
      }
    }

    // Create units at spawn positions
    const spawnIndexA = { current: 0 };
    const spawnIndexB = { current: 0 };

    this.units = players.map((p) => {
      const spawns = map.bases[p.team].spawns;
      const spawnIdx = p.team === 'A' ? spawnIndexA : spawnIndexB;
      const position = spawns[spawnIdx.current % spawns.length];
      spawnIdx.current++;

      return {
        id: p.id,
        team: p.team,
        unitClass: p.unitClass,
        position: { ...position },
        alive: true,
        carryingFlag: false,
      };
    });

    // Initialize flags at base positions
    this.flags = {
      A: {
        team: 'A',
        position: { ...map.bases.A.flag },
        carried: false,
      },
      B: {
        team: 'B',
        position: { ...map.bases.B.flag },
        carried: false,
      },
    };

    this.turn = 0;
    this.phase = 'in_progress';
    this.winner = null;
    this.score = { A: 0, B: 0 };

    this.moveSubmissions = new Map();
    this.teamMessages = { A: [], B: [] };
    this.turnHistory = [];
    this.lastCheckedTurn = new Map();
  }

  getStateForAgent(agentId: string): GameState {
    const unit = this.units.find((u) => u.id === agentId);
    if (!unit) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const team = unit.team;
    const enemyTeam: 'A' | 'B' = team === 'A' ? 'B' : 'A';

    // Build fog units for visibility calculation
    const fogUnits: FogUnit[] = this.units.map((u) => ({
      id: u.id,
      team: u.team,
      unitClass: u.unitClass,
      position: u.position,
      alive: u.alive,
    }));

    const viewer: FogUnit = {
      id: unit.id,
      team: unit.team,
      unitClass: unit.unitClass,
      position: unit.position,
      alive: unit.alive,
    };

    const flagsForFog = {
      A: {
        position: this.flags.A.position,
        carried: this.flags.A.carried,
        carrierId: this.flags.A.carrierId,
      },
      B: {
        position: this.flags.B.position,
        carried: this.flags.B.carried,
        carrierId: this.flags.B.carrierId,
      },
    };

    const visibleTiles = buildVisibleState(
      viewer,
      fogUnits,
      this.wallSet,
      this.map.tiles,
      flagsForFog,
    );

    // Determine your flag status
    const yourFlag = this.flags[team];
    let yourFlagStatus: 'at_base' | 'carried' | 'unknown';
    if (!yourFlag.carried) {
      // Flag is at its base position
      yourFlagStatus = 'at_base';
    } else {
      // Flag is being carried by an enemy
      yourFlagStatus = 'carried';
    }

    // Determine enemy flag status
    const enemyFlag = this.flags[enemyTeam];
    let enemyFlagStatus: 'at_base' | 'carried_by_you' | 'carried_by_ally' | 'unknown';
    if (enemyFlag.carried && enemyFlag.carrierId === agentId) {
      enemyFlagStatus = 'carried_by_you';
    } else if (enemyFlag.carried && enemyFlag.carrierId) {
      const carrier = this.units.find((u) => u.id === enemyFlag.carrierId);
      if (carrier && carrier.team === team) {
        enemyFlagStatus = 'carried_by_ally';
      } else {
        enemyFlagStatus = 'unknown';
      }
    } else if (!enemyFlag.carried) {
      // Check if enemy flag hex is visible
      const enemyFlagKey = hexToString(enemyFlag.position);
      const isVisible = visibleTiles.some(
        (t) => hexToString({ q: t.q, r: t.r }) === enemyFlagKey,
      );
      enemyFlagStatus = isVisible ? 'at_base' : 'unknown';
    } else {
      enemyFlagStatus = 'unknown';
    }

    // Get messages since last check
    const lastCheck = this.lastCheckedTurn.get(agentId) ?? -1;
    const messages = this.teamMessages[team].filter((m) => m.turn > lastCheck);
    this.lastCheckedTurn.set(agentId, this.turn);

    return {
      turn: this.turn,
      phase: this.phase,
      yourUnit: {
        id: unit.id,
        unitClass: unit.unitClass,
        position: { ...unit.position },
        carryingFlag: unit.carryingFlag,
        alive: unit.alive,
      },
      visibleTiles,
      yourFlag: { status: yourFlagStatus },
      enemyFlag: { status: enemyFlagStatus },
      messagesSinceLastCheck: messages,
      timeRemainingSeconds: this.config.turnTimerSeconds,
      moveSubmitted: this.moveSubmissions.has(agentId),
      score: {
        yourTeam: this.score[team],
        enemyTeam: this.score[enemyTeam],
      },
    };
  }

  submitMove(agentId: string, path: Direction[]): { success: boolean; error?: string } {
    if (this.phase !== 'in_progress') {
      return { success: false, error: 'Game is not in progress' };
    }

    const unit = this.units.find((u) => u.id === agentId);
    if (!unit) {
      return { success: false, error: `Unknown agent: ${agentId}` };
    }

    if (!unit.alive) {
      return { success: false, error: 'Dead units cannot move' };
    }

    // Validate path length against class speed
    const moveUnit: MoveUnit = {
      id: unit.id,
      team: unit.team,
      unitClass: unit.unitClass,
      position: unit.position,
    };
    const validation = validatePath(moveUnit, path);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    this.moveSubmissions.set(agentId, path);
    return { success: true };
  }

  submitChat(agentId: string, message: string): void {
    const unit = this.units.find((u) => u.id === agentId);
    if (!unit) return;

    const msg: TeamMessage = {
      from: agentId,
      message,
      turn: this.turn,
    };
    this.teamMessages[unit.team].push(msg);
  }

  getTeamMessages(agentId: string, sinceTurn?: number): TeamMessage[] {
    const unit = this.units.find((u) => u.id === agentId);
    if (!unit) return [];

    const since = sinceTurn ?? 0;
    return this.teamMessages[unit.team].filter((m) => m.turn >= since);
  }

  allMovesSubmitted(): boolean {
    const aliveUnits = this.units.filter((u) => u.alive);
    return aliveUnits.every((u) => this.moveSubmissions.has(u.id));
  }

  resolveTurn(): TurnRecord {
    const currentTurn = this.turn;

    // 1. Record pre-move positions
    const unitPositionsBefore = new Map<string, Hex>();
    for (const unit of this.units) {
      unitPositionsBefore.set(unit.id, { ...unit.position });
    }

    // 2. Build MoveUnit and MoveSubmission arrays
    const moveUnits: MoveUnit[] = [];
    const submissions: MoveSubmission[] = [];

    for (const unit of this.units) {
      if (!unit.alive) continue;

      moveUnits.push({
        id: unit.id,
        team: unit.team,
        unitClass: unit.unitClass,
        position: { ...unit.position },
      });

      const path = this.moveSubmissions.get(unit.id) ?? [];
      submissions.push({ unitId: unit.id, path });
    }

    // Record moves for the turn record
    const moves = new Map<string, Direction[]>();
    for (const [id, path] of this.moveSubmissions) {
      moves.set(id, [...path]);
    }

    // 3. Resolve movements
    const moveResults = resolveMovements(moveUnits, submissions, this.validTiles);

    // 4. Update unit positions
    for (const result of moveResults) {
      const unit = this.units.find((u) => u.id === result.unitId)!;
      unit.position = { ...result.to };

      // If unit is carrying a flag, update flag position too
      if (unit.carryingFlag) {
        const carriedFlag = unit.team === 'A' ? this.flags.B : this.flags.A;
        if (carriedFlag.carrierId === unit.id) {
          carriedFlag.position = { ...result.to };
        }
      }
    }

    // 5. Resolve combat
    const combatUnits: CombatUnit[] = this.units
      .filter((u) => u.alive)
      .map((u) => ({
        id: u.id,
        team: u.team,
        unitClass: u.unitClass,
        position: { ...u.position },
      }));

    const combatResult = resolveCombat(combatUnits, this.wallSet);

    // 6. Process deaths
    const flagEvents: string[] = [];

    for (const deadId of combatResult.deaths) {
      const unit = this.units.find((u) => u.id === deadId)!;
      unit.alive = false;

      // If carrying a flag, drop it back to its home base
      if (unit.carryingFlag) {
        unit.carryingFlag = false;
        const droppedFlag = unit.team === 'A' ? this.flags.B : this.flags.A;
        droppedFlag.carried = false;
        droppedFlag.carrierId = undefined;
        droppedFlag.position = { ...this.map.bases[droppedFlag.team].flag };
        flagEvents.push(
          `${unit.id} died carrying ${droppedFlag.team}'s flag — flag returned to base`,
        );
      }
    }

    // 7. Check flag pickups
    for (const unit of this.units) {
      if (!unit.alive) continue;

      const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
      const enemyFlag = this.flags[enemyTeam];

      if (
        !enemyFlag.carried &&
        hexEquals(unit.position, enemyFlag.position)
      ) {
        enemyFlag.carried = true;
        enemyFlag.carrierId = unit.id;
        unit.carryingFlag = true;
        flagEvents.push(`${unit.id} picked up ${enemyTeam}'s flag`);
      }
    }

    // 8. Check win condition — carrier reaches own base flag hex
    let scored = false;
    for (const unit of this.units) {
      if (!unit.alive || !unit.carryingFlag) continue;

      const homeBase = this.map.bases[unit.team].flag;
      if (hexEquals(unit.position, homeBase)) {
        this.score[unit.team]++;
        flagEvents.push(
          `${unit.id} captured the flag! Team ${unit.team} scores!`,
        );

        // Reset the captured flag
        const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
        const capturedFlag = this.flags[enemyTeam];
        capturedFlag.carried = false;
        capturedFlag.carrierId = undefined;
        capturedFlag.position = { ...this.map.bases[enemyTeam].flag };
        unit.carryingFlag = false;

        this.phase = 'finished';
        this.winner = unit.team;
        scored = true;
        break;
      }
    }

    // 9. Prepare for next turn
    // Respawn dead units at team spawn hexes
    const spawnCountA = { current: 0 };
    const spawnCountB = { current: 0 };

    for (const unit of this.units) {
      if (unit.alive) continue;

      const spawns = this.map.bases[unit.team].spawns;
      const counter = unit.team === 'A' ? spawnCountA : spawnCountB;
      unit.position = { ...spawns[counter.current % spawns.length] };
      counter.current++;
      unit.alive = true;
    }

    // Record post-move positions
    const unitPositionsAfter = new Map<string, Hex>();
    for (const unit of this.units) {
      unitPositionsAfter.set(unit.id, { ...unit.position });
    }

    // Collect messages for this turn
    const turnMessages = [
      ...this.teamMessages.A.filter((m) => m.turn === currentTurn),
      ...this.teamMessages.B.filter((m) => m.turn === currentTurn),
    ];

    // Build turn record
    const record: TurnRecord = {
      turn: currentTurn,
      moves,
      unitPositionsBefore,
      unitPositionsAfter,
      kills: combatResult.kills,
      flagEvents,
      messages: turnMessages,
    };
    this.turnHistory.push(record);

    // Clear move submissions
    this.moveSubmissions.clear();

    // Increment turn
    this.turn++;

    // Check turn limit (draw)
    if (!scored && this.turn > this.config.turnLimit) {
      this.phase = 'finished';
      this.winner = null;
    }

    return record;
  }

  getTurnHistory(): TurnRecord[] {
    return this.turnHistory;
  }

  isGameOver(): boolean {
    return this.phase === 'finished';
  }
}
