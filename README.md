# Deep-curve dip buyer

Entry for make.fun's `memecoin-backtest-48h-01`: a bot that trades pump.fun bonding curves in a replay of
real Solana chain data (protocol `agent-fun/replay/v2`), starting from 10 SOL and ranked by net PnL on the
24 hours from 2026-11-10 03:00 UTC. `node main.ts` (Node 22, standard library only) reads hello, then one
batch per slot, on stdin and answers each batch with one reply of orders on stdout. It reads no clock and
uses no randomness, so two runs give the same bytes.

## Strategy
- **Entry.** Only curves holding at least 50 SOL of real reserve (near graduation, about 85 SOL). A dip is
  the price after a slot's last trade at least 10% below the price 4 slots earlier.
- **Size.** Up to 3 buys on consecutive batches, each 95 bps of the curve's real SOL (the cap is 100 bps
  per reply): about 0.5-0.8 SOL a buy, at most 3 SOL a position, at most 5 positions.
- **Exit.** Sell the whole position once it would fetch 5% over its cost after the curve fee, or 100 slots
  (about 40 s) after the entry decision. A curve that completes first is closed by the replay at its last
  trade.
- **Guardrail.** Until 24 distinct coins hold a round trip of at least 0.01 SOL, small 0.012 SOL round
  trips on 3-30 SOL curves fill the count. They cost about 0.015 SOL in all.

[STRATEGY.md](STRATEGY.md) has the reasoning and the rules in full.

## Evidence
On the 24-hour dev window, graded locally with the kit's harness: **+3.32 SOL net** (90% interval +0.88 to
+6.39), +1.37 SOL with every fee doubled and +1.00 SOL without the three best coins. 39 coins carry a
qualifying round trip, and the maximum drawdown is 7.9%. The house bots on the same window: reversion
-3.71, sniper -0.50, momentum -9.47 SOL, equal-weight -0.02, hold-cash 0.

Most ideas lost money after the ~2.5% round-trip fee drag: momentum, crash rebounds, sniping launches,
riding curves to completion. The dip rule was kept because it holds across a neighbourhood of settings (79
of 81 profitable), on each half of the coins split by hash, and in each of the window's two busy 6-hour
quarters. It is still a thin edge. On the kit's block-surrogate copies, which rebuild each coin from other
coins' trades and so remove the pattern it trades, it loses a median 1.86 SOL.

## Run it locally
From the unpacked kit:

    node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process

The grader runs `node /bot/main.ts` with the repository mounted at `/bot`.
