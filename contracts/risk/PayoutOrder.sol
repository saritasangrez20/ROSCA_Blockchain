// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PayoutOrder
/// @notice Fair "who gets paid when" draw using commit then reveal.
/// @dev 1. Each member commits keccak256(secret, member, circle) without showing the secret.
///      2. Once everyone committed (or the commit window ends) members reveal their secrets.
///      3. The random seed mixes every revealed secret with the hash of the block that holds
///         the last reveal. Nobody (not the organizer, and not the last member to reveal)
///         knows that hash when they choose to reveal, and once it exists the order is fixed,
///         whoever finalizes and whenever.
///      4. Members who never reveal are left out of the order. The circle removes them
///         and charges a penalty, so walking away from the draw costs money and cannot
///         cancel the circle for everyone else.
///
///      Gas optimization G2 (Member C): the draw's flags, deadlines and counters share one
///      storage slot, and each member's "participant" and "revealed" flags share one slot.
///      The public getters of the baseline are kept as view functions with the same outputs.
///
///      Security fix S2 (Member C, attack test A3). The baseline mixed in block.prevrandao at
///      finalize time, and anyone may finalize. A member contract could therefore reveal last
///      and finalize in the same transaction, then revert both unless it liked its slot, and
///      retry every block; or, after revealing, finalize and revert until the order suited it.
///      Now finalize must run in a later block than the last reveal, and the entropy is the
///      hash of the last reveal's block, which is the same for every finalize call.
contract PayoutOrder is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant CIRCLE_ROLE = keccak256("CIRCLE_ROLE");

    uint8 private constant PARTICIPANT = 1;
    uint8 private constant REVEALED = 2;

    struct Draw {
        // ----- one storage slot -----
        bool started;
        bool finalized;
        uint40 commitDeadline;
        uint40 revealDeadline;
        uint16 commitCount;
        uint16 revealCount;
        uint64 lastRevealBlock;
        // -----
        bytes32 seed;
        address[] members;
    }

    mapping(address => Draw) private draws;
    /// circle => member => PARTICIPANT | REVEALED bits
    mapping(address => mapping(address => uint8)) private flags;
    mapping(address => mapping(address => bytes32)) public commitmentOf;

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

    function isParticipant(address circle, address member) public view returns (bool) {
        return flags[circle][member] & PARTICIPANT != 0;
    }

    function hasRevealed(address circle, address member) public view returns (bool) {
        return flags[circle][member] & REVEALED != 0;
    }

    /// @notice Called by a circle when it fills up.
    function startDraw(address[] calldata members, uint256 phaseDuration) external onlyRole(CIRCLE_ROLE) {
        Draw storage d = draws[msg.sender];
        require(!d.started, "Order: already started");
        require(members.length >= 2, "Order: too few members");
        require(members.length <= type(uint16).max, "Order: too many members");
        require(phaseDuration > 0, "Order: zero duration");
        require(phaseDuration <= type(uint32).max, "Order: duration too long");
        d.started = true;
        d.commitDeadline = uint40(block.timestamp + phaseDuration);
        d.revealDeadline = uint40(block.timestamp + 2 * phaseDuration);
        for (uint256 i = 0; i < members.length; i++) {
            d.members.push(members[i]);
            flags[msg.sender][members[i]] = PARTICIPANT;
        }
        emit DrawStarted(msg.sender, d.commitDeadline, d.revealDeadline);
    }

    function commit(address circle, bytes32 commitment) external {
        Draw storage d = draws[circle];
        require(d.started && !d.finalized, "Order: no active draw");
        require(isParticipant(circle, msg.sender), "Order: not a member");
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
        uint8 f = flags[circle][msg.sender];
        require(f & PARTICIPANT != 0, "Order: not a member");
        require(
            d.commitCount == d.members.length || block.timestamp > d.commitDeadline, "Order: commit phase still open"
        );
        require(block.timestamp <= d.revealDeadline, "Order: reveal window closed");
        require(f & REVEALED == 0, "Order: already revealed");
        require(
            commitmentOf[circle][msg.sender] == computeCommitment(secret, msg.sender, circle), "Order: wrong secret"
        );
        flags[circle][msg.sender] = f | REVEALED;
        d.revealCount += 1;
        d.lastRevealBlock = uint64(block.number);
        d.seed = keccak256(abi.encodePacked(d.seed, secret));
        emit Revealed(circle, msg.sender);
    }

    /// @notice Called by the circle to close the draw.
    /// @dev Allowed once everyone revealed, or after the reveal window.
    /// @return order the members who revealed, in payout order (may be shorter than the
    ///         member list, or empty if nobody revealed)
    function finalize() external onlyRole(CIRCLE_ROLE) returns (address[] memory order) {
        Draw storage d = draws[msg.sender];
        require(d.started && !d.finalized, "Order: no active draw");
        uint256 total = d.members.length;
        uint256 n = d.revealCount;
        require(n == total || block.timestamp > d.revealDeadline, "Order: reveal window still open");
        uint256 lastReveal = d.lastRevealBlock;
        // No reveal and finalize in one transaction (or one block): the outcome must not be
        // computable by the member who sends the last reveal.
        require(block.number > lastReveal, "Order: finalize in a later block");
        d.finalized = true;

        order = new address[](n);
        uint256 k = 0;
        for (uint256 i = 0; i < total; i++) {
            address m = d.members[i];
            if (flags[msg.sender][m] & REVEALED != 0) {
                order[k] = m;
                k++;
            }
        }
        // Entropy fixed by the block that holds the last reveal: unknown when that reveal was
        // sent, identical for every later finalize call, so retrying finalize gains nothing.
        // Falls back to block.prevrandao if nobody revealed or that block is more than 256
        // blocks old (blockhash returns 0); see the threat model for this residual risk.
        bytes32 entropy = lastReveal == 0 ? bytes32(0) : blockhash(lastReveal);
        if (entropy == bytes32(0)) entropy = bytes32(block.prevrandao);
        bytes32 seed = keccak256(abi.encodePacked(d.seed, entropy, msg.sender));
        // Fisher Yates shuffle driven by the combined seed.
        if (n > 1) {
            for (uint256 i = n - 1; i > 0; i--) {
                uint256 j = uint256(keccak256(abi.encodePacked(seed, i))) % (i + 1);
                (order[i], order[j]) = (order[j], order[i]);
            }
        }
        emit DrawFinalized(msg.sender, n == total);
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
