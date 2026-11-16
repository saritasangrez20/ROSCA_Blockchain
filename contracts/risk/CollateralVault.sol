// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title CollateralVault
/// @notice Holds every member's security deposit (collateral) for every circle.
/// @dev Money only leaves through `release` (back to the member) or `slash` (to the
///      circle, to cover a missed payment). Only circles registered by the factory can
///      call either, and each circle can only touch its own members' balances.
contract CollateralVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant CIRCLE_ROLE = keccak256("CIRCLE_ROLE");

    IERC20 public immutable token;

    /// circle => member => locked collateral
    mapping(address => mapping(address => uint256)) public collateralOf;
    /// circle => total locked for that circle
    mapping(address => uint256) public totalLocked;

    event CircleRegistered(address indexed circle);
    event CollateralDeposited(address indexed circle, address indexed member, uint256 amount);
    event CollateralReleased(address indexed circle, address indexed member, uint256 amount);
    event CollateralSlashed(address indexed circle, address indexed member, uint256 amount);

    constructor(IERC20 token_, address admin) {
        require(address(token_) != address(0), "Vault: zero token");
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function registerCircle(address circle) external onlyRole(REGISTRAR_ROLE) {
        require(circle != address(0), "Vault: zero address");
        _grantRole(CIRCLE_ROLE, circle);
        emit CircleRegistered(circle);
    }

    /// @notice Collateral a member at `position` (1 = paid first) must keep locked.
    /// @dev After receiving the pot, the member still owes (groupSize - position)
    ///      contributions. Collateral always covers 100% of that, so a member who
    ///      stops paying after their payout can never leave the others short.
    function requiredCollateral(uint256 contribution, uint256 groupSize, uint256 position)
        public
        pure
        returns (uint256)
    {
        require(position >= 1 && position <= groupSize, "Vault: bad position");
        return contribution * (groupSize - position);
    }

    /// @notice Locks `amount` tokens as `member`'s collateral for the calling circle.
    /// @param from who pays: the member themselves (on join, after approving the vault),
    ///        or the circle (refilling a deposit out of the member's own pot)
    function deposit(address from, address member, uint256 amount) external onlyRole(CIRCLE_ROLE) nonReentrant {
        require(amount > 0, "Vault: zero amount");
        require(from == member || from == msg.sender, "Vault: payer must be member or circle");
        // Effects before the external call (checks effects interactions).
        collateralOf[msg.sender][member] += amount;
        totalLocked[msg.sender] += amount;
        token.safeTransferFrom(from, address(this), amount);
        emit CollateralDeposited(msg.sender, member, amount);
    }

    /// @notice Returns up to `amount` of a member's collateral to the member.
    function release(address member, uint256 amount) external onlyRole(CIRCLE_ROLE) nonReentrant returns (uint256) {
        uint256 locked = collateralOf[msg.sender][member];
        uint256 sent = amount > locked ? locked : amount;
        if (sent == 0) return 0;
        collateralOf[msg.sender][member] = locked - sent;
        totalLocked[msg.sender] -= sent;
        token.safeTransfer(member, sent);
        emit CollateralReleased(msg.sender, member, sent);
        return sent;
    }

    /// @notice Moves up to `amount` of a defaulting member's collateral to the calling circle.
    /// @return taken the amount actually covered (may be less if collateral ran out)
    function slash(address member, uint256 amount) external onlyRole(CIRCLE_ROLE) nonReentrant returns (uint256 taken) {
        uint256 locked = collateralOf[msg.sender][member];
        taken = amount > locked ? locked : amount;
        if (taken == 0) return 0;
        collateralOf[msg.sender][member] = locked - taken;
        totalLocked[msg.sender] -= taken;
        token.safeTransfer(msg.sender, taken);
        emit CollateralSlashed(msg.sender, member, taken);
    }
}
