// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PayoutOrder
/// @notice Fair "who gets paid when" draw using commit then reveal.
/// @dev 1. Each member commits keccak256(secret, member, circle) without showing the secret.
///      2. Once everyone committed (or the commit window ends) members reveal their secrets.
///      3. The random seed mixes every secret, so no single member (and not the organizer)
///         can choose the order. A member who refuses to reveal can only block the draw,
///         which cancels the circle with full refunds and records a default for them.
contract PayoutOrder is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant CIRCLE_ROLE = keccak256("CIRCLE_ROLE");

    struct Draw {
        bool started;
        bool finalized;
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 commitCount;
        uint256 revealCount;
        bytes32 seed;
        address[] members;
    }

    mapping(address => Draw) private draws;
    mapping(address => mapping(address => bool)) public isParticipant;
    mapping(address => mapping(address => bytes32)) public commitmentOf;
    mapping(address => mapping(address => bool)) public hasRevealed;

    event CircleRegistered(address indexed circle);
    event DrawStarted(address indexed circle, uint256 commitDeadline, uint256 revealDeadline);
    event Committed(address indexed circle, address indexed member);
    event Revealed(address indexed circle, address indexed member);
    event DrawFinalized(address indexed circle, bool success);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function registerCircle(address circle) external onlyRole(REGISTRAR_ROLE) {
        require(circle != address(0), "Order: zero address");
        _grantRole(CIRCLE_ROLE, circle);
        emit CircleRegistered(circle);
    }

    /// @notice Helper for frontends and tests: the value a member must commit.
    function computeCommitment(bytes32 secret, address member, address circle) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(secret, member, circle));
    }

    /// @notice Called by a circle when it fills up.
    function startDraw(address[] calldata members, uint256 phaseDuration) external onlyRole(CIRCLE_ROLE) {
        Draw storage d = draws[msg.sender];
        require(!d.started, "Order: already started");
        require(members.length >= 2, "Order: too few members");
        require(phaseDuration > 0, "Order: zero duration");
        d.started = true;
        d.commitDeadline = block.timestamp + phaseDuration;
        d.revealDeadline = block.timestamp + 2 * phaseDuration;
        for (uint256 i = 0; i < members.length; i++) {
            d.members.push(members[i]);
            isParticipant[msg.sender][members[i]] = true;
        }
        emit DrawStarted(msg.sender, d.commitDeadline, d.revealDeadline);
    }

    function commit(address circle, bytes32 commitment) external {
        Draw storage d = draws[circle];
        require(d.started && !d.finalized, "Order: no active draw");
        require(isParticipant[circle][msg.sender], "Order: not a member");
        require(block.timestamp <= d.commitDeadline, "Order: commit window closed");
        require(commitmentOf[circle][msg.sender] == bytes32(0), "Order: already committed");
        require(commitment != bytes32(0), "Order: empty commitment");
        commitmentOf[circle][msg.sender] = commitment;
        d.commitCount += 1;
        emit Committed(circle, msg.sender);
    }

    function reveal(address circle, bytes32 secret) external {
        Draw storage d = draws[circle];
        require(d.started && !d.finalized, "Order: no active draw");
        require(isParticipant[circle][msg.sender], "Order: not a member");
        require(
            d.commitCount == d.members.length || block.timestamp > d.commitDeadline, "Order: commit phase still open"
        );
        require(block.timestamp <= d.revealDeadline, "Order: reveal window closed");
        require(!hasRevealed[circle][msg.sender], "Order: already revealed");
        require(
            commitmentOf[circle][msg.sender] == computeCommitment(secret, msg.sender, circle), "Order: wrong secret"
        );
        hasRevealed[circle][msg.sender] = true;
        d.revealCount += 1;
        d.seed = keccak256(abi.encodePacked(d.seed, secret));
        emit Revealed(circle, msg.sender);
    }

    /// @notice Called by the circle to close the draw.
    /// @return success true when every member revealed
    /// @return order members in payout order (empty when the draw failed)
    function finalize() external onlyRole(CIRCLE_ROLE) returns (bool success, address[] memory order) {
        Draw storage d = draws[msg.sender];
        require(d.started && !d.finalized, "Order: no active draw");
        uint256 n = d.members.length;
        if (d.revealCount < n) {
            require(block.timestamp > d.revealDeadline, "Order: reveal window still open");
            d.finalized = true;
            emit DrawFinalized(msg.sender, false);
            return (false, new address[](0));
        }
        d.finalized = true;
        order = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            order[i] = d.members[i];
        }
        // Fisher Yates shuffle driven by the combined seed.
        for (uint256 i = n - 1; i > 0; i--) {
            uint256 j = uint256(keccak256(abi.encodePacked(d.seed, i))) % (i + 1);
            (order[i], order[j]) = (order[j], order[i]);
        }
        emit DrawFinalized(msg.sender, true);
        return (true, order);
    }

    function getDraw(address circle)
        external
        view
        returns (
            bool started,
            bool finalized,
            uint256 commitDeadline,
            uint256 revealDeadline,
            uint256 commitCount,
            uint256 revealCount,
            uint256 memberCount
        )
    {
        Draw storage d = draws[circle];
        return (d.started, d.finalized, d.commitDeadline, d.revealDeadline, d.commitCount, d.revealCount, d.members.length);
    }
}
