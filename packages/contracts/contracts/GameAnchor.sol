// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ICoordinationCredits.sol";

contract GameAnchor {
    ICoordinationCredits public immutable credits;
    address public immutable relayer;
    address public admin;

    struct GameResult {
        bytes32 gameId;
        string gameType;
        uint256[] players;
        bytes outcome;
        bytes32 movesRoot;
        bytes32 configHash;
        uint16 turnCount;
        uint64 timestamp;
    }

    // gameId => stored result
    mapping(bytes32 => GameResult) internal _results;
    // gameId => whether settled
    mapping(bytes32 => bool) public settled;

    // Configurable emergency reclaim delay
    uint256 public reclaimDelay = 3600; // 1 hour default
    uint256 constant MAX_RECLAIM_DELAY = 604800; // 1 week max

    // Events
    event GameSettled(
        bytes32 indexed gameId,
        bytes32 movesRoot,
        uint256[] players,
        int256[] deltas
    );
    event EmergencyReclaimed(bytes32 indexed gameId);
    event ReclaimDelayUpdated(uint256 newDelay);

    // Errors
    error NotRelayer();
    error NotAdmin();
    error AlreadySettled();
    error MissingMovesRoot();
    error LengthMismatch();
    error ZeroSumViolation();
    error TooEarlyForReclaim();
    error GameNotSettled();
    error ReclaimDelayTooLong();

    constructor(address _credits, address _relayer, address _admin) {
        credits = ICoordinationCredits(_credits);
        relayer = _relayer;
        admin = _admin;
    }

    /// @notice Settle a game result and apply credit deltas
    function settleGame(
        GameResult calldata result,
        int256[] calldata deltas
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (settled[result.gameId]) revert AlreadySettled();
        if (result.movesRoot == bytes32(0)) revert MissingMovesRoot();
        if (result.players.length != deltas.length) revert LengthMismatch();

        // Verify zero-sum
        int256 sum = 0;
        for (uint256 i = 0; i < deltas.length; i++) {
            sum += deltas[i];
        }
        if (sum != 0) revert ZeroSumViolation();

        // Store result
        _results[result.gameId] = result;
        settled[result.gameId] = true;

        // Settle credits
        credits.settleDeltas(result.players, deltas);

        emit GameSettled(result.gameId, result.movesRoot, result.players, deltas);
    }

    /// @notice View a stored game result
    function results(bytes32 gameId) external view returns (GameResult memory) {
        return _results[gameId];
    }

    /// @notice Emergency reclaim if game is stale (past configurable delay)
    function emergencyReclaim(bytes32 gameId) external {
        GameResult memory result = _results[gameId];
        if (result.timestamp == 0) revert GameNotSettled();
        if (block.timestamp <= uint256(result.timestamp) + reclaimDelay) revert TooEarlyForReclaim();

        // Refund: create zero deltas (no-op settle to emit event)
        emit EmergencyReclaimed(gameId);
    }

    /// @notice Set emergency reclaim delay (admin only)
    function setReclaimDelay(uint256 newDelay) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newDelay > MAX_RECLAIM_DELAY) revert ReclaimDelayTooLong();
        reclaimDelay = newDelay;
        emit ReclaimDelayUpdated(newDelay);
    }
}
