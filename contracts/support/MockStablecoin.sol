// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockStablecoin
/// @notice Test stablecoin (6 decimals, like USDC) used for contributions and collateral.
/// @dev Demo only. Anyone can call `faucet` to get test money, limited per call.
contract MockStablecoin is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 100_000 * 1e6; // 100,000 tokens

    constructor() ERC20("Mock USD", "mUSD") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Gives the caller FAUCET_AMOUNT test tokens.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner can mint any amount (used by deploy and demo scripts).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
