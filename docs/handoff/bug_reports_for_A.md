# Contract bug reports from Member B (Stage 2)

Per the team rules, Member B does not edit contracts. These were found while building the
indexer, keeper and frontend. Each one has a reproduction, the effect, and a suggested fix.

## B-1. Penalties are locked forever when nobody reveals in the payout draw

**Where:** `Circle.finalizeDraw()` (contracts/core/Circle.sol)

**What happens:** every member who did not reveal is slashed one contribution
(`vault.slash(m, config.contribution)`), and the slashed tokens move from the vault into the
Circle. The penalty pool is then shared only if `drawn.length > 0`:

```solidity
if (penaltyPool > 0 && drawn.length > 0) { ... }
```

If **nobody** revealed (`drawn.length == 0`), the pool is credited to no one and the circle is
cancelled. No function can move those tokens out of the Circle afterwards.

**Reproduce (local node):**

```bash
npx hardhat node
npm run seed:local                      # the "orderDraw" sample circle: 2 of 4 committed, nobody revealed
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"evm_increaseTime","params":[2937600]}' http://127.0.0.1:8545
npm run keeper:once                     # keeper calls finalizeDraw on the expired draw
```

Then `MockStablecoin.balanceOf(<orderDraw circle>)` is **4,000 mUSD** and `withdrawable(...)`
is 0 for all four members. Observed by Member B on 20 Nov 2026.

**Suggested fix (A or C):** when `drawn.length == 0`, do not slash (just release the full
deposits), or credit each removed member's penalty back to `withdrawable[m]`. The function
signature and events stay the same, so the indexer and frontend need no change.

**Severity:** medium (funds stuck, but only when every single member walks away from the draw).
Good candidate for one of C's misuse scenario tests.

## B-2 (note, not a bug). Credits paid by `_payCreditors` have no per creditor event

`DebtRecovered(debtor, amount)` says who repaid, not who received the money. The indexer
therefore reads `withdrawable(member)` from the chain to show "you can claim X". If C adds an
event here later, keep the existing events unchanged so the indexer keeps working.
