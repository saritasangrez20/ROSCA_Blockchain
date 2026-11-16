# Handoff 1: Contracts (Member A to Member B)

Tag: `handoff_1` (create it once this note is merged).

## What works

* All 7 contracts compile with Solidity 0.8.24 and are under the 24 KB size limit.
* 51 automated tests pass (`npx hardhat test`): normal, boundary and failure cases, including
  unauthorized calls for every role. Line coverage about 97% (`npx hardhat coverage`).
* `scripts/deploy.js` deploys everything and writes `deployments/<network>.json` and `deployments/abi/`.
* `scripts/seedLocal.js` (`npm run seed:local`) deploys to a local node and creates three sample
  circles: one Open, one in the order draw, one Active with three of four round 1 payments.
* `scripts/demo.js` plays a full circle with one default in the console.
* `scripts/measureGas.js` writes baseline gas to `docs/gas/baseline.json`.

## How to run

```bash
npm install
npx hardhat test
npx hardhat node
npm run seed:local
```

The last two in separate terminals. Then import Hardhat accounts #1 to #5 into MetaMask
(private keys are printed by `npx hardhat node`; these are public test keys, never use them for real money).
Network: `http://127.0.0.1:8545`, chain id `31337`.

## Notes for Member B (frontend and off chain)

* **Two approvals.** Joining needs `token.approve(vaultAddress, circle.joinCollateral())` first.
  Paying needs `token.approve(circleAddress, contribution)` first. The UI must do both steps.
* **Commit and reveal go to `PayoutOrder`, not `Circle`.** Generate a random 32 byte secret in the
  browser, compute `PayoutOrder.computeCommitment(secret, account, circle)`, call `commit`, and keep
  the secret (for example in localStorage) until reveal. Losing it means losing one contribution.
* **Anyone can call** `finalizeDraw` and `settleRound`. The keeper script should call `settleRound`
  when `getSummary().roundDeadline` has passed, and `finalizeDraw` after the reveal deadline
  (`PayoutOrder.getDraw(circle).revealDeadline`).
* Use `getSummary()` and `getMemberInfo(address)` for screens; use events for history (see
  `docs/workflows.md` for the full list).
* Revert reasons are plain strings (for example `"Circle: round closed"`), plus OpenZeppelin custom
  errors for roles (`AccessControlUnauthorizedAccount`), pause (`EnforcedPause`) and token allowance
  (`ERC20InsufficientAllowance`). Show them to the user.
* Please do not change contract function signatures or events. Report contract bugs to Member A.

## Notes for Member C (gas and security)

Baseline choices left on purpose for you to optimize and measure:

| Baseline | Candidate optimization |
| --- | --- |
| Factory deploys a full `Circle` with `new Circle()` | EIP 1167 clone of one implementation. `Circle` already uses `initialize`, and `factory` is an immutable, so clones work as is: deploy the implementation in the factory constructor and replace `new Circle()` with `Clones.clone(implementation)`. |
| `hasPaid[round][member]` is a nested mapping of bools | One bitmap per round |
| `Config` is all `uint256` | Pack durations and counts into smaller types |
| Revert strings everywhere | Custom errors |
| `ReputationRegistry` keeps history in storage arrays | Events only; the indexer rebuilds history |

Attack scenarios worth testing (normal behaviour already has unit tests):

* **Early recipient default:** covered by the 100% deposit rule; see `Circle.test.js` "defaults keep
  everyone else whole".
* **Order rigging:** a member tries to pick a better slot by not revealing. They are removed and
  lose one contribution; the final seed also uses `block.prevrandao` at finalize time, so the last
  revealer cannot compute the order in advance.
* **Join and never pay:** a member joins and pays nothing; deposits and slashing cover it.
* **Payout reentrancy:** a malicious token or receiver re entering `claimPayout` or `settleRound`;
  every external entry point is `nonReentrant` and updates state before transferring.
* **Unauthorized slash:** only circles registered by the factory hold `CIRCLE_ROLE` on the vault.

## Review fixes included in this handoff

| Issue raised | Fix |
| --- | --- |
| A. 50% deposits would make "others are made whole" false | Deposits are fixed at 100% of what a paid member still owes; the coverage setting was removed. Deposits used up before a member's payout are refilled from that member's own pot. |
| B. One member could cancel the circle by not revealing; the last revealer had an edge | Non revealers are removed with a one contribution penalty shared by the others, and the circle continues (cancelled only if fewer than 2 revealed). The final seed mixes in `block.prevrandao` at finalize time. |
| C. The admin pause is a trust point | Pause only blocks joining and paying, and expires on its own after 7 days. Settling, refunds and withdrawals always work. To be explained in the threat model (Member C). |
| D. Clones do not run constructors | `Circle` and `BaseCircleLifecycle` use an `initialize` function (OpenZeppelin `Initializable`), callable once and only by the factory. |

## Known limitations

* If several members with empty deposits miss payments in the same rounds, a small shortfall can
  remain until their own payouts; anything still owed at the end is taken from their remaining deposit.
* `block.prevrandao` can be slightly influenced by the block proposer. Acceptable for this project;
  Chainlink VRF would remove it (future work).
* Members lock the slot 1 deposit when joining. That is a barrier for poorer members until the draw
  refunds the excess.
* Who is the admin: the account that deploys the system (the platform operator). It can only pause,
  for at most 7 days, and cannot move anyone's money.
