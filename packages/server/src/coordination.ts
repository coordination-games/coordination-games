/**
 * Framework integration — bridges the live game engine with the platform framework.
 *
 * The game engine (GameManager) runs directly for performance during gameplay.
 * The framework (GameFramework) handles lifecycle events: game creation,
 * Merkle tree construction, payout computation, and on-chain settlement.
 *
 * This module provides the bridge between the two:
 * - getFramework() — singleton framework with CtL registered
 * - buildResultFromGameManager() — converts engine state to framework GameResult
 * - computePayoutsFromGameManager() — computes payouts via the CtL plugin
 */

import {
  GameFramework,
  type GameResult,
  buildGameMerkleTree,
  type MerkleLeafData,
} from '@lobster/platform';

import {
  CaptureTheLobsterPlugin,
  type CtlOutcome,
  GameManager,
  TurnRecord,
} from '@lobster/games-ctl';

// ---------------------------------------------------------------------------
// Framework singleton
// ---------------------------------------------------------------------------

let framework: GameFramework | null = null;

export function getFramework(): GameFramework {
  if (!framework) {
    framework = new GameFramework({
      turnTimeoutMs: 30000,
      balanceConfig: { defaultBalance: 1000 },
    });
    framework.registerGame(CaptureTheLobsterPlugin);
    console.log('[Framework] Initialized with games:', framework.listGameTypes());
  }
  return framework;
}

// ---------------------------------------------------------------------------
// Engine → Framework bridges (called at game finish time)
// ---------------------------------------------------------------------------

/**
 * Build a Merkle tree from the engine's turn history.
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
 * Build a GameResult from the engine's state for on-chain anchoring.
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
    configHash: '',
    turnCount: turnHistory.length,
    timestamp: Date.now(),
  };
}

/**
 * Compute payouts using the CtL plugin's payout logic.
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
