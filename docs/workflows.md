# Workflows

Every user action, who does it, which function runs, and what changes. Example numbers use a
4 member circle paying 1,000 mUSD per round.

| # | Workflow | Who | Function | Allowed when | What happens |
| --- | --- | --- | --- | --- | --- |
| W1 | Create circle | Organizer | `CircleFactory.createCircle(config)` | Any time | New `Circle` deployed and initialized in one transaction, registered with vault, draw and registry. State `Open`. |
| W2 | Join | Member | `MockStablecoin.approve(vault, joinCollateral)` then `Circle.join()` | `Open`, before join deadline, not paused, past defaults within limit | Deposit for slot 1 (3,000) locked in the vault. When the last member joins: state `OrderDraw` and the draw starts. |
| W3a | Commit secret | Member | `PayoutOrder.commit(circle, computeCommitment(secret, me, circle))` | Commit window open | Hidden commitment stored. |
| W3b | Reveal secret | Member | `PayoutOrder.reveal(circle, secret)` | Everyone committed (or commit window over), reveal window open | Secret mixed into the random seed. |
| W3c | Finalize draw | Anyone | `Circle.finalizeDraw()` | Everyone revealed, or reveal window over | Members who did not reveal are removed: one contribution of their deposit is shared by the others as a penalty, the rest is refunded, a default is recorded. With 2 or more left: order set from the revealers, extra deposits refunded (4 members: slot 2 keeps 2,000, slot 3 keeps 1,000, slot 4 keeps 0), state `Active`, round 1 starts. With fewer than 2: state `Cancelled`, deposits refunded. |
| W4 | Contribute | Member | `MockStablecoin.approve(circle, contribution)` then `Circle.contribute()` | `Active`, not paid yet this round, before round end plus grace, not paused | Payment held by the circle. |
| W5 | Settle round | Anyone (keeper script) | `Circle.settleRound()` | Everyone paid, or round end plus grace passed | See "Default handling". Pot credited to this round's recipient. Next round starts, or the circle completes. |
| W6 | Claim payout | Recipient | `Circle.claimPayout()` | Has a credit | Credit sent to the member (pull payment). Works while paused and after cancel. |
| W7 | Complete | Automatic in the last `settleRound` | internal `_complete()` | Last round settled | Leftover debts taken from deposits, remaining deposits returned, completions recorded. State `Completed`. |
| W8 | Cancel | Organizer any time while `Open`; anyone after the join deadline | `Circle.cancel()` | `Open` | All deposits refunded. State `Cancelled`. |
| Admin | Emergency pause | Platform admin | `Circle.pause()` / `unpause()` | Any time | Blocks join and contribute only, for at most 7 days. |

## Default handling in detail

The rule: **after a member has received the pot, their deposit always equals 100% of what they still
owe.** So whoever takes the pot and disappears can never leave the others short.

When a round is settled, for every member who did not pay:

* **They already got the pot:** one contribution is taken from their deposit. Fully covered, always.
* **They have not had their payout yet:** one contribution is taken from their deposit if any is left.
  If their deposit is empty (the last slot keeps none), the gap is recorded as `debtOf[defaulter]` and
  `deficitOf[recipient]`.
* **It is their own payout round:** nothing is taken; they simply receive a smaller pot.
* Every miss is written to `ReputationRegistry`; circles can refuse members with past defaults.

Then, when the recipient's own payout is settled:

1. Any debt they owe is repaid out of their pot first and credited to whoever was shortchanged.
2. If earlier misses used part of their deposit, it is refilled out of their pot back to 100% of what
   they still owe.
3. The rest of the pot is credited to them.

## States

```
Open ──(last member joins)──> OrderDraw ──(2 or more revealed)──> Active ──(last round settled)──> Completed
  │                              │
  └──(organizer, or deadline)──> Cancelled <──(fewer than 2 revealed)
```

## Events for the indexer

`CircleCreated`, `MemberJoined`, `DrawStarted`, `Committed`, `Revealed`, `MemberRemoved`,
`PayoutOrderSet`, `RoundStarted`, `ContributionMade`, `MemberDefaulted`, `DebtRecovered`,
`CollateralRefilled`, `RoundSettled`, `PayoutClaimed`, `CircleCancelled`, `CircleCompleted`,
`StateChanged`, `ReputationUpdated`, `CollateralDeposited`, `CollateralReleased`, `CollateralSlashed`,
`Paused`, `Unpaused`.

## Views for the frontend

* `Circle.getSummary()`: state, organizer, amounts, counts, current round, deadline, recipient, join
  deadline, join deposit, paused, terms CID. One call per circle card.
* `Circle.getMemberInfo(address)`: member or removed, position, deposit, paid this round, claimable,
  debt, deficit, defaults. One call per member row.
* `CircleFactory.getCircles()`, `getCirclesByOrganizer(address)`.
* `ReputationRegistry.getRecord(address)`, `getHistory(address)`.
* `PayoutOrder.getDraw(circle)`, `computeCommitment(secret, member, circle)`, `hasRevealed(circle, member)`.
