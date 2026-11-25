# Mitigation map

Each threat from `threat_model.md`, the control that stops it, where the control is in the code,
and the test that proves it. "Before" is the result of the same attack test on the code as handed
over to Member C (`attack_results_baseline.txt`); "After" is the final code
(`attack_results_final.txt`). Run the suite with `npm run test:attacks`.

| Threat | Control | Code | Test (`test/attacks/`) | Before | After |
| --- | --- | --- | --- | --- | --- |
| T1 payout reentrancy | `nonReentrant` on every external entry point; state updated before every transfer; pull payments | `Circle.claimPayout`, `settleRound`, `finalizeDraw`, `cancel`; `CollateralVault.deposit/release/slash` | `payoutReentrancy.test.js` (4 tests) | pass | pass |
| T2 take the pot and run | deposit = 100% of what is still owed after payout; slash each missed round | `CollateralVault.requiredCollateral`; `Circle.settleRound` | `earlyRecipientDefault.test.js` (slots 1 to 3, next circle refuses) | pass | pass |
| T3 join and never pay | slash, then debt repaid from own pot first, then refill | `Circle.settleRound` steps 1 and 2 | `joinAndNeverPay.test.js` (slots 1 to 4, walk away variant) | pass | pass |
| T4 collusion | pot of round k is at least (k-1) contributions | `Circle.settleRound` | `collusionInvariants.test.js` (24 random patterns; 200 with `INVARIANT_TRIALS=200`) | pass | pass |
| T5 withhold reveal | removal, one contribution penalty shared by revealers, continue with 2 or more | `Circle.finalizeDraw` | `orderRigging.test.js` "withholding a reveal" | pass | pass |
| T6 reveal and finalize in one transaction | finalize only in a later block than the last reveal (**S2**) | `PayoutOrder.reveal` stores `lastRevealBlock`; `PayoutOrder.finalize` checks it | `orderRigging.test.js` "cannot reveal and finalize in one transaction" | **fail** | pass |
| T7 grind the finalize block | entropy = `blockhash(lastRevealBlock)` (**S2**) | `PayoutOrder.finalize` | `orderRigging.test.js` "order is fixed", "grinding does not help" | **fail** (attacker got its slot within 12 blocks) | pass |
| T8 copy a commitment | commitment bound to the member address | `PayoutOrder.computeCommitment`, `reveal` | `orderRigging.test.js` "copied from the mempool" | pass | pass |
| T9 commit after seeing secrets | reveal only after all committed or window closed | `PayoutOrder.commit`, `reveal` | `orderRigging.test.js` "nobody can see a secret" | pass | pass |
| T10 fake circle | `CIRCLE_ROLE` on every module write | `CollateralVault`, `PayoutOrder`, `ReputationRegistry` | `unauthorizedAccess.test.js` "contract deployed outside the factory" | pass | pass |
| T11 registered circle crosses circles | balances keyed by (circle, member) | `CollateralVault.collateralOf[circle][member]` | `unauthorizedAccess.test.js` "only touch its own members' deposits" | pass | pass |
| T12 stolen deployer key | renounce `DEFAULT_ADMIN_ROLE` after setup (**S3**) | `scripts/deploy.js` `deployAll` | `unauthorizedAccess.test.js` "nobody, not even the deployer, can register" | **fail** | pass |
| T13 organizer or admin theft | no function moves funds to them | `Circle` (no such function) | `unauthorizedAccess.test.js` "organizer has no path", "admin can pause, but cannot take" | pass | pass |
| T14 re initialization | `initializer`, factory only, same transaction | `Circle.initialize`, `CircleFactory.createCircle` | `unauthorizedAccess.test.js` "exact EIP 1167 clones" plus unit tests | n/a (no clones yet) | pass |
| T15 pause forces defaults | paused time added to the deadline (**S1**) | `BaseCircleLifecycle.totalPausedTime`; `Circle.roundDeadline`, `_startRound` | `adminPauseAbuse.test.js` "no longer forces members into default", "runs out by itself" | **fail** (all four members slashed) | pass |
| T16 chained pauses | 7 day cooldown (**S1**) | `BaseCircleLifecycle.pause` | `adminPauseAbuse.test.js` "cannot chain pauses" | **fail** | pass |
| T17 packed overflow | range checks | `Circle.initialize`, `PayoutOrder.startDraw` | `limitsAndGasExhaustion.test.js` "rejected instead of truncated" | n/a (no packing yet) | pass |
| T18 gas exhaustion | `MAX_MEMBERS = 20` | `Circle.initialize` | `limitsAndGasExhaustion.test.js` "biggest circle" (832,971 gas) | n/a | pass |
| T19 terms tampering | CID on chain, re hash in the browser | `Circle.initialize` stores the CID; `frontend/src/components/TermsCheck.jsx`; `offchain/lib/cid.js` | `termsTampering.test.js`; B's `offchainUnits.test.js`; `frontend/tests/ui-trust-checks.mjs tamper` | pass | pass |
| T20 indexer lies or is down | chain reads for decisions; chain fallback | `frontend/src/lib/chainData.js` | B's `indexerRebuild.test.js`; `ui-trust-checks.mjs offline` | pass | pass |
| T21 keeper stops | public functions | `offchain/keeper/keeper.js` | B's `circleEndToEnd.test.js` | pass | pass |
| R2 hook token blocks refunds | token fixed to a plain ERC20 at deployment | `CircleFactory` constructor | `payoutReentrancy.test.js` "residual risk (accepted)" | (pinned) | (pinned) |
| R3 Sybil | deposit is the protection | `CollateralVault.requiredCollateral` | `joinAndNeverPay.test.js` "fresh address passes" | (pinned) | (pinned) |

Interface guard: `test/unit/AbiCompatibility.test.js` proves none of these fixes changed a
function signature, output or event that the frontend, indexer or keeper use.
