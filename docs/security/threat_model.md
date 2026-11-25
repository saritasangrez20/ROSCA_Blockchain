# Threat model

Member C, Stage 3. Covers the seven contracts, the off chain services and the browser app as
they stand at the `final` tag. Every threat that can be exercised on a local chain has an attack
test in `test/attacks/`; `docs/security/mitigation_map.md` maps each threat to its control, its
code and its test. Results of the attack suite on the handed over code and on the final code are
in `attack_results_baseline.txt` and `attack_results_final.txt`.

## 1. What we protect (assets)

| Id | Asset | Where it lives | Worst case if lost |
| --- | --- | --- | --- |
| AS1 | Security deposits | `CollateralVault`, per (circle, member) | Members lose their deposit; others lose their cover |
| AS2 | Round contributions | each `Circle`, until settled | A round's pot is stolen or stuck |
| AS3 | Credited pots, penalty shares, debt repayments | `Circle.withdrawable` | A member cannot claim, or someone claims twice |
| AS4 | Fair payout order | `PayoutOrder` | Someone picks the first slot (the interest free loan) |
| AS5 | Reputation records | `ReputationRegistry` | Honest members framed as defaulters and refused by circles |
| AS6 | Terms document | IPFS, CID on chain | Members agree to different terms from the ones they see |
| AS7 | Liveness | every circle | A circle can neither finish nor refund: funds frozen |

## 2. Who interacts, and how much we trust them

| Actor | Can do | Trusted for |
| --- | --- | --- |
| Member | join, commit, reveal, pay, claim | nothing: may default, collude, be a smart contract |
| Organizer | create a circle, cancel it while `Open` | nothing: never holds or moves money |
| Platform admin (deployer account, `PAUSER_ROLE` on every circle) | pause joining and paying | not to abuse a bounded pause; it cannot move money (Section 5) |
| Deployer at deployment | deploy, grant `REGISTRAR_ROLE` to the factory | the deployment transaction only; it then renounces the module admin role (fix S3) |
| Keeper | call `settleRound`, `finalizeDraw`, `cancel` | nothing: anyone may call the same functions |
| Indexer, notifier, IPFS store hosts | serve lists, history, reminders, terms | nothing for correctness: the UI decides from the chain and re hashes the terms |
| Block proposer | order transactions, influence `blockhash` / `prevrandao` slightly | not to grind the payout order (residual risk R1) |
| Token (`MockStablecoin`) | move balances | to be a plain ERC20 without receiver hooks or blacklists (residual risk R2) |

## 3. Trust boundaries

1. **Chain and off chain.** No off chain component can move money. The browser reads every
   value that decides an action (state, balances, roles, deadlines) from the contracts, falls
   back to the chain when the indexer is down, and re hashes the terms document against the CID.
2. **Factory registered circles and everything else.** The vault, draw and registry accept writes
   only from addresses holding `CIRCLE_ROLE`, granted only by the factory, which only deploys
   clones of its own implementation. After deployment nobody can add a registrar (fix S3).
3. **One circle and another.** Vault balances are keyed by (circle, member): a registered circle
   can only slash or release its own members' deposits.
4. **Members and the draw.** Commitments are bound to the member's address; the shuffle entropy
   is fixed by the block that holds the last reveal (fix S2).

## 4. Threats

Likelihood and impact are High / Medium / Low for this prototype. Status: **Mitigated** (control
plus passing test), **Fixed in Stage 3** (the attack test failed on the handed over code), or
**Residual** (accepted and documented).

| Id | Threat | Attacker | STRIDE | L / I | Control | Test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Re enter `claimPayout` or another entry point during a payout to be paid twice | member contract with a hook token | Tampering | M / H | `nonReentrant` on every Circle and vault entry point; effects before transfers; pull payments | A1 | Mitigated |
| T2 | Take the pot early and stop paying | early slot member | Repudiation | H / H | deposit = 100% of what is still owed after payout; slashed every missed round | A2 | Mitigated |
| T3 | Join and never pay, in any slot | member | Repudiation | H / M | slash deposit; uncovered misses become debt repaid from the member's own pot first | A4 | Mitigated |
| T4 | Several members default together so shortfalls cannot be repaid | colluding members | Repudiation | M / H | pot of round k is at least (k-1) contributions, enough for debt plus refill; invariants over random patterns | A8 | Mitigated |
| T5 | Withhold a reveal to change the order or cancel the circle | member | Tampering | M / M | non revealer removed, one contribution penalty shared by revealers; circle continues with 2 or more | A3 | Mitigated |
| T6 | Reveal last and finalize in the same transaction, undo unless slot 1, retry each block | member contract | Tampering | M / H | finalize must run in a later block than the last reveal | A3 | **Fixed in Stage 3 (S2)** |
| T7 | After revealing, finalize and undo until the order suits, block after block | member contract | Tampering | M / H | entropy = hash of the last reveal's block, the same for every finalize call | A3 | **Fixed in Stage 3 (S2)** |
| T8 | Copy someone's commitment from the mempool | member | Spoofing | M / L | commitment = keccak(secret, member, circle) | A3 | Mitigated |
| T9 | Commit after seeing other secrets | member | Tampering | L / M | no reveal until all committed or the commit window closed; no commit after the window | A3 | Mitigated |
| T10 | A contract outside the factory slashes, releases or pulls deposits, writes reputation or starts a draw | outsider | Elevation | M / H | `CIRCLE_ROLE` checks on every module function | A5 | Mitigated |
| T11 | A registered circle touches another circle's deposits | compromised circle | Elevation | L / H | balances keyed by (circle, member) | A5 | Mitigated |
| T12 | Stolen deployer key registers a fake circle and frames members as defaulters | key thief | Elevation | L / M | deploy script renounces `DEFAULT_ADMIN_ROLE` on the vault, draw and registry | A5 | **Fixed in Stage 3 (S3)** |
| T13 | Organizer or admin takes the pot or deposits | organizer, admin | Elevation | M / H | no function moves funds except claim (own credit), release (own deposit), slash (own miss) | A5 | Mitigated |
| T14 | Re initialize a clone, or initialize the implementation | anyone | Elevation | L / H | `initializer` (once), only the factory, in the creating transaction | A5, unit | Mitigated |
| T15 | Admin pauses through a payment deadline: nobody can pay, anyone settles, every member is slashed and recorded as a defaulter | admin | DoS / Tampering | M / H | paused time is added to the round deadline | A6 | **Fixed in Stage 3 (S1)** |
| T16 | Admin re pauses the moment a pause expires, freezing the circle | admin | DoS | M / H | 7 day cooldown after each pause; each pause at most 7 days | A6 | **Fixed in Stage 3 (S1)** |
| T17 | Settings that overflow the packed storage (huge contribution stored as a tiny one) | organizer | Tampering | L / H | `initialize` rejects values that do not fit | A9 | Mitigated (added with G2) |
| T18 | A circle too expensive to settle (unbounded loops) | members | DoS | L / H | `MAX_MEMBERS = 20`; worst case 832,971 gas | A9 | Mitigated |
| T19 | Show members tampered terms | IPFS or server host | Tampering | M / M | only the CID is on chain; the UI re hashes the document | A7 (and B's tests) | Mitigated |
| T20 | Indexer lies or goes down | indexer host | Spoofing / DoS | M / L | UI decisions read the chain; chain fallback when the API fails | B's e2e and browser tests | Mitigated |
| T21 | Keeper stops or misbehaves | keeper host | DoS | M / L | every keeper call is public; the UI offers the same buttons | B's e2e tests | Mitigated |
| R1 | Block proposer influences `blockhash` of the last reveal block; if finalize happens more than 256 blocks after the last reveal the seed falls back to `prevrandao` | proposer, finalize caller | Tampering | L / M | none beyond S2 | (documented) | **Residual** |
| R2 | A token with receiver hooks or a blacklist lets one member block push refunds (cancel, completion) | member | DoS | L / H | the factory fixes the token at deployment to `MockStablecoin` (plain ERC20) | A1 residual test | **Residual** |
| R3 | A defaulter returns with a fresh address (Sybil) | defaulter | Spoofing | H / L | the deposit, not the reputation score, protects the group | A4 limitation test | **Residual** |
| R4 | The admin can still pause joining and paying for up to 7 days at a time (at most half of the time) | admin | DoS | L / L | bounded, deadline extended, no funds trapped | A6 | **Residual (by design)** |

## 5. Who is the admin, and what can they do?

The admin is the account that deploys the system (the platform operator). After fix S3 it keeps
exactly one power: `PAUSER_ROLE` on each circle, which stops `join` and `contribute`.

* A pause lasts at most 7 days and switches itself off.
* The time spent paused is added to the current round's deadline, so a pause can never make a
  member miss a payment (T15).
* After a pause ends, the next one is possible only 7 days later, so the circle is unpaused at
  least half of the time and cannot be frozen (T16).
* Settling a round that had already closed, claiming, finalizing the draw and cancel refunds all
  keep working while paused, so a pause can never trap funds.
* The admin has no function that moves tokens, and after S3 cannot register circles or write
  reputation.

## 6. Residual risks, honestly stated

* **R1, randomness.** `blockhash` of the last reveal block cannot be known by the member who
  sends that reveal, and the order no longer depends on who finalizes or when. A block proposer
  who is also a member could still choose between including and not including transactions.
  If finalize happens more than 256 blocks after the last reveal (possible in the deadline path,
  when some members never reveal), the seed falls back to `prevrandao` at finalize time, which a
  contract caller could grind again. Chainlink VRF removes both (future work).
* **R2, token assumption.** Deposits are refunded by pushing tokens in a loop. With a plain ERC20
  this cannot fail, and the token is fixed at deployment. A real deployment on a token with
  blacklists (USDC) or hooks should switch refunds to pull withdrawals (future work); attack test
  A1 pins the assumption.
* **R3, Sybil.** Reputation is per address. A defaulter with a new address passes the reputation
  check. This is acceptable because the deposit covers 100% of what a paid member still owes, so
  a returning defaulter still cannot hurt the group (A2, A4, A8).
* **R4, pause.** The bounded pause remains a small trust point by design (emergency brake).
* **Off chain.** Display names exist only in the indexer database (signed by the member); losing
  the database loses names, never money.
