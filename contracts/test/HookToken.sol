// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Receivers that opt in get a callback on every incoming transfer (ERC777 style).
interface ITokenReceiver {
    function onTokenReceived(address from, uint256 amount) external;
}

/// @title HookToken (TEST ONLY, never deployed by scripts/deploy.js)
/// @notice A stablecoin look alike that calls the receiver on every transfer. Used by the
///         attack tests to give a malicious member a way to run code in the middle of a
///         payout, which a plain ERC20 like MockStablecoin never does.
contract HookToken is ERC20 {
    mapping(address => bool) public wantsHook;

    constructor() ERC20("Hook USD", "hUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function registerHook() external {
        wantsHook[msg.sender] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && wantsHook[to]) {
            ITokenReceiver(to).onTokenReceived(from, value);
        }
    }
}
