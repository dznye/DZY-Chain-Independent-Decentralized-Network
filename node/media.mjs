// Creators' pictures, kept by every node (20 November 2026). The chain's records point at pictures by an address that
// carries the picture's fingerprint: /media/<page address>/<first 32 hex digits of the picture's SHA-256>. A node reads
// those pointers from its own copy of the chain (page photos and banners, posts, item covers), copies each picture
// ONCE (from other nodes first, the wallet's site last), checks the bytes against the fingerprint, keeps them on its
// disk, and serves them at the same address. So a creator who runs a node keeps every public picture of every page,
// even if wallet.dznye.com goes away; and no node can swap a picture: a changed byte changes the fingerprint.
// Paid full pictures are not copied: their address is sealed (only buyers see it), so no node can know it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const POINTER = /^\/media\/([0-9a-f]{64})\/([0-9a-f]{32})$/;
const MAX = 400_000, PER_ROUND = 40;
const TYPES = [['image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'], ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff], ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG']];
export const typeOf = (b) => TYPES.find(([, ok]) => ok(b))?.[0] ?? null;
export const fingerprintOk = (bytes, id) => createHash('sha256').update(bytes).digest('hex').slice(0, 32) === id;

/** every picture the chain's records point at: [page address, id] */
export function pointers(state) {
	const out = new Map();
	const walk = (v, depth = 0) => {
		if (depth > 4 || v === null || v === undefined) return;
		if (typeof v === 'string') { const m = v.match(POINTER); if (m) out.set(m[1] + '/' + m[2], [m[1], m[2]]); return; }
		if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
		if (typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
	};
	for (const r of Object.values(state?.records ?? {})) walk(r?.value);
	return [...out.values()];
}

/** the keeper: `dir` holds the pictures; `sources()` lists where to copy from (nodes, then the site) */
export function mediaKeeper({ dir, sources, fetchFn = fetch }) {
	const path = (addr, id) => join(dir, addr, id);
	const has = (addr, id) => existsSync(path(addr, id));
	/** one picture from the first source that has the real thing; true when kept */
	async function copy(addr, id) {
		for (const src of sources()) {
			try {
				const r = await fetchFn(`${src.replace(/\/+$/, '')}/media/${addr}/${id}`, { signal: AbortSignal.timeout(8000) });
				if (!r.ok) continue;
				const b = Buffer.from(await r.arrayBuffer());
				if (b.length > MAX || !typeOf(b) || !fingerprintOk(b, id)) continue; // a wrong or changed picture: try the next source
				mkdirSync(join(dir, addr), { recursive: true });
				writeFileSync(path(addr, id), b);
				return true;
			} catch { /* not answering: the next source */ }
		}
		return false;
	}
	/** one round: copy up to PER_ROUND pictures this node does not have yet; returns how many were added */
	async function round(state) {
		let added = 0;
		for (const [addr, id] of pointers(state)) {
			if (added >= PER_ROUND) break;
			if (!has(addr, id) && (await copy(addr, id))) added++;
		}
		return added;
	}
	/** serve GET /media/<addr>/<id>: { status, body, type } */
	function serve(pathname) {
		const m = pathname.match(POINTER);
		if (!m || !has(m[1], m[2])) return null;
		const b = readFileSync(path(m[1], m[2]));
		return { status: 200, body: b, type: typeOf(b) ?? 'application/octet-stream' };
	}
	return { round, serve, has, copy };
}
