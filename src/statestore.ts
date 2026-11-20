// Keeping the state on disk one entry at a time, so a block writes what it changed, not the whole state.
//
// Every entry of every keyed collection (layer.ts COLLECTIONS) is one row: its collection, key, value, its position
// (so the order of keys, which some loops depend on, comes back exactly), and its leaf hash and bucket in the
// fingerprint tree (root.ts). The tree's nodes are rows too. The rest of the state (small) is one value.
// After a restart the state is read back row by row, and the tree is put back only if it gives exactly the last
// block's fingerprint; otherwise the node computes it from nothing (slower, never wrong).
// Used by both hosts: Cloudflare (worker/index.ts) and a PC (node/server.mjs), through a tiny SQL adapter.
import { COLLECTIONS, takeDelta } from './layer.ts';
import { primeTree, treeForStore } from './root.ts';
import type { State } from './ledger.ts';

type Obj = Record<string, unknown>;
/** run one statement; returns its rows (none for a write) */
export type Sql = (sql: string, ...args: (string | number | null)[]) => Record<string, unknown>[];
const PATH = new Map(COLLECTIONS);
const at = (s: Obj, path: string[]): Obj | undefined => { let o: unknown = s; for (const p of path) { o = (o as Obj | undefined)?.[p]; if (o === undefined || o === null) return undefined; } return o as Obj; };

export function stateTables(q: Sql) {
	q('CREATE TABLE IF NOT EXISTS entries (c TEXT NOT NULL, k TEXT NOT NULL, o INTEGER NOT NULL, v TEXT NOT NULL, h TEXT, b TEXT, PRIMARY KEY (c, k))');
	q('CREATE INDEX IF NOT EXISTS entries_order ON entries (c, o)');
	q('CREATE TABLE IF NOT EXISTS tree (p TEXT PRIMARY KEY, h TEXT NOT NULL)');
	q('CREATE TABLE IF NOT EXISTS rows_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
}
const getMeta = (q: Sql, k: string) => { const r = q('SELECT v FROM rows_meta WHERE k = ?', k)[0]; return r ? String(r.v) : null; };
const setMeta = (q: Sql, k: string, v: string) => { q('INSERT OR REPLACE INTO rows_meta (k, v) VALUES (?, ?)', k, v); };

/** the state without its keyed collections, as text */
function restText(s: Obj): string {
	const top: Obj = { ...s };
	for (const [, p] of COLLECTIONS) if (p.length === 1) delete top[p[0]];
	if (s.sun) {
		const u: Obj = { ...(s.sun as Obj) };
		for (const [, p] of COLLECTIONS) if (p[0] === 'sun' && p.length === 2) delete u[p[1]];
		if (u.credit) { const c: Obj = { ...(u.credit as Obj) }; delete c.out; delete c.bad; u.credit = c; }
		top.sun = u;
	}
	return JSON.stringify(top);
}

/** Save the state after a block (call inside the host's transaction with the block). `root`: the block's stateRoot.
    `putRest(text)` stores the rest of the state (the host may split a big value). */
export function saveState(q: Sql, s: State, root: string, putRest: (text: string) => void) {
	const st = s as unknown as Obj, delta = takeDelta(st);
	const full = !delta || getMeta(q, 'height') !== String(s.height - 1);
	let seq = Number(getMeta(q, 'seq') ?? 0);
	const write = (name: string, k: string, append: boolean) => {
		const v = at(st, PATH.get(name)!)?.[k];
		if (v === undefined) { q('DELETE FROM entries WHERE c = ? AND k = ?', name, k); return; }
		if (append) q('INSERT INTO entries (c, k, o, v) VALUES (?, ?, ?, ?) ON CONFLICT (c, k) DO UPDATE SET o = excluded.o, v = excluded.v', name, k, ++seq, JSON.stringify(v)); // to the end; its hash stays
		else if (!q('SELECT 1 AS x FROM entries WHERE c = ? AND k = ?', name, k).length) q('INSERT INTO entries (c, k, o, v) VALUES (?, ?, ?, ?)', name, k, ++seq, JSON.stringify(v));
		else q('UPDATE entries SET v = ? WHERE c = ? AND k = ?', JSON.stringify(v), name, k);
	};
	const rewrite = (name: string) => {
		q('DELETE FROM entries WHERE c = ?', name);
		const m = at(st, PATH.get(name)!);
		if (m) for (const k of Object.keys(m)) q('INSERT INTO entries (c, k, o, v) VALUES (?, ?, ?, ?)', name, k, ++seq, JSON.stringify(m[k]));
	};
	if (full) { q('DELETE FROM entries'); for (const [name] of COLLECTIONS) rewrite(name); }
	else {
		for (const name of delta!.whole) rewrite(name);
		for (const [id, op] of delta!.ops) {
			const sep = id.indexOf('\0'), name = id.slice(0, sep);
			if (!delta!.whole.has(name)) write(name, id.slice(sep + 1), op === 'append');
		}
	}
	putRest(restText(st));
	setMeta(q, 'seq', String(seq)); setMeta(q, 'height', String(s.height));
	setMeta(q, 'present', JSON.stringify(COLLECTIONS.filter(([, p]) => at(st, p) !== undefined).map(([n]) => n))); // empty ones too
	// the fingerprint tree, when the node's cache is this state's; else none is kept, and a restart computes it.
	// Changes alone are enough only over a complete saved tree (a collection rewritten whole: its leaves are all among the changes).
	const tree = treeForStore(s, root);
	if (!tree || (!tree.all && (full || getMeta(q, 'tree') !== '1'))) { setMeta(q, 'tree', '0'); return; }
	if (tree.all) { q('DELETE FROM tree'); q('UPDATE entries SET h = NULL, b = NULL'); }
	for (const [id, l] of tree.leaves) {
		const sep = id.indexOf('\0');
		q('UPDATE entries SET h = ?, b = ? WHERE c = ? AND k = ?', l ? l.hash : null, l ? l.bucket : null, id.slice(0, sep), id.slice(sep + 1));
	}
	for (const [p, h] of tree.nodes) { if (h) q('INSERT OR REPLACE INTO tree (p, h) VALUES (?, ?)', p, h); else q('DELETE FROM tree WHERE p = ?', p); }
	setMeta(q, 'tree', '1');
}

/** The state as saved, or null if nothing was saved this way. `getRest()` returns what putRest stored. */
export function loadState(q: Sql, getRest: () => string | null): State | null {
	if (getMeta(q, 'height') === null) return null;
	const text = getRest();
	if (!text) return null;
	const s = JSON.parse(text) as Obj, present = new Set(JSON.parse(getMeta(q, 'present') ?? '[]') as string[]);
	for (const [name, path] of COLLECTIONS) {
		const rows = q('SELECT k, v FROM entries WHERE c = ? ORDER BY o', name);
		if (!rows.length && !present.has(name)) continue;
		const m: Obj = {};
		for (const r of rows) m[String(r.k)] = JSON.parse(String(r.v));
		let o = s;
		for (const p of path.slice(0, -1)) { if (!o[p]) break; o = o[p] as Obj; }
		o[path[path.length - 1]] = m;
	}
	return s as unknown as State;
}

/** After loadState: put the saved fingerprint tree back into the cache if it gives exactly `root` (the last block's). */
export async function loadTree(q: Sql, s: State, root: string): Promise<boolean> {
	if (getMeta(q, 'tree') !== '1') return false;
	const leaves = q('SELECT c, k, h, b FROM entries WHERE h IS NOT NULL').map((r) => [String(r.c) + '\0' + String(r.k), String(r.h), String(r.b)] as [string, string, string]);
	const nodes = q('SELECT p, h FROM tree').map((r) => [String(r.p), String(r.h)] as [string, string]);
	return primeTree(s, root, leaves, nodes);
}
