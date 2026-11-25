# Trustless ROSCA (Committee) DApp

A rotating savings group ("committee") where a smart contract, not an organizer, holds the money.
Members lock a security deposit, pay a fixed amount every round, and one member receives the whole
pot each round in an order drawn fairly at the start. If someone stops paying, their deposit covers
the missed payment so nobody else loses money.

Blockchain Empowerment Project, Fall 2026.

## Status

| Stage | Owner | Status |
| --- | --- | --- |
| 1. Contracts, unit tests, deploy script | Member A | Complete, tag `handoff_1` (see `docs/handoff/handoff_1.md`) |
| 2. Off chain services and frontend | Member B | Complete, tag `handoff_2` (see `docs/handoff/handoff_2.md`) |
| 3. Gas optimization, attack tests, report | Member C | Complete, tag `final` (see `docs/handoff/final.md`) |

## Repository layout

```
contracts/          Solidity (Member A, optimized and hardened by Member C): core/, risk/, support/, interfaces/
  test/             test only helpers for the attack tests (never deployed): HookToken, ReentrantMember, ...
offchain/           Node.js services (Member B)
  lib/              config, chain helpers, IPFS CID code
  ipfs/             terms document store (local, optional Kubo pin)
  indexer/          event indexer + SQLite (sql.js)
  notifier/         in app reminders
  api/              HTTP API (Express)
  keeper/           calls settleRound / finalizeDraw / cancel when deadlines pass
  cli/rebuild.js    rebuild the indexer database from chain events
  index.js          starts indexer + notifier + API
frontend/           React + Vite + ethers v6 web app (Member B)
  src/lib/          contracts, chain reads, API client, CID check, error decoder
  src/components/   pages and panels
  tests/            optional browser tests (Playwright)
test/
  unit/             contract tests (Member A)
  e2e/              end to end, indexer rebuild and off chain unit tests (Member B)
  attacks/          attack scenarios A1 to A9 (Member C)
  fixtures/         the ABIs as handed over, used by the interface compatibility test
scripts/            deploy.js, seedLocal.js, demo.js, measureGas.js, gasSheet.js, storageLayout.js
docs/
  workflows.md      every workflow mapped to contract functions
  handoff/          handoff notes and bug reports
  report/           report sections and the component diagram
  screenshots/      UI screenshots from the automated browser run
  gas/              gas baseline, each optimization step, final numbers, gas sheet (Member C)
  security/         threat model, mitigation map, attack test results (Member C)
  report/latex/     the project report (LaTeX source); the PDF is docs/report/Trustless_ROSCA_Report.pdf
  test_results.md   test counts, coverage and the live check (Member C)
deployments/abi     ABIs for the frontend and indexer (written by deploy.js)
```

## Setup

Requires Node.js 18 or newer (20 or 22 recommended) and, for the demo, MetaMask.

```bash
npm install                  # contracts, tests and off chain services
npm run frontend:install     # the web app (frontend/ has its own package.json)
npx hardhat compile
```

No `.env` is needed for the local demo. To change ports or settings, copy `.env.example` to `.env`
(and `frontend/.env.example` to `frontend/.env.local`). Never commit either file.

## Run the tests

```bash
npx hardhat test        # all 124 tests: 52 contract (A) + 26 off chain / end to end (B) + 46 attack and interface tests (C)
npm run test:unit       # contract unit tests and the interface guard
npm run test:e2e        # only Member B's tests
npm run test:attacks    # Member C's attack scenarios A1 to A9
npm run test:gas        # with a gas table per function
npx hardhat coverage
```

## Run the whole app (four terminals)

```bash
# 1. local blockchain (prints 20 test accounts with their PUBLIC test keys)
npx hardhat node

# 2. deploy + sample circles, then the indexer, notifier and API on http://127.0.0.1:4000
npm run seed:local          # or: npm run deploy:local   (empty system, no samples)
npm run offchain

# 3. keeper: settles rounds and finalizes draws when deadlines pass
npm run keeper

# 4. web app on http://localhost:5173
npm run frontend
```

`npm run dev:services` starts terminals 2 to 4 together (offchain, keeper, frontend) after the
node is running and the system is deployed.

### MetaMask setup (demo)

1. MetaMask, Add network manually: name `Hardhat Local`, RPC `http://127.0.0.1:8545`, chain ID
   `31337`, symbol `ETH`. (Or press *Connect MetaMask*, then *Switch network* in the app.)
2. Import accounts #1 to #5 from the `npx hardhat node` output (account #1 is the Organizer in
   the samples). These keys are public test keys; never use them for real money.
3. In the app press *Get test mUSD*, then *Show mUSD in MetaMask*.
4. After restarting the node, clear MetaMask's activity tab data (Settings, Advanced), or
   transactions fail with a nonce error. The app says so when it happens.

Without MetaMask, use the *Local test account* menu (Hardhat chain only) to act as any account.

### Demo walkthrough (about 10 minutes)

The **Steps** box on the right of every page walks through this and highlights the current step.
Every circle page also says what to do next ("Your next step", "Waiting for others", "Happening
automatically"). Every address and transaction hash has a copy button.

1. Connect wallets, show the network check and faucet.
2. Organizer: *Organize*, preset *Quick demo (minutes)*, *Upload terms and create circle*. The
   circle page shows *Verified* next to the terms.
3. For each member press *Open in new tab (another member)*, pick *Local test account* #2 to #5,
   *Get test mUSD*, *Approve and join*. Then *Commit secret*, then *Reveal secret*. The keeper
   finalizes the draw.
4. Round 1: everyone pays (the first payment approves all remaining rounds at once, so later
   rounds need one confirmation). The keeper settles; the recipient sees *Your pot is ready* and claims.
5. Round 2: the round 1 recipient does not pay. In the Steps box press *Skip time: +1 hour*. The
   keeper settles, the deposit covers the miss, and *Missed payment in round 2* appears.
6. Show *Reminders*, *Activity* and the circle *History*, each with transaction hashes.
7. Trust: stop `npm run offchain`. The app switches to *Indexer offline: reading the chain* and
   keeps working.

### Running it again (second time, demo day, teammates)

The Hardhat node keeps everything in memory, so stopping it erases every circle.

* **Node still running:** nothing to run. Create a new circle in the app.
* **Fresh start:** two terminals, nothing else.

```bash
npx hardhat node          # terminal 1, leave open
npm run deploy:local      # terminal 2, once per node start
npm run dev:services      # terminal 2: indexer + keeper + website (http://localhost:5173)
```

Then in MetaMask: Settings, Advanced, *Clear activity tab data* (the new chain starts at nonce 0).
Imported accounts and the Hardhat Local network stay. Do not also run `npm run seed:local`,
`npm run offchain`, `npm run keeper` or `npm run frontend`: `dev:services` already runs the last
three, and a second copy fails with "port already in use". A teammate's first time only adds
`npm install` and `npm run frontend:install`.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm run keeper:once` | One keeper pass, prints what it did |
| `npm run indexer:rebuild` | Rebuilds the indexer database from chain events (stop `npm run offchain` first) |
| `curl http://127.0.0.1:4000/api/health` | Indexer status: last block, circles, events |
| `npx hardhat run scripts/demo.js` | Console demo of a whole committee (Member A) |
| `npm run gas:measure` | Gas of every call in a full 4 member circle, written to `docs/gas/latest.json` |
| `npm run gas:sheet` | Rebuilds `docs/gas/gas_sheet.md` from the recorded measurements |
| `npm run storage:layout` | Prints the packed storage layout of Circle, PayoutOrder and ReputationRegistry |

### Optional browser tests

```bash
npm i --no-save playwright && npx playwright install chromium
node frontend/tests/ui-full-circle.mjs           # full circle with one default, all workflows, screenshots
node frontend/tests/ui-trust-checks.mjs tamper   # changed terms file is refused
# stop `npm run offchain`, then:
node frontend/tests/ui-trust-checks.mjs offline  # the UI keeps working from the chain
```

## Contracts

| Contract | Job |
| --- | --- |
| `BaseCircleLifecycle` | Abstract base: lifecycle state machine (Open, OrderDraw, Active, Completed, Cancelled), roles, time limited pause (paused time extends the round deadline, 7 day cooldown), reentrancy guard, initializer. Inherited by `Circle`. |
| `Circle` | One committee: join, contribute, settle each round, pay out, handle defaults, complete or cancel. Deployed as an EIP 1167 clone. |
| `CircleFactory` | Deploys one Circle implementation, creates every circle as a 45 byte clone of it and registers each one with the shared modules. |
| `CollateralVault` | Holds every security deposit (always 100% of what a member still owes after payout). Only registered circles can deposit, release or slash. |
| `PayoutOrder` | Commit then reveal draw; the shuffle uses every secret plus the hash of the last reveal's block, and finalize must come in a later block, so nobody can choose the payout order. |
| `ReputationRegistry` | Cross circle record of joins, completions and defaults. Used as a join rule. |
| `MockStablecoin` | Test stablecoin (6 decimals) with a public faucet. |

How they connect: the factory creates a `Circle` clone, initializes it in the same transaction, and
grants it a role on the vault, the draw and the registry. The circle then calls those modules;
nothing else can write to them. `Circle` uses `initialize` instead of a constructor because clones
never run constructors. After deployment the deployer renounces the module admin role, so no other
registrar can ever be added.

## Off chain services

| Service | Job | Trust |
| --- | --- | --- |
| IPFS terms store | Stores the Organizer's terms; returns a CIDv1 (raw, sha256), the same CID a real IPFS node gives. Optional pin to Kubo. | The CID is on chain; the browser re hashes the document and refuses a mismatch. |
| Indexer + API | Reads all contract events into SQLite and serves lists, history, reputation and names. | Read only. Can be deleted and rebuilt from events (`npm run indexer:rebuild`). Detects chain resets by block hash. |
| Notifier | In app reminders: payment due, commit and reveal due, payout ready, default, cancelled, completed. | Convenience only; the UI computes reminders from the chain if it is down. |
| Keeper | Calls `settleRound`, `finalizeDraw` and `cancel` when allowed. | Anyone can call those functions, so it is not a trust point. |

Display names are the only data that exists only off chain. Each is signed by the member's wallet,
so nobody can rename someone else.

API reference: see the header of `offchain/api/server.js`.

## Security notes

* Role based access (OpenZeppelin `AccessControl`): organizer, member, pauser, registrar, circle.
* Funds never sit with the organizer. The only ways money leaves are `claimPayout` (your own credit),
  `release` (your own deposit back) and `slash` (your deposit covering your own missed payment).
* Pull payments plus `ReentrancyGuard` and checks effects interactions on every transfer.
* Pause stops joining and paying only, and switches itself off after 7 days. The time spent paused
  is added to the round's payment deadline, so a pause can never push members into default, and a
  new pause needs 7 days of unpaused time. Settling, refunds and withdrawals keep working, so the
  admin can never trap funds.
* Deposits always cover 100% of what a paid member still owes, so a member who takes the pot and
  disappears cannot leave the others short.
* The payout order commitment is bound to the member's address. A member who never reveals is
  removed and loses one contribution. Finalize must come in a later block than the last reveal and
  the seed uses that block's hash, so the last revealer cannot pick its slot.
* The deployer renounces the admin role of the vault, draw and registry after registering the
  factory, so a stolen deployer key cannot register a fake circle or write false defaults.
* Off chain: no service can move money; terms are verified by hash in the browser; the UI falls
  back to the chain when the indexer is down; display names need a wallet signature.
* B-1 (`docs/handoff/bug_reports_for_A.md`) is fixed.
* Threat model, attack tests and the mitigation map: `docs/security/`. Every threat that can be
  exercised locally has an attack test in `test/attacks/` (`npm run test:attacks`).

## Gas

Measured by `scripts/measureGas.js` on a full 4 member circle with one default (`docs/gas/gas_sheet.md`):

| | Baseline | Final | Change |
| --- | ---: | ---: | ---: |
| `createCircle` | 4,024,450 | 489,638 | -87.8% |
| `join` (middle member) | 251,300 | 174,597 | -30.5% |
| `contribute` (later in round) | 95,498 | 68,132 | -28.7% |
| `settleRound` (one default) | 315,055 | 162,286 | -48.5% |
| Whole circle, every transaction | 9,619,893 | 4,521,109 | -53.0% |

Optimizations: EIP 1167 clones (G1), storage packing and immutable module addresses (G2), one
paid bitmap per round (G3), reputation history in events only (G4). A test
(`test/unit/AbiCompatibility.test.js`) proves no function, output or event used by the frontend,
indexer or keeper changed.

## Reused code

* OpenZeppelin Contracts 5.0.2 (MIT): `AccessControl`, `Pausable`, `ReentrancyGuard`, `ERC20`,
  `Ownable`, `SafeERC20`, `Initializable`, `Clones`.
* Libraries (not copied code): ethers v6, React, Vite, Express, cors, dotenv, sql.js (SQLite in
  WebAssembly), Atkinson Hyperlegible font (SIL OFL, via @fontsource).
* Everything else in `contracts/`, `offchain/`, `frontend/`, `test/` and `scripts/` is original work.

## Never commit secrets

`.env` and `frontend/.env.local` are ignored by git. Only `.env.example` files are committed. The
keeper and seed scripts use Hardhat's unlocked local accounts, so the repository needs no keys.
