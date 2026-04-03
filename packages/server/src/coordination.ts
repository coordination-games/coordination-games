/**
 * Coordination framework integration for the CtL server.
 *
 * Registers the Capture the Lobster plugin with the GameFramework
 * and provides helper functions for bridging between the existing
 * server code and the new framework.
 *
 * This module coexists with the existing server code. The existing
 * GameServer class continues to manage games directly using GameManager.
 * The framework is available as an alternative path, and will become
 * the primary path as more games are added.
 */

import {
  GameFramework,
  type CoordinationGame,
  type GameRoom,
  type GameResult,
  buildGameResult,
  computePayouts,
  buildGameMerkleTree,
  type MerkleLeafData,
} from '@lobster/coordination';

import {
  CaptureTheLobsterPlugin,
  type CtlConfig,
  type CtlState,
  type CtlMove,
  type CtlOutcome,
  GameManager,
  TurnRecord,
  Direction,
} from '@lobster/engine';

// ---------------------------------------------------------------------------
// Framework singleton
// ---------------------------------------------------------------------------

let framework: GameFramework | null = null;

/**
 * Get or create the global GameFramework instance.
 * Registers all known game plugins on first call.
 */
export function getFramework(): GameFramework {
  if (!framework) {
    framework = new GameFramework({
      turnTimeoutMs: 30000,
      balanceConfig: {
        defaultBalance: 1000, // Dev mode: everyone starts with 1000 credits
      },
    });

    // Register the CtL plugin
    framework.registerGame(CaptureTheLobsterPlugin);

    console.log('[Coordination] Framework initialized with games:', framework.listGameTypes());
  }
  return framework;
}

// ---------------------------------------------------------------------------
// Bridge: existing GameManager -> framework Merkle tree
// ---------------------------------------------------------------------------

/**
 * Build a Merkle tree from an existing GameManager's turn history.
 * Useful for anchoring games that were run through the old code path.
 */
export function buildMerkleTreeFromHistory(
  gameId: string,
  turnHistory: TurnRecord[],
): { root: string; leafCount: number } {
  const turns = turnHistory.map((record) => ({
    turnNumber: record.turn,
    moves: [...record.moves.entries()].map(([playerId, path]) => ({
      turnNumber: record.turn,
      playerId,
      moveData: JSON.stringify(path),
    } as MerkleLeafData)),
  }));

  const tree = buildGameMerkleTree(turns);
  return { root: tree.root, leafCount: tree.leaves.length };
}

/**
 * Build a GameResult from an existing GameManager (for on-chain anchoring).
 * Bridges the old game flow with the new settlement system.
 */
export function buildResultFromGameManager(
  gameManager: GameManager,
  gameId: string,
  playerIds: string[],
): GameResult {
  const turnHistory = gameManager.getTurnHistory();
  const { root } = buildMerkleTreeFromHistory(gameId, turnHistory);

  return {
    gameId,
    gameType: 'capture-the-lobster',
    players: playerIds,
    outcome: {
      winner: gameManager.winner,
      score: { ...gameManager.score },
      turnCount: gameManager.turn,
    },
    movesRoot: root,
    configHash: '', // Will be computed when config hashing is needed
    turnCount: turnHistory.length,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Bridge: existing GameManager -> framework payouts
// ---------------------------------------------------------------------------

/**
 * Compute payouts for an existing finished GameManager.
 */
export function computePayoutsFromGameManager(
  gameManager: GameManager,
  playerIds: string[],
): Map<string, number> {
  const outcome: CtlOutcome = {
    winner: gameManager.winner,
    score: { ...gameManager.score },
    turnCount: gameManager.turn,
    playerStats: new Map(),
  };

  for (const unit of gameManager.units) {
    outcome.playerStats.set(unit.id, {
      team: unit.team,
      kills: 0,
      deaths: 0,
      flagCarries: 0,
      flagCaptures: 0,
    });
  }

  return CaptureTheLobsterPlugin.computePayouts(outcome, playerIds);
}
