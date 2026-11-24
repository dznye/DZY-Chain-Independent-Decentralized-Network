// The state's fingerprint (the stateRoot every block carries), built so a block costs work in proportion to what it
// CHANGED, not to how many accounts exist.
//
// Every entry of every keyed collection (an account, an asset, a lock, a deposit, a name, ...) is one leaf:
//   leaf = sha256('leaf:' + canon([collection, key, value]))
// Each leaf sits in one of 16,777,216 buckets, chosen by its key: a key that is 64 lower-case hex digits (an address,
// already a hash) by its own first 6 digits; any other key by the first 6 hex digits of sha256('key:' + collection +
// ':' + key). The buckets hang from a fixed tree, 256 wide at every level:
//   bucket  = sha256('bucket:' + its leaves' hashes, in order of collection then key)
//   level 2 = sha256('node:' + each non-empty bucket under it, as its 2 hex digits + its hash), and the same for
//   level 1 and the top. The rest of the state (everything that is not a keyed collection) is one more leaf.
//   root    = sha256('root:' + rest + ':' + top)      (an empty tree's top is sha256('dzy-empty'))
// A changed leaf re-hashes its bucket and the three nodes above it, nothing else, whatever the size of the chain.
//
// How a node finds what changed (never part of the result): a block's state is a layer over the state before it
// (layer.ts), which knows exactly which entries it changed. RootCache remembers the tree of the last state it
// fingerprinted; from there a block re-hashes only its changes. With no cache that fits, everything is hashed.
// A warm and a cold node always agree (root.test.mjs; set globalThis.DZNYE_ROOT_CHECK to check every block).
import { canon, sha256 } from './crypto.ts';
import { changes, COLLECTIONS, isLayer, isSealed, keysOf, onCommit, parentOf, peek, versionOf } from './layer.ts';

export { COLLECTIONS };
type Obj = Record<string, unknown>;
const at = (s: Obj, path: string[]): Obj | undefined => { let o: unknown = s; for (const p of path) { o = (o as Obj | undefined)?.[p]; if (o === undefined || o === null) return undefined; } return o as Obj; };
const PATH = new Map(COLLECTIONS);

/** everything the fingerprint covers that is not a keyed collection (the Sun without its collections) */
function rest(s: Obj): Obj {
	const sun = s.sun as Obj | undefined;
	let sunRest: Obj | undefined;
	if (sun) {
		sunRest = { ...sun };
		for (const [, p] of COLLECTIONS) if (p[0] === 'sun' && p.length === 2) delete sunRest[p[1]];
		if (sun.credit) { const { out: _o, bad: _b, ...c } = sun.credit as Obj; sunRest.credit = c; }
	}
	return { pools: s.pools, started: s.started, validators: s.validators, fee: s.fee || undefined, staked: s.staked || undefined,
		treasury: s.treasury || undefined, trades: s.trades, swapLog: s.swapLog, sun: sunRest, crew: s.crew, ...(s.heart ? { all: everything(s) } : {}) };
}
/** From the Heart upgrade on, the fingerprint covers the WHOLE state: every other field too (the exchange's vaults, locks
    and pots, the creators' fee, the recent hashes...), so two nodes that differ anywhere can never agree on a block, and a
    copy handed to a new node cannot be altered anywhere. Left out: the collections (leaves of their own), what is listed
    above, and the block's own height, time and hash, which are set after. */
const COVERED = new Set(['pools', 'started', 'validators', 'fee', 'staked', 'treasury', 'trades', 'swapLog', 'sun', 'crew', 'height', 'time', 'last', ...COLLECTIONS.filter(([, p]) => p.length === 1).map(([, p]) => p[0])]);
function everything(s: Obj): Obj {
	const out: Obj = {};
	for (const k of Object.keys(s)) if (!COVERED.has(k) && s[k] !== undefined) out[k] = s[k];
	return out;
}

interface Leaf { hash: string; bucket: string }
export class RootCache {
	leaves = new Map<string, Leaf>();              // collection + '\0' + key
	inBucket = new Map<string, Set<string>>();     // bucket (6 hex) -> its leaves
	node = new Map<string, string>();              // '' (top), 2 or 4 hex digits, or a bucket's 6 -> its hash
	/** the state this tree is of, its version; or a layer of `atParent`, which changed `atChanged` */
	at: object | null = null; atVersion = 0; atParent: object | null = null; atChanged: [string, string | null][] = [];
	fix: [string, string | null][] = []; // changes made to `at` since this tree was right (a commit of a layer it did not see)
	root = '';
	/** what changed in this tree since a store last saved it (leaf ids, node keys); all: everything (rebuilt) */
	touched = { leaves: new Set<string>(), nodes: new Set<string>(), all: true };
	constructor() { ALL.add(new WeakRef(this)); }
}
/** every cache in this program, so a commit can tell each one (layer.ts onCommit) */
const ALL = new Set<WeakRef<RootCache>>();

const EMPTY = sha256('dzy-empty');
let checking = false; // the check itself computes a fingerprint: it must not check that one too
const HEX64 = /^[0-9a-f]{64}$/; // a key that is already a hash (an address): its own first 6 digits are its bucket
const TWO = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
/** a node's hash from its non-empty children (each as its last 2 hex digits + its hash), or null when it has none */
async function nodeHash(c: RootCache, prefix: string): Promise<string | null> {
	const parts: string[] = [];
	for (let i = 0; i < 256; i++) { const h = c.node.get(prefix + TWO[i]); if (h) parts.push(TWO[i] + h); }
	return parts.length ? sha256('node:' + parts.join('')) : null;
}

/** re-hash these leaves (as they are in `s`; gone ones removed), their buckets and the nodes above them */
async function update(s: Obj, c: RootCache, ids: Iterable<string>): Promise<void> {
	const dirty = new Set<string>(), todo: [string, string, string, unknown][] = [];
	for (const id of ids) {
		const sep = id.indexOf('\0'), name = id.slice(0, sep), key = id.slice(sep + 1), m = at(s, PATH.get(name)!);
		const v = m ? peek(m, key) : undefined, old = c.leaves.get(id);
		if (v === undefined) { if (old) { c.leaves.delete(id); c.inBucket.get(old.bucket)!.delete(id); dirty.add(old.bucket); touch(c, id, null); } continue; }
		todo.push([id, name, key, v]);
	}
	const hashed = await Promise.all(todo.map(async ([id, name, key, v]) => {
		const bucket = c.leaves.get(id)?.bucket ?? (HEX64.test(key) ? key.slice(0, 6) : (await sha256('key:' + name + ':' + key)).slice(0, 6));
		return { id, bucket, hash: await sha256('leaf:' + canon([name, key, v])) };
	}));
	for (const { id, bucket, hash } of hashed) {
		c.leaves.set(id, { hash, bucket }); touch(c, id, null);
		let set = c.inBucket.get(bucket); if (!set) c.inBucket.set(bucket, (set = new Set()));
		set.add(id); dirty.add(bucket);
	}
	await Promise.all([...dirty].map(async (b) => {
		const ids = [...(c.inBucket.get(b) ?? [])].sort();
		touch(c, null, b);
		if (!ids.length) { c.node.delete(b); c.inBucket.delete(b); return; }
		c.node.set(b, await sha256('bucket:' + ids.map((id) => c.leaves.get(id)!.hash).join('')));
	}));
	for (const len of [4, 2, 0]) {
		const parents = new Set([...dirty].map((b) => b.slice(0, len)));
		await Promise.all([...parents].map(async (p) => { const h = await nodeHash(c, p); if (h) c.node.set(p, h); else c.node.delete(p); touch(c, null, p); }));
		dirty.clear(); for (const p of parents) dirty.add(p);
	}
}
function touch(c: RootCache, id: string | null, node: string | null) {
	const t = c.touched;
	if (t.all) return;
	if (id !== null) t.leaves.add(id); if (node !== null) t.nodes.add(node);
	if (t.leaves.size > 2_000_000) c.touched = { leaves: new Set(), nodes: new Set(), all: true }; // never saved (no store): stop counting
}
/** every leaf id a state has (read without copying anything) */
function allIds(s: Obj, only?: string): string[] {
	const out: string[] = [];
	for (const [name, path] of COLLECTIONS) { if (only && name !== only) continue; const m = at(s, path); if (m) for (const k of keysOf(m)) if (peek(m, k) !== undefined) out.push(name + '\0' + k); }
	return out;
}
/** the leaf ids a list of changes touches, in `s` and in the cache (a whole collection: every key in either) */
function idsOf(s: Obj, c: RootCache, list: [string, string | null][]): Set<string> {
	const ids = new Set<string>();
	for (const [name, key] of list) {
		if (key !== null) { ids.add(name + '\0' + key); continue; }
		for (const id of allIds(s, name)) ids.add(id);
		for (const id of c.leaves.keys()) if (id.startsWith(name + '\0')) ids.add(id);
	}
	return ids;
}

/** The fingerprint of a state. `cache` makes it incremental; without one it is computed from nothing (the same result). */
export async function stateRootOf(s: Obj, cache: RootCache = new RootCache()): Promise<string> {
	const P = parentOf(s);
	if (P && isLayer(s)) {
		const mine = changes(s);
		const trusted = isSealed(P) && cache.atVersion === versionOf(P); // the parent changes only by commit, and the cache is of its current version
		if (trusted && cache.at === P) await update(s, cache, idsOf(s, cache, [...cache.fix, ...mine]));
		else if (trusted && cache.atParent === P && cache.at && isLayer(cache.at)) await update(s, cache, idsOf(s, cache, [...cache.fix, ...cache.atChanged, ...mine])); // a sibling: undo its changes, apply ours
		else await rebuild(s, cache);
		cache.fix = []; cache.at = s; cache.atParent = P; cache.atVersion = versionOf(P); cache.atChanged = mine;
	} else if (cache.at === s && isSealed(s) && cache.atVersion === versionOf(s)) {
		if (cache.root && !cache.fix.length) return cache.root;
		await update(s, cache, idsOf(s, cache, cache.fix)); cache.fix = [];
	} else {
		await rebuild(s, cache);
		cache.fix = []; cache.at = s; cache.atParent = null; cache.atVersion = versionOf(s); cache.atChanged = [];
	}
	const top = cache.node.get('') ?? (await EMPTY);
	cache.root = await sha256('root:' + (await sha256('leaf:' + canon(['rest', rest(s)]))) + ':' + top);
	if ((globalThis as { DZNYE_ROOT_CHECK?: boolean }).DZNYE_ROOT_CHECK && !checking) {
		checking = true;
		let cold: string; try { cold = await stateRootOf(s, new RootCache()); } finally { checking = false; }
		if (cold !== cache.root) throw new Error(`the incremental fingerprint ${cache.root} is not the full one ${cold}`);
	}
	return cache.root;
}
async function rebuild(s: Obj, c: RootCache) {
	c.leaves.clear(); c.inBucket.clear(); c.node.clear();
	c.touched = { leaves: new Set(), nodes: new Set(), all: true };
	await update(s, c, allIds(s));
}

/* one cache per chain this program runs; after a commit, a cache of the layer is a cache of the state it went into */
const CACHES = new Map<string, RootCache>();
export function rootCacheFor(chain: string): RootCache {
	let c = CACHES.get(chain);
	if (!c) { if (CACHES.size >= 8) CACHES.clear(); CACHES.set(chain, (c = new RootCache())); }
	return c;
}
onCommit((layer, base, changed, before) => {
	for (const ref of ALL) {
		const c = ref.deref();
		if (!c) { ALL.delete(ref); continue; }
		if (c.at === layer) { c.at = base; c.atParent = null; c.atVersion = versionOf(base); c.atChanged = []; }
		else if (c.atVersion === before && (c.at === base || c.atParent === base)) {
			// the cache is of the base itself, or of another candidate over it: it becomes the new base's tree once the
			// winner's changes (and that candidate's) are re-hashed, on the next fingerprint
			c.fix = [...c.fix, ...(c.at === base ? [] : c.atChanged), ...changed];
			c.at = base; c.atParent = null; c.atVersion = versionOf(base); c.atChanged = []; c.root = '';
		}
	}
});

/** For a store: the cache's tree, if it is the tree of `s` with fingerprint `root`; and what changed in it since the
    last call (all: write everything). Null when the cache is of some other state (the store keeps no tree then). */
export function treeForStore(s: object, root: string): { all: boolean; leaves: Map<string, { hash: string; bucket: string } | null>; nodes: Map<string, string | null> } | null {
	const c = rootCacheFor((s as { chain: string }).chain);
	if (c.at !== s || c.root !== root || c.fix.length) return null;
	const t = c.touched, all = t.all;
	const leaves = new Map<string, { hash: string; bucket: string } | null>(), nodes = new Map<string, string | null>();
	for (const id of all ? c.leaves.keys() : t.leaves) leaves.set(id, c.leaves.get(id) ?? null);
	for (const p of all ? c.node.keys() : t.nodes) nodes.set(p, c.node.get(p) ?? null);
	c.touched = { leaves: new Set(), nodes: new Set(), all: false };
	return { all, leaves, nodes };
}
/** A tree a store kept, put back into the cache for `s` if it gives exactly the fingerprint `root` (the last block's).
    Returns whether it did; if not, the next fingerprint is computed from nothing. */
export async function primeTree(s: object, root: string, leaves: [string, string, string][], nodes: [string, string][]): Promise<boolean> {
	const c = rootCacheFor((s as { chain: string }).chain);
	c.leaves.clear(); c.inBucket.clear(); c.node.clear();
	for (const [id, hash, bucket] of leaves) {
		c.leaves.set(id, { hash, bucket });
		let set = c.inBucket.get(bucket); if (!set) c.inBucket.set(bucket, (set = new Set()));
		set.add(id);
	}
	for (const [p, h] of nodes) c.node.set(p, h);
	const top = c.node.get('') ?? (await EMPTY);
	const got = await sha256('root:' + (await sha256('leaf:' + canon(['rest', rest(s as Obj)]))) + ':' + top);
	if (got !== root || c.leaves.size !== allIds(s as Obj).length) { c.leaves.clear(); c.inBucket.clear(); c.node.clear(); c.at = null; c.root = ''; c.touched = { leaves: new Set(), nodes: new Set(), all: true }; return false; }
	c.at = s; c.atParent = null; c.atVersion = versionOf(s); c.atChanged = []; c.fix = []; c.root = root;
	c.touched = { leaves: new Set(), nodes: new Set(), all: false };
	return true;
}
