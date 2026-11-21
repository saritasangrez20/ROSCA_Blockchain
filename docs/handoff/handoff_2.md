# Handoff 2: Off chain services and frontend (Member B to Member C)

Tag: `handoff_2`. Started from `handoff_1` (commit `eb8de83`). **No file in `contracts/` was changed.**

**The bar is met:** a full 4 member circle with one default runs in the UI, from wallet setup to
completion. This was checked by an automated browser run (`frontend/tests/ui-full-circle.mjs`):
an Organizer and four members in separate tabs, the round 1 recipient stops paying, the keeper
settles every round, the deposit covers each missed payment, and the circle completes. Screenshots
from that run are in `docs/screenshots/`.

## What works

| Part | Where | Run |
| --- | --- | --- |
| IPFS terms upload; only the CID goes on chain | `offchain/ipfs/store.js`, `offchain/lib/cid.js` | part of `npm run offchain` |
| Event indexer with SQLite and an HTTP API, full rebuild from chain | `offchain/indexer/`, `offchain/api/server.js` | `npm run offchain`, `npm run indexer:rebuild` |
| Notifier (in app reminders: due, commit, reveal, payout ready, default, cancelled, completed) | `offchain/notifier/notifier.js` | part of `npm run offchain` |
| Keeper (settleRound, finalizeDraw, cancel after the join deadline) | `offchain/keeper/` | `npm run keeper` |
| React frontend: wallet, network check, faucet, Organizer and Member views, all 8 workflows, admin pause, transaction tray, readable errors | `frontend/` | `npm run frontend` |
| Off chain trust: UI re hashes IPFS terms; UI reads the chain when the indexer is down | `frontend/src/components/TermsCheck.jsx`, `frontend/src/lib/chainData.js` | automatic |

## Tests

`npx hardhat test` runs **77 tests: A's 51 plus 26 new ones**, all passing.

| File | Tests | What it proves |
| --- | --- | --- |
| `test/e2e/circleEndToEnd.test.js` | 9 | 4 member circle with one default through the real stack: IPFS upload, signed names, API over HTTP, indexer, notifier, keeper. Honest members end with exactly the money they started with; indexer state equals chain state. |
| `test/e2e/indexerRebuild.test.js` | 6 | Delete the database and rebuild from events: identical tables. Rebuild in place keeps display names. Restart applies nothing twice. Chain reorganisation is detected and repaired. Another deployment's database is reset. |
| `test/e2e/offchainUnits.test.js` | 11 | CIDs match a real IPFS node (Kubo 0.32.1); browser and server agree; tampering detected; API input checks (bad names, forged and replayed signatures); frontend error decoder, including a real revert. |

Run only B's tests: `npm run test:e2e`.

Optional browser tests (need Playwright and the whole stack running; see README):
`frontend/tests/ui-full-circle.mjs`, `frontend/tests/ui-trust-checks.mjs tamper|offline`.

## How to run (four terminals)

```bash
npm install && npm run frontend:install      # once
npx hardhat node                             # 1
npm run seed:local                           # 2  (or npm run deploy:local for an empty system)
npm run offchain                             # 2  indexer + notifier + API on :4000
npm run keeper                               # 3
npm run frontend                             # 4  http://localhost:5173
```

## For Member C

* **Gas baseline:** measure from this tag. Contracts are byte for byte A's `handoff_1`.
* **After each contract change, rerun `npm run test:e2e`.** The indexer, keeper and frontend depend
  only on function names, events and the `getSummary` / `getMemberInfo` view structs. If an
  optimization changes a view struct (for example packing `Config` into smaller types), the ABI
  stays compatible as long as field names stay the same; numbers are converted with `Number()`.
* Tests load ABIs from `artifacts/` so they follow your changes. The running app loads them from
  `deployments/abi/`, which `scripts/deploy.js` rewrites on every deploy.
* If you move history from storage arrays to events only (ReputationRegistry), the indexer already
  rebuilds reputation from `ReputationUpdated` events (`reputation` table, `/api/reputation/:address`).
* Attack scenario idea from Stage 2: **B-1** in `docs/handoff/bug_reports_for_A.md` (penalties
  locked when nobody reveals). Demo idea: tamper with a terms file in `offchain/data/ipfs/` and
  press *Check again* on the circle page.

## Known broken or limited

* **Contract bug B-1 (reported to A, not fixed by B):** if no member reveals in the draw, the
  non reveal penalties stay in the cancelled Circle forever. Reproduction in
  `docs/handoff/bug_reports_for_A.md`.
* Display names live only in the indexer database. Deleting the file loses them (members sign again).
* The IPFS store is local unless `IPFS_API_URL` points to a Kubo node. The CID format is identical
  either way, so switching later changes nothing on chain.
* Terms files are limited to 1 MiB so they fit one IPFS block and stay checkable with a plain hash.
* Reminders are in app only (no email or Telegram), as planned.
* MetaMask keeps an old nonce after the Hardhat node restarts. The app explains the fix (clear
  activity tab data).
* Not deployed to Sepolia (optional, Day 13, Member C).
