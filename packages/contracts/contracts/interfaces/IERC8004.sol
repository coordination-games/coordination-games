// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC8004 {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
}
