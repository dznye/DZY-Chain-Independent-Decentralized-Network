/* The Heart upgrade (22 Nov 2026, the owner's blueprint). It starts at a set block of each chain (heartFrom); every block
   before it keeps the old rules, and until then nothing here does anything. From it on (State.heart):

   1. POWER = STAKE x TIME. A validator's say is the DZY behind it times the hours it has been online, up to
      HEART.fullHours (90 days). Added stake starts its own clock, so nobody turns 1 old DZY into 10,000 old DZY. Anyone
      with 1 DZY joins; chances grow by staying. Being away costs hours, missing a turn costs a day of them (at most half).
   2. A RAFFLE FOR EVERY BLOCK. Who makes each block, and who steps in if it does not, is drawn by power, seeded by Bitcoin.
   3. NEWCOMERS CANNOT STOP OR TAKE THE CHAIN. Keys that are not proven (30 days online, 100 DZY behind them) together
      hold at most a quarter of the say, however many DZY or keys they bring: they can neither finish a block nor block one.
      Until four proven validators besides the starting ones (the anchors), with 10,000 DZY behind them, are online, that
      holds for everyone but the anchors. (Until then the chain is the anchors' to keep running: that is the price of nobody
      being able to buy it for a few dollars.)
   4. FEES. Of every fee: 40% validators by blocks made, 30% to the Sun and the pot (what stands behind DZY), 5% to those
      online who made fewer blocks than their share, 10% to contributors, 15% to lockers by amount x time. DZY fees in DZY; the
      exchange's fees in the very coin they were paid in (BTC, ETH, SOL, USDC...).
   5. A PRICE THAT MOVES. From here the sale curve doubles every priceDouble DZY instead of every 500,000: every buy moves
      it up, every lock closed and every DZY sold at the floor moves it down, along the same curve. Dollar prices paid in
      DZY use the lower of the price now and its average over about an hour, so nobody buys cheaply by pushing it for a
      moment. The chain never sells DZY below 1.25 times its backing, and at most 5% of each coin behind DZY leaves in a
      day, 1% of it staying: the treasury cannot be emptied by going round.
   6. BLOCKS BY WEIGHT, FOLLOWING DEMAND. A block is limited by its size and its work, not by a count. The limit grows by
      an eighth after a block more than half full and shrinks after a quiet one, up to what validators holding four fifths
      of the say declare they can take. An action pays by its size (one fee per 1,000 characters), like baggage.
   7. A PLACE TO MAKE BLOCKS costs a little more for each validator there already (a stake, not a payment: it comes back).
   A fingerprint (root.ts) that covers the whole state. Layers are in zones.ts.

   Whole numbers only. Nobody holds a key to any of this. */
import { sha256 as sha256Sync } from './btc.ts';
import { emptyOf, keysOf, peek } from './layer.ts';
import { evmRoom, FUTURE, fullness, workAdd } from './work.ts';
export { evmRoom, FUTURE, fullness, workAdd };
// @ts-ignore: plain JavaScript, shared with the tested model
import { RULES as V2 } from '../v2/rules.mjs';
// @ts-ignore
import { salePrice, saleUnitsFor } from '../v2/sale.mjs';
import { isCandidate, isOnline, RULES as LEDGER, weightOf, type State } from './ledger.ts';

const B = BigInt, N = Number, DZY = 100_000_000;
const fail = (m: string): never => { throw new Error(m); };
const own = (o: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(o, k);

export const HEART = Object.freeze({
	fullHours: 2_160,      // 90 days online: the whole weight of its stake
	provenHours: 720,      // 30 days online ...
	provenStake: 100 * DZY, // ... with this much behind it: proven
	provenMin: 4,          // proven validators besides the anchors ...
	provenTotal: 10_000 * DZY, // ... with this much behind them all together, before the anchors are like everyone else
	awayCost: 4,           // hours lost for every hour away
	missCost: 24,          // hours lost for every turn missed (at most half of what it has)
	missLimit: 3,          // turns missed in a row before a validator is benched
	/* blocks by weight */
	sizeStart: 1_400_000, sizeMin: 250_000, sizeMax: 8_000_000, // a block's bytes: where it starts, and the bounds
	sizeBp: 8_000,         // the limit is what validators with this much of the say can take
	gasPerByte: 6,         // the gas one block's contract calls may use, for each byte it may hold (1.4 MB: 8.4 million)
	charsPerFee: 1_000,    // one fee for every 1,000 characters of an action (or part)
	seatStep: 50,          // a place to make blocks: 1 DZY x (1 + validators there / 50)^2
	seatKeep: 7 * 24 * 60 * 60 * 1000, // who was away for less than this keeps the price they joined at
	/* the moving price */
	priceDouble: 85_000n * 100_000_000n, // DZY sold that doubles the price
	averageMinutes: 60, aboveBacking: 12_500n, // the chain sells at 1.25 x the backing, at least
	exitBp: 100, dayBp: 500, // 1% of what is taken out of the backing stays; 5% of each coin a day, at most
	/* the split of every fee, in basis points: together 10,000 */
	validatorsBp: 4_000, backingBp: 3_000, leastBp: 500, contributorsBp: 1_000, lockersBp: 1_500,
	devBp: 1_000,          // a contract's maker gets at most this share of the fees its own contract brought in (so paying yourself always loses)
	grantDays: 7 * 24 * 60 * 60 * 1000, maxGrants: 50,
});
/** kept: the chain's lasting memory. Anything that adds an entry every node must hold for good pays `entryFees` more fees; a
    day's additions past 4 blocks' worth of bytes cost double, past 8 triple, and so on: no day can flood it cheaply */
export const KEPT = Object.freeze({ floorUsd: 20, entryFees: 9, entryBytes: 300, dayBlocks: 4, bookMax: 200 });
/** THE TIME RULES (from block timeFrom): every second counts. One DZY behind a validator for one second online is one raffle
    shard; a validator's chance in the raffle, and its say, are its shards, up to four years of them. A validator is proven at
    69 DZY and 30 days. What all the others together may say grows with the DZY that proven ones really have behind them: a
    quarter at first, the same share of everything as their DZY is of 250,000, all of it from there on (four of them at
    least). No step in it: there is no day on which the chain can be bought at a bargain.
    A place among the block makers costs 69 DZY for the first and moves like the price of DZY does: it doubles with every 25
    there are, up as they come, down as they go. It is a stake: it comes back. Only checking the history stays 1 DZY. */
export const TIME = Object.freeze({ full: 4 * 365 * 86_400 + 86_400, proven: 30 * 86_400, stake: 69 * DZY, min: 4, whole: 250_000 * DZY, window: 3_600, awayCost: 4, miss: 86_400, seatDouble: 25 });
export interface Grant { by: string; to: string; asset: string; amount: number; reason: string; until: number; votes: Record<string, boolean> }
type Coins = Record<string, number>;
export interface HeartState {
	from: number; anchors: string[]; open?: true; // open: enough proven validators, the anchors have no special part any more
	least: number; grants: number; dev: Record<string, number>; // DZY waiting; dev: today's contract fees by the contract's maker
	coin: { v: Coins; l: Coins; g: Coins; k: Coins }; // the exchange's fees waiting: validators, least, contributors, lockers
	props: Record<string, Grant>;
	size: number; can: number; // a block's limit in bytes now, and what the validators can take
	p0: number; avg: number; // the moving price: where its curve starts (µ$), and its average (µ$ x 1,000)
	fut?: 1; load?: number; // the last rules are on; the work done so far in this block
	proof?: 1; inst?: [number, number]; // the proof rules are on; the chain day, and the µ$ of deposits that counted at once in it
	sec?: 1; // the time rules are on: time is counted in seconds
	kept?: [number, number]; // the chain day, and the bytes of lasting memory added in it
	day: [number, string]; // the chain day, and the seed of its draws (blobs.ts)
	out: Record<string, [number, number]>; // coin -> [chain day, what may still leave the backing that day]
	hold: number; owe: { v: number; l: number; g: number; k: number; b: number }; // DZY fees not yet a whole shard to anyone: what each part is owed, in ten-thousandths of a shard (together exactly `hold`)
}

/* ---------- when ---------- */
const HEART_FROM: Record<string, number> = { 'dznye-mainnet': 8_760 }; // set on 22 Nov 2026 (live height 8,709): every node runs this code before it
/** The starting validators of a chain (its genesis). Fixed here, not "whoever makes blocks when the upgrade starts": otherwise
    someone could join just before and be an anchor. A chain not listed: its validators at that moment (test chains). */
const ANCHORS: Record<string, readonly string[]> = { 'dznye-mainnet': ['6653763632eb15f0e36df4f6710722e95ac555939df956aac01f1cf8f9341ac4'] };
const TEST_HEART = new Map<string, number>(), TEST_ANCHORS = new Map<string, string[]>();
/** TEST ONLY: the first block a test chain makes by these rules (null: back to the rule) */
export function testHeartFrom(chain: string, height: number | null, anchors?: string[]) { if (height === null) TEST_HEART.delete(chain); else TEST_HEART.set(chain, height); if (anchors) TEST_ANCHORS.set(chain, anchors); }
export const heartFrom = (chain: string) => TEST_HEART.get(chain) ?? (own(HEART_FROM, chain) ? HEART_FROM[chain] : Infinity);
const TIME_FROM: Record<string, number> = { 'dznye-mainnet': 8_820 }; // the owner's rules, as early as possible (22 Nov 2026, live height 8,773): every node runs this code before it
const TEST_TIME = new Map<string, number>();
/** TEST ONLY: the first block a test chain makes by the time rules */
export function testTimeFrom(chain: string, height: number | null) { if (height === null) TEST_TIME.delete(chain); else TEST_TIME.set(chain, height); }
export const timeFrom = (chain: string) => TEST_TIME.get(chain) ?? (own(TIME_FROM, chain) ? TIME_FROM[chain] : Infinity);
/** THE PROOF RULES (from block proofFrom): a pipe checked at both ends. A Bitcoin payment counts by its proof alone, which every
    node checks (ledger.ts x.prove). On other chains, once the validators and an anchor said they saw it, it counts at
    once, whatever its size (23 Nov 2026). The wait for anyone to object (`wait`, x.doubt, x.drop) is there but
    off: a chain may set how much counts at once in a day (`waitOver`), and only past that does a payment wait. */
export const PROOF = Object.freeze({ sure: 50_000_000_000, wait: 30 * 60_000, hold: 6 * 3_600_000, guardian: 86_400, depth: 6, dust: 1_000, liarBp: 1_000, liarOut: 30 * 86_400_000 });
const PROOF_FROM: Record<string, number> = { 'dznye-mainnet': 8_985 }; // set on 23 Nov 2026 (live height 8,938): every node runs this code before it
const TEST_PROOF = new Map<string, number>();
/** TEST ONLY: the first block a test chain makes by the proof rules */
export function testProofFrom(chain: string, height: number | null) { if (height === null) TEST_PROOF.delete(chain); else TEST_PROOF.set(chain, height); }
export const proofFrom = (chain: string) => TEST_PROOF.get(chain) ?? (own(PROOF_FROM, chain) ? PROOF_FROM[chain] : Infinity);
export function startProof(s: State, height: number) { if (s.heart?.sec && !s.heart.proof && height + 1 >= proofFrom(s.chain)) s.heart.proof = 1; }
const WAIT_OVER: Record<string, number> = {}; // no chain: nothing waits
const TEST_WAIT = new Map<string, number>();
/** TEST ONLY: the millionths of a dollar that count at once in a day on a test chain; past them a payment waits */
export function testWaitOver(chain: string, usd: number | null) { if (usd === null) TEST_WAIT.delete(chain); else TEST_WAIT.set(chain, usd); }
export const waitOver = (chain: string) => TEST_WAIT.get(chain) ?? (own(WAIT_OVER, chain) ? WAIT_OVER[chain] : Infinity);
/** how much still counts at once today (without end, where nothing waits) */
export const instantLeft = (s: State) => waitOver(s.chain) - (s.heart!.inst && s.heart!.inst[0] === s.heart!.day[0] ? s.heart!.inst[1] : 0);
export function instantUse(s: State, usd: number) { if (waitOver(s.chain) !== Infinity) s.heart!.inst = [s.heart!.day[0], waitOver(s.chain) - instantLeft(s) + usd]; }
/** THE LAST RULES (from block futureFrom): the mathematics new things need, priced by the time it takes; a block full of work raises the
    fee as a block full of bytes does; and a key no quantum computer breaks. After these nothing new needs the node changed. */
const FUTURE_FROM: Record<string, number> = { 'dznye-mainnet': 9721 }; // as soon as possible (23 Nov 2026, live height 9707): every node runs this code before it
const TEST_FUTURE = new Map<string, number>();
/** TEST ONLY: the first block a test chain makes by the last rules */
export function testFutureFrom(chain: string, height: number | null) { if (height === null) TEST_FUTURE.delete(chain); else TEST_FUTURE.set(chain, height); }
export const futureFrom = (chain: string) => TEST_FUTURE.get(chain) ?? (own(FUTURE_FROM, chain) ? FUTURE_FROM[chain] : Infinity);
export function startFuture(s: State, height: number) { if (s.heart?.proof && !s.heart.fut && height + 1 >= futureFrom(s.chain)) s.heart.fut = 1; }
export const maxTx = (s: State) => (s.heart ? Math.floor(s.heart.size / 200) : LEDGER.maxTxPerBlock);
/** the bytes and the gas the next block may hold */
export const roomOf = (s: State): { bytes: number; gas: number; evm?: number } => (s.heart ? { bytes: s.heart.size, gas: s.heart.size * HEART.gasPerByte, ...(s.heart.fut ? { evm: evmRoom(s) } : {}) } : { bytes: HEART.sizeStart, gas: Infinity });
/** after a block of `bytes`: the limit follows demand */
export function sizeAfter(s: State, bytes: number) {
	const h = s.heart!, full = h.size;
	if (bytes * 2 > full) h.size = full + Math.floor(full / 8); else if (bytes * 4 < full) h.size = full - Math.floor(full / 8);
	h.size = Math.max(HEART.sizeMin, Math.min(h.size, Math.max(HEART.sizeMin, h.can)));
}
/** the smallest fee, in shards: 20 millionths of a dollar. Below it, filling every node's disk and memory would cost nothing */
export const feeFloor = (s: State) => Math.max(1, Math.ceil((KEPT.floorUsd * DZY) / payPrice(s)));
export const keptToday = (s: State) => (s.heart?.kept && s.heart.kept[0] === s.heart.day[0] ? s.heart.kept[1] : 0);
/** how many times its price lasting memory costs now */
export const keptTimes = (s: State) => (s.heart ? 1 + Math.floor(keptToday(s) / (s.heart.size * KEPT.dayBlocks)) : 1);
export function keptAdd(s: State, bytes: number) { if (s.heart && bytes) s.heart.kept = [s.heart.day[0], keptToday(s) + bytes]; }
/** the kinds that leave a new entry behind (others pay for theirs some other way, or only change what is there) */
const ENTRY = new Set(['blob.in', 'blob.out', 'drop.make', 'evm.in', 'layer.open', 'layer.deposit', 'layer.ask', 'lock', 'x.park', 'loan.open', 'market.create', 'round.bet', 'offer.create', 'xoffer.create', 'pool.open', 'margin.open', 'shop.set', 'creator.join', 'item.buy', 'resale.list', 'order.open', 'task.create', 'gift.create', 'stream.open', 'swap.lock', 'stake.delegate', 'points.create', 'channel.open', 'q.run']);
const ACCOUNT = /^[0-9a-f]{64}$/;
/** how many lasting entries an action adds: its own, and the accounts it is the first to pay */
export function newEntries(s: State, tx: { type: string; data: Record<string, unknown> }): number {
	let n = ENTRY.has(tx.type) ? 1 : 0; const to = tx.data?.to, fresh = (a: unknown) => typeof a === 'string' && ACCOUNT.test(a) && !own(s.accounts, a);
	if (Array.isArray(to)) { const seen = new Set<string>(); for (const x of to) { const a = Array.isArray(x) ? x[0] : x; if (fresh(a)) seen.add(a as string); } n += seen.size; } else if (fresh(to)) n++;
	return n;
}
/** how many fees an action's size costs */
export const sizeFees = (chars: number) => Math.max(1, Math.ceil(chars / HEART.charsPerFee));

/* ---------- the moving price ---------- */
/** the sale curve's numbers: the launch's, or the moving price's */
export function curveOf(s: State): typeof V2 { return s.heart ? { ...V2, saleStart: B(s.heart.p0), saleDouble: HEART.priceDouble } : V2; }
/** the index's price (ledger.ts indexPrice), set once by the ledger: heart.ts cannot import it without a loop */
// eslint-disable-next-line no-var -- `var` with no value: the ledger may set it before this file's own lines run (the two import each other)
var indexPriceOf: ((s: State) => number | null) | undefined;
export function setIndexPrice(f: (s: State) => number | null) { indexPriceOf = f; }
/** DZY's price now (µ$): on the curve, or, once the index is on, what stands behind each backed DZY (its last price while a coin has none) */
export const spotPrice = (s: State) => { if (s.x?.index && indexPriceOf) { const p = indexPriceOf(s) ?? s.x.nav; if (p) return p; } return N(salePrice(curveOf(s), B(s.sun!.sold))); };
/** what DZY counts for when it pays a dollar price: the lower of the price now and its hour's average */
export const payPrice = (s: State) => (s.heart ? Math.min(spotPrice(s), Math.max(1, Math.floor(s.heart.avg / 1000))) : spotPrice(s));
/** a chain minute passed: the average moves a sixtieth of the way */
export function priceMinute(s: State) { const h = s.heart!, d = spotPrice(s) * 1000 - h.avg; h.avg += Math.trunc(d / HEART.averageMinutes) || Math.sign(d); }
/** where the new curve starts, so that it goes on exactly from the price of the moment */
function startOf(sold: bigint): number {
	const now = salePrice(V2, sold);
	let lo = 1n, hi = now;
	while (lo < hi) { const m = (lo + hi) / 2n; if (salePrice({ ...V2, saleStart: m, saleDouble: HEART.priceDouble }, sold) >= now) hi = m; else lo = m + 1n; }
	return N(lo);
}
/** DZY `usd` µ$ buys from the chain: along the curve, and never below 1.25 times what stands behind a DZY (`floor`: µ$ per
    DZY; null: a coin behind it has no price right now, so none is sold) */
export function unitsFor(s: State, usd: bigint, floor: { perDzy: number } | null): bigint {
	const n = saleUnitsFor(curveOf(s), B(s.sun!.sold), usd);
	if (!s.heart) return n;
	if (!floor) return 0n;
	if (floor.perDzy <= 0) return n;
	const most = (usd * B(DZY) * 10_000n) / (B(floor.perDzy + 1) * HEART.aboveBacking);
	return n < most ? n : most;
}
/** taking `pay` of a coin out of the backing: what is paid after the 1% that stays, and what to do when it happens. Throws
    when the day's part is used up. */
export function takeBacking(s: State, coin: string, pot: number, pay: number): { pay: number; done: () => void } {
	if (!s.heart) return { pay, done: () => {} };
	const day = Math.floor(s.sun!.minute / 1440), was = own(s.heart.out, coin) && s.heart.out[coin][0] === day ? s.heart.out[coin][1] : Math.floor((pot * HEART.dayBp) / 10_000);
	if (pay > was) fail(`at most 5% of the ${coin} behind DZY leaves in a day: ${was} is left today`);
	const left = pay - N((B(pay) * B(HEART.exitBp) + 9_999n) / 10_000n);
	if (left <= 0) fail('too small to pay');
	return { pay: left, done: () => { s.heart!.out[coin] = [day, was - pay]; } };
}

/** at the end of the block before the first: the chain's starting validators become the anchors, with the hours they have served */
export function startHeart(s: State, height: number, time: number) {
	if (s.heart || !s.sun || height + 1 < heartFrom(s.chain)) return;
	const anchors = (TEST_ANCHORS.get(s.chain) ?? (own(ANCHORS, s.chain) ? ANCHORS[s.chain] : s.validators)).slice().sort(), served = Math.min(HEART.fullHours * 1000, Math.max(1000, s.started ? Math.floor((time - s.started) / 3_600) : 1000));
	s.heart = { from: height + 1, anchors, least: 0, grants: 0, dev: {}, coin: { v: {}, l: {}, g: {}, k: {} }, props: {}, size: HEART.sizeStart, can: HEART.sizeStart, p0: startOf(B(s.sun.sold)), avg: spotPrice(s) * 1000, out: {}, day: dayOf(s), hold: 0, owe: { v: 0, l: 0, g: 0, k: 0, b: 0 } };
	for (const k of keysOf(s.nodes ?? {})) s.nodes![k] = { ...s.nodes![k], on: HOUR, ch: chainHour(s) }; // everyone whose node has checked in before starts with an hour
	for (const a of anchors) (s.nodes ??= {})[a] = { ...(own(s.nodes, a) ? s.nodes[a] : { at: time }), on: served, ch: chainHour(s) };
	delete s.crew; // drawn again at once, by the new rules
}

/** at the end of the block before the first: thousandths of an hour become seconds, for every clock and where every stake began on it */
export function startTime(s: State, height: number) {
	if (!s.heart || s.heart.sec || height + 1 < timeFrom(s.chain)) return;
	const sec = (n: number) => Math.floor((n * 18) / 5);
	for (const k of keysOf(s.nodes ?? {})) { const { ch: _ch, ...n } = s.nodes![k]; s.nodes![k] = n.on === undefined ? n : { ...n, on: sec(n.on) }; }
	for (const k of keysOf(s.stakes ?? {})) if (s.stakes![k].since) s.stakes![k] = { ...s.stakes![k], since: sec(s.stakes![k].since!) };
	for (const k of keysOf(s.backed ?? {})) s.backed![k] = sec(s.backed![k]);
	s.heart.sec = 1; delete s.crew;
}
/** Who may say that something happened outside this chain (a payment, a vault, a price, who won): the validators, and always
    the anchors while they have a stake. It counts with more than two thirds of the say, as before, AND (the time rules) at
    least one anchor among them, while any has a stake. The checkers cannot see outside this chain: without this, whoever
    gathered two thirds of the say could confirm payments that never happened, and be given DZY and coins for them. */
export const vouchers = (s: State): string[] => (s.heart?.sec ? s.heart.anchors.filter((a) => !!s.stakes && own(s.stakes, a) && s.stakes[a].bond > 0 && !s.stakes[a].tomb) : []);
export const mayVouch = (s: State, a: string) => s.validators.includes(a) || vouchers(s).includes(a);
export const vouched = (s: State, votes: readonly string[]) => { const v = vouchers(s); return !v.length || votes.some((a) => v.includes(a)); };

/* ---------- time online ----------
   nodes[a].on: all the time this key has served, in thousandths of an hour. It grows by one hour in each chain hour the key
   checks in (chain hours pass only while blocks are made, so nobody pays for the chain standing still). Every stake
   remembers where that clock stood when it was put there (its "from"); its own hours are the difference. */
const HOUR = 1000;
export const chainHour = (s: State) => Math.floor(s.sun!.minute / 60);
const onOf = (s: State, a: string) => (s.nodes && own(s.nodes, a) ? s.nodes[a].on ?? 0 : 0);
/** the clock after a check-in now */
export function clockAfter(s: State, was: { on?: number; ch?: number; at?: number } | null, time: number): { on: number; ch?: number } {
	if (s.heart!.sec) { // every second since the last check-in, if that was lately; time away costs four times itself
		const gone = was?.at === undefined ? 0 : Math.max(0, Math.floor((time - was.at) / 1000));
		return { on: gone <= TIME.window ? (was?.on ?? 0) + gone : Math.max(0, (was?.on ?? 0) - TIME.awayCost * (gone - TIME.window)) };
	}
	const ch = chainHour(s);
	if (!was || was.ch === undefined) return { on: (was?.on ?? 0) + HOUR, ch };
	const gone = ch - was.ch;
	if (gone <= 0) return { on: was.on ?? 0, ch: was.ch };
	return { on: Math.max(HOUR, (was.on ?? 0) + HOUR - HEART.awayCost * HOUR * (gone - 1)), ch };
}
/** stake `added` joins `had` (which counts from `from`): together they count from the average, weighted by amount, rounded up */
const blend = (had: number, from: number, added: number, now: number) => (had ? N((B(had) * B(from) + B(added) * B(now) + B(had + added) - 1n) / B(had + added)) : now);
/** own stake was added (call before the bond changes) */
export function bondAdded(s: State, a: string, amount: number) {
	if (!s.heart) return;
	const st = s.stakes && own(s.stakes, a) ? s.stakes[a] : null;
	const from = blend(st?.bond ?? 0, st?.since ?? 0, amount, onOf(s, a));
	return (x: { since?: number }) => { if (from) x.since = from; else delete x.since; };
}
/** a holder backs `v` with more (call before the delegation changes) */
export function backAdded(s: State, v: string, who: string, amount: number) {
	if (!s.heart) return;
	const k = v + ':' + who, had = s.delegations && own(s.delegations, v) && own(s.delegations[v], who) ? s.delegations[v][who] : 0;
	const from = blend(had, s.backed && own(s.backed, k) ? s.backed[k] : 0, amount, onOf(s, v));
	if (from) (s.backed ??= {})[k] = from;
}
export function backGone(s: State, v: string, who: string) { if (s.backed) { delete s.backed[v + ':' + who]; if (emptyOf(s.backed)) delete s.backed; } }

const hoursFrom = (s: State, on: number, from: number) => Math.min(s.heart?.sec ? TIME.full : HEART.fullHours * HOUR, Math.max(0, on - from));
/** the hours behind a validator's own stake, in thousandths */
export const ownHours = (s: State, a: string) => { const st = s.stakes && own(s.stakes, a) ? s.stakes[a] : null; return st?.bond ? hoursFrom(s, onOf(s, a), st.since ?? 0) : 0; };
/** a validator's power: the DZY behind it times the hours each part has served, in thousandths of a DZY-hour (fine enough that
    sixty small newcomers under the limit still each get theirs) */
export function stakeTime(s: State, a: string): bigint {
	const st = s.stakes && own(s.stakes, a) ? s.stakes[a] : null, on = onOf(s, a);
	let sum = B(st?.bond ?? 0) * B(hoursFrom(s, on, st?.since ?? 0));
	const m = s.delegations && own(s.delegations, a) ? s.delegations[a] : null;
	if (m) for (const k of Object.keys(m)) sum += B(m[k]) * B(hoursFrom(s, on, s.backed && own(s.backed, a + ':' + k) ? s.backed[a + ':' + k] : 0));
	return sum / B(DZY);
}
export const isProven = (s: State, a: string) => (s.heart?.sec ? ownHours(s, a) >= TIME.proven && weightOf(s, a) >= TIME.stake : ownHours(s, a) >= HEART.provenHours * HOUR && weightOf(s, a) >= HEART.provenStake);

/* ---------- the raffle ---------- */
const hash = (text: string) => { const b = sha256Sync(new TextEncoder().encode(text)); let h = ''; for (const x of b) h += x.toString(16).padStart(2, '0'); return h; };
const pick = (seed: string, total: bigint) => B('0x' + hash(seed)) % total;
/** Every validator's power after the newcomers' limit: [address, power], the trusted first. */
function limited(s: State, cands: string[], open: boolean): { trusted: [string, bigint][]; fresh: [string, bigint][] } {
	const anchors = new Set(s.heart!.anchors), trusted: [string, bigint][] = [];
	let fresh: [string, bigint][] = [];
	for (const a of cands) {
		const p = stakeTime(s, a), ok = open ? isProven(s, a) : anchors.has(a);
		if (ok) trusted.push([a, p > 0n ? p : 1n]); else fresh.push([a, p]);
	}
	const T = trusted.reduce((n, [, p]) => n + p, 0n), U = fresh.reduce((n, [, p]) => n + p, 0n);
	if (s.heart!.sec && !open && trusted.length) return { trusted, fresh: othersSay(s, T, fresh) };
	if (trusted.length && U * 3n > T) fresh = fresh.map(([a, p]) => [a, p * (T / 3n) / U]); // together at most a third of the trusted: a quarter of all
	fresh = fresh.filter(([, p]) => p > 0n);
	if (!trusted.length && !fresh.length) fresh = cands.map((a) => [a, 1n]);
	return { trusted, fresh };
}
/** The time rules, before the others have 250,000 DZY: the anchors' power, and what everyone else's comes to beside it. */
function othersSay(s: State, T: bigint, list: [string, bigint][]): [string, bigint][] {
	const proven = list.filter(([a]) => isProven(s, a)), set = new Set(proven.map(([a]) => a)), R = proven.reduce((n, [, p]) => n + p, 0n);
	let fresh = list.filter(([a]) => !set.has(a)); const U = fresh.reduce((n, [, p]) => n + p, 0n);
	if (U * 3n > T + R) fresh = fresh.map(([a, p]) => [a, p * ((T + R) / 3n) / U]); // the not yet proven: at most a quarter of all
	const all = [...proven, ...fresh], sum = all.reduce((n, [, p]) => n + p, 0n);
	const P = B(proven.reduce((n, [a]) => n + weightOf(s, a), 0)), W = B(TIME.whole), [up, down] = proven.length >= TIME.min && P * 4n > W ? [P, W - P] : [1n, 3n]; // the others' share, as share : what is left
	const most = (T * up) / down; // (down is above 0: at the whole of it, the anchors have no special part any more)
	return (sum > most ? all.map(([a, p]): [string, bigint] => [a, (p * most) / sum]) : all).filter(([, p]) => p > 0n);
}
/** the crew of the period: everyone while there are crewMin or fewer, each with its power; else a fair sample by power.
    The sample walks the whole line of powers in equal steps from a drawn start, so a holder of a quarter of the power
    gets a quarter of the seats (give or take one), never by luck a third. */
export function drawHeartCrew(s: State, time: number, epoch: number): { validators: string[]; powers: Record<string, number>; seed: string } | null {
	const h = s.heart!, anchors = h.anchors.filter((a) => isCandidate(s, a));
	const online = keysOf(s.stakes ?? {}).filter((a) => isCandidate(s, a) && isOnline(s, a, time) && (h.anchors.includes(a) || (s.nodes![a].url !== undefined && s.stakes![a].bond >= (s.nodes![a].seat ?? 0))));
	const others = online.filter((a) => !h.anchors.includes(a) && isProven(s, a));
	const open = others.length >= (h.sec ? TIME.min : HEART.provenMin) && others.reduce((n, a) => n + weightOf(s, a), 0) >= (h.sec ? TIME.whole : HEART.provenTotal);
	const cands = [...new Set(open ? online : [...online, ...anchors])].sort(); // until then the anchors are always in: nobody takes over because a check-in was late
	if (!cands.length) return null;
	if (open) h.open = true; else delete h.open;
	const { trusted, fresh } = limited(s, cands, open), seed = hash(`dznye-crew:${s.sun?.btc?.hash ?? s.last}:${epoch}`);
	const powers: Record<string, number> = {}, all = [...trusted, ...fresh];
	if (all.length <= LEDGER.crewMin) for (const [a, p] of all) powers[a] = N(p);
	else {
		const size = Math.min(LEDGER.crewMax, Math.max(LEDGER.crewMin, Math.ceil(all.length * LEDGER.crewShareBp / 10_000)));
		const line = all.map(([a, p]): [string, bigint] => [a, p * B(size)]), W = line.reduce((n, [, p]) => n + p, 0n), step = W / B(size); // each power x size: the step is a whole number
		let next = pick(seed + ':start', step), upto = 0n;
		for (const [a, p] of line) { upto += p; let n = 0; while (next < upto) { n++; next += step; } if (n) powers[a] = n; }
	}
	h.can = canTake(s, powers);
	return { validators: Object.keys(powers).sort(), powers, seed };
}
/** the biggest block that validators with sizeBp of the say declared they can take (one that declares nothing: sizeStart) */
function canTake(s: State, powers: Record<string, number>): number {
	const by = Object.keys(powers).map((a): [number, bigint] => [s.nodes && own(s.nodes, a) ? s.nodes[a].big ?? HEART.sizeStart : HEART.sizeStart, B(powers[a])]).sort((x, y) => y[0] - x[0]);
	const all = by.reduce((n, [, p]) => n + p, 0n);
	let got = 0n;
	for (const [big, p] of by) { got += p; if (got * 10_000n >= all * B(HEART.sizeBp)) return big; }
	return HEART.sizeStart;
}
/** what it costs (in stake) to take a place among the block makers now: 1 DZY x (1 + places taken / seatStep)^2 */
export function seatEntry(s: State, who: string, time: number = s.time): number {
	let n = 0;
	for (const a of keysOf(s.stakes ?? {})) if (a !== who && isCandidate(s, a) && isOnline(s, a, time) && s.nodes![a].url !== undefined && !(s.heart?.proof && s.heart.anchors.includes(a))) n++; // (the proof rules: the anchors' own places are not counted, so the first to join pays 69)
	if (s.heart?.sec) { const d = TIME.seatDouble; return N((B(TIME.stake) * (1n << B(Math.min(20, Math.floor(n / d)))) * B(d + (n % d))) / B(d)); } // evenly between one doubling and the next
	return N((B(DZY) * B(HEART.seatStep + n) * B(HEART.seatStep + n)) / B(HEART.seatStep * HEART.seatStep));
}
/** a node with a public address checks in: the price of its place, as it was when it joined (or now, if it is new or was away long) */
export function seatFor(s: State, who: string, was: { url?: string; at: number; seat?: number } | null, time: number): number {
	if (was?.seat !== undefined && was.url !== undefined && time - was.at <= HEART.seatKeep) return was.seat;
	if (s.heart!.anchors.includes(who)) return 0;
	const price = was?.url !== undefined && was.seat === undefined ? DZY : seatEntry(s, who, time); // who made blocks before the upgrade keeps 1 DZY
	if ((s.stakes?.[who]?.bond ?? 0) < price) fail(`a place among the block makers takes ${price / DZY} DZY staked now (without a public address, a node checks for 1 DZY)`);
	return price;
}
/** whose turn: drawn by power for this height and round (the validators and powers as they stand before the block) */
export function turnFor(validators: readonly string[], power: Record<string, number>, seed: string, height: number, round: number): string {
	let W = 0n;
	for (const v of validators) W += B(power[v] ?? 0);
	if (W <= 0n) return validators[(height + round) % validators.length];
	let x = pick(`dznye-turn:${seed}:${height}:${round}`, W);
	for (const v of validators) { x -= B(power[v] ?? 0); if (x < 0n) return v; }
	return validators[validators.length - 1];
}
/** a validator missed its turn: a day of its hours, at most half of them (one slow moment does not put a newcomer out) */
export function missed(s: State, a: string) {
	if (!s.nodes || !own(s.nodes, a)) return;
	const n = s.nodes[a]; s.nodes[a] = { ...n, on: Math.max(Math.floor((n.on ?? 0) / 2), (n.on ?? 0) - (s.heart!.sec ? TIME.miss : HEART.missCost * HOUR)) };
}
/** may this key be benched? Not an anchor, while the anchors still carry the chain */
export const benchable = (s: State, a: string) => !!s.heart!.open || !s.heart!.anchors.includes(a);

/* ---------- fees ---------- */
const part = (n: number, bp: number) => N((B(n) * B(bp)) / 10_000n);
/** one fee in five parts; what rounding leaves goes to the backing */
export function splitFee(n: number) {
	const v = part(n, HEART.validatorsBp), l = part(n, HEART.leastBp), g = part(n, HEART.contributorsBp), k = part(n, HEART.lockersBp);
	return { v, l, g, k, backing: n - v - l - g - k };
}
/** a minute's DZY fees in five parts, exact over time: a shard nobody is owed whole yet waits (a quiet chain's fees are a
    shard a minute: without this, rounding would give all of it to one part) */
export function splitCarry(s: State, n: number) {
	const h = s.heart!, bp = { v: HEART.validatorsBp, l: HEART.leastBp, g: HEART.contributorsBp, k: HEART.lockersBp, b: HEART.backingBp }, out = { v: 0, l: 0, g: 0, k: 0, b: 0 };
	h.hold += n;
	for (const p of ['v', 'l', 'g', 'k', 'b'] as const) {
		const t = B(h.owe[p]) + B(n) * B(bp[p]);
		out[p] = N(t / 10_000n); h.owe[p] = N(t % 10_000n); h.hold -= out[p];
	}
	return out;
}
const addTo = (m: Coins, c: string, n: number) => { if (n) m[c] = (own(m, c) ? m[c] : 0) + n; };
/** a fee the exchange took in `coin`: returns what is left for the pot (the backing) */
export function coinFee(s: State, coin: string, n: number): number {
	if (!s.heart || n <= 0) return n;
	const x = splitFee(n), c = s.heart.coin;
	addTo(c.v, coin, x.v); addTo(c.l, coin, x.l); addTo(c.g, coin, x.g); addTo(c.k, coin, x.k);
	return x.backing;
}
/** coin the split holds, by coin (it is still in the vaults: owed to people) */
export function heartCoin(s: State): Coins { const t: Coins = {}; if (s.heart) for (const m of Object.values(s.heart.coin)) for (const [c, n] of Object.entries(m)) addTo(t, c, n); return t; }
/** DZY the split holds */
export const heartHeld = (s: State) => (s.heart ? s.heart.least + s.heart.grants + s.heart.hold : 0);

/** one amount to several, by weight; what whole units leave over stays (returned) */
export function share(amount: number, weights: [string, bigint][], give: (a: string, n: number) => void): number {
	const W = weights.reduce((n, [, w]) => n + w, 0n);
	if (!amount || W <= 0n) return amount;
	let left = amount;
	for (const [a, w] of weights) { const n = N((B(amount) * w) / W); if (n) { give(a, n); left -= n; } }
	return left;
}
/** the keys online in checkerMinHours or more hours since the last pay day that made fewer blocks than their stake x time's
    fair share (the raffle passed them by, or they only check), with their stake x time. Measured against one's own stake x
    time, never by rank: a crowd of tiny keys cannot fill the bottom places and push real ones out of the pay */
export function leastWorking(s: State, work: Record<string, number>): [string, bigint][] {
	const on: string[] = [];
	for (const k of keysOf(s.nodes ?? {})) {
		const n = peek(s.nodes!, k) as { hrs?: number };
		if ((n.hrs ?? 0) >= LEDGER.checkerMinHours && isCandidate(s, k)) on.push(k);
	}
	const all = on.sort().map((k): [string, bigint] => [k, stakeTime(s, k)]), W = all.reduce((n, [, w]) => n + w, 0n), done = B(on.reduce((n, k) => n + (work[k] ?? 0), 0));
	return all.filter(([k, w]) => B(work[k] ?? 0) * W < done * w);
}
/** the chain day now, with a seed nobody chooses (the newest Bitcoin block the chain holds) */
export const dayOf = (s: State): [number, string] => { const day = Math.floor(s.sun!.minute / 1440); return [day, hash(`dzy-day:${day}:${s.sun!.btc?.hash ?? s.last}`)]; };
/** what the contributors' fund holds of an asset */
export const grantOf = (h: HeartState, asset: string) => (asset === 'DZY' ? h.grants : own(h.coin.g, asset) ? h.coin.g[asset] : 0);
/** pay today's contract makers: each at most devBp of the fees its own contracts brought, all together at most what waits */
export function payMakers(s: State, give: (a: string, n: number) => void) {
	const h = s.heart!, want: [string, number][] = Object.keys(h.dev).sort().map((a) => [a, part(h.dev[a], HEART.devBp)]), sum = want.reduce((n, [, x]) => n + x, 0);
	for (const [a, x] of want) { const n = sum > h.grants ? N((B(h.grants) * B(x)) / B(sum)) : x; if (n) give(a, n); }
	h.dev = {};
}

/* ---------- what anyone may see ---------- */
/** how much of the say the others may have now, in basis points (the time rules) */
const othersNow = (s: State) => { const p = keysOf(s.stakes ?? {}).filter((a) => !s.heart!.anchors.includes(a) && isCandidate(s, a) && isProven(s, a)), P = p.reduce((n, a) => n + weightOf(s, a), 0); return { proven: p.length, dzy: P / DZY, shareBp: s.heart!.open ? 10_000 : p.length >= TIME.min ? Math.max(2_500, Math.floor((P / TIME.whole) * 10_000)) : 2_500 }; };
export function heartView(s: State) {
	const from = heartFrom(s.chain), rules = { ...HEART, priceDouble: N(HEART.priceDouble), aboveBacking: N(HEART.aboveBacking) };
	if (!s.heart) return { on: false, from: Number.isFinite(from) ? from : null };
	const power = s.crew?.powers ?? {}, total = Object.values(power).reduce((a, b) => a + b, 0);
	return {
		on: true, ...s.heart, rules, timeFrom: Number.isFinite(timeFrom(s.chain)) ? timeFrom(s.chain) : null, time: s.heart.sec ? { ...TIME, others: othersNow(s) } : null, price: spotPrice(s), payPrice: payPrice(s), nextPlace: seatEntry(s, ''), totalPower: total, seed: s.crew?.seed ?? null,
		validators: keysOf(s.stakes ?? {}).filter((a) => isCandidate(s, a)).map((a) => ({
			address: a, stake: weightOf(s, a), hours: Math.floor(ownHours(s, a) / (s.heart!.sec ? 360 : 100)) / 10, dzyHours: N(stakeTime(s, a) / B(s.heart!.sec ? 3_600 : HOUR)), ...(s.heart!.sec ? { seconds: ownHours(s, a), shards: N(stakeTime(s, a)) } : {}), proven: isProven(s, a), anchor: s.heart!.anchors.includes(a),
			power: power[a] ?? 0, chancePct: total && power[a] ? Math.round((power[a] / total) * 10_000) / 100 : 0,
		})),
	};
}
