// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseCircleLifecycle} from "./BaseCircleLifecycle.sol";
import {ICollateralVault, IPayoutOrder, IReputationRegistry} from "../interfaces/IRoscaModules.sol";

/// @title Circle
/// @notice One committee (ROSCA). Members pay a fixed amount every round and one member
///         receives the whole pot each round, in an order drawn fairly at the start.
/// @dev Money flows:
///      * security deposits (collateral) live in CollateralVault, never in this contract
///      * monthly contributions are held here until the round is settled
///      * payouts are pull based: settlement credits `withdrawable`, members call claimPayout
///      Nobody, including the organizer, has a function that moves funds anywhere else.
///
///      Guarantee: once a member has received the pot, their deposit equals 100% of the
///      contributions they still owe, so if they stop paying the others still get full pots.
///      A member who misses payments before their own payout repays from their own pot.
///
///      Gas optimizations (Member C, Stage 3). External functions, events and view outputs are
///      unchanged, so the indexer, keeper and frontend keep working:
///      * G2 storage packing: the configuration, round timing and round counter fit in three
///        slots (one of them shared with the lifecycle state); each member's position, removal flag and default count share one slot; a
///        round result takes one slot. The four shared module addresses are immutables of the
///        implementation (identical for every clone of one factory), so they cost no storage.
///        The public getters of the baseline are kept as view functions with the same outputs.
///      * Security fix S1 (attack test A6): the payment deadline of a round is pushed back by
///        the time the circle spent paused during that round (see BaseCircleLifecycle).
///      * G3 paid bitmap: who paid in a round is one uint256 per round (bit i = payout position
///        i + 1) instead of a nested mapping of bools plus a separate counter. Paying writes one
///        slot instead of two, and settling reads one slot instead of one per member.
contract Circle is BaseCircleLifecycle {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_MEMBERS = 20;

    /// Input of `createCircle` / `initialize`, and output shape of `config()` (all uint256 so
    /// the external signatures stay those of the baseline; stored packed, see below).
    struct Config {
        uint256 contribution; // amount each member pays per round (token units)
        uint256 groupSize; // members needed to start = number of rounds if everyone reveals
        uint256 roundDuration; // seconds members have to pay each round
        uint256 gracePeriod; // extra seconds after the round before defaults are applied
        uint256 joinDuration; // seconds the circle stays open for joining
        uint256 drawPhaseDuration; // seconds for the commit phase (and again for the reveal phase)
        uint256 maxDefaults; // join rule: max past defaults allowed in ReputationRegistry
        string termsCid; // IPFS CID of the human readable terms document
    }

    struct Modules {
        IERC20 token;
        ICollateralVault vault;
        IPayoutOrder payoutOrder;
        IReputationRegistry reputation;
    }

    /// One call summary for the frontend.
    struct Summary {
        State state;
        address organizer;
        uint256 contribution;
        uint256 groupSize;
        uint256 memberCount;
        uint256 participantCount;
        uint256 currentRound;
        uint256 roundDeadline;
        address currentRecipient;
        uint256 joinDeadline;
        uint256 joinCollateral;
        bool paused;
        string termsCid;
    }

    /// Everything the frontend needs about one address.
    struct MemberView {
        bool isMember;
        bool removed;
        uint256 position;
        uint256 collateral;
        bool paidThisRound;
        uint256 withdrawable;
        uint256 debt;
        uint256 deficit;
        uint256 defaults;
    }

    /// Per member record, one storage slot.
    struct MemberData {
        uint8 position; // 1 based payout position, 0 = not in the order
        bool removed; // left out of the draw for not revealing
        uint32 defaults; // missed payments in this circle
    }

    /// Result of a settled round, one storage slot. `pot` is at most MAX_MEMBERS times a
    /// uint64 contribution (< 2^69), so 88 bits always hold it. The shortfall is rare and
    /// lives in its own mapping, written only when it is not zero.
    struct RoundRecord {
        address recipient;
        bool settled;
        uint88 pot;
    }

    /// The factory that deployed this code. Only it may initialize a circle.
    /// @dev Immutables are part of the code, so they also hold for every clone.
    address public immutable factory;
    IERC20 public immutable token;
    ICollateralVault public immutable vault;
    IPayoutOrder public immutable payoutOrder;
    IReputationRegistry public immutable reputation;

    // ----- these three fill the last 88 bits of BaseCircleLifecycle's slot (state + pause
    //       bookkeeping, 168 bits): the slot is non zero from initialize on, so state changes
    //       never pay for a zero to non zero write, and every call that checks the state reads
    //       the contribution for free -----
    uint64 private _contribution;
    uint8 private _groupSize;
    uint16 private _maxDefaults;
    // ----- one slot (28 bytes): organizer and the two durations only needed before the rounds -----
    address public organizer;
    uint32 private _joinDuration;
    uint32 private _drawPhaseDuration;
    // ----- one slot (24 bytes): everything roundDeadline(), contribute and settleRound need.
    //       _joinDeadline comes first on purpose: it does not fit in the 4 bytes left above, so
    //       it starts this slot and the round fields after it stay together -----
    uint40 private _joinDeadline;
    uint32 private _roundDuration;
    uint32 private _gracePeriod;
    uint40 private _roundStart;
    uint8 private _currentRound; // 0 before Active, then 1..order.length
    uint40 private _roundPauseMark; // totalPausedTime() when the current round started
    string private _termsCid; // IPFS CID of the human readable terms document

    // ----- membership and order -----
    address[] private members; // everyone who joined
    address[] private order; // participants in payout order; order[0] is paid in round 1
    mapping(address => MemberData) private _member;

    // ----- rounds -----
    /// round => bit (position - 1) set once that member has paid the round
    mapping(uint256 => uint256) private _paidBits;
    mapping(uint256 => RoundRecord) private _rounds;
    mapping(uint256 => uint256) private _shortfall;

    // ----- balances -----
    mapping(address => uint256) public withdrawable; // pull payments
    mapping(address => uint256) public debtOf; // uncovered missed payments owed by a member
    mapping(address => uint256) public deficitOf; // amount a member was shortchanged

    event MemberJoined(address indexed member, uint256 collateral);
    event DrawStarted(uint256 phaseDuration);
    event MemberRemoved(address indexed member, uint256 penalty);
    event PayoutOrderSet(address[] order);
    event RoundStarted(uint256 indexed round, address indexed recipient, uint256 deadline);
    event ContributionMade(uint256 indexed round, address indexed member, uint256 amount);
    event MemberDefaulted(uint256 indexed round, address indexed member, uint256 covered, uint256 uncovered);
    event DebtRecovered(address indexed debtor, uint256 amount);
    event CollateralRefilled(address indexed member, uint256 amount);
    event RoundSettled(uint256 indexed round, address indexed recipient, uint256 pot, uint256 shortfall);
    event PayoutClaimed(address indexed member, uint256 amount);
    event CircleCancelled(address indexed by);
    event CircleCompleted();

    /// @dev Runs once, for the implementation deployed by the factory. Clones share its code
    ///      and therefore these immutables.
    constructor(IERC20 token_, ICollateralVault vault_, IPayoutOrder payoutOrder_, IReputationRegistry reputation_) {
        require(
            address(token_) != address(0) && address(vault_) != address(0) && address(payoutOrder_) != address(0)
                && address(reputation_) != address(0),
            "Circle: zero module"
        );
        factory = msg.sender;
        token = token_;
        vault = vault_;
        payoutOrder = payoutOrder_;
        reputation = reputation_;
    }

    /// @notice Sets up a new circle. Called once, by the factory, in the same transaction
    ///         that creates the circle, so nobody can front run it.
    function initialize(Config calldata cfg, Modules calldata mods, address organizer_, address pauser_)
        external
        initializer
    {
        require(msg.sender == factory, "Circle: only factory");
        require(cfg.contribution > 0, "Circle: zero contribution");
        require(cfg.groupSize >= 2 && cfg.groupSize <= MAX_MEMBERS, "Circle: bad group size");
        require(cfg.roundDuration > 0 && cfg.joinDuration > 0 && cfg.drawPhaseDuration > 0, "Circle: zero duration");
        require(bytes(cfg.termsCid).length > 0, "Circle: missing terms");
        require(
            address(mods.token) == address(token) && address(mods.vault) == address(vault)
                && address(mods.payoutOrder) == address(payoutOrder) && address(mods.reputation) == address(reputation),
            "Circle: wrong module"
        );
        // Packed storage: reject values that would not fit instead of truncating them.
        require(cfg.contribution <= type(uint64).max, "Circle: contribution too large");
        require(
            cfg.roundDuration <= type(uint32).max && cfg.gracePeriod <= type(uint32).max
                && cfg.joinDuration <= type(uint32).max && cfg.drawPhaseDuration <= type(uint32).max,
            "Circle: duration too long"
        );
        require(cfg.maxDefaults <= type(uint16).max, "Circle: max defaults too large");

        __BaseCircleLifecycle_init(organizer_, pauser_);
        organizer = organizer_;
        _contribution = uint64(cfg.contribution);
        _groupSize = uint8(cfg.groupSize);
        _maxDefaults = uint16(cfg.maxDefaults);
        _roundDuration = uint32(cfg.roundDuration);
        _gracePeriod = uint32(cfg.gracePeriod);
        _joinDuration = uint32(cfg.joinDuration);
        _drawPhaseDuration = uint32(cfg.drawPhaseDuration);
        _joinDeadline = uint40(block.timestamp + cfg.joinDuration);
        _termsCid = cfg.termsCid;
    }

    // =====================================================================
    // W2  Join
    // =====================================================================

    /// @notice Collateral every member locks when joining (the amount slot 1 needs).
    ///         The excess is refunded once the draw fixes each member's position.
    function joinCollateral() public view returns (uint256) {
        return vault.requiredCollateral(_contribution, _groupSize, 1);
    }

    /// @notice Join the circle. Caller must first approve the vault for joinCollateral().
    function join() external inState(State.Open) whenNotPaused nonReentrant {
        require(block.timestamp <= _joinDeadline, "Circle: joining closed");
        require(!hasRole(MEMBER_ROLE, msg.sender), "Circle: already a member");
        uint256 size = _groupSize;
        require(members.length < size, "Circle: full");
        require(reputation.isEligible(msg.sender, _maxDefaults), "Circle: too many past defaults");

        _grantRole(MEMBER_ROLE, msg.sender);
        members.push(msg.sender);

        uint256 collateral = vault.requiredCollateral(_contribution, size, 1);
        vault.deposit(msg.sender, msg.sender, collateral);
        reputation.recordJoin(msg.sender);
        emit MemberJoined(msg.sender, collateral);

        if (members.length == size) {
            _transition(State.OrderDraw);
            uint256 phase = _drawPhaseDuration;
            payoutOrder.startDraw(members, phase);
            emit DrawStarted(phase);
        }
    }

    // =====================================================================
    // W8  Cancel (circle never filled)
    // =====================================================================

    /// @notice Organizer may cancel while the circle is still open; anyone may cancel
    ///         once the join deadline has passed without the circle filling up.
    function cancel() external inState(State.Open) nonReentrant {
        require(
            hasRole(ORGANIZER_ROLE, msg.sender) || block.timestamp > _joinDeadline,
            "Circle: only organizer before deadline"
        );
        _cancelAndRefund();
    }

    // =====================================================================
    // W3  Payout order draw (members commit and reveal on PayoutOrder directly)
    // =====================================================================

    /// @notice Closes the draw. Anyone can call it once every member revealed, or after
    ///         the reveal window.
    /// @dev Members who did not reveal are removed: one contribution of their deposit is
    ///      taken as a penalty and shared by the members who did reveal, the rest of their
    ///      deposit is returned, and a default is recorded. The circle continues with the
    ///      remaining members; it is only cancelled if fewer than two revealed.
    function finalizeDraw() external inState(State.OrderDraw) nonReentrant {
        // `drawn` holds exactly the members who revealed, in payout order.
        address[] memory drawn = payoutOrder.finalize();
        uint256 n = drawn.length;
        // B-1: the penalty for not revealing is shared among the members who revealed.
        // If nobody revealed there is nobody to share it with, so no penalty is taken:
        // otherwise the slashed tokens would stay in this cancelled circle forever.
        bool anyoneRevealed = n > 0;
        uint256 c = _contribution;

        uint256 penaltyPool = 0;
        uint256 total = members.length;
        for (uint256 i = 0; i < total; i++) {
            address m = members[i];
            // Read the reveal set from `drawn` in memory instead of one external call per member.
            if (_contains(drawn, m)) continue;
            MemberData storage md = _member[m];
            md.removed = true;
            md.defaults += 1;
            _revokeRole(MEMBER_ROLE, m);
            reputation.recordDefault(m);
            uint256 penalty = anyoneRevealed ? vault.slash(m, c) : 0;
            penaltyPool += penalty;
            vault.release(m, type(uint256).max);
            emit MemberRemoved(m, penalty);
        }

        if (penaltyPool > 0 && n > 0) {
            uint256 share = penaltyPool / n;
            for (uint256 i = 0; i < n; i++) {
                withdrawable[drawn[i]] += share;
            }
            withdrawable[drawn[0]] += penaltyPool - share * n; // rounding dust
        }

        if (n < 2) {
            _cancelAndRefund();
            return;
        }

        for (uint256 i = 0; i < n; i++) {
            order.push(drawn[i]);
            _member[drawn[i]].position = uint8(i + 1);
        }
        emit PayoutOrderSet(drawn);

        // Later positions owe less after their payout, so they need less collateral.
        for (uint256 i = 0; i < n; i++) {
            address m = drawn[i];
            uint256 required = vault.requiredCollateral(c, n, i + 1);
            uint256 locked = vault.collateralOf(address(this), m);
            if (locked > required) {
                vault.release(m, locked - required);
            }
        }

        _transition(State.Active);
        _startRound(1);
    }

    // =====================================================================
    // W4  Contribute
    // =====================================================================

    /// @notice Pay this round's contribution. Caller must approve this circle first.
    function contribute() external inState(State.Active) whenNotPaused nonReentrant onlyRole(MEMBER_ROLE) {
        uint256 r = _currentRound;
        // Every MEMBER_ROLE holder in the Active state has a payout position (non revealers
        // lost the role in finalizeDraw), so position - 1 is a valid bit index.
        uint256 bit = 1 << (_member[msg.sender].position - 1);
        uint256 bits = _paidBits[r];
        require(bits & bit == 0, "Circle: already paid this round");
        require(block.timestamp <= roundDeadline(), "Circle: round closed");

        _paidBits[r] = bits | bit;
        uint256 c = _contribution;
        token.safeTransferFrom(msg.sender, address(this), c);
        emit ContributionMade(r, msg.sender, c);
    }

    /// @notice Last moment a payment for the current round is accepted. Time spent paused
    ///         during the round is added, because nobody can pay while the circle is paused.
    function roundDeadline() public view returns (uint256) {
        return uint256(_roundStart) + _roundDuration + _gracePeriod + (totalPausedTime() - _roundPauseMark);
    }

    // =====================================================================
    // W5  Settle round (anyone, normally the keeper script)
    // =====================================================================

    /// @notice Closes the current round: covers missed payments from deposits, credits the
    ///         pot to this round's recipient and starts the next round.
    function settleRound() external inState(State.Active) nonReentrant {
        uint256 r = _currentRound;
        uint256 n = order.length;
        uint256 bits = _paidBits[r];
        uint256 everyone = (1 << n) - 1;
        require(bits == everyone || block.timestamp > roundDeadline(), "Circle: round still open");

        address recipient = order[r - 1];
        uint256 c = _contribution;
        uint256 pot = 0;
        uint256 shortfall = 0;

        if (bits == everyone) {
            pot = n * c;
        } else {
            for (uint256 i = 0; i < n; i++) {
                if ((bits >> i) & 1 == 1) {
                    pot += c;
                    continue;
                }
                address m = order[i];
                _member[m].defaults += 1;
                reputation.recordDefault(m);

                if (m == recipient) {
                    // Missing your own payout round only shrinks your own pot.
                    emit MemberDefaulted(r, m, 0, 0);
                    continue;
                }
                uint256 covered = vault.slash(m, c);
                uint256 uncovered = c - covered;
                pot += covered;
                if (uncovered > 0) {
                    // Only possible before the defaulter's own payout: repaid from their pot later.
                    shortfall += uncovered;
                    debtOf[m] += uncovered;
                    deficitOf[recipient] += uncovered;
                }
                emit MemberDefaulted(r, m, covered, uncovered);
            }
        }

        // 1. If the recipient owes money from earlier defaults, repay it out of their pot first.
        uint256 debt = debtOf[recipient];
        if (debt > 0 && pot > 0) {
            uint256 recovered = debt > pot ? pot : debt;
            debtOf[recipient] = debt - recovered;
            pot -= recovered;
            _payCreditors(recovered);
            emit DebtRecovered(recipient, recovered);
        }

        // 2. If earlier defaults used up part of the recipient's deposit, refill it from their
        //    pot so it again covers 100% of what they still owe after being paid.
        uint256 required = vault.requiredCollateral(c, n, r);
        uint256 locked = vault.collateralOf(address(this), recipient);
        if (locked < required && pot > 0) {
            uint256 refill = required - locked > pot ? pot : required - locked;
            pot -= refill;
            token.forceApprove(address(vault), refill);
            vault.deposit(address(this), recipient, refill);
            emit CollateralRefilled(recipient, refill);
        }

        withdrawable[recipient] += pot;
        _rounds[r] = RoundRecord({recipient: recipient, settled: true, pot: uint88(pot)});
        if (shortfall > 0) _shortfall[r] = shortfall;
        emit RoundSettled(r, recipient, pot, shortfall);

        if (r == n) {
            _complete();
        } else {
            _startRound(r + 1);
        }
    }

    // =====================================================================
    // W6  Claim payout (pull payment)
    // =====================================================================

    /// @notice Withdraw everything credited to the caller (pot, debt repayments, penalties).
    /// @dev Not blocked by pause, so members can always get their money out.
    function claimPayout() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "Circle: nothing to claim");
        withdrawable[msg.sender] = 0; // effects before the transfer
        token.safeTransfer(msg.sender, amount);
        emit PayoutClaimed(msg.sender, amount);
    }

    // =====================================================================
    // Views for the frontend and indexer (same outputs as the baseline getters)
    // =====================================================================

    function config()
        external
        view
        returns (
            uint256 contribution,
            uint256 groupSize,
            uint256 roundDuration,
            uint256 gracePeriod,
            uint256 joinDuration,
            uint256 drawPhaseDuration,
            uint256 maxDefaults,
            string memory termsCid
        )
    {
        return (
            _contribution,
            _groupSize,
            _roundDuration,
            _gracePeriod,
            _joinDuration,
            _drawPhaseDuration,
            _maxDefaults,
            _termsCid
        );
    }

    function rounds(uint256 round)
        external
        view
        returns (address recipient, uint256 pot, uint256 shortfall, bool settled)
    {
        RoundRecord memory rr = _rounds[round];
        return (rr.recipient, rr.pot, _shortfall[round], rr.settled);
    }

    /// @notice True when `account` has paid `round` (same output as the baseline mapping getter).
    function hasPaid(uint256 round, address account) public view returns (bool) {
        uint256 pos = _member[account].position;
        return pos != 0 && (_paidBits[round] >> (pos - 1)) & 1 == 1;
    }

    /// @notice Number of members who paid `round`.
    function paidCount(uint256 round) external view returns (uint256 count) {
        uint256 bits = _paidBits[round];
        while (bits != 0) {
            count += bits & 1;
            bits >>= 1;
        }
    }

    function currentRound() public view returns (uint256) {
        return _currentRound;
    }

    function roundStart() external view returns (uint256) {
        return _roundStart;
    }

    function joinDeadline() external view returns (uint256) {
        return _joinDeadline;
    }

    /// @notice 1 based payout position, 0 = not in the order.
    function positionOf(address account) external view returns (uint256) {
        return _member[account].position;
    }

    /// @notice True for a member left out of the draw for not revealing.
    function removed(address account) external view returns (bool) {
        return _member[account].removed;
    }

    function defaultsInCircle(address account) external view returns (uint256) {
        return _member[account].defaults;
    }

    function getMembers() external view returns (address[] memory) {
        return members;
    }

    function getPayoutOrder() external view returns (address[] memory) {
        return order;
    }

    function memberCount() external view returns (uint256) {
        return members.length;
    }

    /// @notice Members taking part in the rounds (members minus anyone removed in the draw).
    function participantCount() external view returns (uint256) {
        return order.length;
    }

    function isMember(address account) external view returns (bool) {
        return hasRole(MEMBER_ROLE, account);
    }

    function currentRecipient() public view returns (address) {
        if (state != State.Active) return address(0);
        return order[_currentRound - 1];
    }

    function getSummary() external view returns (Summary memory s) {
        s.state = state;
        s.organizer = organizer;
        s.contribution = _contribution;
        s.groupSize = _groupSize;
        s.memberCount = members.length;
        s.participantCount = order.length;
        s.currentRound = _currentRound;
        s.roundDeadline = state == State.Active ? roundDeadline() : 0;
        s.currentRecipient = currentRecipient();
        s.joinDeadline = _joinDeadline;
        s.joinCollateral = joinCollateral();
        s.paused = paused();
        s.termsCid = _termsCid;
    }

    function getMemberInfo(address account) external view returns (MemberView memory v) {
        MemberData memory md = _member[account];
        uint256 r = _currentRound;
        v.isMember = hasRole(MEMBER_ROLE, account);
        v.removed = md.removed;
        v.position = md.position;
        v.collateral = vault.collateralOf(address(this), account);
        v.paidThisRound = r > 0 && hasPaid(r, account);
        v.withdrawable = withdrawable[account];
        v.debt = debtOf[account];
        v.deficit = deficitOf[account];
        v.defaults = md.defaults;
    }

    // =====================================================================
    // Internal
    // =====================================================================

    function _startRound(uint256 r) private {
        _currentRound = uint8(r);
        _roundStart = uint40(block.timestamp);
        _roundPauseMark = uint40(totalPausedTime());
        emit RoundStarted(r, order[r - 1], roundDeadline());
    }

    /// W7  Complete: settle any leftover debt from deposits, release the rest, update reputation.
    function _complete() private {
        _transition(State.Completed);
        uint256 n = order.length;
        for (uint256 i = 0; i < n; i++) {
            address m = order[i];
            uint256 debt = debtOf[m];
            if (debt > 0) {
                uint256 taken = vault.slash(m, debt);
                if (taken > 0) {
                    debtOf[m] = debt - taken;
                    _payCreditors(taken);
                    emit DebtRecovered(m, taken);
                }
            }
        }
        for (uint256 i = 0; i < n; i++) {
            address m = order[i];
            vault.release(m, type(uint256).max);
            if (_member[m].defaults == 0) {
                reputation.recordCompletion(m);
            }
        }
        emit CircleCompleted();
    }

    /// Hands recovered money to members who were shortchanged, in payout order.
    function _payCreditors(uint256 amount) private {
        uint256 n = order.length;
        for (uint256 i = 0; i < n && amount > 0; i++) {
            address m = order[i];
            uint256 deficit = deficitOf[m];
            if (deficit == 0) continue;
            uint256 give = deficit > amount ? amount : deficit;
            deficitOf[m] = deficit - give;
            withdrawable[m] += give;
            amount -= give;
        }
    }

    function _cancelAndRefund() private {
        _transition(State.Cancelled);
        uint256 total = members.length;
        for (uint256 i = 0; i < total; i++) {
            vault.release(members[i], type(uint256).max);
        }
        emit CircleCancelled(msg.sender);
    }

    function _contains(address[] memory list, address who) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == who) return true;
        }
        return false;
    }
}
