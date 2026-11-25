# Test results

Final run on the `final` tag (Windows 11, Node.js 24, Hardhat 2.28.6, Solidity 0.8.24).

```
npx hardhat test        124 passing
npm run test:attacks     38 passing
npx hardhat coverage    124 passing (instrumented)
```

## By suite

| Suite | Owner | Tests | What it proves |
| --- | --- | ---: | --- |
| `test/unit/Circle.test.js` | A | 35 | Every workflow W1 to W8, boundaries and failure cases, default handling, pause |
| `test/unit/Modules.test.js` | A | 17 | Vault, registry, draw, factory, token: roles and rules |
| `test/e2e/circleEndToEnd.test.js` | B | 9 | A 4 member circle with one default through IPFS, indexer, notifier, keeper and API |
| `test/e2e/indexerRebuild.test.js` | B | 6 | Rebuild from events gives identical tables; reorg and redeploy handling |
| `test/e2e/offchainUnits.test.js` | B | 11 | CIDs, API input checks, frontend error decoder |
| `test/attacks/*.test.js` (9 files) | C | 38 | Attack scenarios A1 to A9 (below) |
| `test/unit/AbiCompatibility.test.js` | C | 6 | No function signature, output or event the off chain code uses was changed |
| `test/unit/FrontendErrors.test.js` | C | 2 | Every contract revert string has a plain words message in the UI |
| **Total** | | **124** | |

## Attack scenarios (Member C)

| Id | Scenario | Tests | On handed over code | On final code |
| --- | --- | ---: | --- | --- |
| A1 | Payout reentrancy (hook token, same and cross function, during refunds; residual risk pinned) | 5 | pass | pass |
| A2 | Early recipient takes the pot and stops paying (slots 1 to 3) | 4 | pass | pass |
| A3 | Payout order rigging (reveal and finalize at once, finalize grinding, withholding, copying, late commit) | 6 | 3 fail | pass |
| A4 | Join and never pay (every slot), walk away from the draw, Sybil limitation | 6 | pass | pass |
| A5 | Fake circles, cross circle access, stolen deployer key, organizer and admin limits, clones | 6 | 2 fail (1 is the clone check, clones did not exist yet) | pass |
| A6 | Admin pause abuse (forced defaults, expired pause, chained pauses) | 5 | 3 fail | pass |
| A7 | Off chain terms tampering against the on chain CID | 3 | pass | pass |
| A8 | Colluding defaulters: invariants over 24 random patterns (200 also pass) | 1 | (added after the fixes) | pass |
| A9 | Oversized settings (packed storage) and gas exhaustion with 20 members | 2 | (added with G2) | pass |

Full outputs: `docs/security/attack_results_baseline.txt` (27 passing, 8 failing on the
contracts as handed over, A1 to A7) and `docs/security/attack_results_final.txt` (38 passing).

## Coverage (production contracts)

| Contract | Lines | Statements | Branches | Functions |
| --- | ---: | ---: | ---: | ---: |
| BaseCircleLifecycle | 95.1% | 93.3% | 84.4% | 90.0% |
| Circle | 94.9% | 94.6% | 85.0% | 87.9% |
| CircleFactory | 100% | 100% | 50.0% | 100% |
| CollateralVault | 100% | 100% | 82.4% | 100% |
| PayoutOrder | 98.5% | 98.1% | 75.9% | 90.0% |
| ReputationRegistry | 100% | 100% | 70.0% | 100% |
| MockStablecoin | 100% | 100% | 100% | 100% |

The uncovered lines in `Circle` are the leftover debt branch of `_complete`. Attack test A8 shows
why it is never reached: in round k the pot is at least (k - 1) contributions, which always
covers the recipient's earlier uncovered debt and the refill of its deposit, so no member can
still owe money when the circle completes. The branch stays as a defensive fallback.

## Live check of the whole stack

On a local Hardhat node with `npm run seed:local`, `npm run offchain`, the keeper and the web app:

* the sample circles (all clones) load in the app with the correct deposits, payments and history;
* pause, unpause and a second pause in the admin panel: the second pause is refused with
  "A new pause is possible only 7 days after the previous pause ended" (screenshot 18);
* after skipping 34 days, one keeper pass settles the active circle (the unpaid last slot becomes
  a debt, as designed), cancels the expired open circle and finalizes the draw nobody revealed,
  leaving 0 tokens in that circle (B-1 stays fixed);
* no console errors in the browser; `npm --prefix frontend run build` succeeds.
