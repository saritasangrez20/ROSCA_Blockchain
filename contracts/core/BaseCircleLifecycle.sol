// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BaseCircleLifecycle
/// @notice Reusable lifecycle (state machine), roles and safety switches for a circle.
/// @dev Inherited by Circle. Keeps "which step is allowed when" in one place so the
///      business logic in Circle cannot skip or reverse a stage.
///
///      Set up through an initializer instead of a constructor, so the same code works
///      whether the factory deploys a full contract or a cheap EIP 1167 clone (clones
///      never run constructors).
///
///      Open ──(full)──> OrderDraw ──(draw ok)──> Active ──(last round)──> Completed
///        │                  │
///        └──(not filled)──> Cancelled <──(fewer than 2 revealed)
///
///      Gas optimization G2 (Member C): `state` and the pause bookkeeping share one slot.
///
///      Security fix S1 (Member C, attack test A6): a pause used to block paying while the
///      round clock kept running, so pausing through a deadline let anyone settle the round
///      and slash every member, and a pause that expired could be renewed at once. Now the
///      time a circle spends paused is tracked (totalPausedTime) so Circle can add it to the
///      current round's deadline, and a new pause needs PAUSE_COOLDOWN of unpaused time.
abstract contract BaseCircleLifecycle is Initializable, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant ORGANIZER_ROLE = keccak256("ORGANIZER_ROLE");
    bytes32 public constant MEMBER_ROLE = keccak256("MEMBER_ROLE");
    /// Platform admin: may pause in an emergency, nothing else.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// A pause switches itself off after this long, so the admin cannot freeze a circle forever.
    uint256 public constant MAX_PAUSE_DURATION = 7 days;
    /// After a pause ends, the next one can start only this much later, so pauses cannot be
    /// chained to freeze a circle.
    uint256 public constant PAUSE_COOLDOWN = 7 days;

    enum State {
        Open,
        OrderDraw,
        Active,
        Completed,
        Cancelled
    }

    // ----- one storage slot -----
    State public state;
    uint40 private _pauseExpiresAt; // when the running pause switches itself off (0 = none)
    uint40 private _pausedAt; // when the running pause started (0 = none)
    uint40 private _pausedTotal; // seconds of pauses that have already ended
    uint40 private _lastPauseEnd; // when the previous pause ended (0 = never paused)

    event StateChanged(State indexed from, State indexed to);

    function __BaseCircleLifecycle_init(address organizer, address pauser) internal onlyInitializing {
        require(organizer != address(0) && pauser != address(0), "Lifecycle: zero address");
        _grantRole(ORGANIZER_ROLE, organizer);
        _grantRole(PAUSER_ROLE, pauser);
        state = State.Open;
    }

    modifier inState(State expected) {
        require(state == expected, "Lifecycle: wrong state");
        _;
    }

    /// @notice When the current pause switches itself off (0 when not paused).
    function pauseExpiresAt() public view returns (uint256) {
        return _pauseExpiresAt;
    }

    /// @notice Emergency stop for at most MAX_PAUSE_DURATION. Blocks joining and paying
    ///         only; settling, refunds and withdrawals stay open so a pause can never
    ///         trap member funds. The paused time is added to the current round's payment
    ///         deadline, so a pause can never make anyone miss a payment.
    function pause() external onlyRole(PAUSER_ROLE) {
        _requireNotPaused();
        _closeExpiredPause();
        uint256 lastEnd = _lastPauseEnd;
        require(lastEnd == 0 || block.timestamp >= lastEnd + PAUSE_COOLDOWN, "Lifecycle: pause cooldown");
        _pause();
        _pausedAt = uint40(block.timestamp);
        _pauseExpiresAt = uint40(block.timestamp + MAX_PAUSE_DURATION);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause(); // reverts unless a pause is running
        _pausedTotal += uint40(block.timestamp - _pausedAt);
        _lastPauseEnd = uint40(block.timestamp);
        _pausedAt = 0;
        _pauseExpiresAt = 0;
    }

    /// @notice Seconds this circle has spent paused so far, including a running pause.
    function totalPausedTime() public view returns (uint256 total) {
        total = _pausedTotal;
        uint256 startedAt = _pausedAt;
        if (startedAt != 0) {
            uint256 end = _pauseExpiresAt;
            if (block.timestamp < end) end = block.timestamp;
            total += end - startedAt;
        }
    }

    /// Books a pause that ran out by itself (nobody called unpause) into the totals.
    /// Only called after `_requireNotPaused`, so a recorded pause here has expired.
    function _closeExpiredPause() private {
        uint256 startedAt = _pausedAt;
        if (startedAt == 0) return;
        uint256 end = _pauseExpiresAt;
        _pausedTotal += uint40(end - startedAt);
        _lastPauseEnd = uint40(end);
        _pausedAt = 0;
        _pauseExpiresAt = 0;
    }

    /// @notice True only while a pause is on and has not expired.
    function paused() public view override returns (bool) {
        return super.paused() && block.timestamp < _pauseExpiresAt;
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
