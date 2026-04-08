/**
 * Comedy of the Commons — Pure game functions
 *
 * All game logic is pure: state in, state out.
 */

import type { ActionResult } from '@coordination-games/engine';
import type {
  ComedyAction,
  ComedyConfig,
  ComedyHex,
  ComedyOutcome,
  ComedyPhase,
  ComedyPlayer,
  ComedyState,
  EcosystemHealth,
  Resource,
  Structure,
  Terrain,
  TradeOffer,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixed world map — 19 hexes
// ---------------------------------------------------------------------------

function createFixedHexMap(): ComedyHex[] {
  // 19-hex island: center + 2 rings
  const layout: [number, number, Terrain, 0 | 1 | 2][] = [
    // Center
    [0, 0, 'commons', 0],
    // Inner ring (6 hexes)
    [-1, 0, 'plains', 0],
    [-1, 1, 'forest', 1],
    [0, -1, 'plains', 0],
    [0, 1, 'forest', 1],
    [1, -1, 'plains', 0],
    [1, 0, 'mountain', 2],
    // Outer ring (12 hexes)
    [-2, 1, 'forest', 1],
    [-2, 2, 'mountain', 2],
    [-1, -1, 'plains', 0],
    [-1, 2, 'mountain', 2],
    [0, -2, 'ocean', 0],
    [0, 2, 'forest', 1],
    [1, -2, 'ocean', 0],
    [1, 1, 'plains', 0],
    [2, -2, 'ocean', 0],
    [2, -1, 'ocean', 0],
    [2, 0, 'mountain', 2],
  ];

  return layout.map(([q, r, terrain, ecosystem]) => ({
    q, r, terrain, ecosystem,
    owner: null,
    structure: null,
    extractionLevel: 0,
  }));
}

// ---------------------------------------------------------------------------
// Resource production per terrain
// ---------------------------------------------------------------------------

const PRODUCTION: Record<Terrain, Partial<Record<Resource, number>>> = {
  plains: { grain: 2 },
  forest: { timber: 2 },
  mountain: { ore: 2 },
  ocean: { fish: 2 },
  commons: { energy: 1, grain: 1 },
};

// ---------------------------------------------------------------------------
// Build cost per structure
// ---------------------------------------------------------------------------

const BUILD_COST: Record<Structure, Partial<Record<Resource, number>>> = {
  farm: { grain: 2, timber: 1 },
  mine: { grain: 1, timber: 2 },
  port: { grain: 2, timber: 2 },
  tower: { timber: 3, ore: 1 },
};

// ---------------------------------------------------------------------------
// Extraction yield
// ---------------------------------------------------------------------------

function extractionYield(hex: ComedyHex, eco: EcosystemHealth): Partial<Record<Resource, number>> {
  const base = PRODUCTION[hex.terrain] ?? {};
  const result: Partial<Record<Resource, number>> = {};
  for (const [res, amount] of Object.entries(base)) {
    result[res as Resource] = Math.floor((amount as number) * eco.extractionYield);
  }
  return result;
}

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

export function createInitialState(config: ComedyConfig): ComedyState {
  const players = new Map<string, ComedyPlayer>();
  for (const p of config.players) {
    players.set(p.id, {
      id: p.id,
      handle: p.handle,
      vp: 0,
      resources: { grain: 3, timber: 3, ore: 0, fish: 0, energy: 0 },
      builtStructures: 0,
    });
  }

  return {
    phase: 'production',
    turn: 1,
    maxTurns: 20,
    hexes: createFixedHexMap(),
    players,
    ecosystems: [
      { ecosystem: 0 as const, health: 80, extractionYield: 1.0 },
      { ecosystem: 1 as const, health: 80, extractionYield: 1.0 },
      { ecosystem: 2 as const, health: 80, extractionYield: 1.0 },
    ],
    trades: [],
    productionWheel: [6, 8, 5, 9, 7, 4],
    winner: null,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateAction(
  state: ComedyState,
  playerId: string | null,
  action: ComedyAction,
): boolean {
  if (!playerId) return action.type === 'game_start';
  if (!state.players.has(playerId)) return false;

  switch (action.type) {
    case 'game_start': return false; // already started
    case 'submit_trade': return state.phase === 'negotiation';
    case 'accept_trade':
    case 'reject_trade': return state.phase === 'negotiation';
    case 'build': return state.phase === 'building';
    case 'extract': return state.phase === 'extraction';
    case 'pass': return true;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Apply action
// ---------------------------------------------------------------------------

let tradeIdCounter = 0;

export function applyAction(
  state: ComedyState,
  playerId: string | null,
  action: ComedyAction,
): ActionResult<ComedyState, ComedyAction> {
  // System actions
  if (action.type === 'game_start') {
    return { state }; // game already started by createInitialState
  }

  if (!playerId) return { state };

  const player = state.players.get(playerId);
  if (!player) return { state };

  switch (action.type) {
    case 'submit_trade': {
      if (state.phase !== 'negotiation') return { state };
      if (!state.players.has(action.offer.to)) return { state };
      if (action.offer.from !== playerId) return { state };
      const trade: TradeOffer = {
        id: `trade_${++tradeIdCounter}`,
        ...action.offer,
        accepted: false,
        rejected: false,
      };
      return { state: { ...state, trades: [...state.trades, trade] } };
    }

    case 'accept_trade': {
      if (state.phase !== 'negotiation') return { state };
      const trade = state.trades.find(t => t.id === action.tradeId);
      if (!trade || trade.to !== playerId || trade.accepted || trade.rejected) return { state };
      const giver = state.players.get(trade.from);
      const receiver = player;
      if (!giver) return { state };
      const newGiver = { ...giver, resources: { ...giver.resources } };
      const newReceiver = { ...receiver, resources: { ...receiver.resources } };
      for (const [res, amt] of Object.entries(trade.give)) {
        newGiver.resources[res as Resource] -= amt as number;
        newReceiver.resources[res as Resource] += amt as number;
      }
      const newPlayers = new Map(state.players);
      newPlayers.set(trade.from, newGiver);
      newPlayers.set(playerId, newReceiver);
      const newTrades = state.trades.map(t =>
        t.id === action.tradeId ? { ...t, accepted: true } : t,
      );
      return { state: { ...state, players: newPlayers, trades: newTrades } };
    }

    case 'reject_trade': {
      const newTrades = state.trades.map(t =>
        t.id === action.tradeId ? { ...t, rejected: true } : t,
      );
      return { state: { ...state, trades: newTrades } };
    }

    case 'build': {
      if (state.phase !== 'building') return { state };
      const hex = state.hexes.find(h => h.q === action.hexQ && h.r === action.hexR);
      if (!hex || hex.owner !== playerId || hex.structure !== null) return { state };
      const cost = BUILD_COST[action.structure];
      for (const [res, amt] of Object.entries(cost)) {
        if ((player.resources[res as Resource] ?? 0) < (amt as number)) return { state };
      }
      const newPlayer = {
        ...player,
        resources: { ...player.resources },
        builtStructures: player.builtStructures + 1,
      };
      for (const [res, amt] of Object.entries(cost)) {
        newPlayer.resources[res as Resource] -= amt as number;
      }
      const newHexes = state.hexes.map(h =>
        h.q === action.hexQ && h.r === action.hexR ? { ...h, structure: action.structure } : h,
      );
      const newPlayers = new Map(state.players);
      newPlayers.set(playerId, newPlayer);
      return { state: { ...state, players: newPlayers, hexes: newHexes } };
    }

    case 'extract': {
      if (state.phase !== 'extraction') return { state };
      const hex = state.hexes.find(h => h.q === action.hexQ && h.r === action.hexR);
      if (!hex || hex.owner !== playerId || hex.structure === null) return { state };
      const eco = state.ecosystems[hex.ecosystem];
      const yields = extractionYield(hex, eco);
      const newPlayer = { ...player, resources: { ...player.resources } };
      for (const [res, amt] of Object.entries(yields)) {
        newPlayer.resources[res as Resource] += amt as number;
      }
      const newEcosystems = state.ecosystems.map((e, i) =>
        i === hex.ecosystem
          ? { ...e, health: Math.max(0, e.health - 5), extractionYield: 1 - Math.max(0, e.health - 5) / 100 }
          : e,
      ) as [EcosystemHealth, EcosystemHealth, EcosystemHealth];
      const newHexes = state.hexes.map(h =>
        h.q === action.hexQ && h.r === action.hexR
          ? { ...h, extractionLevel: Math.min(3, h.extractionLevel + 1) }
          : h,
      );
      const newPlayers = new Map(state.players);
      newPlayers.set(playerId, newPlayer);
      return { state: { ...state, players: newPlayers, ecosystems: newEcosystems, hexes: newHexes } };
    }

    case 'pass':
      return { state };

    default:
      return { state };
  }
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export function getVisibleState(state: ComedyState, playerId: string | null): unknown {
  return state;
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------

export function isOver(state: ComedyState): boolean {
  if (state.winner !== null) return true;
  for (const player of state.players.values()) {
    if (player.vp >= 10) return true;
  }
  return state.turn > state.maxTurns;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export function getOutcome(state: ComedyState): ComedyOutcome {
  let winner: string | null = null;
  let maxVp = -1;
  const vp = new Map<string, number>();

  for (const [id, player] of state.players) {
    vp.set(id, player.vp);
    if (player.vp > maxVp) {
      maxVp = player.vp;
      winner = id;
    }
  }

  const winners = [...state.players.values()].filter(p => p.vp === maxVp);
  if (winners.length > 1) winner = null;

  return { winner, vp, turnsPlayed: state.turn };
}

// ---------------------------------------------------------------------------
// Spectator view
// ---------------------------------------------------------------------------

export function getSpectatorView(state: ComedyState): unknown {
  return {
    turn: state.turn,
    phase: state.phase,
    maxTurns: state.maxTurns,
    hexes: state.hexes,
    players: [...state.players.values()],
    ecosystems: state.ecosystems,
    productionWheel: state.productionWheel,
    winner: state.winner,
  };
}
