/* Layers: other people's chains on top of Dznye, with Dznye as the heart they settle on (the Heart upgrade).

   Anyone may open one. Nothing a layer does can touch Dznye itself: a layer holds only what people put into it, and never
   pays out more than that. Two kinds:

   APP LAYERS ("app") run anything at all, their own way: a game, an exchange, a social app. They write the fingerprint of
   their state onto Dznye (layer.anchor), where it can never be changed, and Dznye contracts can read the newest one
   (["layerroot", id]). They hold no coins on Dznye: what an app layer says is as true as its operators are honest.

   COIN LAYERS ("pay") hold one coin or token and move it between their accounts as fast as their operators like, and
   nobody has to trust the operators:
   - Every batch of steps is written here as two fingerprints: the steps, and the state after them. It waits (`wait`) before
     it counts.
   - While it waits, anyone may ASK about any step (layer.ask, with a small deposit). The operator must then PROVE that step
     on Dznye (layer.prove): show it, and the accounts it touched, and Dznye itself works the step out again: the
     signature, the balance, the new fingerprint. A proved step pays the operator the deposit. A step that is wrong, or
     hidden, cannot be proved: the layer is stopped (layer.fail), every batch that was waiting is dropped, and half the
     operator's bond goes to whoever asked (the other half to the Sun).
   - From the last batch that counted, everyone takes their own balance out of a stopped layer with the proof of it
     (layer.exit), and deposits it had not used yet go straight back (layer.refund). An operator who goes silent for
     `quiet` stops the layer the same way (layer.freeze).
   - An operator who leaves one person out: that person writes their own signed withdrawal on Dznye (layer.force). If their
     account has not moved, in a batch that counts, within three waits, the layer stops (layer.fail) and they take it out.
   So an operator can stop, but cannot take or hold back anyone's coins, as long as ONE person anywhere checks its batches.

   State of a coin layer: 1,048,576 accounts (leaf 0 is the count of deposits used), a tree of SHA-256. Whole numbers only. */
import { canon } from './crypto.ts';
import { sha256 as sha256Sync } from './btc.ts';

const enc = new TextEncoder(), own = (o: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(o, k);
const fail = (m: string): never => { throw new Error(m); };
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const H = (t: string): string => { const b = sha256Sync(enc.encode(t)); let s = ''; for (const x of b) s += HEX[x]; return s; };

export const ZONE = Object.freeze({
	depth: 20, stepDepth: 10, maxSteps: 1_024, // a million accounts; 1,024 steps a batch
	minWait: 10 * 60_000, maxWait: 7 * 24 * 60 * 60_000, quiet: 7 * 24 * 60 * 60_000,
	openFee: 100_000_000, minBond: 25 * 100_000_000, // 1 DZY to the Sun; at least 25 DZY of bond for a coin layer: more than asking about every step of a batch costs (10.24)
	batchFee: 250_000, depositFee: 100_000, // what Dznye keeps of a batch and of a deposit costs its room once (0.0025 and 0.001 DZY, to the Sun), like a record
	askDeposit: 1_000_000, // 0.01 DZY for each step asked about
	maxOps: 8, maxPending: 8_192, maxAsks: 1_024, minGap: 1_000,
});

/* ---------- trees ---------- */
const node = (l: string, r: string) => H('zone-node:' + l + r);
const EMPTY = [H('zone-empty')];
for (let i = 0; i < ZONE.depth; i++) EMPTY.push(node(EMPTY[i], EMPTY[i]));
export const emptyAt = (level: number) => EMPTY[level];
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const isPath = (p: unknown, depth: number): p is string[] => Array.isArray(p) && p.length === depth && p.every(isHash);
/** the root a leaf gives at this place with these neighbours */
export function rootFrom(leaf: string, index: number, path: string[]): string {
	let h = leaf, i = index;
	for (const s of path) { h = i & 1 ? node(s, h) : node(h, s); i = Math.floor(i / 2); }
	return h;
}
export const acctLeaf = (owner: string, bal: number, nonce: number) => H('zone-acct:' + canon([owner, bal, nonce]));
export const metaLeaf = (next: number) => H('zone-meta:' + canon([next]));
export const stepLeaf = (i: number, op: Op, root: string) => H('zone-step:' + canon([i, op, root]));
/** the state a coin layer starts from: no accounts, no deposits used */
export const START_ROOT = rootFrom(metaLeaf(0), 0, EMPTY.slice(0, ZONE.depth));

/* ---------- steps ---------- */
export type Op =
	| { k: 't'; f: number; t: number; a: number; n: number; to: string; sig: string } // account f pays a to account t (owned by `to`; an empty place becomes theirs)
	| { k: 'w'; f: number; a: number; n: number; to: string; sig: string }            // account f takes a out to Dznye address `to`
	| { k: 'd'; q: number; i: number };                                               // deposit q arrives in account i
/** the accounts a step touched, as they were, with their places in the tree */
export interface Seen { fo?: string; fb?: number; fn?: number; fp?: string[]; te?: boolean; tb?: number; tn?: number; tp?: string[]; mp?: string[] }
const isNum = (v: unknown, most = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= most;
const place = (v: unknown): v is number => isNum(v, 2 ** ZONE.depth - 1) && v > 0;
export const isOwner = isHash;
/** the exact text an account's owner signs for a step */
export const opMessage = (chain: string, layer: string, op: Op) => 'dzy-zone:' + canon(op.k === 'd' ? { chain, layer, k: 'd' } : { chain, layer, k: op.k, f: op.f, a: op.a, n: op.n, to: op.to, ...(op.k === 't' ? { t: op.t } : {}) });
export function checkOp(v: unknown): Op {
	const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : fail('bad step')) as Record<string, unknown>;
	const keys = (...k: string[]) => { for (const x of Object.keys(o)) if (!k.includes(x)) fail('bad step'); };
	if (o.k === 'd') { keys('k', 'q', 'i'); if (!isNum(o.q) || !place(o.i)) fail('bad step'); return { k: 'd', q: o.q as number, i: o.i as number }; }
	if (o.k !== 't' && o.k !== 'w') fail('bad step');
	keys('k', 'f', 'a', 'n', 'to', 'sig', ...(o.k === 't' ? ['t'] : []));
	if (!place(o.f) || !isNum(o.a) || (o.a as number) < 1 || !isNum(o.n) || !isOwner(o.to) || typeof o.sig !== 'string' || !/^[0-9a-f]{128}$/.test(o.sig)) fail('bad step');
	if (o.k === 't' && !place(o.t)) fail('bad step');
	return o as unknown as Op;
}
/** Work a step out again. `prev`: the state before it. `sigOk`: the owner named in `seen.fo` signed it. `dep`: what deposit
    q is (null: there is none). Returns the state after it, or throws: such a step cannot be proved. */
export function applyStep(prev: string, op: Op, seen: Seen, sigOk: boolean, dep: { to: string; amount: number } | null): string {
	if (op.k === 'd') {
		if (!dep) fail('no such deposit');
		if (!isPath(seen.mp, ZONE.depth) || rootFrom(metaLeaf(op.q), 0, seen.mp) !== prev) fail('deposits are used in order, once each');
		const mid = rootFrom(metaLeaf(op.q + 1), 0, seen.mp!);
		return arrive(mid, op.i, dep!.to, dep!.amount, seen);
	}
	if (!isOwner(seen.fo) || !isNum(seen.fb) || !isNum(seen.fn) || !isPath(seen.fp, ZONE.depth)) fail('the paying account is not shown');
	if (rootFrom(acctLeaf(seen.fo!, seen.fb!, seen.fn!), op.f, seen.fp!) !== prev) fail('the paying account is not what it was');
	if (!sigOk) fail('its owner did not sign this step');
	if (op.n !== seen.fn) fail('that is not its next step');
	if (seen.fb! < op.a) fail('it does not hold that much');
	const mid = rootFrom(acctLeaf(seen.fo!, seen.fb! - op.a, seen.fn! + 1), op.f, seen.fp!);
	if (op.k === 'w') return mid;
	if (op.t === op.f) fail('an account cannot pay itself');
	return arrive(mid, op.t, op.to, op.a, seen);
}
function arrive(root: string, at: number, to: string, amount: number, seen: Seen): string {
	if (!isPath(seen.tp, ZONE.depth)) fail('the receiving account is not shown');
	if (seen.te === true) {
		if (rootFrom(EMPTY[0], at, seen.tp!) !== root) fail('that place is not empty');
		return rootFrom(acctLeaf(to, amount, 0), at, seen.tp!);
	}
	if (!isNum(seen.tb) || !isNum(seen.tn) || !isNum(seen.tb! + amount)) fail('the receiving account is not shown');
	if (rootFrom(acctLeaf(to, seen.tb!, seen.tn!), at, seen.tp!) !== root) fail('the receiving account is not what it was');
	return rootFrom(acctLeaf(to, seen.tb! + amount, seen.tn!), at, seen.tp!);
}

/* ---------- what Dznye keeps of a layer ---------- */
export interface Layer {
	by: string; kind: 'app' | 'pay'; name: string; ops: string[]; wait: number; asset: string; bond: number; held: number;
	posted: number; proot: string; // the newest batch written, and the state after it
	fin: number; root: string;     // the newest batch that counts, and the state after it
	deps: number; last: number; dead?: number; // dead: when it was stopped
	asks: number;                  // open questions and forced withdrawals (each with its deposit)
	force: Record<string, { by: string; nonce: number; until: number }>; // forced withdrawals not served yet, by account
	out: Record<string, 1>;        // a stopped layer: what has been taken out already ("a<account>", "d<deposit>")
}
export interface Batch { prev: string; root: string; steps: string; count: number; at: number; asks: Record<string, { by: string; until: number }>; paid: Record<string, 1> }
export interface Dep { to: string; amount: number }
interface Z { chain: string; layers?: Record<string, Layer>; lbatches?: Record<string, Batch>; ldeps?: Record<string, Dep>; heart?: unknown }
/** what the ledger lends: balances, the Sun, and its own checks */
export interface Bank { add(who: string, asset: string, n: number): void; sub(who: string, asset: string, n: number): void; balance(who: string, asset: string): number; toSun(n: number): void; asset(id: unknown): string; amount(v: unknown): number; addr(v: unknown): string }
export interface ZCtx { stepSig?: boolean }

const only = (d: Record<string, unknown>, ...k: string[]) => { for (const x of Object.keys(d)) if (!k.includes(x)) fail(`"${x}" is not expected here`); };
const need = (s: Z) => { if (!s.heart) fail('layers start with the Heart upgrade'); };
const layerOf = (s: Z, id: unknown): [string, Layer] => (s.layers && own(s.layers, id) ? [id, s.layers[id]] : fail('no such layer'));
const batchKey = (id: string, n: number) => id + '/' + n;
/** the newest batch that counts by now, and the state after it: in order, each whose wait is over and that no open question holds up */
function counted(s: Z, id: string, l: Layer, time: number): { n: number; root: string } {
	let n = l.fin, root = l.root;
	if (l.dead === undefined) while (n < l.posted) { const b = s.lbatches![batchKey(id, n + 1)]; if (time < b.at + l.wait || Object.keys(b.asks).length) break; n++; root = b.root; }
	return { n, root };
}
export function settle(s: Z, id: string, l: Layer, time: number) { const c = counted(s, id, l, time); l.fin = c.n; l.root = c.root; }
/** the newest state of a layer that counts by now (what contracts read), or null */
export function layerRoot(s: Z, id: string, time: number): string | null {
	return s.layers && own(s.layers, id) ? counted(s, id, s.layers[id], time).root : null;
}
function stop(s: Z, id: string, l: Layer, time: number, bank: Bank) {
	for (let n = l.fin + 1; n <= l.posted; n++) { // what was waiting is dropped, and everyone who asked about it gets their deposit back
		const b = s.lbatches![batchKey(id, n)];
		for (const a of Object.values(b.asks)) bank.add(a.by, 'DZY', ZONE.askDeposit);
		delete s.lbatches![batchKey(id, n)];
	}
	for (const f of Object.values(l.force)) bank.add(f.by, 'DZY', ZONE.askDeposit);
	l.force = {}; l.asks = 0; l.posted = l.fin; l.proot = l.root; l.dead = time;
}

type ZHandler = (s: Z, from: string, d: Record<string, unknown>, id: string, time: number, ctx: ZCtx, bank: Bank) => () => void;
export const ZONE_HANDLERS: Record<string, ZHandler> = {
	/** open a layer: its name, its kind, who may write its batches, how long a batch waits before it counts */
	'layer.open'(s, from, d, txid, _time, _c, bank) {
		need(s); only(d, 'name', 'kind', 'ops', 'wait', 'asset', 'bond');
		const name = typeof d.name === 'string' && /^[a-z0-9][a-z0-9 -]{2,39}$/i.test(d.name) ? d.name : fail('a name: 3 to 40 letters, digits, spaces or dashes');
		const kind = d.kind === 'app' || d.kind === 'pay' ? d.kind : fail('kind: "app" or "pay"');
		const ops = Array.isArray(d.ops) && d.ops.length >= 1 && d.ops.length <= ZONE.maxOps && new Set(d.ops).size === d.ops.length ? (d.ops as unknown[]).map((x) => bank.addr(x)) : fail(`ops: 1 to ${ZONE.maxOps} different addresses`);
		const wait = isNum(d.wait) && (d.wait as number) >= ZONE.minWait && (d.wait as number) <= ZONE.maxWait ? (d.wait as number) : fail('wait: 10 minutes to 7 days, in milliseconds');
		const asset = kind === 'pay' ? bank.asset(d.asset) : d.asset === undefined ? '' : fail('an app layer holds no coins');
		const bond = kind === 'pay' ? bank.amount(d.bond) : d.bond === undefined ? 0 : fail('an app layer has no bond');
		if (kind === 'pay' && bond < ZONE.minBond) fail(`a coin layer's bond is at least ${ZONE.minBond / 1e8} DZY`);
		if (bank.balance(from, 'DZY') < ZONE.openFee + bond) fail('not enough DZY');
		const id = 'l' + txid.slice(0, 16);
		if (s.layers && own(s.layers, id)) fail('that layer already exists');
		return () => {
			bank.sub(from, 'DZY', ZONE.openFee + bond); bank.toSun(ZONE.openFee);
			const root = kind === 'pay' ? START_ROOT : H('zone-app:' + id);
			(s.layers ??= {})[id] = { by: from, kind, name, ops, wait, asset, bond, held: 0, posted: 0, proot: root, fin: 0, root, deps: 0, last: 0, asks: 0, force: {}, out: {} };
		};
	},
	/** put coins into a coin layer; they arrive in `to`'s account there when the operator uses the deposit */
	'layer.deposit'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'amount', 'to');
		const [id, l] = layerOf(s, d.id), amount = bank.amount(d.amount), to = d.to === undefined ? from : bank.addr(d.to);
		if (l.kind !== 'pay') fail('an app layer holds no coins');
		if (l.dead !== undefined) fail('that layer was stopped');
		if (bank.balance(from, l.asset) < amount || bank.balance(from, 'DZY') < (l.asset === 'DZY' ? amount : 0) + ZONE.depositFee) fail('not enough balance');
		if (!Number.isSafeInteger(l.held + amount)) fail('too much');
		return () => { bank.sub(from, 'DZY', ZONE.depositFee); bank.toSun(ZONE.depositFee); bank.sub(from, l.asset, amount); l.held += amount; (s.ldeps ??= {})[batchKey(id, l.deps)] = { to, amount }; l.deps += 1; if (!l.last) l.last = time; };
	},
	/** an operator writes the next batch */
	'layer.anchor'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'n', 'prev', 'root', 'steps', 'count');
		const [id, l] = layerOf(s, d.id);
		if (!l.ops.includes(from)) fail('only its operators write a layer\'s batches');
		if (l.dead !== undefined) fail('that layer was stopped');
		if (d.n !== l.posted + 1 || d.prev !== l.proot) fail('a batch follows the one before it');
		if (time < l.last + ZONE.minGap && l.posted > 0) fail('a batch every second, at most');
		const root = isHash(d.root) ? d.root : fail('root: the state after this batch'), pay = l.kind === 'pay';
		const steps = pay ? (isHash(d.steps) ? d.steps : fail('steps: the fingerprint of its steps')) : isHash(d.steps) ? d.steps : '';
		const count = pay ? (isNum(d.count, ZONE.maxSteps) && (d.count as number) >= 1 ? (d.count as number) : fail(`count: 1 to ${ZONE.maxSteps} steps`)) : 0;
		if (l.posted - counted(s, id, l, time).n >= ZONE.maxPending) fail('too many batches are waiting');
		if (bank.balance(from, 'DZY') < ZONE.batchFee) fail(`a batch costs ${ZONE.batchFee / 1e8} DZY`);
		return () => {
			bank.sub(from, 'DZY', ZONE.batchFee); bank.toSun(ZONE.batchFee);
			settle(s, id, l, time);
			l.posted += 1; l.proot = root; l.last = time;
			(s.lbatches ??= {})[batchKey(id, l.posted)] = { prev: d.prev as string, root, steps, count, at: time, asks: {}, paid: {} };
			if (!pay) { const old = l.posted - ZONE.maxPending; if (old > 0 && old <= l.fin) delete s.lbatches![batchKey(id, old)]; } // an app layer's old batches stay in the blocks
		};
	},
	/** ask about one step of a batch that does not count yet: its operator must prove it within `wait`, or the layer stops */
	'layer.ask'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'n', 'i');
		const [id, l] = layerOf(s, d.id), n = isNum(d.n) ? (d.n as number) : fail('which batch'), b = n > l.fin && n <= l.posted ? s.lbatches![batchKey(id, n)] : fail('that batch does not wait any more (or does not exist)');
		if (l.kind !== 'pay' || l.dead !== undefined) fail('only a running coin layer proves steps');
		if (time >= b.at + l.wait) fail('that batch does not wait any more');
		const i = isNum(d.i, b.count - 1) ? (d.i as number) : fail('which step');
		if (own(b.asks, String(i))) fail('that step is already asked about');
		if (l.asks >= ZONE.maxAsks * 4) fail('too many open questions');
		if (bank.balance(from, 'DZY') < ZONE.askDeposit) fail(`asking needs a deposit of ${ZONE.askDeposit / 1e8} DZY`);
		return () => { bank.sub(from, 'DZY', ZONE.askDeposit); b.asks[String(i)] = { by: from, until: time + l.wait }; l.asks += 1; };
	},
	/** prove a step that was asked about: Dznye works it out again. Anyone may (who proves gets the deposit) */
	'layer.prove'(s, from, d, _id, time, ctx, bank) {
		need(s); only(d, 'id', 'n', 'i', 'op', 'prev', 'root', 'before', 'bpath', 'path', 'seen');
		const [id, l] = layerOf(s, d.id), n = isNum(d.n) ? (d.n as number) : fail('which batch'), b = s.lbatches && own(s.lbatches, batchKey(id, n)) ? s.lbatches[batchKey(id, n)] : fail('no such batch');
		const i = isNum(d.i) && own(b.asks, String(d.i)) ? (d.i as number) : fail('nobody asked about that step');
		if (time > b.asks[String(i)].until) fail('the time to prove it is over');
		const op = checkOp(d.op), prev = isHash(d.prev) ? d.prev : fail('prev'), root = isHash(d.root) ? d.root : fail('root');
		if (!isPath(d.path, ZONE.stepDepth) || rootFrom(stepLeaf(i, op, root), i, d.path) !== b.steps) fail('that is not the step the batch holds');
		if (i === 0) { if (prev !== b.prev) fail('a batch\'s first step follows the batch before'); }
		else if (!isPath(d.bpath, ZONE.stepDepth) || rootFrom(stepLeaf(i - 1, checkOp(d.before), prev), i - 1, d.bpath) !== b.steps) fail('that is not the step before it');
		if (i === b.count - 1 && root !== b.root) fail('the last step does not give the batch\'s state');
		const seen = (d.seen && typeof d.seen === 'object' ? d.seen : fail('seen: the accounts it touched')) as Seen;
		const dep = op.k === 'd' && op.q < l.deps ? s.ldeps![batchKey(id, op.q)] ?? null : null;
		if (applyStep(prev, op, seen, !!ctx.stepSig, dep) !== root) fail('that step does not give that state');
		return () => { delete b.asks[String(i)]; l.asks -= 1; bank.add(from, 'DZY', ZONE.askDeposit); settle(s, id, l, time); };
	},
	/** your own withdrawal, written on Dznye because the operator leaves it out: your account in the state that counts now,
	    and the step you signed there. The operator must serve it (layer.served) within three waits, or the layer stops */
	'layer.force'(s, from, d, _id, time, ctx, bank) {
		need(s); only(d, 'id', 'op', 'bal', 'path');
		const [id, l] = layerOf(s, d.id), op = checkOp(d.op);
		if (l.kind !== 'pay' || l.dead !== undefined) fail('only in a running coin layer');
		if (op.k !== 'w') fail('only a withdrawal');
		if (!ctx.stepSig) fail('that step is not signed by you');
		const w = op as Op & { k: 'w' };
		if (own(l.force, String(w.f))) fail('already asked for');
		if (!isNum(d.bal) || (d.bal as number) < w.a || !isPath(d.path, ZONE.depth) || rootFrom(acctLeaf(from, d.bal as number, w.n), w.f, d.path) !== counted(s, id, l, time).root) fail('that is not your account in the state that counts now');
		if (l.asks >= ZONE.maxAsks * 4) fail('too many open questions');
		if (bank.balance(from, 'DZY') < ZONE.askDeposit) fail(`it needs a deposit of ${ZONE.askDeposit / 1e8} DZY`);
		return () => { bank.sub(from, 'DZY', ZONE.askDeposit); l.force[String(w.f)] = { by: from, nonce: w.n, until: time + 3 * l.wait }; l.asks += 1; };
	},
	/** a forced withdrawal was served: in a state that counts, that account has made a step its owner signed. Anyone may show it */
	'layer.served'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'at', 'bal', 'nonce', 'path');
		const [id, l] = layerOf(s, d.id), f = own(l.force, String(d.at)) ? l.force[String(d.at)] : fail('no such forced withdrawal');
		if (!place(d.at) || !isNum(d.bal) || !isNum(d.nonce) || (d.nonce as number) <= f.nonce || !isPath(d.path, ZONE.depth) || rootFrom(acctLeaf(f.by, d.bal as number, d.nonce as number), d.at as number, d.path) !== counted(s, id, l, time).root) fail('that account has not moved, in the state that counts now');
		return () => { settle(s, id, l, time); delete l.force[String(d.at)]; l.asks -= 1; bank.add(from, 'DZY', ZONE.askDeposit); };
	},
	/** a step nobody proved in time, or a forced withdrawal nobody served in time: the layer stops, and half its bond goes to whoever asked */
	'layer.fail'(s, _from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'n', 'i', 'at');
		const [id, l] = layerOf(s, d.id);
		if (d.at !== undefined) {
			const f = own(l.force, String(d.at)) ? l.force[String(d.at)] : fail('no such forced withdrawal');
			if (time <= f.until) fail('there is still time to serve it');
			return () => { settle(s, id, l, time); const half = Math.floor(l.bond / 2); bank.add(f.by, 'DZY', half); bank.toSun(l.bond - half); l.bond = 0; stop(s, id, l, time, bank); };
		}
		const b = s.lbatches && own(s.lbatches, batchKey(id, d.n as number)) ? s.lbatches[batchKey(id, d.n as number)] : fail('no such batch');
		const a = own(b.asks, String(d.i)) ? b.asks[String(d.i)] : fail('nobody asked about that step');
		if (time <= a.until) fail('there is still time to prove it');
		return () => { settle(s, id, l, time); const half = Math.floor(l.bond / 2); bank.add(a.by, 'DZY', half); bank.toSun(l.bond - half); l.bond = 0; stop(s, id, l, time, bank); };
	},
	/** an operator silent for `quiet`: anyone stops the layer, so everyone can take their coins out */
	'layer.freeze'(s, _from, d, _id, time, _c, bank) {
		need(s); only(d, 'id');
		const [id, l] = layerOf(s, d.id);
		if (l.kind !== 'pay' || l.dead !== undefined) fail('that layer is not a running coin layer');
		if (l.asks) fail('a question is still open: prove it, or fail it');
		if (!l.last || time < l.last + ZONE.quiet) fail('its operator has not been silent for 7 days');
		return () => { settle(s, id, l, time); const back = l.bond; l.bond = 0; stop(s, id, l, time, bank); if (back) bank.add(l.by, 'DZY', back); };
	},
	/** a withdrawal in a batch that counts: anyone may send its proof, it pays whom the step names */
	'layer.claim'(s, _from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'n', 'i', 'op', 'root', 'path');
		const [id, l] = layerOf(s, d.id), op = checkOp(d.op), root = isHash(d.root) ? d.root : fail('root');
		if (op.k !== 'w') fail('that step takes nothing out');
		const b = s.lbatches && own(s.lbatches, batchKey(id, d.n as number)) ? s.lbatches[batchKey(id, d.n as number)] : fail('no such batch'), i = isNum(d.i, b.count - 1) ? (d.i as number) : fail('which step');
		if (!isNum(d.n) || (d.n as number) > counted(s, id, l, time).n) fail('that batch does not count yet');
		if (own(b.paid, String(i))) fail('already paid');
		if (!isPath(d.path, ZONE.stepDepth) || rootFrom(stepLeaf(i, op, root), i, d.path) !== b.steps) fail('that is not a step of that batch');
		if (l.held < op.a) fail('the layer does not hold that much');
		return () => { settle(s, id, l, time); b.paid[String(i)] = 1; l.held -= op.a; bank.add(op.to, l.asset, op.a); };
	},
	/** out of a stopped layer: your balance in the last state that counts */
	'layer.exit'(s, from, d, _id, _time, _c, bank) {
		need(s); only(d, 'id', 'at', 'bal', 'nonce', 'path');
		const [, l] = layerOf(s, d.id), at = place(d.at) ? (d.at as number) : fail('which account'), bal = isNum(d.bal) && (d.bal as number) > 0 ? (d.bal as number) : fail('bal');
		if (l.dead === undefined) fail('that layer is running: take coins out with a step there');
		if (own(l.out, 'a' + at)) fail('already taken out');
		if (!isNum(d.nonce) || !isPath(d.path, ZONE.depth) || rootFrom(acctLeaf(from, bal, d.nonce as number), at, d.path) !== l.root) fail('that is not your account in the last state that counts');
		if (l.held < bal) fail('the layer does not hold that much');
		return () => { l.out['a' + at] = 1; l.held -= bal; bank.add(from, l.asset, bal); };
	},
	/** out of a stopped layer: a deposit it had not used in the last state that counts */
	'layer.refund'(s, _from, d, _id, _time, _c, bank) {
		need(s); only(d, 'id', 'q', 'next', 'path');
		const [id, l] = layerOf(s, d.id), q = isNum(d.q) && (d.q as number) < l.deps ? (d.q as number) : fail('no such deposit');
		if (l.dead === undefined) fail('that layer is running');
		if (own(l.out, 'd' + q)) fail('already given back');
		if (!isNum(d.next) || !isPath(d.path, ZONE.depth) || rootFrom(metaLeaf(d.next as number), 0, d.path) !== l.root) fail('that is not the count of deposits in the last state that counts');
		if (q < (d.next as number)) fail('that deposit was used: it is in an account');
		const dep = s.ldeps![batchKey(id, q)];
		return () => { l.out['d' + q] = 1; l.held -= dep.amount; bank.add(dep.to, l.asset, dep.amount); };
	},
};
/** what layers hold, by asset (and DZY: bonds and deposits for questions) */
export function zoneHeld(s: Z, t: Record<string, number>) {
	for (const l of Object.values(s.layers ?? {})) { if (l.asset) t[l.asset] = (t[l.asset] ?? 0) + l.held; t.DZY += l.bond + l.asks * ZONE.askDeposit; }
}

/* ---------- an operator's own books (not part of the chain): what anyone running a coin layer needs ---------- */
class Tree {
	private levels: Map<number, string>[] = Array.from({ length: ZONE.depth + 1 }, () => new Map());
	set(i: number, leaf: string) { this.levels[0].set(i, leaf); let k = i; for (let d = 0; d < ZONE.depth; d++) { const l = k - (k & 1); k = Math.floor(k / 2); this.levels[d + 1].set(k, node(this.at(d, l), this.at(d, l + 1))); } }
	at(d: number, i: number) { return this.levels[d].get(i) ?? EMPTY[d]; }
	get root() { return this.at(ZONE.depth, 0); }
	path(i: number) { const out: string[] = []; let k = i; for (let d = 0; d < ZONE.depth; d++) { out.push(this.at(d, k ^ 1)); k = Math.floor(k / 2); } return out; }
}
export function stepTree(leaves: string[]) {
	const rows = [Array.from({ length: ZONE.maxSteps }, (_, i) => leaves[i] ?? EMPTY[0])];
	for (let d = 0; d < ZONE.stepDepth; d++) { const r = rows[d], up: string[] = []; for (let i = 0; i < r.length; i += 2) up.push(node(r[i], r[i + 1])); rows.push(up); }
	return { root: rows[ZONE.stepDepth][0], path: (i: number) => { const out: string[] = []; let k = i; for (let d = 0; d < ZONE.stepDepth; d++) { out.push(rows[d][k ^ 1]); k = Math.floor(k / 2); } return out; } };
}
interface Step { op: Op; prev: string; root: string; seen: Seen }
export class ZoneBooks {
	accts = new Map<number, { owner: string; bal: number; nonce: number }>();
	where = new Map<string, number>();
	private tree = new Tree(); private steps: Step[] = []; private before = START_ROOT; private next = 1;
	used = 0; n = 0;
	batches: { n: number; prev: string; root: string; steps: Step[]; tree: ReturnType<typeof stepTree> }[] = [];
	constructor() { this.tree.set(0, metaLeaf(0)); }
	get root() { return this.tree.root; }
	get waiting() { return this.steps.length; }
	private spot(owner: string) { return this.where.get(owner) ?? this.next; }
	private land(owner: string, amount: number, seen: Seen) {
		const i = this.spot(owner), a = this.accts.get(i);
		seen.tp = this.tree.path(i);
		if (a) { seen.tb = a.bal; seen.tn = a.nonce; a.bal += amount; } else { seen.te = true; this.accts.set(i, { owner, bal: amount, nonce: 0 }); this.where.set(owner, i); this.next = i + 1; }
		const x = this.accts.get(i)!; this.tree.set(i, acctLeaf(x.owner, x.bal, x.nonce));
	}
	private leave(i: number, a: number, seen: Seen) {
		const x = this.accts.get(i)!;
		seen.fo = x.owner; seen.fb = x.bal; seen.fn = x.nonce; seen.fp = this.tree.path(i);
		x.bal -= a; x.nonce += 1; this.tree.set(i, acctLeaf(x.owner, x.bal, x.nonce));
	}
	private done(op: Op, prev: string, seen: Seen) { this.steps.push({ op, prev, root: this.root, seen }); }
	deposit(dep: Dep) { const prev = this.root, seen: Seen = { mp: this.tree.path(0) }, op: Op = { k: 'd', q: this.used, i: this.spot(dep.to) }; this.used += 1; this.tree.set(0, metaLeaf(this.used)); this.land(dep.to, dep.amount, seen); this.done(op, prev, seen); }
	/** a step its owner signed (checked by the caller); throws if it cannot be */
	apply(op: Op) {
		if (op.k === 'd') throw new Error('use deposit');
		const x = this.accts.get(op.f);
		if (!x || x.nonce !== op.n || x.bal < op.a) throw new Error('that account cannot do this');
		if (op.k === 't' && (op.t !== this.spot(op.to) || op.t === op.f)) throw new Error('not that person\'s account');
		const prev = this.root, seen: Seen = {};
		this.leave(op.f, op.a, seen); if (op.k === 't') this.land(op.to, op.a, seen);
		this.done(op, prev, seen);
	}
	spotFor(owner: string) { return this.spot(owner); }
	/** close the batch: what to send with layer.anchor */
	seal() {
		if (!this.steps.length) throw new Error('nothing to write');
		if (this.steps.length > ZONE.maxSteps) throw new Error('too many steps');
		const steps = this.steps, tree = stepTree(steps.map((st, i) => stepLeaf(i, st.op, st.root)));
		this.n += 1; this.batches.push({ n: this.n, prev: this.before, root: this.root, steps, tree });
		const out = { n: this.n, prev: this.before, root: this.root, steps: tree.root, count: steps.length };
		this.before = this.root; this.steps = [];
		return out;
	}
	proof(n: number, i: number) { const b = this.batches[n - 1], st = b.steps[i]; return { n, i, op: st.op, prev: st.prev, root: st.root, path: b.tree.path(i), seen: st.seen, ...(i ? { before: b.steps[i - 1].op, bpath: b.tree.path(i - 1) } : {}) }; }
	claim(n: number, i: number) { const b = this.batches[n - 1], st = b.steps[i]; return { n, i, op: st.op, root: st.root, path: b.tree.path(i) }; }
	exit(owner: string) { const at = this.where.get(owner)!, x = this.accts.get(at)!; return { at, bal: x.bal, nonce: x.nonce, path: this.tree.path(at) }; }
	acct(owner: string) { return this.exit(owner); }
	unused() { return { next: this.used, path: this.tree.path(0) }; }
}
