// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICoordinationCredits {
    function mintFor(uint256 agentId, uint256 usdcAmount) external;
    function settleDeltas(uint256[] calldata agentIds, int256[] calldata deltas) external;
}
