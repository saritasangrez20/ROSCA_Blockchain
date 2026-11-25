// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ReputationRegistry
/// @notice Cross circle record of how reliable each address has been.
/// @dev Only circles registered by the factory can write. Anyone can read.
///      Baseline design: history is kept in storage arrays so the frontend can read it
///      directly. (Gas optimization candidate: move history to events only.)
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

    struct HistoryEntry {
        address circle;
        EntryKind kind;
        uint256 timestamp;
    }

    mapping(address => PackedRecord) private records;
    mapping(address => HistoryEntry[]) private history;

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

    function getHistory(address member) external view returns (HistoryEntry[] memory) {
        return history[member];
    }

    /// @notice True when the member has no more than `maxDefaults` recorded defaults.
    function isEligible(address member, uint256 maxDefaults) external view returns (bool) {
        return records[member].defaults <= maxDefaults;
    }

    function _log(address member, EntryKind kind) private {
        history[member].push(HistoryEntry({circle: msg.sender, kind: kind, timestamp: block.timestamp}));
        emit ReputationUpdated(member, msg.sender, kind);
    }
}
