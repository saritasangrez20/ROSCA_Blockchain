# Final handoff: hardening, measurement and report (Member C)

Tag: `final`, on branch `develop`. Started from `handoff_2` plus Member B's B-1 fix (commit
`f07d545`). The gas baseline was recorded first (commit `2c63365`), before any contract change.

## What works

| Part | Where | Run |
| --- | --- | --- |
| Gas baseline, four optimizations, gas sheet | `scripts/measureGas.js`, `scripts/gasSheet.js`, `docs/gas/` | `npm run gas:measure`, `npm run gas:sheet` |
| Three security fixes found by attack tests | `contracts/` (S1, S2), `scripts/deploy.js` (S3) | part of `npx hardhat test` |
| Nine attack scenarios, 38 tests | `test/attacks/`, helpers in `contracts/test/` | `npm run test:attacks` |
| Interface guard (team rule) | `test/unit/AbiCompatibility.test.js` | part of `npx hardhat test` |
| Threat model and mitigation map | `docs/security/` | read |
| Test results and coverage | `docs/test_results.md` | `npx hardhat coverage` |
| Report (LaTeX source and PDF) | `docs/report/latex/`, `docs/report/Trustless_ROSCA_Report.pdf` | `latexmk -pdf main.tex` |

`npx hardhat test` runs **124 tests**, all passing: A's 52, B's 26, C's 46.

## Gas, in one line

A whole 4 member circle with one default costs **4,521,109 gas, down from 9,619,893 (-53.0%)**;
`createCircle` -87.8%, `contribute` -21% to -29%, `settleRound` -40% to -59%. See
`docs/gas/gas_sheet.md`.

| Id | Optimization |
| --- | --- |
| G1 | EIP 1167 clones of one Circle implementation |
| G2 | Storage packing; module addresses as immutables |
| G3 | One paid bitmap per round |
| G4 | Reputation history in events only |

## Security fixes

| Id | Problem found by an attack test | Fix |
| --- | --- | --- |
| S1 | A6: the admin could pause through a payment deadline, so every member was slashed and recorded as a defaulter; an expired pause could be renewed at once | Paused time is added to the round deadline; 7 day cooldown between pauses |
| S2 | A3: a member contract could reveal last and finalize in one transaction, undoing both unless it got slot 1; or grind the finalize block | Finalize must be in a later block than the last reveal; entropy is the hash of the last reveal's block |
| S3 | A5: the deployer kept the module admin role, so a stolen key could register a fake circle and frame members | `deploy.js` renounces it once the factory is registered |

## Interface changes (for the frontend and indexer)

None that existing code depends on: every function, output and event Member B used is unchanged
(proved by the ABI test). Added: `CircleFactory.implementation()`, `Circle.totalPausedTime()`,
`Circle.PAUSE_COOLDOWN()`. Removed: `ReputationRegistry.getHistory()` (unused; the indexer
rebuilds history from `ReputationUpdated`). New revert reasons have plain words messages in
`frontend/src/lib/errors.js`. The notifier now reads the round deadline from the chain, because a
pause extends it. `deployments/abi/` was regenerated.

## How to run

Unchanged from the README: `npx hardhat node`, `npm run seed:local` (or `npm run deploy:local`),
`npm run offchain`, `npm run keeper`, `npm run frontend`.

## Known limitations (also in the threat model)

* Randomness: a block proposer can still influence the hash of the last reveal block; if finalize
  happens more than 256 blocks after the last reveal, the seed falls back to `prevrandao`.
  Chainlink VRF is future work.
* Refunds are pushed in loops; safe with the plain ERC20 used here, but a token with blacklists
  or hooks would need pull withdrawals.
* Reputation is per address (Sybil); the deposit is the real protection.
* The bounded pause is a small trust point by design.
* Not deployed to Sepolia: the local Hardhat demo covers every workflow.
