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
contract Circle is BaseCircleLifecycle {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_MEMBERS = 20;

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

    struct RoundResult {
        address recipient;
        uint256 pot;
        uint256 shortfall;
        bool settled;
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

    /// The factory that deployed this code. Only it may initialize a circle.
    /// @dev Immutable, so it is part of the code itself and also holds for clones.
    address public immutable factory;

    // ----- configuration (set once in initialize) -----
    Config public config;
    IERC20 public token;
    ICollateralVault public vault;
    IPayoutOrder public payoutOrder;
    IReputationRegistry public reputation;
    address public organizer;
    uint256 public joinDeadline;

    // ----- membership and order -----
    address[] private members; // everyone who joined
    address[] private order; // participants in payout order; order[0] is paid in round 1
    mapping(address => uint256) public positionOf; // 1 based, 0 = not in the order
    mapping(address => bool) public removed; // left out of the draw for not revealing

    // ----- rounds -----
    uint256 public currentRound; // 0 before Active, then 1..order.length
    uint256 public roundStart;
    mapping(uint256 => mapping(address => bool)) public hasPaid;
    mapping(uint256 => uint256) public paidCount;
    mapping(uint256 => RoundResult) public rounds;

    // ----- balances and records -----
    mapping(address => uint256) public withdrawable; // pull payments
    mapping(address => uint256) public debtOf; // uncovered missed payments owed by a member
    mapping(address => uint256) public deficitOf; // amount a member was shortchanged
    mapping(address => uint256) public defaultsInCircle;

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

    constructor() {
        factory = msg.sender;
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
            address(mods.token) != address(0) && address(mods.vault) != address(0)
                && address(mods.payoutOrder) != address(0) && address(mods.reputation) != address(0),
            "Circle: zero module"
        );
        __BaseCircleLifecycle_init(organizer_, pauser_);
        config = cfg;
        token = mods.token;
        vault = mods.vault;
        payoutOrder = mods.payoutOrder;
        reputation = mods.reputation;
        organizer = organizer_;
        joinDeadline = block.timestamp + cfg.joinDuration;
    }

    // =====================================================================
    // W2  Join
    // =====================================================================

    /// @notice Collateral every member locks when joining (the amount slot 1 needs).
    ///         The excess is refunded once the draw fixes each member's position.
    function joinCollateral() public view returns (uint256) {
        return vault.requiredCollateral(config.contribution, config.groupSize, 1);
    }

    /// @notice Join the circle. Caller must first approve the vault for joinCollateral().
    function join() external inState(State.Open) whenNotPaused nonReentrant {
        require(block.timestamp <= joinDeadline, "Circle: joining closed");
        require(!hasRole(MEMBER_ROLE, msg.sender), "Circle: already a member");
        require(members.length < config.groupSize, "Circle: full");
        require(reputation.isEligible(msg.sender, config.maxDefaults), "Circle: too many past defaults");

        _grantRole(MEMBER_ROLE, msg.sender);
        members.push(msg.sender);

        uint256 collateral = joinCollateral();
        vault.deposit(msg.sender, msg.sender, collateral);
        reputation.recordJoin(msg.sender);
        emit MemberJoined(msg.sender, collateral);

        if (members.length == config.groupSize) {
            _transition(State.OrderDraw);
            payoutOrder.startDraw(members, config.drawPhaseDuration);
            emit DrawStarted(config.drawPhaseDuration);
        }
    }

    // =====================================================================
    // W8  Cancel (circle never filled)
    // =====================================================================

    /// @notice Organizer may cancel while the circle is still open; anyone may cancel
    ///         once the join deadline has passed without the circle filling up.
    function cancel() external inState(State.Open) nonReentrant {
        require(
            hasRole(ORGANIZER_ROLE, msg.sender) || block.timestamp > joinDeadline, "Circle: only organizer before deadline"
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
        address[] memory drawn = payoutOrder.finalize();
        // B-1: the penalty for not revealing is shared among the members who revealed.
        // If nobody revealed there is nobody to share it with, so no penalty is taken:
        // otherwise the slashed tokens would stay in this cancelled circle forever.
        bool anyoneRevealed = drawn.length > 0;

        uint256 penaltyPool = 0;
        for (uint256 i = 0; i < members.length; i++) {
            address m = members[i];
            if (payoutOrder.hasRevealed(address(this), m)) continue;
            removed[m] = true;
            _revokeRole(MEMBER_ROLE, m);
            defaultsInCircle[m] += 1;
            reputation.recordDefault(m);
            uint256 penalty = anyoneRevealed ? vault.slash(m, config.contribution) : 0;
            penaltyPool += penalty;
            vault.release(m, type(uint256).max);
            emit MemberRemoved(m, penalty);
        }

        if (penaltyPool > 0 && drawn.length > 0) {
            uint256 share = penaltyPool / drawn.length;
            for (uint256 i = 0; i < drawn.length; i++) {
                withdrawable[drawn[i]] += share;
            }
            withdrawable[drawn[0]] += penaltyPool - share * drawn.length; // rounding dust
        }

        if (drawn.length < 2) {
            _cancelAndRefund();
            return;
        }

        uint256 n = drawn.length;
        for (uint256 i = 0; i < n; i++) {
            order.push(drawn[i]);
            positionOf[drawn[i]] = i + 1;
        }
        emit PayoutOrderSet(drawn);

        // Later positions owe less after their payout, so they need less collateral.
        for (uint256 i = 0; i < n; i++) {
            address m = drawn[i];
            uint256 required = vault.requiredCollateral(config.contribution, n, i + 1);
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
        uint256 r = currentRound;
        require(!hasPaid[r][msg.sender], "Circle: already paid this round");
        require(block.timestamp <= roundDeadline(), "Circle: round closed");

        hasPaid[r][msg.sender] = true;
        paidCount[r] += 1;
        token.safeTransferFrom(msg.sender, address(this), config.contribution);
        emit ContributionMade(r, msg.sender, config.contribution);
    }

    /// @notice Last moment a payment for the current round is accepted.
    function roundDeadline() public view returns (uint256) {
        return roundStart + config.roundDuration + config.gracePeriod;
    }

    // =====================================================================
    // W5  Settle round (anyone, normally the keeper script)
    // =====================================================================

    /// @notice Closes the current round: covers missed payments from deposits, credits the
    ///         pot to this round's recipient and starts the next round.
    function settleRound() external inState(State.Active) nonReentrant {
        uint256 r = currentRound;
        uint256 n = order.length;
        require(paidCount[r] == n || block.timestamp > roundDeadline(), "Circle: round still open");

        address recipient = order[r - 1];
        uint256 pot = paidCount[r] * config.contribution;
        uint256 shortfall = 0;

        for (uint256 i = 0; i < n; i++) {
            address m = order[i];
            if (hasPaid[r][m]) continue;
            defaultsInCircle[m] += 1;
            reputation.recordDefault(m);

            if (m == recipient) {
                // Missing your own payout round only shrinks your own pot.
                emit MemberDefaulted(r, m, 0, 0);
                continue;
            }
            uint256 covered = vault.slash(m, config.contribution);
            uint256 uncovered = config.contribution - covered;
            pot += covered;
            if (uncovered > 0) {
                // Only possible before the defaulter's own payout: repaid from their pot later.
                shortfall += uncovered;
                debtOf[m] += uncovered;
                deficitOf[recipient] += uncovered;
            }
            emit MemberDefaulted(r, m, covered, uncovered);
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
        uint256 required = vault.requiredCollateral(config.contribution, n, r);
        uint256 locked = vault.collateralOf(address(this), recipient);
        if (locked < required && pot > 0) {
            uint256 refill = required - locked > pot ? pot : required - locked;
            pot -= refill;
            token.forceApprove(address(vault), refill);
            vault.deposit(address(this), recipient, refill);
            emit CollateralRefilled(recipient, refill);
        }

        withdrawable[recipient] += pot;
        rounds[r] = RoundResult({recipient: recipient, pot: pot, shortfall: shortfall, settled: true});
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
    // Views for the frontend and indexer
    // =====================================================================

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
        return order[currentRound - 1];
    }

    function getSummary() external view returns (Summary memory s) {
        s.state = state;
        s.organizer = organizer;
        s.contribution = config.contribution;
        s.groupSize = config.groupSize;
        s.memberCount = members.length;
        s.participantCount = order.length;
        s.currentRound = currentRound;
        s.roundDeadline = state == State.Active ? roundDeadline() : 0;
        s.currentRecipient = currentRecipient();
        s.joinDeadline = joinDeadline;
        s.joinCollateral = joinCollateral();
        s.paused = paused();
        s.termsCid = config.termsCid;
    }

    function getMemberInfo(address account) external view returns (MemberView memory v) {
        v.isMember = hasRole(MEMBER_ROLE, account);
        v.removed = removed[account];
        v.position = positionOf[account];
        v.collateral = vault.collateralOf(address(this), account);
        v.paidThisRound = currentRound > 0 && hasPaid[currentRound][account];
        v.withdrawable = withdrawable[account];
        v.debt = debtOf[account];
        v.deficit = deficitOf[account];
        v.defaults = defaultsInCircle[account];
    }

    // =====================================================================
    // Internal
    // =====================================================================

    function _startRound(uint256 r) private {
        currentRound = r;
        roundStart = block.timestamp;
        emit RoundStarted(r, order[r - 1], roundDeadline());
    }

    /// W7  Complete: settle any leftover debt from deposits, release the rest, update reputation.
    function _complete() private {
        _transition(State.Completed);
        for (uint256 i = 0; i < order.length; i++) {
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
        for (uint256 i = 0; i < order.length; i++) {
            address m = order[i];
            vault.release(m, type(uint256).max);
            if (defaultsInCircle[m] == 0) {
                reputation.recordCompletion(m);
            }
        }
        emit CircleCompleted();
    }

    /// Hands recovered money to members who were shortchanged, in payout order.
    function _payCreditors(uint256 amount) private {
        for (uint256 i = 0; i < order.length && amount > 0; i++) {
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
        for (uint256 i = 0; i < members.length; i++) {
            vault.release(members[i], type(uint256).max);
        }
        emit CircleCancelled(msg.sender);
    }
}
