# Workflows

Every user action, who does it, which function runs, and what changes. Example numbers use a
4 member circle paying 1,000 mUSD per round with 100% deposit coverage.

| # | Workflow | Who | Function | Allowed when | What happens |
| --- | --- | --- | --- | --- | --- |
| W1 | Create circle | Organizer | `CircleFactory.createCircle(config)` | Any time | New `Circle` deployed, registered with vault, draw and registry. State `Open`. |
| W2 | Join | Member | `MockStablecoin.approve(vault, joinCollateral)` then `Circle.join()` | `Open`, before join deadline, not paused, past defaults within limit | Deposit for slot 1 (3,000) locked in the vault. When the last member joins: state `OrderDraw` and the draw starts. |
| W3a | Commit secret | Member | `PayoutOrder.commit(circle, computeCommitment(secret, me, circle))` | Commit window open | Hidden commitment stored. |
| W3b | Reveal secret | Member | `PayoutOrder.reveal(circle, secret)` | Everyone committed (or commit window over), reveal window open | Secret mixed into the random seed. |
| W3c | Finalize draw | Anyone | `Circle.finalizeDraw()` | Everyone revealed, or reveal window over | Success: order set, extra deposits refunded (slot 2 keeps 2,000, slot 3 keeps 1,000, slot 4 keeps 0), state `Active`, round 1 starts. Failure: state `Cancelled`, all deposits refunded, non revealers get a default. |
| W4 | Contribute | Member | `MockStablecoin.approve(circle, contribution)` then `Circle.contribute()` | `Active`, not paid yet this round, before round end plus grace, not paused | Payment held by the circle. |
| W5 | Settle round | Anyone (keeper script) | `Circle.settleRound()` | Everyone paid, or round end plus grace passed | Each unpaid member: deposit slashed, default recorded. Pot credited to this round's recipient. Any old debt the recipient owes is repaid from their pot first. Next round starts, or the circle completes. |
| W6 | Claim payout | Recipient | `Circle.claimPayout()` | Has a credit | Credit sent to the member (pull payment). Works while paused. |
| W7 | Complete | Automatic in the last `settleRound` | internal `_complete()` | Last round settled | Leftover debts taken from deposits, remaining deposits returned, completions recorded. State `Completed`. |
| W8 | Cancel | Organizer any time while `Open`; anyone after the join deadline | `Circle.cancel()` | `Open` | All deposits refunded. State `Cancelled`. |
| Admin | Emergency pause | Platform admin | `Circle.pause()` / `unpause()` | Any time | Blocks join and contribute only. |

## Default handling in detail

* **Member who already got the pot stops paying:** their deposit covers each missed payment, so the
  current recipient still gets the full pot.
* **Deposit not enough** (coverage below 100%, or a later slot member who has little deposit): the gap
  is recorded as `debtOf[defaulter]` and `deficitOf[recipient]`. When the defaulter's own payout
  round comes, the debt is taken out of their pot and credited to whoever was shortchanged.
* **Member misses their own payout round:** they simply receive a smaller pot; no debt is created.
* Every default is written to `ReputationRegistry`, and circles can refuse members with past defaults.

## States

```
Open ──(last member joins)──> OrderDraw ──(everyone revealed)──> Active ──(last round settled)──> Completed
  │                              │
  └──(organizer, or deadline)──> Cancelled <──(someone never revealed)
```

## Events for the indexer

`CircleCreated`, `MemberJoined`, `DrawStarted`, `Committed`, `Revealed`, `PayoutOrderSet`,
`RoundStarted`, `ContributionMade`, `MemberDefaulted`, `DebtRecovered`, `RoundSettled`,
`PayoutClaimed`, `CircleCancelled`, `CircleCompleted`, `StateChanged`, `ReputationUpdated`,
`CollateralDeposited`, `CollateralReleased`, `CollateralSlashed`.
