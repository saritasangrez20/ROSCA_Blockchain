// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal views of the shared modules a Circle talks to (composition).

interface ICollateralVault {
    function requiredCollateral(uint256 contribution, uint256 groupSize, uint256 position)
        external
        pure
        returns (uint256);
    function collateralOf(address circle, address member) external view returns (uint256);
    function deposit(address from, address member, uint256 amount) external;
    function release(address member, uint256 amount) external returns (uint256);
    function slash(address member, uint256 amount) external returns (uint256);
    function registerCircle(address circle) external;
}

interface IPayoutOrder {
    function startDraw(address[] calldata members, uint256 phaseDuration) external;
    function finalize() external returns (address[] memory order);
    function hasRevealed(address circle, address member) external view returns (bool);
    function registerCircle(address circle) external;
}

interface IReputationRegistry {
    function recordJoin(address member) external;
    function recordCompletion(address member) external;
    function recordDefault(address member) external;
    function isEligible(address member, uint256 maxDefaults) external view returns (bool);
    function registerCircle(address circle) external;
}
