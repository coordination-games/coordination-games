// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IERC8004.sol";
import "./interfaces/IUSDC.sol";

contract CoordinationCredits {
    IERC8004 public immutable canonical8004;
    IUSDC public immutable usdc;
    address public immutable registry;
    address public immutable gameAnchor;
    address public immutable treasury;
    address public immutable vault;
    address public admin;

    // agentId => credit balance
    mapping(uint256 => uint256) public balances;

    struct PendingBurn {
        uint256 amount;
        uint256 executeAfter;
    }

    // agentId => pending burn request
    mapping(uint256 => PendingBurn) public pendingBurns;

    uint256 public burnDelay = 3600; // 1 hour default
    uint256 constant MAX_BURN_DELAY = 86400; // 24 hours max

    // Events
    event CreditsMinted(uint256 indexed agentId, uint256 credits);
    event CreditsSettled(uint256[] agentIds, int256[] deltas);
    event BurnRequested(uint256 indexed agentId, uint256 amount, uint256 executeAfter);
    event BurnExecuted(uint256 indexed agentId, uint256 credits, uint256 usdcAmount);
    event BurnCancelled(uint256 indexed agentId);
    event BurnDelayUpdated(uint256 newDelay);

    // Errors
    error NotRegistry();
    error NotGameAnchor();
    error NotAdmin();
    error NotAgentOwner();
    error NotRegistered();
    error InsufficientBalance();
    error NonTransferable();
    error ZeroSumViolation();
    error LengthMismatch();
    error NoPendingBurn();
    error BurnNotReady();
    error BurnDelayTooLong();

    constructor(
        address _canonical8004,
        address _usdc,
        address _registry,
        address _gameAnchor,
        address _treasury,
        address _vault,
        address _admin
    ) {
        canonical8004 = IERC8004(_canonical8004);
        usdc = IUSDC(_usdc);
        registry = _registry;
        gameAnchor = _gameAnchor;
        treasury = _treasury;
        vault = _vault;
        admin = _admin;
    }

    /// @notice Mint credits by depositing USDC (10% tax)
    function mint(uint256 agentId, uint256 usdcAmount) external {
        if (canonical8004.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _mintCredits(agentId, usdcAmount, 1000); // 10% tax
    }

    /// @notice Mint credits for an agent without tax (registry only)
    function mintFor(uint256 agentId, uint256 usdcAmount) external {
        if (msg.sender != registry) revert NotRegistry();
        _mintCredits(agentId, usdcAmount, 0);
    }

    function _mintCredits(uint256 agentId, uint256 usdcAmount, uint256 taxBps) internal {
        uint256 fee = (usdcAmount * taxBps) / 10000;
        if (fee > 0) {
            usdc.transferFrom(msg.sender, treasury, fee);
        }
        uint256 net = usdcAmount - fee;
        usdc.transferFrom(msg.sender, vault, net);
        uint256 credits = net * 100;
        balances[agentId] += credits;
        emit CreditsMinted(agentId, credits);
    }

    /// @notice Settle credit deltas after a game (gameAnchor only)
    function settleDeltas(uint256[] calldata agentIds, int256[] calldata deltas) external {
        if (msg.sender != gameAnchor) revert NotGameAnchor();
        if (agentIds.length != deltas.length) revert LengthMismatch();

        int256 sum = 0;
        for (uint256 i = 0; i < deltas.length; i++) {
            sum += deltas[i];
        }
        if (sum != 0) revert ZeroSumViolation();

        for (uint256 i = 0; i < agentIds.length; i++) {
            if (deltas[i] >= 0) {
                balances[agentIds[i]] += uint256(deltas[i]);
            } else {
                uint256 debit = uint256(-deltas[i]);
                if (balances[agentIds[i]] < debit) {
                    balances[agentIds[i]] = 0;
                } else {
                    balances[agentIds[i]] -= debit;
                }
            }
        }

        emit CreditsSettled(agentIds, deltas);
    }

    /// @notice Request a burn (starts cooldown)
    function requestBurn(uint256 agentId, uint256 amount) external {
        if (canonical8004.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (balances[agentId] < amount) revert InsufficientBalance();

        pendingBurns[agentId] = PendingBurn({
            amount: amount,
            executeAfter: block.timestamp + burnDelay
        });

        emit BurnRequested(agentId, amount, block.timestamp + burnDelay);
    }

    /// @notice Execute a pending burn after cooldown
    function executeBurn(uint256 agentId) external {
        PendingBurn memory pending = pendingBurns[agentId];
        if (pending.amount == 0) revert NoPendingBurn();
        if (block.timestamp < pending.executeAfter) revert BurnNotReady();

        uint256 actual = pending.amount;
        if (actual > balances[agentId]) {
            actual = balances[agentId];
        }

        delete pendingBurns[agentId];
        balances[agentId] -= actual;

        uint256 usdcAmount = actual / 100;
        if (usdcAmount > 0) {
            usdc.transferFrom(vault, msg.sender, usdcAmount);
        }

        emit BurnExecuted(agentId, actual, usdcAmount);
    }

    /// @notice Cancel a pending burn
    function cancelBurn(uint256 agentId) external {
        if (canonical8004.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (pendingBurns[agentId].amount == 0) revert NoPendingBurn();
        delete pendingBurns[agentId];
        emit BurnCancelled(agentId);
    }

    /// @notice Set burn delay (admin only)
    function setBurnDelay(uint256 newDelay) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newDelay > MAX_BURN_DELAY) revert BurnDelayTooLong();
        burnDelay = newDelay;
        emit BurnDelayUpdated(newDelay);
    }

    /// @notice Non-transferable - always reverts
    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    /// @notice Non-transferable - always reverts
    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }
}
