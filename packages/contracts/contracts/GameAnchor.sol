// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/ICoordinationCredits.sol";

contract GameAnchor is ReentrancyGuard {
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

    // Events
    event GameSettled(
        bytes32 indexed gameId,
        bytes32 movesRoot,
        uint256[] players,
        int256[] deltas
    );

    // Errors
    error NotRelayer();
    error AlreadySettled();
    error MissingMovesRoot();
    error LengthMismatch();
    error ZeroSumViolation();

    constructor(address _credits, address _relayer, address _admin) {
        credits = ICoordinationCredits(_credits);
        relayer = _relayer;
        admin = _admin;
    }

    /// @notice Settle a game result and apply credit deltas
    function settleGame(
        GameResult calldata result,
        int256[] calldata deltas
    ) external nonReentrant {
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
}
