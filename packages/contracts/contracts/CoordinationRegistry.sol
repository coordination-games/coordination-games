// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IERC8004.sol";
import "./interfaces/IUSDC.sol";
import "./interfaces/ICoordinationCredits.sol";

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract CoordinationRegistry {
    IERC8004 public immutable canonical8004;
    IUSDC public immutable usdc;
    ICoordinationCredits public immutable creditContract;
    address public immutable treasury;

    // name (lowercased) => agentId
    mapping(bytes32 => uint256) public nameToAgent;
    // agentId => display name
    mapping(uint256 => string) public displayName;
    // agentId => registered flag
    mapping(uint256 => bool) public registered;

    uint256 constant REGISTRATION_FEE = 1e6; // $1 USDC
    uint256 constant INITIAL_CREDITS_USDC = 4e6; // $4 USDC worth of credits

    event Registered(address indexed user, uint256 indexed agentId, string name);

    error InvalidName();
    error NameTaken();
    error AlreadyRegistered();
    error NotAgentOwner();

    constructor(
        address _canonical8004,
        address _usdc,
        address _creditContract,
        address _treasury
    ) {
        canonical8004 = IERC8004(_canonical8004);
        usdc = IUSDC(_usdc);
        creditContract = ICoordinationCredits(_creditContract);
        treasury = _treasury;
    }

    /// @notice Register a new agent (mints a new ERC-8004 identity)
    /// @param user The agent's address (who the NFT and credits go to)
    /// @dev The relay calls this on behalf of the user. USDC permit is from user to this contract.
    function registerNew(
        address user,
        string calldata name,
        string calldata agentURI,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        usdc.permit(user, address(this), REGISTRATION_FEE + INITIAL_CREDITS_USDC, deadline, v, r, s);
        // canonical 8004 mints to msg.sender (this contract) via _safeMint
        uint256 agentId = canonical8004.register(agentURI);
        // Transfer the NFT to the actual user
        IERC721(address(canonical8004)).transferFrom(address(this), user, agentId);
        _register(user, name, agentId);
    }

    /// @notice Register with an existing ERC-8004 agent identity
    function registerExisting(
        address user,
        string calldata name,
        uint256 agentId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        usdc.permit(user, address(this), REGISTRATION_FEE + INITIAL_CREDITS_USDC, deadline, v, r, s);
        if (canonical8004.ownerOf(agentId) != user) revert NotAgentOwner();
        _register(user, name, agentId);
    }

    /// @dev Required to receive ERC-721 tokens via _safeMint from canonical 8004
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function _register(address user, string calldata name, uint256 agentId) internal {
        if (registered[agentId]) revert AlreadyRegistered();
        if (!_validName(name)) revert InvalidName();

        bytes32 nameKey = keccak256(bytes(_toLower(name)));
        if (nameToAgent[nameKey] != 0) revert NameTaken();

        // Transfer $1 registration fee to treasury
        usdc.transferFrom(user, treasury, REGISTRATION_FEE);

        // Store registration
        nameToAgent[nameKey] = agentId;
        displayName[agentId] = name;
        registered[agentId] = true;

        // Approve credit contract for initial credits and mint
        usdc.approve(address(creditContract), INITIAL_CREDITS_USDC);
        usdc.transferFrom(user, address(this), INITIAL_CREDITS_USDC);
        creditContract.mintFor(agentId, INITIAL_CREDITS_USDC);

        emit Registered(user, agentId, name);
    }

    /// @notice Check if a name is available
    function checkName(string calldata name) external view returns (bool available) {
        if (!_validName(name)) return false;
        bytes32 nameKey = keccak256(bytes(_toLower(name)));
        return nameToAgent[nameKey] == 0;
    }

    /// @notice Validate name matches ^[a-zA-Z0-9_-]{3,20}$
    function _validName(string calldata name) internal pure returns (bool) {
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > 20) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool valid = (c >= 0x30 && c <= 0x39) || // 0-9
                (c >= 0x41 && c <= 0x5A) || // A-Z
                (c >= 0x61 && c <= 0x7A) || // a-z
                c == 0x5F || // _
                c == 0x2D;   // -
            if (!valid) return false;
        }
        return true;
    }

    /// @notice Convert string to lowercase
    function _toLower(string calldata str) internal pure returns (string memory) {
        bytes memory b = bytes(str);
        bytes memory lower = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) {
                lower[i] = bytes1(uint8(b[i]) + 32);
            } else {
                lower[i] = b[i];
            }
        }
        return string(lower);
    }
}
