// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ReputationRegistry
/// @notice Cross circle record of how reliable each address has been.
/// @dev Only circles registered by the factory can write. Anyone can read.
///      Gas optimizations (Member C, Stage 3):
///      * G2: the three counters share one storage slot.
///      * G4: the per entry history lives in `ReputationUpdated` events only, not in storage
///        arrays. The counters (what the join rule needs) stay on chain; the indexer rebuilds
///        the full history from events (`reputation` table, /api/reputation/:address).
///        Every record call saves two new storage slots plus an array length update.
contract ReputationRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant CIRCLE_ROLE = keccak256("CIRCLE_ROLE");

    enum EntryKind {
        Joined,
        Completed,
        Defaulted
    }

    /// Output shape of getRecord (unchanged from the baseline).
    struct Record {
        uint256 joined;
        uint256 completed;
        uint256 defaults;
    }

    /// Stored form: all three counters in one storage slot (gas optimization G2).
    struct PackedRecord {
        uint64 joined;
        uint64 completed;
        uint64 defaults;
    }

    mapping(address => PackedRecord) private records;

    event CircleRegistered(address indexed circle);
    event ReputationUpdated(address indexed member, address indexed circle, EntryKind kind);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Factory registers each new circle so it may write records.
    function registerCircle(address circle) external onlyRole(REGISTRAR_ROLE) {
        require(circle != address(0), "Reputation: zero address");
        _grantRole(CIRCLE_ROLE, circle);
        emit CircleRegistered(circle);
    }

    function recordJoin(address member) external onlyRole(CIRCLE_ROLE) {
        records[member].joined += 1;
        _log(member, EntryKind.Joined);
    }

    function recordCompletion(address member) external onlyRole(CIRCLE_ROLE) {
        records[member].completed += 1;
        _log(member, EntryKind.Completed);
    }

    function recordDefault(address member) external onlyRole(CIRCLE_ROLE) {
        records[member].defaults += 1;
        _log(member, EntryKind.Defaulted);
    }

    function getRecord(address member) external view returns (Record memory) {
        PackedRecord memory r = records[member];
        return Record({joined: r.joined, completed: r.completed, defaults: r.defaults});
    }

    /// @notice True when the member has no more than `maxDefaults` recorded defaults.
    function isEligible(address member, uint256 maxDefaults) external view returns (bool) {
        return records[member].defaults <= maxDefaults;
    }

    function _log(address member, EntryKind kind) private {
        emit ReputationUpdated(member, msg.sender, kind);
    }
}
