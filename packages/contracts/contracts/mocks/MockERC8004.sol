// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockERC8004 {
    uint256 private _nextId = 1;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => string) private _uris;

    event Registered(uint256 indexed agentId, address indexed owner, string agentURI);

    function register(string calldata agentURI) external returns (uint256) {
        uint256 id = _nextId++;
        _owners[id] = msg.sender;
        _uris[id] = agentURI;
        emit Registered(id, msg.sender, agentURI);
        return id;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _owners[agentId];
    }

    // Test helper: mint an agent to a specific address
    function mintTo(address to, string calldata agentURI) external returns (uint256) {
        uint256 id = _nextId++;
        _owners[id] = to;
        _uris[id] = agentURI;
        return id;
    }
}
