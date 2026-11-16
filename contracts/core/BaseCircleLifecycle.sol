// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BaseCircleLifecycle
/// @notice Reusable lifecycle (state machine), roles and safety switches for a circle.
/// @dev Inherited by Circle. Keeps "which step is allowed when" in one place so the
///      business logic in Circle cannot skip or reverse a stage.
///
///      Open ──(full)──> OrderDraw ──(draw ok)──> Active ──(last round)──> Completed
///        │                  │
///        └──(not filled)──> Cancelled <──(draw failed)
abstract contract BaseCircleLifecycle is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE");
    bytes32 public constant MEMBER_ROLE = keccak256("MEMBER_ROLE");
    /// Platform admin: may pause in an emergency, nothing else.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    enum State {
        Open,
        OrderDraw,
        Active,
        Completed,
        Cancelled
    }

    State public state;

    event StateChanged(State indexed from, State indexed to);

    constructor(address organizer, address pauser) {
        require(organizer != address(0) && pauser != address(0), "Lifecycle: zero address");
        _grantRole(ORGANIZER_ROLE, organizer);
        _grantRole(PAUSER_ROLE, pauser);
        state = State.Open;
    }

    modifier inState(State expected) {
        require(state == expected, "Lifecycle: wrong state");
        _;
    }

    /// @notice Emergency stop. Blocks joining and paying only; refunds and
    ///         withdrawals stay open so a pause can never trap member funds.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _transition(State to) internal {
        State from = state;
        require(_isAllowed(from, to), "Lifecycle: illegal transition");
        state = to;
        emit StateChanged(from, to);
    }

    function _isAllowed(State from, State to) internal pure returns (bool) {
        if (from == State.Open) return to == State.OrderDraw || to == State.Cancelled;
        if (from == State.OrderDraw) return to == State.Active || to == State.Cancelled;
        if (from == State.Active) return to == State.Completed;
        return false; // Completed and Cancelled are final
    }
}
