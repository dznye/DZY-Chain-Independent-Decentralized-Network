import { canon, isAddrHex, sha256 } from './crypto.ts';
// @ts-ignore: plain JavaScript, shared with the tested model (chain/v2/econ.mjs) so the two can never drift apart
import { BP, DAY, DECIMALS, IDX, RULES as R, SUB, SUPPLY as SUPPLY_B, TICK, YEAR, bufferFor, feeNext, moneyGrowthBp, nextFloor, nextRate, policyTarget, seatWeight, ticketsFor, useGapBp, wageSub } from '../v2/rules.mjs';
// @ts-ignore
import { saleCost, salePrice, saleUnitsFor } from '../v2/sale.mjs';
import { creditCoin, crewOn, exchangeOn, powers, RULES as LEDGER, weightOf, type State } from './ledger.ts';
import { dayOf, feeFloor, fullness, heartHeld, leastWorking, mayVouch, vouched, payMakers, priceMinute, share, sizeAfter, splitCarry, spotPrice, stakeTime } from './heart.ts';
import { keysOf, peek } from './layer.ts';
import { checkHeader } from './btc.ts';

/* The Sun: the Dznye chain's own economy, on a chain whose genesis chose it (State.sun). Formula for formula it is the
   economy tested first in chain/v2/econ.mjs; chain/economy.test.mjs runs both side by side and requires every number
   to be identical every minute.

   - All 12,000,000 DZY exist from the first block: 9,000,000 in the Sun (State.treasury), 3,000,000 for sale. Nobody
     holds a key that can make or destroy any, or pay the Sun out: it moves only by these formulas.
   - Every chain minute (a minute in which a block was made) the chain's profit = fees released (1/1,440 of the fee pot)
     + the Sun's drip (5% a year of the Sun, times the share of all DZY in people's hands). 40% is raffled among
     lockers who answer when they win; 10% goes to DZY left untouched (the deposit); 50% stays in the Sun.
   - Every DZY credit and debit to a person's account goes through receive() or spend(), so the deposit's clocks always
     match the balance.
   Amounts are whole shards (1 DZY = 10^8) kept as ordinary numbers (all 12,000,000 DZY are 1.2 x 10^15 shards, inside
   what numbers hold exactly); anything that could grow past that (running totals, clocks) is a BigInt, stored as text. */

const B = BigInt, N = Number, ZERO3 = () => [0, 0, 0];
const T: bigint[] = R.tiers;
export const SUN_SUPPLY = N(SUPPLY_B);
export const MAX_SUN_LOCKS = 16;

export interface SunLock { id: string; amt: number; w: number; end: number }
export interface LockAcct { weight: number; benched: boolean; wh: [number, number][]; list: SunLock[] } // wh: the weight that took part, minute by minute, for the last hour or so
export interface Deposit { M: number[]; P: number[]; s: (string | null)[]; pend: (number | null)[]; dw: number; dsnap: string; rem: string; last: number | null; eligible: boolean; renewPend: number | null; won: number; held: number }
export type SunEvent = { k: 'unlock'; a: string; id: string } | { k: 'step'; a: string; i: number } | { k: 'renew'; a: string } | { k: 'credit'; a: string };
/** the council fund: validators paid like a fair job (rules.mjs: councilBp, wageBp, bonusBp). inc: its income on each of the last days */
export interface Council { fund: number; owed: string; bonus: number; last: string; today: number; inc: number[]; pot?: number } // pot: the crew upgrade's wage of the day, paid at its end by work
/** the chain's own central bank, once a chain day: the fee floor (the commission) and the policy rate (the Taylor rule).
    M: DZY in people's hands at the end of each of the last days; use: [transactions, blocks] of each of the last days */
export interface Fed { floor: number; rate: number; M: number[]; tx: number; blocks: number; use: [number, number][]; growth: number; useGap: number; target: number; buffer: number }
/** one account's starter credit: what it has used, repaid, when it took it and at what rate, when it is due */
export interface Credit { used: number; paid: number; at: number; due: number; rate: number; name?: string; closed?: boolean }
export interface CreditBook { budget: number; sub: string; day: number; today: number; out: Record<string, Credit>; bad: Record<string, number> }
export interface Round { prize: number; k: number; W: number; at?: number; winners?: (string | null)[]; bh?: number; src?: string } // bh: the Bitcoin tip when the round was made; src: what it was drawn from (btc:<height> or own)
/** the newest Bitcoin headers the chain holds: the tip, and the last BTC_RECENT heights and hashes (for draws and re-orgs) */
export interface BtcTip { height: number; hash: string; time: number; recent: [number, string][] }
const BTC_MAX = 10, BTC_RECENT = 288, BTC_PAST = 3 * 3_600_000, BTC_FUTURE = 2 * 3_600_000;
export interface GenesisSale { to: string; units: number; paid: number; proof: string; lockYears?: number }
export interface SunState {
	minute: number; stamp: number; seedWait: number;
	salePot: number; sold: number; sales: GenesisSale[]; L: number; // L: all DZY locked, kept as a running total (the price of a seat needs it at once)
	feePot: number; valPool: number; valOwed: string; roundPot: number; W: number; N: number;
	holdPool: number; holdOwed: string; holdIdx: string; HW: number;
	welcome: { budget: number; sub: string }; backstop: { budget: number; sub: string };
	locks: Record<string, LockAcct>; deposits: Record<string, Deposit>;
	events: Record<string, SunEvent[]>; rounds: Record<string, Round>;
	btc?: BtcTip; // the newest Bitcoin headers anyone has posted (sun.btc): the raffle's randomness
	claims: Record<string, Claim>;  // purchases waiting for the validators to confirm the burned dollars, by "<net>:<payment id>"
	paid: Record<string, { to: string; usd: number; units: number }>; // every payment ever credited, so none counts twice
	council: Council; fed: Fed; credit: CreditBook;
	worked: Record<string, number>; // each validator: the last chain minute it made a block
	work?: Record<string, number>; // the crew upgrade: blocks each validator made today (pay by work)
	free: Record<string, [number, number]>; // each locker: [chain day, free transactions used that day]
}

const fail = (m: string): never => { throw new Error(m); };
const own = (o: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(o, k);
const sunOf = (s: State) => s.sun as SunState;
const sunBal = (s: State) => s.treasury ?? 0;
const setSun = (s: State, n: number) => { if (n < 0) fail('the Sun cannot go below zero'); if (n) s.treasury = n; else delete s.treasury; };

/* ---------- balances, exactly as the rest of the chain keeps them ---------- */
const balOf = (s: State, a: string) => (own(s.accounts, a) && own(s.accounts[a].bal, 'DZY') ? s.accounts[a].bal.DZY : 0);
function setBal(s: State, a: string, n: number) {
	if (!own(s.accounts, a)) s.accounts[a] = { nonce: 0, bal: {} };
	if (n) s.accounts[a].bal.DZY = n; else delete s.accounts[a].bal.DZY;
}

/* ---------- the deposit (the same functions as econ.mjs, name for name) ---------- */
function dep(s: State, a: string): Deposit {
	const u = sunOf(s);
	if (!own(u.deposits, a)) u.deposits[a] = { M: ZERO3(), P: ZERO3(), s: [null, null, null], pend: [null, null, null], dw: 0, dsnap: u.holdIdx, rem: '0', last: null, eligible: false, renewPend: null, won: 0, held: 0 };
	return u.deposits[a];
}
const crossOf = (d: Deposit, k: number) => B(d.s[k] as string) + T[k] * TICK;
const depositWeight = (d: Deposit) => (d.eligible ? d.M[0] + d.M[1] + d.M[2] : 0);
function refresh(s: State, d: Deposit) { const w = depositWeight(d), u = sunOf(s); u.HW += w - d.dw; d.dw = w; }
function schedule(s: State, m: number, ev: SunEvent) { (sunOf(s).events[String(m)] ??= []).push(ev); }
function scheduleSteps(s: State, a: string, d: Deposit) {
	T.forEach((_, k) => {
		if (d.pend[k] !== null || d.P[k] === 0) return;
		const at = N((crossOf(d, k) + TICK - 1n) / TICK);
		if (at > sunOf(s).minute) { d.pend[k] = at; schedule(s, at, { k: 'step', a, i: k }); }
	});
}
function mature(s: State, d: Deposit) {
	const now = B(sunOf(s).minute) * TICK;
	T.forEach((_, k) => { if (d.P[k] && crossOf(d, k) <= now) { d.M[k] += d.P[k]; d.P[k] = 0; d.s[k] = null; } });
}
/** what a deposit has earned since it last changed, with the fraction of a unit it carries (never lost to rounding) */
const owedOf = (s: State, d: Deposit) => B(d.dw) * (B(sunOf(s).holdIdx) - B(d.dsnap)) + B(d.rem);
const pendingReward = (s: State, d: Deposit) => N(owedOf(s, d) / IDX);
function joinAtMaturity(s: State, a: string, d: Deposit, e: number) { // a deposit reward joins at the deposit's own maturity: it restarts nothing
	const bal = balOf(s, a);
	d.M.forEach((m, k) => { const p = d.P[k], toM = p === 0 ? e : m === 0 ? 0 : N(B(e) * B(m) / B(bal)); d.M[k] += toM; d.P[k] += e - toM; });
	setBal(s, a, bal + e);
}
function settle(s: State, a: string): Deposit {
	const u = sunOf(s), d = dep(s, a);
	if (d.dw) { const owed = owedOf(s, d), e = N(owed / IDX); d.rem = String(owed - B(e) * IDX); if (e) { joinAtMaturity(s, a, d, e); u.holdPool -= e; d.held += e; } }
	d.dsnap = u.holdIdx;
	mature(s, d); refresh(s, d); scheduleSteps(s, a, d);
	return d;
}
function blendIn(s: State, a: string, d: Deposit, amt: number) { // new DZY waits for every step on its own clock
	if (amt === 0) return;
	const now = B(sunOf(s).minute) * TICK;
	d.P.forEach((p, k) => { d.s[k] = String(p === 0 ? now : (B(p) * B(d.s[k] as string) + B(amt) * now) / B(p + amt)); d.P[k] = p + amt; });
	setBal(s, a, balOf(s, a) + amt);
}
/** DZY arrives in a person's account (from anyone or anything) */
export function receive(s: State, a: string, amt: number) { amt = repayCredit(s, a, amt); const d = settle(s, a); blendIn(s, a, d, amt); refresh(s, d); scheduleSteps(s, a, d); }
/** DZY leaves a person's account for anything but a fee: its deposit starts again */
export function spend(s: State, a: string, amt: number) {
	const d = settle(s, a), bal = balOf(s, a);
	if (bal < amt) fail('not enough DZY');
	setBal(s, a, bal - amt);
	const left = bal - amt, now = String(B(sunOf(s).minute) * TICK);
	d.M = ZERO3(); d.P = [left, left, left]; d.s = left ? [now, now, now] : [null, null, null];
	refresh(s, d); scheduleSteps(s, a, d);
}
/** a fee: from the waiting parts first, and it restarts nothing */
function payFee(s: State, a: string, fee: number) {
	const d = settle(s, a), bal = balOf(s, a);
	if (bal < fee) fail('not enough DZY for the fee');
	d.P.forEach((p, k) => { const fromP = p < fee ? p : fee; d.P[k] -= fromP; d.M[k] -= fee - fromP; });
	setBal(s, a, bal - fee); refresh(s, d);
}
/** the account signed something: its deposit earns for another year */
function touch(s: State, a: string) {
	const u = sunOf(s), d = settle(s, a);
	d.eligible = true; d.last = u.minute; refresh(s, d);
	if (d.renewPend === null) { d.renewPend = u.minute + N(R.renewMinutes); schedule(s, d.renewPend, { k: 'renew', a }); }
}

/* ---------- locks and who takes part in the raffle ---------- */
function lk(s: State, a: string): LockAcct { const u = sunOf(s); if (!own(u.locks, a)) u.locks[a] = { weight: 0, benched: false, wh: [], list: [] }; return u.locks[a]; }
const lockedOf = (s: State, a: string) => (own(sunOf(s).locks, a) ? sunOf(s).locks[a].list.reduce((n, l) => n + l.amt, 0) : 0);
const horizon = (s: State) => sunOf(s).seedWait + N(R.answerMinutes) + 2;
function mark(s: State, x: LockAcct) {
	const m = sunOf(s).minute, w = x.benched ? 0 : x.weight, last = x.wh.at(-1);
	if (last && last[0] === m) last[1] = w; else x.wh.push([m, w]);
	while (x.wh.length > 1 && x.wh[1][0] <= m - horizon(s)) x.wh.shift();
	if (x.wh.length === 1 && x.wh[0][1] === 0 && x.wh[0][0] <= m - horizon(s)) x.wh = [];
}
const activeAt = (x: LockAcct, m: number) => { for (let i = x.wh.length - 1; i >= 0; i--) if (x.wh[i][0] <= m) return x.wh[i][1]; return 0; };
function setWeight(s: State, a: string, add: number) {
	const u = sunOf(s); settle(s, a);
	const x = lk(s, a), was = x.weight;
	x.weight += add;
	if (!x.benched) { u.W += add; if (!was && x.weight) u.N++; if (was && !x.weight) u.N--; }
	mark(s, x);
}
function bench(s: State, a: string) {
	const u = sunOf(s), x = lk(s, a);
	if (x.benched) return;
	settle(s, a); x.benched = true; u.W -= x.weight; if (x.weight) u.N--;
	mark(s, x);
}
/** the price of a seat, now: each unit counts by the share of DZY still circulating as it is locked (rules.mjs seatWeight) */
export function seatNow(s: State, amt: number, years: number) {
	return N(seatWeight(B(amt), B(years), B(SUN_SUPPLY - sunBal(s) - sunOf(s).salePot), B(sunHeld(s).locked)));
}
/** A lock becomes validator stake (ledger.ts lock.stake): out of the lockers' share, its unlock unscheduled. Its DZY stay held to the
    same minute, now as stake: answerable for cheating, never back sooner than the lock promised. Returns what it was. */
export function lockOut(s: State, a: string, id: string): { amt: number; end: number } {
	const u = sunOf(s), x = lk(s, a), i = x.list.findIndex((l) => l.id === id), l = x.list[i];
	setWeight(s, a, -l.w); x.list.splice(i, 1); u.L -= l.amt;
	const k = String(l.end), evs = u.events[k]; if (evs) { const rest = evs.filter((e) => !(e.k === 'unlock' && e.a === a && e.id === id)); if (rest.length) u.events[k] = rest; else delete u.events[k]; }
	return { amt: l.amt, end: l.end };
}
export const lockOf = (s: State, a: string, id: unknown) => (s.sun && own(sunOf(s).locks, a) && typeof id === 'string' ? sunOf(s).locks[a].list.find((l) => l.id === id) ?? null : null);
function addLock(s: State, a: string, id: string, amt: number, years: number, w: number) {
	spend(s, a, amt);
	const end = sunOf(s).minute + years * N(YEAR);
	setWeight(s, a, w); lk(s, a).list.push({ id, amt, w, end }); sunOf(s).L += amt;
	schedule(s, end, { k: 'unlock', a, id });
}

/* ---------- genesis ---------- */
export interface SunGenesis { chain: string; time: number; validators: string[]; seedWait?: number; sales: GenesisSale[] }
const NOBODY = '0'.repeat(64); // an address no key can sign for: DZY's "issuer", so nobody can ever issue any
/** The first state of a chain with the Sun. `sales` are the purchases made before the chain existed, each with its
    public proof: they come out of the sale like any later purchase, never under the opening price, and may start
    locked. Nothing else can put DZY in anyone's hands at genesis. */
export async function sunGenesis(g: SunGenesis): Promise<State> {
	if (!g || typeof g.chain !== 'string' || !/^[a-z0-9-]{3,32}$/.test(g.chain)) fail('bad chain name');
	if (!Number.isSafeInteger(g.time) || g.time < 0) fail('bad start time');
	if (!Array.isArray(g.validators) || !g.validators.length || g.validators.length > 64 || !g.validators.every(isAddrHex) || new Set(g.validators).size !== g.validators.length) fail('a chain needs validators, each a different address');
	const seedWait = g.seedWait ?? N(R.seedWait);
	if (!Number.isSafeInteger(seedWait) || seedWait < 0 || seedWait > 1_440) fail('bad seed wait');
	const zero = '0';
	const s = {
		chain: g.chain, authority: NOBODY, validators: g.validators.slice().sort(), fee: N(R.feeFloor), height: 0, time: g.time, started: 0, pools: {}, last: '',
		accounts: {}, offers: {}, treasury: SUN_SUPPLY - N(R.saleCap),
		assets: { DZY: { symbol: 'DZY', name: 'Dznye', issuer: NOBODY, supply: SUN_SUPPLY, minted: SUN_SUPPLY, mintable: false, decimals: DECIMALS, cap: SUN_SUPPLY } },
		sun: {
			minute: 0, stamp: Math.floor(g.time / 60_000), seedWait, salePot: N(R.saleCap), sold: 0, sales: [], L: 0,
			feePot: 0, valPool: 0, valOwed: zero, roundPot: 0, W: 0, N: 0, holdPool: 0, holdOwed: zero, holdIdx: zero, HW: 0,
			welcome: { budget: 0, sub: zero }, backstop: { budget: 0, sub: zero }, locks: {}, deposits: {}, events: {}, rounds: {}, claims: {}, paid: {},
			council: { fund: 0, owed: zero, bonus: 0, last: '', today: 0, inc: [] },
			fed: { floor: N(R.feeFloor), rate: N(R.rateStartBp), M: [], tx: 0, blocks: 0, use: [], growth: 0, useGap: 0, target: N(R.rateStartBp), buffer: 0 },
			credit: { budget: 0, sub: zero, day: 0, today: 0, out: {}, bad: {} }, worked: {}, free: {},
		} as SunState,
	} as unknown as State;
	const u = sunOf(s);
	for (const [i, sale] of (Array.isArray(g.sales) ? g.sales : fail('bad sales')).entries()) {
		if (!sale || !isAddrHex(sale.to)) fail(`genesis purchase ${i + 1}: bad address`);
		if (!Number.isSafeInteger(sale.units) || sale.units <= 0 || sale.units > u.salePot) fail(`genesis purchase ${i + 1}: more than the sale has left, or nothing`);
		// priced exactly like every later buyer: the area under the sale curve from what is sold so far
		if (!Number.isSafeInteger(sale.paid) || B(sale.paid) < saleCost(R, B(u.sold), B(u.sold + sale.units))) fail(`genesis purchase ${i + 1}: paid less than the sale curve asks`);
		if (typeof sale.proof !== 'string' || !sale.proof || sale.proof.length > 200) fail(`genesis purchase ${i + 1}: needs a proof of payment (up to 200 characters)`);
		const years = sale.lockYears;
		if (years !== undefined && !(Number.isSafeInteger(years) && years >= N(R.minYears) && years <= N(R.maxYears))) fail(`genesis purchase ${i + 1}: lock 1 to ${R.maxYears} whole years`);
		u.salePot -= sale.units; u.sold += sale.units;
		receive(s, sale.to, sale.units);
		if (years !== undefined) {
			const w = seatNow(s, sale.units, years);
			if (w <= 0) fail(`genesis purchase ${i + 1}: too small to count as a lock`);
			addLock(s, sale.to, `g${i + 1}`, sale.units, years, w);
		}
		u.sales.push({ to: sale.to, units: sale.units, paid: sale.paid, proof: sale.proof, ...(years === undefined ? {} : { lockYears: years }) });
	}
	s.last = await sha256('dznye-genesis:' + canon(s));
	return s;
}

/* ---------- what a transaction does to the economy ---------- */
/** would the welcome budget pay this account's fee now? (an account holding some DZY, but less than 100 fees) */
function welcomePays(s: State, a: string, fee: number) {
	const u = sunOf(s);
	const holds = balOf(s, a) + lockedOf(s, a); // an empty account is never helped this way: free transactions for new keys would be free spam
	if (s.x?.index) return false; // the index: the Sun pays nobody's fees any more (they would be DZY with nothing behind them)
	return fee > 0 && holds > 0 && holds < N(R.welcomeTinyFees) * fee && u.welcome.budget >= fee && sunBal(s) >= fee;
}
/** would starter credit pay this account's fee now? (it took credit, cannot pay itself, has credit left, within the budget) */
function creditPays(s: State, a: string, fee: number) {
	return fee > 0 && balOf(s, a) < fee && creditCovers(s, a, fee) && sunOf(s).credit.budget >= fee && sunBal(s) >= fee;
}
/** would the Sun pay this account's fee now: the welcome budget for a tiny account, or its starter credit
    (`lasting`: it adds entries every node must hold for good: the welcome budget never pays for those, or it would be free flooding) */
export function sunPays(s: State, a: string, fee: number, lasting = false) { return (!lasting && welcomePays(s, a, fee)) || creditPays(s, a, fee); }

/* ---------- free transactions for lockers (rules.mjs: freePerDay) ---------- */
/** how many free simple transactions this account has left today: its share of freePerDay by the DZY it has locked */
export function lockFreeLeft(s: State, a: string) {
	if (!s.sun) return 0;
	const u = sunOf(s), mine = lockedOf(s, a);
	if (!mine || !u.L) return 0;
	const day = Math.floor(u.minute / N(DAY)), used = own(u.free, a) && u.free[a][0] === day ? u.free[a][1] : 0;
	return Math.max(0, N(R.freePerDay * B(mine) / B(u.L)) - used);
}
/** one free transaction used */
export function lockFreeUse(s: State, a: string) {
	const u = sunOf(s), day = Math.floor(u.minute / N(DAY)), used = own(u.free, a) && u.free[a][0] === day ? u.free[a][1] : 0;
	u.free[a] = [day, used + 1];
}

/* ---------- starter credit (rules.mjs: creditAmount, creditMinutes, creditPerDay, creditNameMin, creditBp) ---------- */
/** what a credit owes now: what it used, plus the policy rate it was taken at over the time since (until it fell due), less what was repaid */
const creditOwed = (s: State, c: Credit) => c.used + N(B(c.used) * B(c.rate) * B(Math.max(0, Math.min(sunOf(s).minute, c.due) - c.at)) / (BP * YEAR)) - c.paid;
/** can this account's starter credit pay `amt` of fees or charges now? (a name taken on credit has at least creditNameMin characters) */
export function creditCovers(s: State, a: string, amt: number, name?: string) {
	const u = sunOf(s), c = s.sun && own(u.credit.out, a) ? u.credit.out[a] : null;
	if (!c || c.closed || u.minute >= c.due || amt <= 0 || c.used + amt > N(R.creditAmount)) return false;
	return name === undefined || name.length >= N(R.creditNameMin);
}
/** a charge (a name, a token, a contract) paid on credit: it would have gone to the Sun, so nothing moves; it is owed */
export function creditUse(s: State, a: string, amt: number, name?: string) { const c = sunOf(s).credit.out[a]; c.used += amt; if (name !== undefined) c.name = name; }
/** the first DZY an account with credit receives repays it (to the Sun); what is left arrives as usual */
function repayCredit(s: State, a: string, amt: number) {
	const b = sunOf(s).credit;
	if (amt <= 0 || !own(b.out, a)) return amt;
	const c = b.out[a], owe = creditOwed(s, c);
	if (owe <= 0) { if (c.closed || c.used > 0) delete b.out[a]; return amt; }
	const r = Math.min(amt, owe);
	c.paid += r; setSun(s, sunBal(s) + r);
	if (r === owe) delete b.out[a];
	return amt - r;
}
/** when a credit falls due: repaid in full, it is gone; unpaid, it closes, its name is released, and the account never takes credit again */
function creditDue(s: State, a: string) {
	const b = sunOf(s).credit, c = own(b.out, a) ? b.out[a] : null;
	if (!c || c.closed) return;
	if (creditOwed(s, c) <= 0) { delete b.out[a]; return; }
	c.closed = true; b.bad[a] = sunOf(s).minute;
	if (c.name && s.names && own(s.names, c.name) && s.names[c.name] === a) { delete s.names[c.name]; const x = own(s.accounts, a) ? s.accounts[a] : null; if (x && x.name === c.name) delete x.name; }
}
/** a signed transaction from `from`, whose fee is `fee` paid by `payer` (the Sun, when `bySun`): the sender's deposit
    renews, the fee is taken, and it waits in the profit pot. Runs after every check has passed. */
export function charge(s: State, from: string, payer: string, fee: number, bySun: boolean, lasting = false) {
	const u = sunOf(s);
	if (bySun && !lasting && welcomePays(s, payer, fee)) { u.welcome.budget -= fee; setSun(s, sunBal(s) - fee); touch(s, from); }
	else if (bySun) { u.credit.budget -= fee; setSun(s, sunBal(s) - fee); creditUse(s, payer, fee); touch(s, from); } // starter credit
	else { touch(s, from); if (fee) payFee(s, payer, fee); }
	u.feePot += fee;
}
/** part of a fee that is given back (gas a contract did not use) */
export function refund(s: State, payer: string, n: number) { const u = sunOf(s); u.feePot -= n; receive(s, payer, n); }
/** other DZY the chain itself takes (a token's charge, a name, a pool's cut, a penalty) goes straight to the Sun */
export const toSun = (s: State, n: number) => { if (n > 0) setSun(s, sunBal(s) + n); };

/* ---------- buying from the Sun after genesis ----------
   A buyer burns dollar stablecoins on another chain (Solana, or an Ethereum-style chain): sent to an address nobody
   can spend from, with the memo "dzy-sun:<their Dznye address>". The buyer's wallet then TELLS the validators about
   the payment (POST /sun/hint to a node: off the chain, so it costs the chain nothing and fills nothing). Each
   validator checks that exact payment on that chain through its own nodes (dip.ts: final, the right coin, at least
   that amount, to the burn address, with that memo) and confirms it on the chain with sun.attest, naming every detail.
   Once validators with more than two thirds of the say have confirmed the same details, the address in the memo gets
   what the sale curve gives at that moment. Nobody receives the dollars: they are gone for good.
   Only validators write anything here, so nobody can fill the chain with made-up purchases: each validator may have at
   most MAX_PENDING confirmations waiting, and one that is not joined by enough others within a day is dropped. */
export const SUN_BURN: Readonly<Record<string, string>> = Object.freeze({
	sol: '1nc1nerator11111111111111111111111111111111', // Solana's incinerator
	...Object.fromEntries(['eth', 'base', 'arb', 'op', 'polygon', 'bsc', 'avax'].map((n) => [n, '0x000000000000000000000000000000000000dead'])), // the usual dead address
});
/** the dollar coins each chain's adapter can check, all with 6 decimals: an amount is in millionths of a dollar */
export const SUN_DOLLARS: Readonly<Record<string, readonly string[]>> = Object.freeze({ sol: ['USDC', 'USDT'], eth: ['USDC'], base: ['USDC'], arb: ['USDC'], op: ['USDC'], polygon: ['USDC'], bsc: ['USDC'], avax: ['USDC'] });
/** every coin a purchase may be paid in, as the chain's rules accept it: the dollar coins, and each chain's own coin (and
    bitcoin). A coin that is not a dollar is confirmed at its dollar value when paid (the amount is always in millionths of
    a dollar), read by each validator from Chainlink's price feeds on Ethereum; validators confirm only what they can check */
export const SUN_COINS: Readonly<Record<string, readonly string[]>> = Object.freeze({ sol: ['USDC', 'USDT', 'SOL'], eth: ['USDC', 'ETH'], base: ['USDC', 'ETH'], arb: ['USDC', 'ETH'], op: ['USDC', 'ETH'], polygon: ['USDC', 'POL'], bsc: ['USDC', 'BNB'], avax: ['USDC', 'AVAX'], btc: ['BTC'] });
export const sunMemo = (address: string) => 'dzy-sun:' + address;
export const CLAIM_WAIT = 24 * 60 * 60 * 1000; // a confirmation not joined by enough others within a day is dropped
export const MIN_BUY = 1_000_000;  // $1: the smallest purchase, so the validators' work is always for real money
export const MAX_PENDING = 1_000;  // confirmations one validator may have waiting at once
export interface Claim { by: string; net: string; token: string; amount: number; tx: string; at: number; votes: string[] }
const isPaymentId = (net: string, v: unknown): v is string => typeof v === 'string' && (net === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(v) : net === 'btc' ? /^[0-9a-f]{64}$/.test(v) : /^0x[0-9a-f]{64}$/.test(v));
/** A purchase as a buyer describes it (POST /sun/hint) and a validator confirms it: { net, token, amount, tx, to }.
    The reason it cannot be one, or '' when it is well formed. The chain and every node use this same check. */
export function sunBuyProblem(d: unknown): string {
	const p = d as Record<string, unknown> | null;
	if (!p || typeof p !== 'object' || Array.isArray(p)) return 'a purchase is { net, token, amount, tx, to }';
	for (const k of Object.keys(p)) if (!['net', 'token', 'amount', 'tx', 'to'].includes(k)) return `"${k}" is not expected here`;
	if (typeof p.net !== 'string' || !own(SUN_COINS, p.net)) return 'buy with coins burned on Solana, an Ethereum-style chain or Bitcoin: sol, eth, base, arb, op, polygon, bsc, avax or btc';
	if (typeof p.token !== 'string' || !SUN_COINS[p.net].includes(p.token)) return `on that chain, only ${SUN_COINS[p.net].join(' or ')} counts`;
	if (typeof p.amount !== 'number' || !Number.isSafeInteger(p.amount) || p.amount > 1e15) return 'the amount is the dollars burned, in millionths (USDC and USDT have 6 decimals)';
	if (p.amount < MIN_BUY) return 'the smallest purchase is $1';
	if (!isPaymentId(p.net, p.tx)) return 'that is not a payment id on that chain';
	if (!isAddrHex(p.to)) return "to is the Dznye address the payment's memo names";
	return '';
}
/** where one version of a purchase waits: the payment and every detail, so a validator reporting other details cannot
    block the true ones (each version collects its own confirmations) */
const claimKey = (d: { net: string; tx: string; to: string; token: string; amount: number }) => `${d.net}:${d.tx}:${d.to}:${d.token}:${d.amount}`;
/** what a validator must find on the other chain for a waiting purchase (undefined when there is none) */
export function sunPayment(s: State, id: string) {
	const c = s.sun && own(sunOf(s).claims, id) ? sunOf(s).claims[id] : null;
	return c ? { net: c.net, tx: c.tx, to: c.by, token: c.token, amount: c.amount, want: { payTo: SUN_BURN[c.net], token: c.token, amount: c.amount, memo: sunMemo(c.by) } } : undefined;
}
/** drop confirmations that waited a day without enough others joining them (runs as each chain minute passes) */
function dropStale(s: State, time: number) {
	const u = sunOf(s);
	for (const k of Object.keys(u.claims)) if (time - u.claims[k].at >= CLAIM_WAIT) delete u.claims[k];
}

type Handler = (s: State, from: string, d: Record<string, unknown>, id: string, time: number) => () => void;
const only = (d: Record<string, unknown>, ...keys: string[]) => { for (const k of Object.keys(d)) if (!keys.includes(k)) fail(`"${k}" is not expected here`); };
const needSun = (s: State) => { if (!s.sun) fail('this works only on a chain with the Sun'); };
export const SUN_HANDLERS: Record<string, Handler> = {
	/** Post Bitcoin block headers (anyone; free for validators): each with real proof of work, each following the one
	    before, the first following a header the chain holds (or, on a chain that holds none, any), and each recent by the
	    chain's own clock. A branch from an earlier held header (a Bitcoin re-org) is taken only when it reaches higher. */
	'sun.btc'(s, _from, d, _id, time) {
		needSun(s); only(d, 'height', 'headers');
		const hs = Array.isArray(d.headers) && d.headers.length >= 1 && d.headers.length <= BTC_MAX ? (d.headers as unknown[]) : fail(`headers: 1 to ${BTC_MAX} Bitcoin block headers, in order`);
		const h0 = typeof d.height === 'number' && Number.isSafeInteger(d.height) && d.height > 0 ? d.height : fail('height: the Bitcoin height of the first header');
		const u = sunOf(s), tip = u.btc;
		let prev: string | null = null;
		if (tip) {
			if (h0 + hs.length - 1 <= tip.height) fail('the chain already holds Bitcoin headers this high: a branch must reach higher');
			const at = tip.recent.find(([h]) => h === h0 - 1);
			if (!at) fail('these headers do not follow the Bitcoin headers the chain holds: start right after one of them');
			prev = at![1];
		}
		const got: [number, string, number][] = [];
		hs.forEach((hex, i) => {
			const hd = checkHeader(hex) ?? fail(`header ${i + 1} is not a Bitcoin block header with real proof of work`);
			if (prev !== null && hd.prev !== prev) fail(`header ${i + 1} does not follow the one before it`);
			if (hd.time * 1000 < time - BTC_PAST || hd.time * 1000 > time + BTC_FUTURE) fail(`header ${i + 1} is not recent: its time is too far from the chain's clock`);
			got.push([h0 + i, hd.hash, hd.time]); prev = hd.hash;
		});
		return () => {
			const last = got.at(-1)!, recent = (u.btc?.recent ?? []).filter(([h]) => h < h0).concat(got.map(([h, x]): [number, string] => [h, x]));
			u.btc = { height: last[0], hash: last[1], time: last[2], recent: recent.slice(-BTC_RECENT) };
		};
	},
	/** a validator confirms it found this payment on the other chain, with every detail (free for validators) */
	'sun.attest'(s, from, d, _id, time) {
		needSun(s);
		if (exchangeOn(s)) fail('nothing is burned any more: DZY is bought through the exchange, where the coin is held in a vault (EXCHANGE.md)');
		if (!mayVouch(s, from)) fail('only a validator can confirm a payment');
		const why = sunBuyProblem(d); if (why) fail(why);
		const u = sunOf(s), p = d as unknown as { net: string; token: string; amount: number; tx: string; to: string };
		if (u.salePot <= 0) fail('the sale has ended: all 3,000,000 DZY are sold, and burned dollars cannot be given back');
		const paidKey = `${p.net}:${p.tx}`;
		if (own(u.paid, paidKey)) fail('that payment was already counted');
		const key = claimKey(p), c = own(u.claims, key) ? u.claims[key] : null;
		if (c?.votes.includes(from)) fail('this validator already confirmed it');
		if (!c && Object.values(u.claims).filter((x) => x.votes.includes(from)).length >= MAX_PENDING) fail(`this validator already has ${MAX_PENDING} confirmations waiting`);
		const votes = [...(c?.votes ?? []), from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
		if (said * 3 <= all * 2 || !vouched(s, votes)) return () => { u.claims[key] = c ? { ...c, votes } : { by: p.to, net: p.net, token: p.token, amount: p.amount, tx: p.tx, at: time, votes }; }; // not enough of the say yet
		return () => {
			const units = N(saleUnitsFor(R, B(u.sold), B(p.amount))); // the curve's price now: whoever is confirmed first buys first
			u.salePot -= units; u.sold += units;
			if (units) receive(s, p.to, units);
			u.paid[paidKey] = { to: p.to, usd: p.amount, units };
			for (const k of Object.keys(u.claims)) if (k.startsWith(paidKey + ':')) delete u.claims[k]; // every other version of it is done too
		};
	},
	/** take starter credit: an account with no DZY tries the chain on credit (a name, a token, a contract, fees). Free. */
	'credit.take'(s, from, d) {
		needSun(s); only(d);
		const u = sunOf(s), b = u.credit;
		if (own(b.bad, from)) fail('this account did not repay its starter credit, so it cannot take it again');
		if (own(b.out, from)) fail('this account already has starter credit');
		if (balOf(s, from) > 0 || lockedOf(s, from) > 0) fail('starter credit is for an account with no DZY yet');
		const day = Math.floor(u.minute / N(DAY)), today = b.day === day ? b.today : 0;
		if (today >= N(R.creditPerDay)) fail('today\'s starter credit is all taken: try again tomorrow');
		return () => {
			b.day = day; b.today = today + 1;
			b.out[from] = { used: 0, paid: 0, at: u.minute, due: u.minute + N(R.creditMinutes), rate: u.fed.rate };
			schedule(s, u.minute + N(R.creditMinutes), { k: 'credit', a: from });
		};
	},
	/** lock DZY for 1 to 100 whole years: weight = DZY x years, in the raffle from this minute until the lock ends. Nothing unlocks early. */
	lock(s, from, d, id) {
		needSun(s); only(d, 'amount', 'years');
		const amt = d.amount, years = d.years;
		if (typeof years !== 'number' || !Number.isSafeInteger(years) || years < N(R.minYears) || years > N(R.maxYears)) fail(`lock for 1 to ${R.maxYears} whole years`);
		if (typeof amt !== 'number' || !Number.isSafeInteger(amt) || amt <= 0) fail('the amount must be a whole number above zero');
		if (own(sunOf(s).locks, from) && sunOf(s).locks[from].list.length >= MAX_SUN_LOCKS) fail(`at most ${MAX_SUN_LOCKS} locks on one account`);
		if (balOf(s, from) < amt) fail('not enough DZY');
		const w = seatNow(s, amt, years); // worked out before anything moves (the model does the same)
		if (w <= 0) fail('too small to count at today\'s share of DZY circulating: lock more');
		return () => addLock(s, from, id.slice(0, 16), amt, years, w);
	},
	/** a locker that sat out after missing a ticket says it is back */
	'lock.ready'(s, from, d) {
		needSun(s); only(d);
		const u = sunOf(s);
		if (!own(u.locks, from) || !u.locks[from].benched) fail('this account is not sitting out');
		return () => { settle(s, from); const x = u.locks[from]; x.benched = false; u.W += x.weight; if (x.weight) u.N++; mark(s, x); };
	},
	/** sign that the account is alive: its deposit keeps earning for another year. Moves nothing. */
	renew(s, _from, d) { needSun(s); only(d); return () => {}; },
	/** collect a raffle ticket this account won (free) */
	'ticket.answer'(s, from, d) {
		needSun(s); only(d, 'round', 'n');
		const u = sunOf(s);
		const r = typeof d.round === 'string' && /^\d{1,15}$/.test(d.round) && own(u.rounds, d.round) ? u.rounds[d.round] : fail('no such round (or its time to answer has passed)');
		const n = d.n;
		if (!r.winners) fail('no such ticket yet: this round has not been drawn');
		if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n >= r.winners!.length || r.winners![n] === null) fail('no such ticket (or it was already collected)');
		if (r.winners![n as number] !== from) fail('this ticket is not yours');
		return () => { r.winners![n as number] = null; u.roundPot -= r.prize; receive(s, from, r.prize); dep(s, from).won += r.prize; };
	},
};

/* ---------- every chain minute ---------- */
async function resolve(s: State, m: string, from?: { seed: string; src: string }) { // draw a round's winners from the lockers as they stood in its own minute
	const u = sunOf(s), r = u.rounds[m], at = N(m), list: [number, string][] = [];
	let c = 0;
	for (const a of keysOf(u.locks).sort()) { const w = activeAt(peek(u.locks, a) as LockAcct, at); if (w) { c += w; list.push([c, a]); } } // read only: nothing copied (layer.ts)
	if (c !== r.W) fail(`round ${m}: the lockers' weight does not add up`); // cannot happen; a node that sees it must stop, not guess
	const seed = await sha256(from ? `${from.seed}:${m}` : `dznye-own:${s.last}:${m}`), winners: string[] = [];
	for (let n = 0; n < r.k; n++) {
		const x = N(B('0x' + (await sha256(`${seed}:${n}`))) % B(r.W));
		let lo = 0, hi = list.length - 1;
		while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][0] > x) hi = mid; else lo = mid + 1; }
		winners.push(list[lo][1]);
	}
	r.winners = winners; r.at = u.minute; r.src = from?.src ?? 'own';
}
const roundsInOrder = (s: State) => Object.keys(sunOf(s).rounds).sort((a, b) => N(a) - N(b));
/** the tickets an account has won and not yet collected, oldest round first */
export function openTickets(s: State, a: string): { round: string; n: number }[] {
	const out: { round: string; n: number }[] = [];
	if (!s.sun) return out;
	for (const m of roundsInOrder(s)) sunOf(s).rounds[m].winners?.forEach((w, n) => { if (w === a) out.push({ round: m, n }); });
	return out;
}
/** The drip follows real use: the Sun's drip is never more than the fees released that same minute. So the Sun never
    shrinks by paying out (it keeps half of fees plus drip, and the drip is at most the fees): a chain nobody uses keeps
    its Sun whole, like coins not yet mined, and a busy chain still pays lockers and holders more. */
const TEST_CAPS = new Map<string, number>();
/** TEST ONLY: the minute a test chain starts the cap (Infinity: never, to test the raffle with the drip as launched;
    null: back to the rule). No node calls this. */
export function testDripCap(chain: string, from: number | null) { if (from === null) TEST_CAPS.delete(chain); else TEST_CAPS.set(chain, from); }
export const dripCapFrom = (chain: string) => (TEST_CAPS.has(chain) ? TEST_CAPS.get(chain)! : 0);
function accrue(b: { budget: number; sub: string }, s: State, bp: bigint, bank: bigint) {
	const sun = B(sunBal(s));
	let sub = B(b.sub) + sun * bp * SUB / (BP * YEAR);
	const add = sub / SUB; sub -= add * SUB; b.sub = String(sub);
	const cap = N(sun * bp * bank / (BP * YEAR)), room = cap > b.budget ? cap - b.budget : 0;
	b.budget += N(add) < room ? N(add) : room;
	if (b.budget > cap) b.budget = cap;
}
/* ---------- the council and the chain's central bank (rules.mjs: the council, the commission, the policy rate) ---------- */
/** the validators that worked: made a block within the last workMinutes, and are not benched */
function workers(s: State) {
	const u = sunOf(s), since = u.minute - N(R.workMinutes);
	return s.validators.filter((v) => own(u.worked, v) && u.worked[v] >= since && !(s.stakes && own(s.stakes, v) && s.stakes[v].jailed !== undefined)).sort();
}
/** this minute's wage (wageBp of the DZY in people's hands, M, a year), paid from the council fund as far as it goes:
    bonusBp to the bonus, the rest in equal shares to every validator that worked. With nobody working, nothing is owed. */
function payWage(s: State, M: bigint) {
	const c = sunOf(s).council, w = workers(s);
	if (!w.length) { c.owed = '0'; return; }
	let owed = B(c.owed) + wageSub(R, M, 1n), pay = owed / SUB;
	owed -= pay * SUB; c.owed = String(owed);
	if (pay > B(c.fund)) pay = B(c.fund); // a fund that is short pays what it has; the rest of the wage is not owed later
	const bonus = pay * R.bonusBp / BP, each = (pay - bonus) / B(w.length);
	c.fund -= N(bonus + each * B(w.length)); c.bonus += N(bonus);
	if (crewOn(s)) { c.pot = (c.pot ?? 0) + N(each * B(w.length)); return; } // the crew upgrade: paid at the day's end, by blocks made
	if (each) for (const v of w) receive(s, v, N(each));
}
/** the day's bonus winner: a lottery per staked shard among the validators that worked. Each one's chances are its
    shards (its own stake plus what holders back it with), like mining odds; the draw is seeded by the newest Bitcoin
    block anyone has posted (else the chain's last block) and the day, so no one picks the winner. With no shards at all
    (cannot happen on a live chain), the next worker in turn. */
export async function bonusWinner(s: State, w: string[], last: string, day: number): Promise<string> {
	const list: [bigint, string][] = [];
	let c = 0n;
	for (const v of w) { const x = s.heart ? stakeTime(s, v) : B(weightOf(s, v)); if (x > 0n) { c += x; list.push([c, v]); } }
	if (!c) return w.find((v) => v > last) ?? w[0];
	const u = sunOf(s), x = B('0x' + (await sha256(`dznye-bonus:${u.btc ? u.btc.hash : s.last}:${day}`))) % c;
	return list.find(([top]) => top > x)![1];
}
/** The crew upgrade, once a chain day: the day's wage split by blocks each validator made (its work), the bonus to one
    drawn by shards (its investment); then each one's pay is shared with its backers (payOut). */
async function payDay(s: State, w: string[]) {
	const u = sunOf(s), c = u.council, work = u.work ?? {}, pay = new Map<string, number>();
	const add = (v: string, n: number) => { if (n > 0) pay.set(v, (pay.get(v) ?? 0) + n); };
	const busy = w.filter((v) => (work[v] ?? 0) > 0), total = busy.reduce((n, v) => n + work[v], 0);
	// checkers: staked keys whose node checked in during at least checkerMinHours different hours since the last pay
	// day share checkerShareBp of the day's work pay (the pot; the bonus is apart), by stake (their own plus their backers', so splitting one stake over many
	// keys earns nothing more); then everyone's hours start again. With no checkers, the block makers get it all.
	const checkers: string[] = [];
	const least = s.heart ? leastWorking(s, work) : [];
	for (const k of keysOf(s.nodes ?? {})) {
		const n = peek(s.nodes!, k) as { hrs?: number };
		const st = s.stakes && own(s.stakes, k) ? s.stakes[k] : null;
		if ((n.hrs ?? 0) >= LEDGER.checkerMinHours && st && st.bond >= LEDGER.crewMinStake && !st.tomb && st.jailed === undefined) checkers.push(k);
		if (n.hrs) s.nodes![k] = { ...s.nodes![k], hrs: 0 };
	}
	const cw = checkers.map((k) => B(weightOf(s, k))), cwTotal = cw.reduce((a, b) => a + b, 0n);
	if (s.heart) payHeart(s, busy, work, least, add);
	if (c.pot && cwTotal > 0n && !s.heart) { // (the Heart upgrade pays the least working instead: payHeart)
		const share = total ? N(B(c.pot) * B(LEDGER.checkerShareBp) / BP) : c.pot; // nobody made blocks: all of it
		let given = 0;
		checkers.forEach((k, i) => { const x = N(B(share) * cw[i] / cwTotal); add(k, x); given += x; });
		c.pot -= given;
	}
	if (c.pot && total) {
		let given = 0;
		for (const v of busy) { const x = N(B(c.pot) * B(work[v]) / B(total)); add(v, x); given += x; }
		add(busy.reduce((a, b) => (work[b] > work[a] ? b : a)), c.pot - given); // what whole shards leave over: to the busiest
		c.pot = 0;
	}
	if (c.bonus && w.length) { const next = await bonusWinner(s, w, c.last, Math.floor(u.minute / N(DAY))); add(next, c.bonus); c.last = next; c.bonus = 0; }
	for (const v of [...pay.keys()].sort()) payOut(s, v, pay.get(v)!);
	u.work = {};
}
/** The Heart upgrade, once a chain day: those online who made the fewest blocks share their 5% by stake x time; the makers
    of contracts are paid for the fees their contracts brought; and the exchange's fees are paid out in their own coins:
    to validators by blocks made, to the least working, and to lockers by amount x time. */
function payHeart(s: State, busy: string[], work: Record<string, number>, least: [string, bigint][], add: (v: string, n: number) => void) {
	const h = s.heart!, u = sunOf(s), some = least.some(([, w]) => w > 0n);
	if (h.least) { if (some) h.least = share(h.least, least, add); else { setSun(s, sunBal(s) + h.least); h.least = 0; } } // nobody but one: to the Sun
	payMakers(s, (a, n) => { h.grants -= n; receive(s, a, n); });
	const byWork = busy.map((v): [string, bigint] => [v, B(work[v])]);
	const lockers: [string, bigint][] = [];
	if (Object.keys(h.coin.k).length) for (const a of keysOf(u.locks).sort()) { const x = peek(u.locks, a) as LockAcct; if (!x.benched && x.weight) lockers.push([a, B(x.weight)]); }
	const pay = (m: Record<string, number>, to: [string, bigint][], give: (a: string, coin: string, n: number) => void) => {
		for (const coin of Object.keys(m).sort()) { const left = share(m[coin], to, (a, n) => give(a, coin, n)); if (left) m[coin] = left; else delete m[coin]; }
	};
	pay(h.coin.v, byWork, (a, coin, n) => payOut(s, a, n, (who, x) => creditCoin(s, who, coin, x)));
	pay(h.coin.l, least, (a, coin, n) => payOut(s, a, n, (who, x) => creditCoin(s, who, coin, x)));
	pay(h.coin.k, lockers, (a, coin, n) => creditCoin(s, a, coin, n));
}
/** Pay a validator `amount` and share it with its backers, automatically: it keeps its commission (10% unless it set
    its own), and the rest is split by stake: its own share to it, each backer's share straight to the backer. */
function payOut(s: State, v: string, amount: number, give: (who: string, n: number) => void = (who, n) => receive(s, who, n)) {
	const st = s.stakes && own(s.stakes, v) ? s.stakes[v] : null, backers = s.delegations && own(s.delegations, v) ? s.delegations[v] : null;
	const names = backers ? Object.keys(backers).sort() : [], D = names.reduce((n, k) => n + backers![k], 0), P = (st?.bond ?? 0) + D;
	if (!D || !P) { give(v, amount); return; }
	const com = N(B(amount) * B(st?.commission ?? LEDGER.commissionDefaultBp) / 10_000n), toBackers = N(B(amount - com) * B(D) / B(P));
	let paid = 0;
	for (const k of names) { const x = N(B(toBackers) * B(backers![k]) / B(D)); if (x) { give(k, x); paid += x; } }
	give(v, amount - paid);
}
/** once a chain day: the bonus to a worker drawn by shards (bonusWinner); the fund's income, the DZY in hands and the block use recorded;
    then the commission sets tomorrow's fee floor from the fund against its buffer, and the policy rate steps toward the Taylor rule */
async function newDay(s: State, M: bigint) {
	const u = sunOf(s), c = u.council, f = u.fed, H = N(R.historyDays), w = workers(s);
	if (s.heart) s.heart.day = dayOf(s);
	if (crewOn(s)) await payDay(s, w);
	else if (c.bonus && w.length) { const next = await bonusWinner(s, w, c.last, Math.floor(u.minute / N(DAY))); receive(s, next, c.bonus); c.last = next; c.bonus = 0; }
	c.inc.push(c.today); c.today = 0; if (c.inc.length > H) c.inc.shift();
	f.M.push(N(M)); if (f.M.length > H + 1) f.M.shift();
	f.use.push([f.tx, f.blocks]); f.tx = 0; f.blocks = 0; if (f.use.length > H) f.use.shift();
	const buffer = bufferFor(R, M, c.inc.map(B));
	f.buffer = N(buffer); if (!s.heart) f.floor = N(nextFloor(R, B(f.floor), B(c.fund), buffer));
	const growth = moneyGrowthBp(M, B(f.M[0]), B(f.M.length - 1)), [tx, bl] = f.use.reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0]), useBp = useGapBp(R, B(tx), B(bl));
	f.growth = N(growth); f.useGap = N(useBp); f.target = N(policyTarget(R, growth, useBp)); f.rate = N(nextRate(R, B(f.rate), B(f.target)));
}
/** the Heart upgrade: the fees released this minute, in their five parts. The lockers' 15% joins the raffle's prizes
    (tickets by DZY locked x years); with nobody taking part it goes to the Sun. */
function heartMinute(s: State, release: number): number {
	const u = sunOf(s), h = s.heart!, x = splitCarry(s, release);
	u.feePot -= release;
	u.council.pot = (u.council.pot ?? 0) + x.v; u.council.today += x.v;
	h.least += x.l; h.grants += x.g;
	setSun(s, sunBal(s) + x.b + (u.W ? 0 : x.k));
	if (u.W) u.valPool += x.k;
	priceMinute(s);
	return x.b;
}
/** the yearly base rate of every loan, in basis points (the policy rate) */
export const policyRate = (s: State) => sunOf(s).fed.rate;
async function tick(s: State) {
	const u = sunOf(s);
	// rounds past their answer time: what nobody collected goes to the Sun, and those winners sit out
	for (const m of roundsInOrder(s)) {
		const r = u.rounds[m];
		if (!r.winners || u.minute - (r.at as number) < N(R.answerMinutes)) continue;
		for (const a of r.winners) if (a !== null) { u.roundPot -= r.prize; setSun(s, sunBal(s) + r.prize); bench(s, a); }
		delete u.rounds[m];
	}
	// rounds whose next Bitcoin block has arrived are drawn from its hash; a round with none for seedWait minutes, from the chain's own block
	for (const m of roundsInOrder(s)) {
		const r = u.rounds[m];
		if (r.winners || r.bh === undefined || !u.btc || u.btc.height <= r.bh) continue;
		const next = u.btc.recent.find(([h]) => h === r.bh! + 1);
		if (next) await resolve(s, m, { seed: 'dznye-btc:' + next[1], src: 'btc:' + next[0] });
	}
	for (const m of roundsInOrder(s)) if (!u.rounds[m].winners && u.minute - N(m) >= u.seedWait) await resolve(s, m);
	// 1. profit = fees (spread over about a day) + the Sun's drip, which grows with the share of DZY in people's hands
	//    and is never more than the fees released this minute
	//    councilBp of the fees released go to the council fund (the validators' wage); the rest is the profit
	const release = u.feePot === 0 ? 0 : N((B(u.feePot) + R.potMinutes - 1n) / R.potMinutes), toCouncil = N(B(release) * R.councilBp / BP), rest = release - toCouncil;
	let rest0 = rest; // the Sun's own part of the fees: the drip is never more
	if (s.heart) rest0 = heartMinute(s, release); // 40 / 30 / 5 / 10 / 15 (heart.ts); then only the drip is shared below
	else { u.feePot -= release; u.council.fund += toCouncil; u.council.today += toCouncil; setSun(s, sunBal(s) + rest); }
	const sun0 = B(sunBal(s) - rest0), out = SUPPLY_B - sun0 - B(u.salePot);
	let drip = sun0 * R.dripBp * SUB * out / (BP * YEAR * SUPPLY_B);
	if (u.minute >= dripCapFrom(s.chain) && drip > B(rest0) * SUB) drip = B(rest0) * SUB;
	if (s.x?.index) drip = 0n; // the index (ledger.ts): nothing enters people's hands without coin behind it; fees pay validators and holders
	const profit = (s.heart ? 0n : B(rest) * SUB) + drip;
	// 2. 40% to the validators' pot and 10% to deposits, whole units with fractions carried; the rest stays in the Sun
	if (u.W) {
		let owed = B(u.valOwed) + profit * R.validatorBp / BP;
		const take = owed / SUB; owed -= take * SUB; u.valOwed = String(owed);
		setSun(s, sunBal(s) - N(take)); u.valPool += N(take);
	}
	const part: [string, bigint][] = []; let PW = 0n; // deposits whose step comes part-way through this minute earn for that part
	for (const ev of u.events[String(u.minute + 1)] ?? []) {
		if (ev.k !== 'step') continue;
		const d = u.deposits[ev.a];
		if (!d.eligible || d.pend[ev.i] !== u.minute + 1 || !d.P[ev.i]) continue;
		const cross = crossOf(d, ev.i), end = B(u.minute + 1) * TICK;
		if (cross > B(u.minute) * TICK && cross < end) { const w = B(d.P[ev.i]) * (end - cross); part.push([ev.a, w]); PW += w; }
	}
	if (u.HW || PW) {
		let owed = B(u.holdOwed) + profit * R.holderBp / BP;
		const take = owed / SUB; owed -= take * SUB; u.holdOwed = String(owed);
		setSun(s, sunBal(s) - N(take)); u.holdPool += N(take);
		if (take) {
			const dI = take * IDX * TICK / (B(u.HW) * TICK + PW);
			u.holdIdx = String(B(u.holdIdx) + dI);
			for (const [a, w] of part) { const d = settle(s, a), owed = w * dI / TICK + B(d.rem), e = N(owed / IDX); d.rem = String(owed - B(e) * IDX); if (e) { joinAtMaturity(s, a, d, e); u.holdPool -= e; d.held += e; refresh(s, d); } }
		}
	}
	// 3. this minute's raffle: its prizes wait in the round until each winner answers
	if (u.W) {
		const k = N(ticketsFor(R, B(u.N))), prize = Math.floor(u.valPool / k);
		if (prize) {
			u.valPool -= prize * k; u.roundPot += prize * k;
			u.rounds[String(u.minute)] = { prize, k, W: u.W, ...(u.btc ? { bh: u.btc.height } : {}) };
			if (u.seedWait === 0) await resolve(s, String(u.minute));
		}
	} else if (u.valPool) { setSun(s, sunBal(s) + u.valPool); u.valPool = 0; } // nobody is taking part
	// 4. the validators' wage from the council fund, and the Sun's budgets
	payWage(s, out);
	accrue(u.welcome, s, R.welcomeBp, R.welcomeBank);
	accrue(u.backstop, s, R.backstopBp, R.backstopBank);
	accrue(u.credit, s, R.creditBp, DAY);
	u.minute += 1;
	// a new chain day: the bonus, the commission (fee floor) and the policy rate
	if (u.minute % N(DAY) === 0) await newDay(s, out);
	// 5. what falls due this minute: locks that end, deposit steps, accounts that have gone silent
	const evs = u.events[String(u.minute)];
	if (evs) {
		delete u.events[String(u.minute)];
		for (const ev of evs) {
			if (ev.k === 'unlock') {
				const x = lk(s, ev.a), i = x.list.findIndex((l) => l.id === ev.id), l = x.list[i];
				setWeight(s, ev.a, -l.w); x.list.splice(i, 1); u.L -= l.amt; receive(s, ev.a, l.amt);
			} else if (ev.k === 'step') { dep(s, ev.a).pend[ev.i] = null; settle(s, ev.a); }
			else if (ev.k === 'credit') creditDue(s, ev.a);
			else {
				const d = dep(s, ev.a);
				d.renewPend = null;
				if ((d.last as number) + N(R.renewMinutes) > u.minute) { d.renewPend = (d.last as number) + N(R.renewMinutes); schedule(s, d.renewPend, { k: 'renew', a: ev.a }); }
				else if (d.eligible) { settle(s, ev.a); d.eligible = false; refresh(s, d); }
			}
		}
	}
}

/** After a block's transactions: the fee follows how full the block was, and if the clock has reached a new minute,
    one chain minute passes (exactly one, however long the chain stood still). */
export async function sunBlock(s: State, time: number, txCount: number, proposer?: string, bytes = 0) {
	if (!s.sun) return;
	if (!Number.isSafeInteger(txCount) || txCount < 0) fail('bad transaction count');
	const u = sunOf(s), clock = Math.floor(time / 60_000);
	// the fee follows how full the block was, never below the commission's floor
	// (the Heart upgrade: how full by weight, and the next block's limit follows)
	if (s.heart) { const room = s.heart.size, full = fullness(s, bytes); s.fee = Math.max(N(feeNext(R, B(s.fee ?? 1), B(Math.min(full, room)), B(room) / 2n)), u.fed.floor, feeFloor(s)); sizeAfter(s, bytes); }
	else s.fee = Math.max(N(feeNext(R, B(s.fee ?? 1), B(txCount), R.maxTxPerBlock / 2n)), u.fed.floor);
	u.fed.tx += txCount; u.fed.blocks += 1;
	if (proposer !== undefined && s.validators.includes(proposer)) {
		u.worked[proposer] = u.minute; // it did its turn
		if (crewOn(s)) (u.work ??= {})[proposer] = (u.work[proposer] ?? 0) + 1; // the crew upgrade: blocks made today, for pay by work
	}
	if (clock > u.stamp) { u.stamp = clock; dropStale(s, time); await tick(s); if ((s.fee ?? 0) < u.fed.floor) s.fee = u.fed.floor; if (s.heart) s.fee = Math.max(s.fee ?? 0, feeFloor(s)); } // a new day may have raised the floor
}

/* ---------- views ---------- */
/** DZY the economy holds outside people's accounts and the Sun: locks and the pots on their way to people */
export function sunHeld(s: State) {
	const u = sunOf(s);
	return { locked: u.L, pots: u.feePot + u.valPool + u.roundPot + u.holdPool + u.council.fund + u.council.bonus + (u.council.pot ?? 0) + heartHeld(s), unsold: u.salePot };
}
/** where the 12,000,000 are. The Sun, unsold and locked DZY are out of circulation; none is ever destroyed. */
export function sunSupply(s: State) {
	const h = sunHeld(s), sun = sunBal(s);
	return { supply: SUN_SUPPLY, sun, unsold: h.unsold, sold: sunOf(s).sold, locked: h.locked, pots: h.pots, circulating: SUN_SUPPLY - sun - h.unsold - h.locked - h.pots, price: s.heart ? spotPrice(s) : N(salePrice(R, B(sunOf(s).sold))), fee: s.fee ?? 0, minute: sunOf(s).minute, lockWeight: sunOf(s).W, lockers: sunOf(s).N, btc: sunOf(s).btc ? { height: sunOf(s).btc!.height, hash: sunOf(s).btc!.hash, time: sunOf(s).btc!.time } : null };
}
/** the chain's economy as its central bank sees it (GET /economy): every number the rules act on, so anyone can check them */
export function economyView(s: State) {
	const u = sunOf(s), c = u.council, f = u.fed, inHands = SUN_SUPPLY - sunBal(s) - u.salePot, day = Math.floor(u.minute / N(DAY));
	return {
		minute: u.minute, day, inHands,
		policyRate: f.rate, rateTarget: f.target, moneyGrowth: f.growth, blockUse: f.useGap,
		fee: s.fee ?? 0, feeFloor: f.floor,
		council: { fund: c.fund, buffer: f.buffer, bonus: c.bonus, wagePerDay: N(wageSub(R, B(inHands), DAY) / SUB), workers: workers(s), lastBonus: c.last || null, income: c.inc },
		credit: { open: Object.keys(u.credit.out).length, defaulted: Object.keys(u.credit.bad).length, leftToday: N(R.creditPerDay) - (u.credit.day === day ? u.credit.today : 0), feeBudget: u.credit.budget },
		history: { inHands: f.M, use: f.use },
	};
}
/** one account's starter credit, or null */
export function creditView(s: State, a: string) {
	const u = sunOf(s), c = own(u.credit.out, a) ? u.credit.out[a] : null;
	return { credit: c ? { ...c, owed: creditOwed(s, c), left: c.closed ? 0 : N(R.creditAmount) - c.used, dueIn: c.due - u.minute } : null, defaulted: own(u.credit.bad, a) };
}
export function sunView(s: State, a: string) {
	const u = sunOf(s), d = own(u.deposits, a) ? u.deposits[a] : null, x = own(u.locks, a) ? u.locks[a] : null;
	return {
		balance: balOf(s, a) + (d ? pendingReward(s, d) : 0), locked: lockedOf(s, a), weight: x?.weight ?? 0, locks: x?.list ?? [], sittingOut: x?.benched ?? false,
		depositWeight: d ? depositWeight(d) : 0, earning: d?.eligible ?? false, won: d?.won ?? 0, held: (d?.held ?? 0) + (d ? pendingReward(s, d) : 0),
		renewIn: d?.eligible && d.last !== null ? d.last + N(R.renewMinutes) - u.minute : null, locksEndIn: (x?.list ?? []).map((l) => l.end - u.minute), tickets: openTickets(s, a),
	};
}
