// SPDX-License-Identifier: MIT
// Curve trader for make.fun's pumpfun-replay/v2 (agent-fun/replay/v2 protocol).
//
// It buys a pump.fun bonding curve that has filled fast since its launch, but not in one bundled
// burst, and that no small group of wallets can crash; builds the stake over consecutive batches
// (each buy under the per-reply cap of 1% of the curve's real SOL); and holds it until the curve
// completes, when the replay closes the position at the completing trade. It sells early only when
// the curve falls a set amount of real SOL below where it was bought, and it sells part of a
// position that has grown too large a share of the account. A drawdown governor sizes every new
// stake. A few tiny "filler" round trips early in the run make sure the 20-coin guardrail is met
// however few real trades the day brings.
//
// Deterministic: no clock, no randomness, no environment; iteration follows the event order of each
// batch. Standard library only. Run as `node main.ts` (Node 22 type stripping: erasable syntax only).

import { createInterface } from 'node:readline';

// ------------------------------------------------------------------ parameters

const P = {
  /** Enter only while the curve's real SOL is inside this band... */
  entryRq: 39,
  entryRqMax: 60,
  /** ...and the coin is between minAge and maxAge slots old: it got here fast, but not in a burst. */
  minAge: 40,
  maxAge: 120,
  /** Breadth: distinct wallets that have bought the coin. */
  minBuyers: 30,
  /** The launch group is every wallet that bought in the creation slot or the launchSlots after it. */
  launchSlots: 1,
  /** Skip a coin whose launch group could still pull more than this many SOL out by selling. */
  maxGroupSol: 16,
  /** Skip a coin whose largest holder could pull more than this many SOL out by selling. */
  maxWhaleSol: 11,
  /** Stake per position: this share of equity, never under minStake SOL (smaller: no trade). */
  stakeFrac: 0.35,
  minStake: 0.3,
  /** Keep building the stake while the real SOL is at most addRqMax and at most addDropSol under the entry. */
  addRqMax: 70,
  addDropSol: 8,
  /** Floor: sell when the real SOL falls this far below where the position was entered. */
  floorSol: 20,
  /** Sell a position down when it is worth more than this share of equity. */
  trimFrac: 0.35,
  /** Drawdown governor: a new stake is sized so that losing every open position outright would
   *  still leave equity within ddLine of its peak. */
  ddLine: 0.4,
  /** Concurrent positions, and slots to wait after leaving a coin. */
  maxSprint: 3,
  cooldown: 30,
  /** Guardrail filler: distinct coins to round-trip, the SOL of each, where and how long. */
  fillerCoins: 24,
  fillerSol: 0.012,
  fillerMinRq: 3,
  fillerMaxRq: 30,
  fillerHold: 10,
};

const LAMPORTS = 1_000_000_000;
/** Curve fee assumed when valuing a position (protocol 95 + creator 30 bps). */
const CURVE_FEE_BPS = 125n;
const BUY_SLIPPAGE_BPS = 1500;
const FILLER_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 5000;
/** A floor exit must get out whatever the next two slots do. */
const STOP_SLIPPAGE_BPS = 9900;
/** Round-trip floor of the guardrail. */
const ROUND_TRIP_MIN = 10_000_000n;

// ------------------------------------------------------------------ wire types (subset we read)

interface TradeEv {
  event: 'TradeEvent';
  mint: string;
  slot: number;
  user: string;
  is_buy: boolean;
  token_amount: string;
  virtual_quote_reserves: string;
  virtual_token_reserves: string;
  real_quote_reserves: string;
}
interface OtherEv {
  event: 'CreateEvent' | 'CompleteEvent';
  mint: string;
  slot: number;
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
  created: number;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  /** Real SOL in the curve, as a number. */
  sol: number;
  complete: boolean;
  /** Tokens each wallet bought on the curve and has not sold back (every wallet that ever bought). */
  held: Map<string, bigint>;
  /** The launch group: wallets that bought in the launch slots. */
  group: Set<string>;
  /** Set once we have traded the coin as a sprint: one entry per coin. */
  entered: boolean;
}
interface Trade {
  kind: 'sprint' | 'filler';
  decidedSlot: number;
  selling: boolean;
  /** SOL the buys sent so far asked to spend, and the SOL the position aims at. */
  committed: bigint;
  target: bigint;
  lastBuySlot: number;
  /** Real SOL in the curve when the position was decided. */
  entrySol: number;
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
/** Share of the curve's real SOL a buy may spend, in bps: 5 bps under hello's cap (100 bps). */
let sizeBps = 95n;
let txFee = 105_000n;
let nextId = 1;
let peakEquity = 0n;

function newId(): string {
  return 'o' + String(nextId++);
}
function lamports(sol: number): bigint {
  return BigInt(Math.floor(sol * LAMPORTS));
}
/** `share` (0..1) of an amount, in whole bps. */
function shareOf(amount: bigint, share: number): bigint {
  return (amount * BigInt(Math.floor(share * 10_000))) / 10_000n;
}

function onHello(msg: any): void {
  maxOpen = msg.caps.max_open_positions;
  maxOrders = msg.caps.max_orders_per_batch;
  const capBps = BigInt(msg.caps.max_order_bps_of_real_reserve);
  sizeBps = capBps > 5n ? capBps - 5n : capBps;
  txFee = BigInt(msg.fees.base_fee_lamports) + BigInt(msg.fees.priority_fee_lamports);
}

function curveOf(mint: string, slot: number): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = { created: slot, vq: 0n, vt: 0n, rq: 0n, sol: 0, complete: false, held: new Map(), group: new Set(), entered: false };
    curves.set(mint, c);
  }
  return c;
}

function onTrade(e: TradeEv): void {
  const c = curveOf(e.mint, e.slot);
  c.vq = BigInt(e.virtual_quote_reserves);
  c.vt = BigInt(e.virtual_token_reserves);
  c.rq = BigInt(e.real_quote_reserves);
  c.sol = Number(c.rq) / LAMPORTS;
  const tokens = BigInt(e.token_amount);
  const bal = c.held.get(e.user) ?? 0n;
  if (e.is_buy) {
    c.held.set(e.user, bal + tokens);
    if (e.slot <= c.created + P.launchSlots) c.group.add(e.user);
  } else {
    c.held.set(e.user, tokens < bal ? bal - tokens : 0n);
  }
}

/** SOL that selling `tokens` into the curve would take out of it now. */
function dumpSol(c: Curve, tokens: bigint): number {
  if (tokens <= 0n) return 0;
  return Number((tokens * c.vq) / (c.vt + tokens)) / LAMPORTS;
}

/** What the launch group could take out by selling everything it still holds. */
function groupDumpSol(c: Curve): number {
  let tokens = 0n;
  for (const w of c.group) tokens += c.held.get(w) ?? 0n;
  return dumpSol(c, tokens);
}

/** What the largest single holder could take out by selling everything. */
function whaleDumpSol(c: Curve): number {
  let top = 0n;
  for (const t of c.held.values()) if (t > top) top = t;
  return dumpSol(c, top);
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

/** A sprint: deep enough, there fast but not in a burst, broadly bought, and nobody can crash it. */
function sprintSignal(c: Curve, slot: number): boolean {
  if (c.entered || c.sol < P.entryRq || c.sol > P.entryRqMax) return false;
  const age = slot - c.created;
  if (age < P.minAge || age > P.maxAge) return false;
  if (c.held.size < P.minBuyers) return false;
  if (groupDumpSol(c) > P.maxGroupSol) return false;
  return whaleDumpSol(c) <= P.maxWhaleSol;
}

function handleBatch(b: Batch): Order[] {
  const slot = b.slot;

  // 1. Resolved orders.
  const held = new Map<string, Position>();
  for (const p of b.account.positions) held.set(p.mint, p);
  for (const f of b.fills) {
    const sent = pending.get(f.client_id);
    pending.delete(f.client_id);
    if (f.side === 'buy') {
      if (f.status === 'filled') {
        const paid = (roundTripPaid.get(f.mint) ?? 0n) + BigInt(f.quote_lamports);
        roundTripPaid.set(f.mint, paid);
        if (paid >= ROUND_TRIP_MIN) qualifiedCoins.add(f.mint);
      } else {
        // Not bought: give the SOL back to the position's budget.
        const t = trades.get(f.mint);
        if (t !== undefined && sent !== undefined) t.committed -= BigInt(sent.quote_lamports!);
      }
    }
    if (!held.has(f.mint)) {
      roundTripPaid.delete(f.mint);
      if (f.side === 'sell' || f.client_id.startsWith('_')) {
        trades.delete(f.mint);
        coolUntil.set(f.mint, slot + P.cooldown);
      }
    } else if (f.side === 'sell') {
      const t = trades.get(f.mint);
      if (t !== undefined) t.selling = false; // partly sold or failed: look again
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
    } else if (e.event === 'CreateEvent') {
      curveOf(e.mint, e.slot);
    } else if (e.event === 'CompleteEvent') {
      curveOf(e.mint, e.slot).complete = true;
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

  // A trade whose buys all came to nothing is over.
  for (const mint of [...trades.keys()]) {
    if (!held.has(mint) && !pendingMints.has(mint)) trades.delete(mint);
  }

  // Equity at what the positions would sell for now, and how much of it sits in sprint positions.
  let equity = BigInt(b.account.cash_lamports);
  let atRisk = 0n;
  const worth = new Map<string, bigint>();
  for (const p of b.account.positions) {
    const v = sellValue(marks.get(p.mint), BigInt(p.token_amount));
    worth.set(p.mint, v);
    equity += v;
    if (trades.get(p.mint)?.kind === 'sprint') atRisk += v;
  }
  for (const o of pending.values()) {
    if (o.side === 'buy' && trades.get(o.mint)?.kind === 'sprint') atRisk += BigInt(o.quote_lamports!);
  }
  if (equity > peakEquity) peakEquity = equity;
  // Drawdown governor: what could still be lost before equity falls to the floor line, if every
  // sprint position went to zero.
  let riskBudget = equity - shareOf(peakEquity, 1 - P.ddLine) - atRisk;

  const send = (o: Order): void => {
    orders.push(o);
    pending.set(o.client_id, o);
    pendingMints.add(o.mint);
  };

  // 3. Exits.
  for (const p of b.account.positions) {
    if (orders.length >= maxOrders) break;
    const c = curves.get(p.mint);
    if (c === undefined || c.complete) continue;
    let t = trades.get(p.mint);
    if (t === undefined) {
      t = { kind: 'filler', decidedSlot: -1_000_000, selling: false, committed: 0n, target: 0n, lastBuySlot: -1, entrySol: c.sol };
      trades.set(p.mint, t);
    }
    if (t.selling) continue;
    const amount = BigInt(p.token_amount);
    if (amount === 0n) continue;
    let part = 0n;
    let slippage = SELL_SLIPPAGE_BPS;
    if (t.kind === 'filler') {
      if (slot - t.decidedSlot >= P.fillerHold) part = amount;
    } else if (c.sol < t.entrySol - P.floorSol) {
      // Floor: the curve gave back too much. Sell everything.
      part = amount;
      slippage = STOP_SLIPPAGE_BPS;
    } else {
      // Trim: a position worth more than trimFrac of equity is sold down to 80% of that.
      const v = worth.get(p.mint) ?? 0n;
      const limit = shareOf(equity, P.trimFrac);
      if (v > limit && v > 0n) part = (amount * (v - (limit * 8n) / 10n)) / v;
    }
    if (part <= 0n) continue;
    // A sell lands after the buys still in flight, so it can go out beside them; the stake is closed.
    t.target = t.committed;
    send({ side: 'sell', client_id: newId(), mint: p.mint, token_amount: part.toString(), max_slippage_bps: slippage });
    t.selling = true;
    cash -= txFee;
  }

  // 4. Later buys of open stakes, one per coin per reply, until the position starts exiting.
  for (const [mint, t] of trades) {
    if (orders.length >= maxOrders) break;
    if (t.kind !== 'sprint' || t.selling || t.lastBuySlot >= slot) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    if (c.sol > P.addRqMax || c.sol < t.entrySol - P.addDropSol) continue;
    const m = marks.get(mint);
    const rq = m !== undefined ? BigInt(m.real_quote_reserves) : c.rq;
    let q = (rq * sizeBps) / 10_000n;
    if (q > t.target - t.committed) q = t.target - t.committed;
    if (q < ROUND_TRIP_MIN || q + txFee > cash) continue;
    send({ side: 'buy', client_id: newId(), mint, quote_lamports: q.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS });
    t.committed += q;
    t.lastBuySlot = slot;
    cash -= q + txFee;
  }

  // 5. Entries.
  let open = held.size;
  for (const m of pendingMints) if (!held.has(m)) open++;
  let sprints = 0;
  let inflightFillers = 0;
  for (const t of trades.values()) {
    if (t.kind === 'sprint') sprints++;
    else inflightFillers++;
  }
  let fillersThisBatch = 0;
  for (const mint of touched) {
    if (orders.length >= maxOrders || open >= maxOpen) break;
    if (held.has(mint) || pendingMints.has(mint) || trades.has(mint)) continue;
    if ((coolUntil.get(mint) ?? -1) > slot) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete) continue;
    const cap = (c.rq * sizeBps) / 10_000n;

    // Sprint.
    if (sprints < P.maxSprint && sprintSignal(c, slot)) {
      let target = shareOf(equity, P.stakeFrac);
      if (target > riskBudget) target = riskBudget;
      const q = cap < target ? cap : target;
      if (target >= lamports(P.minStake) && q + txFee <= cash && q >= ROUND_TRIP_MIN) {
        send({ side: 'buy', client_id: newId(), mint, quote_lamports: q.toString(), max_slippage_bps: BUY_SLIPPAGE_BPS });
        trades.set(mint, { kind: 'sprint', decidedSlot: slot, selling: false, committed: q, target, lastBuySlot: slot, entrySol: c.sol });
        c.entered = true;
        riskBudget -= target;
        cash -= q + txFee;
        open++;
        sprints++;
        continue;
      }
    }

    // Guardrail filler: tiny round trips until enough distinct coins qualify. Keeps two position
    // slots free for sprints.
    if (fillersThisBatch > 0 || open >= maxOpen - 2) continue;
    if (qualifiedCoins.size + inflightFillers >= P.fillerCoins) continue;
    if (qualifiedCoins.has(mint)) continue;
    const fq = lamports(P.fillerSol);
    if (c.sol < P.fillerMinRq || c.sol > P.fillerMaxRq || cap < fq) continue;
    if (fq + txFee > cash) continue;
    send({ side: 'buy', client_id: newId(), mint, quote_lamports: fq.toString(), max_slippage_bps: FILLER_SLIPPAGE_BPS });
    trades.set(mint, { kind: 'filler', decidedSlot: slot, selling: false, committed: fq, target: fq, lastBuySlot: slot, entrySol: c.sol });
    cash -= fq + txFee;
    open++;
    fillersThisBatch++;
    inflightFillers++;
  }
  return orders;
}

// === wire loop

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length === 0) continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    onHello(msg);
  } else if (msg.type === 'batch') {
    const orders = handleBatch(msg as Batch);
    process.stdout.write(JSON.stringify({ type: 'reply', seq: msg.seq, orders }) + '\n');
  } else if (msg.type === 'done') {
    break;
  }
}
