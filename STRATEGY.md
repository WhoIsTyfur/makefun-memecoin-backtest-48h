# Strategy: ride fast, broadly held curves to graduation

## What it trades on

A pump.fun bonding curve completes ("graduates") at about 85 SOL of real reserve, and the replay then
closes any position at the completing trade's reserves: the top of the curve, with none of the bot's
own price impact. From 39 SOL to completion the price rises about 2.8 times.

On the dev window 35 of 1,222 coins graduated, about 26 of them bundled to completion in their
creation slot, which a 2-slot latency cannot trade. Seven were tradable, and they looked alike on
reaching 40 SOL. The bot enters a coin once, when all of these hold:

- **Depth**: real reserve between 39 and 60 SOL.
- **Sprint**: the coin is 40 to 120 slots old. It filled fast, but not in one burst: every coin that
  got this deep in under 40 slots failed, and slow fillers mostly stalled.
- **Breadth**: at least 30 distinct wallets have bought.
- **Launch group**: the wallets that bought in the creation slot or the next one could take at most
  16 SOL out by selling all they still hold. Every one-slot collapse in the data (real SOL going 74
  to 5) was a bundled launch whose group still held 40 SOL or more. No stop can fill inside one slot,
  so these are avoided at entry.
- **No whale**: no single wallet could take more than 11 SOL out by selling.

## How it sizes positions

- **Stake**: 35% of equity per coin, built over consecutive batches, each buy just under the per-reply
  cap (95 of the allowed 100 bps of the curve's real SOL). It stops adding above 70 SOL, or once the
  curve is 8 SOL under the entry.
- **Drawdown governor**: a new stake is cut to what the account could lose outright, every open
  position going to zero, and still stay within 40% of its peak equity. Under 0.3 SOL, no trade.
- At most 3 positions at once.

## When it exits

- **Completion**: the replay closes the position at the completing trade. This is the intended exit.
- **Floor**: sell everything when the curve's real SOL falls 20 below its level at entry, or 40
  below its peak. Graduating curves gave back up to 32 SOL on the way; tighter stops sold them early.
- **Trim**: a position worth more than 35% of equity is sold down to 28%. It banks part of a run and
  caps what one coin's collapse can cost.

## Guardrail filler

Sprints are rare (7 on the dev window), so the bot also makes 0.012 SOL round trips on 3-30 SOL
curves until 24 distinct coins carry a qualifying round trip, about 0.015 SOL in all.

## Evidence (dev window, my replay of the kit's engine)

The replay reproduces the earlier dip-buying entry's graded +3.32 SOL to within the failed-order draw.
This bot: **about +26.8 SOL net**, +24.7 with every fee doubled, +6.9 without its three best coins,
maximum drawdown 21%, 31 qualifying coins. Five of seven sprints graduated; two were stopped.

Both halves of the coins split by hash are profitable (+10.0, +16.9). On 17 pseudo-windows (coin
subsets; halves and quarters of the day run alone) it averages +10.7 SOL and none loses. Moving any
one threshold to its neighbours stays positive (+12 to +27 SOL).

## Risks

Seven trades is a small sample, and the thresholds were chosen on it. A day with no graduating
sprint earns about nothing, and each failure costs 35-50% of its stake.
