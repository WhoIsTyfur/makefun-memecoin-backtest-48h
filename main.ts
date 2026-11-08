// SPDX-License-Identifier: MIT
// Deep-curve dip buyer for make.fun's pumpfun-replay/v2 (agent-fun/replay/v2 protocol).
//
// Trades pump.fun bonding curves that already hold a lot of real SOL (close to graduation). When
// such a curve's price drops 10% or more within 4 slots, it buys in up to three tranches on
// consecutive batches (each under the per-reply cap of 1% of the curve's real SOL), sells the whole
// position as soon as it would fetch 5% over its cost, or after 100 slots at the latest, and lets the
// replay close it at the completing trade if the curve graduates first. A few tiny "filler" round trips
// early in the run make sure the 20-coin guardrail is met however many dips the day brings.
//
// Deterministic: no clock, no randomness, no environment; iteration follows the event order of each
// batch. Standard library only. Run as `node main.ts` (Node 22 type stripping: erasable syntax only).

import { createInterface } from 'node:readline';

// ------------------------------------------------------------------ parameters

const LAMPORTS = 1_000_000_000n;
/** Only curves holding at least this much real SOL are dip candidates. */
const DIP_MIN_REAL_SOL = 50n * LAMPORTS;
/** A dip: last price at most (100 - DIP_PCT)% of the price DIP_LOOKBACK slots earlier. */
const DIP_PCT = 10n;
const DIP_LOOKBACK = 4;
/** Sell this many slots after the entry decision at the latest (the curve may complete first)... */
const DIP_HOLD_SLOTS = 100;
/** ...or as soon as the position would sell for this much over its cost (bps, sell fee deducted). */
const TAKE_PROFIT_BPS = 500n;
/** Curve fee assumed when valuing a position (protocol 95 + creator 30 bps). */
const CURVE_FEE_BPS = 125n;
/** A dip entry is bought in up to this many buys on consecutive batches (each under its own reply cap). */
const DIP_TRANCHES = 3;
/** Most SOL per dip position; the per-reply cap usually binds first. */
const DIP_MAX_STAKE = 3n * LAMPORTS;
/** Share of the curve's real SOL a buy may spend, in bps: 5 bps under hello's cap (100 bps). */
let sizeBps = 95n;
const DIP_BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 5000;
/** After leaving a coin, ignore it for this many slots. */
const COOLDOWN_SLOTS = 30;

/** Guardrail filler: distinct coins with a qualifying round trip we aim for. */
const FILLER_TARGET_COINS = 24;
const FILLER_LAMPORTS = 12_000_000n; // 0.012 SOL, above the 0.01 SOL round-trip floor
const FILLER_MIN_REAL_SOL = 3n * LAMPORTS;
const FILLER_MAX_REAL_SOL = 30n * LAMPORTS;
const FILLER_HOLD_SLOTS = 10;
const FILLER_BUY_SLIPPAGE_BPS = 1000;
/** Round-trip floor of the guardrail. */
const ROUND_TRIP_MIN = 10_000_000n;

// ------------------------------------------------------------------ wire types (subset we read)

interface TradeEv {
  event: 'TradeEvent';
  mint: string;
  slot: number;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  real_quote_reserves: string;
}
interface OtherEv {
  event: 'CreateEvent' | 'CompleteEvent';
  mint: string;
  slot: number;
  virtual_quote_reserves?: string;
  virtual_token_reserves?: string;
}
type Ev = TradeEv | OtherEv;
interface Mark {
  mint: string;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  real_quote_reserves: string;
}
interface Fill {
  client_id: string;
  mint: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  quote_lamports: string;
}
interface Position {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}
interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: Ev[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: string; positions: Position[] };
}
interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ------------------------------------------------------------------ state

interface Curve {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  complete: boolean;
  /** Recent (slot, vq, vt) after the last trade of each slot, oldest first. */
  hist: { slot: number; vq: bigint; vt: bigint }[];
}
interface Trade {
  kind: 'dip' | 'filler';
  decidedSlot: number;
  selling: boolean;
  /** Buys sent for this position, and the SOL they asked to spend. */
  tranches: number;
  committed: bigint;
  lastBuySlot: number;
}

const curves = new Map<string, Curve>();
const trades = new Map<string, Trade>();
const coolUntil = new Map<string, number>();
/** client_id -> order still in flight. */
const pending = new Map<string, Order>();
/** Buy SOL paid into the open round trip of each coin. */
const roundTripPaid = new Map<string, bigint>();
const qualifiedCoins = new Set<string>();
let maxOpen = 5;
let maxOrders = 16;
let txFee = 105_000n;
let nextId = 1;

function newId(): string {
  return 'o' + String(nextId++);
}

/** Price at or before `slot` from a curve's history; null when unknown. */
function priceAt(c: Curve, slot: number): { vq: bigint; vt: bigint } | null {
  for (let i = c.hist.length - 1; i >= 0; i--) {
    const h = c.hist[i]!;
    if (h.slot <= slot) return h;
  }
  return null;
}

/** What selling `tokens` would pay now, curve fee deducted, at the mark's reserves (own impact included). */
function sellValue(m: Mark | undefined, tokens: bigint): bigint {
  if (m === undefined) return 0n;
  const vq = BigInt(m.virtual_quote_reserves);
  const vt = BigInt(m.virtual_token_reserves);
  const rq = BigInt(m.real_quote_reserves);
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * CURVE_FEE_BPS) / 10_000n;
}

function onTrade(e: TradeEv): void {
  let c = curves.get(e.mint);
  if (c === undefined) {
    c = { vq: 0n, vt: 0n, rq: 0n, complete: false, hist: [] };
    curves.set(e.mint, c);
  }
  c.vq = BigInt(e.virtual_quote_reserves);
  c.vt = BigInt(e.virtual_token_reserves);
  c.rq = BigInt(e.real_quote_reserves);
  const last = c.hist[c.hist.length - 1];
  if (last !== undefined && last.slot === e.slot) {
    last.vq = c.vq;
    last.vt = c.vt;
  } else {
    c.hist.push({ slot: e.slot, vq: c.vq, vt: c.vt });
    if (c.hist.length > 32) c.hist.shift();
  }
}

function handleBatch(b: Batch): Order[] {
  const slot = b.slot;

  // 1. Resolved orders.
  const held = new Map<string, Position>();
  for (const p of b.account.positions) held.set(p.mint, p);
  for (const f of b.fills) {
    pending.delete(f.client_id);
    if (f.side === 'buy') {
      if (f.status === 'filled') {
        const paid = (roundTripPaid.get(f.mint) ?? 0n) + BigInt(f.quote_lamports);
        roundTripPaid.set(f.mint, paid);
        if (paid >= ROUND_TRIP_MIN) qualifiedCoins.add(f.mint);
      } else if (!held.has(f.mint)) {
        trades.delete(f.mint);
      }
    }
    if (!held.has(f.mint)) {
      roundTripPaid.delete(f.mint);
      if (f.side === 'sell' || f.client_id.startsWith('_')) {
        trades.delete(f.mint);
        coolUntil.set(f.mint, slot + COOLDOWN_SLOTS);
      }
    } else if (f.side === 'sell') {
      const t = trades.get(f.mint);
      if (t !== undefined) t.selling = false; // partly sold or failed: try again
    }
  }

  // 2. Market events.
  const touched: string[] = [];
  const seen = new Set<string>();
  for (const e of b.events) {
    if (e.event === 'TradeEvent') {
      onTrade(e);
      if (!seen.has(e.mint)) {
        seen.add(e.mint);
        touched.push(e.mint);
      }
    } else if (e.event === 'CompleteEvent') {
      const c = curves.get(e.mint);
      if (c !== undefined) c.complete = true;
      else curves.set(e.mint, { vq: 0n, vt: 0n, rq: 0n, complete: true, hist: [] });
    }
  }
  const marks = new Map<string, Mark>();
  for (const m of b.marks) marks.set(m.mint, m);

  const orders: Order[] = [];
  const pendingMints = new Set<string>();
  let pendingBuyCash = 0n;
  for (const o of pending.values()) {
    pendingMints.add(o.mint);
    if (o.side === 'buy') pendingBuyCash += BigInt(o.quote_lamports!) + txFee;
  }
  let cash = BigInt(b.account.cash_lamports) - pendingBuyCash;

  // 3. Exits.
  for (const p of b.account.positions) {
    if (orders.length >= maxOrders) break;
    const c = curves.get(p.mint);
    if (c !== undefined && c.complete) continue;
    if (pendingMints.has(p.mint)) continue;
    let t = trades.get(p.mint);
    if (t === undefined) {
      t = { kind: 'filler', decidedSlot: -1_000_000, selling: false, tranches: 1, committed: 0n, lastBuySlot: -1 };
      trades.set(p.mint, t);
    }
    if (t.selling) continue;
    const amount = BigInt(p.token_amount);
    if (amount === 0n) continue;
    const hold = t.kind === 'dip' ? DIP_HOLD_SLOTS : FILLER_HOLD_SLOTS;
    let exit = slot - t.decidedSlot >= hold;
    if (!exit && t.kind === 'dip') {
      const value = sellValue(marks.get(p.mint), amount);
      exit = value * 10_000n >= BigInt(p.cost_lamports) * (10_000n + TAKE_PROFIT_BPS);
    }
    if (!exit) continue;
    const o: Order = { side: 'sell', client_id: newId(), mint: p.mint, token_amount: amount.toString(), max_slippage_bps: SELL_SLIPPAGE_BPS };
    orders.push(o);
    pending.set(o.client_id, o);
    pendingMints.add(p.mint);
    t.selling = true;
    cash -= txFee;
  }

  // 4. Later tranches of dip entries, one buy per coin per reply, until the position starts exiting.
  for (const [mint, t] of trades) {
    if (orders.length >= maxOrders) break;
    if (t.kind !== 'dip' || t.selling || t.tranches >= DIP_TRANCHES || t.lastBuySlot >= slot) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    const m = marks.get(mint);
    const rq = m !== undefined ? BigInt(m.real_quote_reserves) : c.rq;
    let q = (rq * sizeBps) / 10_000n;
    if (q > DIP_MAX_STAKE - t.committed) q = DIP_MAX_STAKE - t.committed;
    if (q < FILLER_LAMPORTS || q + txFee > cash) continue;
    const o: Order = { side: 'buy', client_id: newId(), mint, quote_lamports: q.toString(), max_slippage_bps: DIP_BUY_SLIPPAGE_BPS };
    orders.push(o);
    pending.set(o.client_id, o);
    t.tranches++;
    t.committed += q;
    t.lastBuySlot = slot;
    cash -= q + txFee;
  }

  // 5. Entries.
  let open = held.size;
  for (const m of pendingMints) if (!held.has(m)) open++;
  let fillersThisBatch = 0;
  for (const mint of touched) {
    if (orders.length >= maxOrders || open >= maxOpen) break;
    if (held.has(mint) || pendingMints.has(mint) || trades.has(mint)) continue;
    if ((coolUntil.get(mint) ?? -1) > slot) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    const cap = (c.rq * sizeBps) / 10_000n;

    // Dip on a deep curve.
    if (c.rq >= DIP_MIN_REAL_SOL) {
      const ref = priceAt(c, slot - DIP_LOOKBACK);
      // now/ref <= (100 - DIP_PCT)/100  <=>  vq*vtRef*100 <= (100-DIP_PCT)*vqRef*vt
      if (ref !== null && c.vq * ref.vt * 100n <= (100n - DIP_PCT) * ref.vq * c.vt) {
        let q = cap < DIP_MAX_STAKE ? cap : DIP_MAX_STAKE;
        if (q + txFee <= cash && q >= FILLER_LAMPORTS) {
          const o: Order = { side: 'buy', client_id: newId(), mint, quote_lamports: q.toString(), max_slippage_bps: DIP_BUY_SLIPPAGE_BPS };
          orders.push(o);
          pending.set(o.client_id, o);
          pendingMints.add(mint);
          trades.set(mint, { kind: 'dip', decidedSlot: slot, selling: false, tranches: 1, committed: q, lastBuySlot: slot });
          cash -= q + txFee;
          open++;
          continue;
        }
      }
    }

    // Guardrail filler: tiny round trips until enough distinct coins qualify. Keeps two position
    // slots free for dips.
    if (fillersThisBatch > 0 || open >= maxOpen - 2) continue;
    let inflightFillers = 0;
    for (const t of trades.values()) if (t.kind === 'filler') inflightFillers++;
    if (qualifiedCoins.size + inflightFillers >= FILLER_TARGET_COINS) continue;
    if (qualifiedCoins.has(mint)) continue;
    if (c.rq < FILLER_MIN_REAL_SOL || c.rq > FILLER_MAX_REAL_SOL || cap < FILLER_LAMPORTS) continue;
    if (FILLER_LAMPORTS + txFee > cash) continue;
    const o: Order = { side: 'buy', client_id: newId(), mint, quote_lamports: FILLER_LAMPORTS.toString(), max_slippage_bps: FILLER_BUY_SLIPPAGE_BPS };
    orders.push(o);
    pending.set(o.client_id, o);
    pendingMints.add(mint);
    trades.set(mint, { kind: 'filler', decidedSlot: slot, selling: false, tranches: 1, committed: FILLER_LAMPORTS, lastBuySlot: slot });
    cash -= FILLER_LAMPORTS + txFee;
    open++;
    fillersThisBatch++;
  }
  return orders;
}

// ------------------------------------------------------------------ wire loop

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0) continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    maxOpen = msg.caps.max_open_positions;
    maxOrders = msg.caps.max_orders_per_batch;
    const capBps = BigInt(msg.caps.max_order_bps_of_real_reserve);
    sizeBps = capBps > 5n ? capBps - 5n : capBps;
    txFee = BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
  } else if (msg.type === 'batch') {
    const orders = handleBatch(msg as Batch);
    process.stdout.write(JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n');
  } else if (msg.type === 'done') {
    break;
  }
}
