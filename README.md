# Curve trader

Entry for make.fun's `memecoin-backtest-48h-01`: a bot that trades pump.fun bonding curves in a replay of
real Solana chain data (protocol `agent-fun/replay/v2`), starting from 10 SOL and ranked by net PnL on the
24 hours from 2026-11-10 03:30 UTC. `node main.ts` (Node 22, standard library only) reads hello, then one
batch per slot, on stdin and answers each batch with one reply of orders on stdout. It reads no clock and
uses no randomness, so two runs give the same bytes.

## Strategy
- **Entry.** A curve holding 39-60 SOL of real reserve that is 40-120 slots old (it filled fast, but not in
  one bundled burst), bought by at least 30 wallets, where neither the launch-slot wallets together (16 SOL)
  nor any single wallet (11 SOL) could pull much out by selling what they hold. One entry per coin.
- **Size.** 35% of equity per coin, built over consecutive batches at 95 bps of the curve's real SOL a buy
  (the cap is 100 bps per reply); at most 3 positions. A drawdown governor cuts a new stake to what the
  account could lose outright and still stay within 40% of its peak.
- **Exit.** Hold to completion: the replay closes the position at the completing trade, the top of the
  curve. Sell everything if the curve falls 20 SOL of real reserve below the entry or 40 below its peak;
  sell a position down when it is worth more than 35% of equity.
- **Guardrail.** Until 24 distinct coins hold a round trip of at least 0.01 SOL, small 0.012 SOL round
  trips on 3-30 SOL curves fill the count. They cost about 0.015 SOL in all.

[STRATEGY.md](STRATEGY.md) has the reasoning and the rules in full.

## Evidence
On the 24-hour dev window, in a replay written from the kit's engine source (it reproduces the earlier
version's server-graded +3.32 SOL to within the 2% failed-order draw): **about +26.8 SOL net**, +24.7 SOL
with every fee doubled and +6.9 SOL without the three best coins. 31 coins carry a qualifying round trip
and the maximum drawdown is 21%. Seven sprint trades: five graduated, two were stopped.

Both halves of the coins split by a hash of the mint are profitable (+10.0 and +16.9 SOL). On 17
pseudo-windows (hash subsets of the coins, and each half and quarter of the day run alone from 10 SOL) the
mean is +10.7 SOL and none loses. Nearly all of the dev day's profit came in its second half, so a quiet
day earns about nothing. An earlier version of this entry bought sharp dips on deep curves (+3.32 SOL); the
kit's rebuilt copies of the window showed that edge leaning on the window's own coins, and it was replaced.

## Run it locally
From the unpacked kit:

    node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver docker

The grader runs `node /bot/main.ts` with the repository mounted at `/bot`.
