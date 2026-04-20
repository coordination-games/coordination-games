// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice USDC mock that re-enters a target contract during `transferFrom`.
///         Used exclusively to test that `nonReentrant` guards on
///         CoordinationCredits + GameAnchor block reentrancy attacks.
contract MaliciousUSDC {
    string public constant name = "Malicious USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Reentrancy hook configuration
    address public reenterTarget;
    bytes public reenterPayload;
    bool private _entered;

    function setReenter(address target, bytes calldata payload) external {
        reenterTarget = target;
        reenterPayload = payload;
    }

    function clearReenter() external {
        reenterTarget = address(0);
        reenterPayload = "";
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256, /* deadline */
        uint8, /* v */
        bytes32, /* r */
        bytes32 /* s */
    ) external {
        allowance[owner][spender] = value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        // The first time we observe a transferFrom, fire the reentrant call.
        // Subsequent calls (e.g. inside the reentrant call) should NOT fire
        // again, otherwise we'd loop forever.
        if (reenterTarget != address(0) && !_entered) {
            _entered = true;
            (bool ok, bytes memory ret) = reenterTarget.call(reenterPayload);
            _entered = false;
            // Bubble up the revert reason from the reentrant call so the
            // outer test can match on the custom error.
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }

        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            require(allowed >= amount, "allowance");
            if (allowed != type(uint256).max) {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
