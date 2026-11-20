// State layers: the next state as a thin layer over the current one, instead of a full copy of it.
//
// fork(base) gives a state whose big keyed collections (root.ts COLLECTIONS: accounts, locks, deposits, ...) are
// layers over the base's: an entry is copied into the layer the first time it is read through it, and every change
// stays in the layer. The rest of the state (small) is copied whole. The base is never changed by the layer, so several
// layers can share one base (the candidate blocks of one height). commit(layer) then writes the layer's changes into
// its base: the base becomes the next state, at the cost of what the block touched, not of the size of the chain.
//
// A layer behaves exactly like a plain object, key order included (some loops depend on it): keys that look like array
// indexes come first in ascending order, then the others in the order they were added; a deleted key that is added
// again goes to the end. (Tested against plain objects: layer.test.mjs.)
/** the keyed collections: a name used in the leaf, and where it is in the state */
export const COLLECTIONS: [string, string[]][] = [
	['account', ['accounts']], ['asset', ['assets']], ['offer', ['offers']], ['stake', ['stakes']], ['name', ['names']],
	['contract', ['contracts']], ['channel', ['channels']], ['swap', ['swaps']], ['gift', ['gifts']], ['stream', ['streams']],
	['record', ['records']], ['shop', ['shops']], ['task', ['tasks']], ['xoffer', ['xoffers']], ['liquidity', ['liquidity']],
	['vault', ['vaults']], ['position', ['positions']], ['delegation', ['delegations']], ['undelegating', ['undelegating']],
	['proposal', ['proposals']],
	['sun.lock', ['sun', 'locks']], ['sun.deposit', ['sun', 'deposits']], ['sun.event', ['sun', 'events']], ['sun.round', ['sun', 'rounds']],
	['sun.claim', ['sun', 'claims']], ['sun.paid', ['sun', 'paid']], ['sun.credit', ['sun', 'credit', 'out']], ['sun.bad', ['sun', 'credit', 'bad']],
	['sun.worked', ['sun', 'worked']], ['sun.free', ['sun', 'free']], ['node', ['nodes']],
	['xpay', ['xpays']], ['xseen', ['xseen']], ['xclaim', ['xclaims']], ['market', ['markets']], ['round', ['rounds']],
	['owned', ['owned']], ['sale', ['sales']], ['tipbox', ['tipboxes']], // creators (tip, item.buy)
	['order', ['orders']], ['feeowed', ['feeOwed']], // checkout from any wallet (order.*)
];

type Obj = Record<string, unknown>;
const TOMB = Symbol('deleted');
const RAW = Symbol('layer');
const own = (o: object, k: string) => Object.hasOwn(o, k);
const isIndex = (k: string) => /^(0|[1-9]\d{0,9})$/.test(k) && Number(k) < 4294967295;

/** one collection's layer: its parent (a plain object or another layer) and what changed over it */
class Layer {
	over = new Map<string, unknown>(); // key -> value, or TOMB; in the order a plain object would hold the keys added here
	moved = new Set<string>();         // keys the parent has that were deleted here and added again (they go to the end)
	dead: Obj | null = null;           // after commit: the base it was written into (reads go there; writes are refused)
	parent: Obj;
	constructor(parent: Obj) { this.parent = parent; }
	visible(k: string): boolean {
		if (this.dead) return own(this.dead, k);
		if (this.over.has(k)) return this.over.get(k) !== TOMB;
		return has(this.parent, k);
	}
	/** the value without copying it (for reading only) */
	peek(k: string): unknown {
		if (this.dead) return own(this.dead, k) ? this.dead[k] : undefined;
		if (this.over.has(k)) { const v = this.over.get(k); return v === TOMB ? undefined : v; }
		return peek(this.parent, k);
	}
	keys(): string[] {
		if (this.dead) return Object.keys(this.dead);
		const out: string[] = [];
		for (const k of keysOf(this.parent)) { if (this.over.has(k) && (this.over.get(k) === TOMB || this.moved.has(k))) continue; out.push(k); }
		const inParent = new Set(out);
		for (const [k, v] of this.over) if (v !== TOMB && !inParent.has(k) && (this.moved.has(k) || !has(this.parent, k))) out.push(k);
		const idx = out.filter(isIndex).sort((a, b) => Number(a) - Number(b));
		return idx.length ? [...idx, ...out.filter((k) => !isIndex(k))] : out;
	}
}
const layerOf = (m: unknown): Layer | undefined => (m && typeof m === 'object' ? (m as { [RAW]?: Layer })[RAW] : undefined);
function has(m: Obj, k: string): boolean { const l = layerOf(m); return l ? l.visible(k) : own(m, k); }
/** a value in a collection (plain or layer) without copying it: for reading only */
export function peek(m: Obj, k: string): unknown { const l = layerOf(m); return l ? l.peek(k) : own(m, k) ? m[k] : undefined; }
/** a collection's keys (plain or layer), in a plain object's order, without copying anything */
export function keysOf(m: Obj): string[] { const l = layerOf(m); return l ? l.keys() : Object.keys(m); }

function layered(parent: Obj): Obj {
	const L = new Layer(parent);
	const write = () => { if (L.dead) throw new Error('this state was already committed: use the state it was committed into'); };
	return new Proxy({}, {
		get(_t, k) {
			if (k === RAW) return L;
			if (typeof k === 'symbol') return (Object.prototype as Record<symbol, unknown>)[k];
			if (L.dead) return own(L.dead, k) ? L.dead[k] : (Object.prototype as Obj)[k];
			if (L.over.has(k)) { const v = L.over.get(k); return v === TOMB ? undefined : v; }
			if (!has(L.parent, k)) return (Object.prototype as Obj)[k]; // like a plain object: its inherited methods
			const v = peek(L.parent, k), c = v !== null && typeof v === 'object' ? structuredClone(v) : v; // copied the first time it is read
			L.over.set(k, c);
			return c;
		},
		set(_t, k, v) {
			if (typeof k === 'symbol') return false;
			write();
			if (L.over.get(k) === TOMB) { L.over.delete(k); L.moved.add(k); } // added again after a delete: to the end
			L.over.set(k, v);
			return true;
		},
		deleteProperty(_t, k) {
			if (typeof k === 'symbol') return true;
			write();
			if (!L.visible(k)) return true;
			if (has(L.parent, k)) L.over.set(k, TOMB); else { L.over.delete(k); L.moved.delete(k); }
			return true;
		},
		has(_t, k) { return typeof k === 'string' && L.visible(k); },
		ownKeys() { return L.keys(); },
		getOwnPropertyDescriptor(_t, k) {
			if (typeof k !== 'string' || !L.visible(k)) return undefined;
			return { value: L.peek(k), writable: true, enumerable: true, configurable: true };
		},
		defineProperty(_t, k, d) { if (typeof k === 'symbol' || !('value' in d)) return false; write(); if (L.over.get(k) === TOMB) { L.over.delete(k); L.moved.add(k); } L.over.set(k, d.value); return true; },
		getPrototypeOf() { return Object.prototype; },
	});
}

/* ---------- whole states ---------- */
const at = (s: Obj, path: string[]): Obj | undefined => { let o: unknown = s; for (const p of path) { o = (o as Obj | undefined)?.[p]; if (o === undefined || o === null) return undefined; } return o as Obj; };
interface Info { parent: Obj; depth: number; version: number; dead?: Obj }
const INFO = new WeakMap<object, Info>();
const VERSION = new WeakMap<object, number>(); // a base's commit count: a layer made from an older version is stale
const MAX_DEPTH = 8; // a layer of a layer of ... (tests chain blocks without committing): flattened past this

/** how many layers have been committed into this state (a cache of it is only good for the same count) */
export const versionOf = (s: object) => VERSION.get(s) ?? 0;
/** A state that only ever changes by commit (a node's own live state): a fingerprint cache may trust it. A plain state
    changed directly (applyTx on it, as tests do) must never be sealed. */
const SEALED = new WeakSet<object>();
export const seal = (s: object) => { SEALED.add(s); };
export const isSealed = (s: object) => SEALED.has(s);
/** hand a sealed state to code that may change it directly: no cache trusts it any more */
export const unseal = (s: object) => { SEALED.delete(s); };
/** told after every commit: (the layer, the state it was written into) */
type Changes = [string, string | null][];
const LISTENERS: ((layer: object, base: object, changed: Changes, before: number) => void)[] = [];
export const onCommit = (f: (layer: object, base: object, changed: Changes, before: number) => void) => { LISTENERS.push(f); };
/** What commits did to a state's keyed collections since a store last took it: per entry, 'set' (changed in place),
    'append' (added, or deleted and added again: it moves to the end) or 'del'; and collections replaced whole. */
export interface Delta { ops: Map<string, 'set' | 'append' | 'del'>; whole: Set<string> }
const DELTA = new WeakMap<object, Delta>();
function deltaOf(s: object): Delta { let d = DELTA.get(s); if (!d) DELTA.set(s, (d = { ops: new Map(), whole: new Set() })); return d; }
function note(d: Delta, id: string, op: 'set' | 'append' | 'del') {
	const was = d.ops.get(id);
	d.ops.set(id, op === 'set' && was === 'append' ? 'append' : op); // an entry added then changed is still added
}
/** the changes recorded since the last call (null when none were recorded: the store writes everything) */
export function takeDelta(s: object): Delta | null { const d = DELTA.get(s) ?? null; DELTA.delete(s); return d; }
/** is this state a layer (made by fork and not yet committed)? */
export const isLayer = (s: object) => { const i = INFO.get(s); return !!i && !i.dead; };
/** the state a layer was made from (undefined for a plain state) */
export const parentOf = (s: object) => { const i = INFO.get(s); return i && !i.dead ? i.parent : undefined; };

/** the state without its keyed collections, copied (the small part every layer copies whole) */
function restCopy(s: Obj): Obj {
	const top: Obj = { ...s };
	const sun = s.sun as Obj | undefined;
	if (sun) {
		const u: Obj = { ...sun };
		if (sun.credit) { const c: Obj = { ...(sun.credit as Obj) }; delete c.out; delete c.bad; u.credit = c; }
		for (const [, p] of COLLECTIONS) if (p[0] === 'sun' && p.length === 2) delete u[p[1]];
		top.sun = u;
	}
	for (const [, p] of COLLECTIONS) if (p.length === 1) delete top[p[0]];
	return structuredClone(top);
}
function setAt(s: Obj, path: string[], v: unknown) {
	let o = s;
	for (const p of path.slice(0, -1)) { if (!o[p]) return; o = o[p] as Obj; }
	if (v === undefined) delete o[path[path.length - 1]]; else o[path[path.length - 1]] = v;
}

/** A plain, independent copy of any state (a layer included), in a plain object's key order. */
export function plain<T extends object>(s: T): T {
	const out = restCopy(s as Obj);
	for (const [, path] of COLLECTIONS) {
		const m = at(s as Obj, path);
		if (!m) continue;
		const c: Obj = {};
		for (const k of keysOf(m)) c[k] = structuredClone(peek(m, k));
		setAt(out, path, c);
	}
	return out as T;
}

/** The next state as a layer over `s` (which it never changes). */
export function fork<T extends object>(s: T): T {
	let base = s as Obj;
	const i = INFO.get(base);
	if (i?.dead) base = i.dead;
	const depth = (INFO.get(base) && !INFO.get(base)!.dead ? INFO.get(base)!.depth : 0) + 1;
	if (depth > MAX_DEPTH) return fork(plain(base as T)); // a long chain of uncommitted layers: start again from a plain copy
	const child = restCopy(base);
	for (const [, path] of COLLECTIONS) { const m = at(base, path); if (m) setAt(child, path, layered(m)); }
	INFO.set(child, { parent: base, depth, version: VERSION.get(base) ?? 0 });
	return child as T;
}

const same = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a), kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) if (!own(b, k) || !same((a as Obj)[k], (b as Obj)[k])) return false;
	return true;
};

/** What a layer changed in its parent's keyed collections, by content: [collection name, key] (key null: the whole
    collection was replaced, added or removed). Entries only read, or written back unchanged, are not changes. */
export function changes(s: object): [string, string | null][] {
	const i = INFO.get(s);
	if (!i || i.dead) throw new Error('not a layer');
	const out: [string, string | null][] = [];
	for (const [name, path] of COLLECTIONS) {
		const m = at(s as Obj, path), pm = at(i.parent, path), L = layerOf(m);
		if (L && !L.dead && pm && L.parent === pm) {
			for (const [k, v] of L.over) {
				const before = peek(pm, k), had = has(pm, k);
				if (v === TOMB ? had : !had || !same(before, v)) out.push([name, k]);
			}
		} else if (m !== pm) out.push([name, null]);
	}
	return out;
}

/** Write a layer into the state it was made from, which becomes the next state; returns it. The layer must have
    been made from the base as it is now (not from an older version of it), and cannot be used to change anything
    afterwards (reading it reads the base). */
export function commit<T extends object>(layer: T): T {
	const i = INFO.get(layer);
	if (!i) return layer; // already a plain state
	if (i.dead) return i.dead as T;
	const base = i.parent;
	if (INFO.get(base) && !INFO.get(base)!.dead) throw new Error('commit the layer underneath first');
	if ((VERSION.get(base) ?? 0) !== i.version) throw new Error('this layer was made from an older version of its state');
	const s = layer as Obj, changed = changes(layer), before = VERSION.get(base) ?? 0;
	const d = deltaOf(base), content = new Set(changed.map(([n, k]) => n + '\0' + k));
	for (const [name, path] of COLLECTIONS) {
		const m = at(s, path), pm = at(base, path), L = layerOf(m);
		if (L && pm && L.parent === pm) {
			for (const [k, v] of L.over) {
				const id = name + '\0' + k;
				if (v === TOMB) { if (own(pm, k)) { delete pm[k]; note(d, id, 'del'); } continue; }
				if (L.moved.has(k) || !own(pm, k)) { delete pm[k]; pm[k] = v; note(d, id, 'append'); }
				else { pm[k] = v; if (content.has(id)) note(d, id, 'set'); }
			}
			L.dead = pm; L.over.clear(); L.moved.clear();
		} else if (m !== pm) d.whole.add(name);
	}
	// the rest of the state, and whole collections the layer added, replaced or removed
	const keep = new Map<string[], unknown>();
	for (const [, path] of COLLECTIONS) { const m = at(s, path), L = layerOf(m); keep.set(path, L ? L.dead : m); }
	const rest = restCopy(s);
	const sunRest = rest.sun as Obj | undefined;
	for (const k of Object.keys(base)) if (!own(rest, k)) delete base[k];
	for (const [k, v] of Object.entries(rest)) if (k !== 'sun') base[k] = v;
	if (sunRest) {
		const bs = (base.sun ??= {}) as Obj;
		const keepCredit = bs.credit as Obj | undefined;
		for (const k of Object.keys(bs)) if (!own(sunRest, k) && !COLLECTIONS.some(([, p]) => p[0] === 'sun' && p[1] === k)) delete bs[k];
		for (const [k, v] of Object.entries(sunRest)) if (k !== 'credit') bs[k] = v;
		if (sunRest.credit) { const c = (keepCredit ?? {}) as Obj; for (const k of Object.keys(c)) if (k !== 'out' && k !== 'bad' && !own(sunRest.credit as Obj, k)) delete c[k]; Object.assign(c, sunRest.credit); bs.credit = c; }
		else delete bs.credit;
	} else delete base.sun;
	for (const [path, m] of keep) setAt(base, path, m);
	VERSION.set(base, (VERSION.get(base) ?? 0) + 1);
	i.dead = base;
	for (const f of LISTENERS) f(layer, base, changed, before);
	for (const k of Object.keys(s)) delete s[k]; // the layer's own object now reads as the base (see below)
	Object.assign(s, base);
	return base as T;
}
