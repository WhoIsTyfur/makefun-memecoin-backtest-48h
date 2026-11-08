# Strategy: buy sharp dips on deep curves, sell the bounce

## What it trades on

Only pump.fun bonding curves holding **at least 50 SOL of real reserve**: the deep end, close to
graduation (about 85 SOL). After the last trade of each slot the bot compares the price with the
price 4 slots earlier; a drop of **10% or more** is a dip.

Why only this: on the dev window I measured net-of-fee forward returns (filled at slot s+2) for
momentum, crash rebounds, launch sniping, riding curves to completion, crowd milestones and a 2-D
search over a dozen features. Nearly everything lost money: memecoins drift down, and buying strength
is worst. One family stayed positive under every check: a sharp, short dip on a deep curve. A big
sell into a curve with plenty of SOL and live buyers tends to be absorbed within a minute, and a curve
that completes is closed by the replay at the completing trade's reserves.

Checks before trusting it:
- **Plateau, not peak**: the parameters sit mid-plateau (real SOL 45-55, dip 9-11%, lookback 3-5
  slots, hold 80-120 slots); 79 of those 81 configurations are profitable.
- **Holdout by coin**: each half of a hash split of the coins is profitable alone.
- **Holdout by time**: the two busy 6-hour quarters are each profitable alone; the two quiet ones
  had few trades and lost a few hundredths of a SOL.
- An early crash-rebound rule looked brilliant until I found a lookahead bug in my study (a lookup
  that silently returned a coin's last trade); it was dropped.

## How it sizes positions

- A dip entry buys in **up to 3 tranches on consecutive batches**, each just under the per-reply cap
  (95 of the allowed 100 bps of the curve's real SOL): about 0.5-0.8 SOL per tranche, at most 3 SOL
  per position.
- At most 5 open positions, one buy per coin per reply, and only with cash not already committed to
  orders in flight.
- Buys accept 15% slippage; sells accept 50%, so an exit is not refused when the price moves during
  the two slots of latency.

## When it exits

- **Take profit**: once the position would sell for **5% over its cost** (valued at the batch's
  marks, which include the bot's own impact, after the sell's curve fee).
- **Time stop**: **100 slots** (about 40 s) after the entry decision at the latest. The bounce, when it
  comes, is quick; longer holds turned the edge negative.
- **Completion**: if the curve graduates first, the replay closes the position.
- After an exit the coin is ignored for 30 slots.

## Guardrails

The dip rule trades about 15-20 coins a day, so a **filler** module makes 0.012 SOL round trips
(held 10 slots) on 3-30 SOL curves until 24 distinct coins carry a qualifying round trip. It never
takes the last two position slots and costs about 0.015 SOL in all.

## Dev window (local grade)

+3.32 SOL net (90% interval +0.88 .. +6.39), +1.37 SOL with every fee doubled, +1.00 SOL without its
three best coins; 39 coins with qualifying round trips; maximum drawdown 7.9%. The house bots lost on
the same window (reversion -3.71, sniper -0.50, momentum -9.47 SOL).

## Risks

A thin edge on about 45 positions a day. The kit's block-surrogate copies rebuild each coin from other
coins' flow, removing the dynamics this relies on; there it loses a median 1.86 SOL (worst 3.35): the
downside of a day without the pattern. Deterministic; standard library only.
