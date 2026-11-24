// Files kept by nodes (src/blobs.ts): pieces of big files on this node's disk, at most `budget` bytes, each checked against
// the chain's fingerprint before it is kept; small files rebuilt from the blocks. A node serves both, whole:
//   GET  /blob/<id>          the file (rebuilt here)         GET /blob/<id>/<piece>   one piece, as it is kept
//   POST /blob/<id>/<piece>  a piece someone hands over: kept only if it is exactly the one the chain names, and there is room
// What this node will not serve or keep is its owner's choice: `refuse` holds file ids, one a line (BLOB_REFUSE).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOB, SHOWN, fromBlocks, isAwake, pieceLen, pieceTree, proofOf, rebuild } from '../src/blobs.ts';

const HEX64 = /^[0-9a-f]{64}$/, WAY = /^\/blob\/([0-9a-f]{64})(?:\/(\d{1,2}))?$/;
export function blobKeeper({ dir, budget = 0, block, state, sources = () => [], refuseFile = null, fetchFn = fetch }) {
	if (dir && budget) mkdirSync(dir, { recursive: true });
	const refused = () => { try { return new Set(readFileSync(refuseFile, 'utf8').split(/\s+/).filter((x) => HEX64.test(x))); } catch { return new Set(); } };
	const at = (id, p) => join(dir, id + '.' + p), blobOf = (id) => { const b = state().blobs; return b && Object.hasOwn(b, id) ? b[id] : null; };
	const mine = () => { try { return readdirSync(dir).map((f) => f.match(/^([0-9a-f]{64})\.(\d{1,2})$/)).filter(Boolean).map((m) => [m[1], Number(m[2])]); } catch { return []; } };
	const used = () => mine().reduce((n, [id, p]) => { try { return n + statSync(at(id, p)).size; } catch { return n; } }, 0);
	const has = (id, p) => !!dir && existsSync(at(id, p));
	const read = (id, p) => new Uint8Array(readFileSync(at(id, p)));
	/** keep a piece: '' when kept, else why not */
	function keep(id, p, bytes) {
		const b = blobOf(id);
		if (!b || b.kind !== 'out' || !(p >= 0 && p < BLOB.total)) return 'The chain knows no such piece';
		if (!isAwake(b, state().time)) return 'That file is asleep';
		if (refused().has(id)) return 'This node does not keep that file';
		if (!dir || !budget) return 'This node keeps no files';
		if (has(id, p)) return '';
		if (bytes.length !== pieceLen(b.size)) return 'That is not the piece the chain names';
		if (used() + bytes.length > budget) return 'This node has no room';
		if (pieceTree(bytes).root !== b.hashes[p]) return 'That is not the piece the chain names';
		const tmp = at(id, p) + '.part'; writeFileSync(tmp, bytes); renameSync(tmp, at(id, p)); // whole, or not at all
		return '';
	}
	async function fetchPiece(id, p, size) {
		for (const src of sources()) try {
			const r = await fetchFn(`${src.replace(/\/+$/, '')}/blob/${id}/${p}`, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
			if (!r.ok || Number(r.headers.get('content-length') ?? 0) > size) continue;
			const bytes = new Uint8Array(await r.arrayBuffer()); if (bytes.length === size) return bytes;
		} catch { /* not answering: the next */ }
		return null;
	}
	/** the whole file: from the blocks, or from any 8 pieces (its own first, then others') */
	async function whole(id) {
		const b = blobOf(id);
		if (!b) return null;
		if (b.kind === 'in') return fromBlocks(id, b, block);
		const have = new Map();
		for (let p = 0; p < BLOB.total && have.size < BLOB.data; p++) if (has(id, p)) { const bytes = read(id, p); if (pieceTree(bytes).root === b.hashes[p]) have.set(p, bytes); }
		for (let p = 0; p < BLOB.total && have.size < BLOB.data; p++) if (!have.has(p)) { const bytes = await fetchPiece(id, p, pieceLen(b.size)); if (bytes && pieceTree(bytes).root === b.hashes[p]) have.set(p, bytes); }
		return rebuild(b, have);
	}
	/** files rebuilt lately, so a video that is being watched is not rebuilt for every part of it (64 MB at most) */
	const warm = new Map(); let warmSize = 0;
	async function cached(id) {
		const had = warm.get(id); if (had) { warm.delete(id); warm.set(id, had); return had; }
		const bytes = await whole(id); if (bytes && bytes.length <= 64_000_000) { warm.set(id, bytes); warmSize += bytes.length; for (const [k, v] of warm) { if (warmSize <= 64_000_000) break; warm.delete(k); warmSize -= v.length; } }
		return bytes;
	}
	const drop = (id) => { const v = warm.get(id); if (v) { warm.delete(id); warmSize -= v.length; } };
	const HEAD = (type) => ({ ...(SHOWN.has(type) || type === 'application/octet-stream' ? {} : { 'content-disposition': 'attachment' }), 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'access-control-allow-origin': '*' });
	/** bytes from..to straight out of the pieces this node keeps (the first 8 are the file itself, in order), when it keeps the right ones */
	async function part(id, b, from, to) {
		if (b.kind !== 'out' || warm.has(id)) return null;
		const len = pieceLen(b.size), out = new Uint8Array(to - from + 1); for (let p = Math.floor(from / len); p <= Math.floor(to / len); p++) if (!has(id, p)) return null;
		for (let p = Math.floor(from / len); p <= Math.floor(to / len); p++) { const bytes = read(id, p), s = Math.max(from, p * len), e = Math.min(to + 1, (p + 1) * len); out.set(bytes.subarray(s - p * len, e - p * len), s - from); }
		return out;
	}
	/** answer a request, or null when it is not about files */
	async function handle(method, path, body, range) {
		const m = path.match(WAY);
		if (!m) return null;
		const [, id, ps] = m, p = ps === undefined ? null : Number(ps), b = blobOf(id);
		if (!b) return { status: 404, text: 'No such file' };
		if (refused().has(id)) drop(id);
		if (refused().has(id)) return { status: 451, text: 'This node does not serve that file' };
		if (b.asleep) drop(id);
		if (b.asleep) return { status: 410, text: 'That file is asleep: nobody paid for its time. Whoever has it may wake it' };
		if (method === 'POST') { if (p === null) return { status: 405, text: 'Not allowed' }; const why = keep(id, p, new Uint8Array(body)); return why ? { status: why.includes('room') ? 507 : 400, text: why } : { status: 200, text: 'kept' }; }
		if (p !== null) return has(id, p) ? { status: 200, head: HEAD('application/octet-stream'), bytes: read(id, p) } : { status: 404, text: 'This node does not keep that piece' };
		const m2 = typeof range === 'string' ? range.match(/^bytes=(\d{0,12})-(\d{0,12})$/) : null, head = { ...HEAD(b.type), 'accept-ranges': 'bytes' };
		try {
			if (!m2 || (m2[1] === '' && m2[2] === '')) return { status: 200, head: { ...head, 'content-length': b.size }, bytes: await cached(id) };
			const from = m2[1] === '' ? Math.max(0, b.size - Number(m2[2])) : Number(m2[1]), to = m2[1] === '' || m2[2] === '' ? b.size - 1 : Math.min(b.size - 1, Number(m2[2]));
			if (from > to || from >= b.size) return { status: 416, head: { ...head, 'content-range': `bytes */${b.size}` }, text: '' };
			return { status: 206, head: { ...head, 'content-range': `bytes ${from}-${to}/${b.size}`, 'content-length': to - from + 1 }, bytes: (await part(id, b, from, to)) ?? (await cached(id)).subarray(from, to + 1) };
		} catch (e) { return { status: 503, text: e.message }; }
	}
	/** one round: give up what the chain no longer has or the owner refuses; copy at most one piece that too few keep */
	async function round() {
		if (!dir || !budget) return 0;
		const no = refused();
		for (const [id, p] of mine()) if (!isAwake(blobOf(id), state().time) || no.has(id)) rmSync(at(id, p), { force: true });
		const all = Object.entries(state().blobs ?? {}).filter(([id, b]) => b.kind === 'out' && isAwake(b, state().time) && !no.has(id));
		for (const [id, b] of all) {
			if (used() + pieceLen(b.size) > budget || mine().filter(([x]) => x === id).length >= 2) continue; // two pieces of one file at most: the rest belong elsewhere
			const count = (p) => Object.keys(b.holders ?? {}).filter((k) => k.startsWith(p + ':')).length;
			const want = Array.from({ length: BLOB.total }, (_, p) => p).filter((p) => !has(id, p) && count(p) < BLOB.slots).sort((x, y) => count(x) - count(y) || Math.random() - 0.5);
			for (const p of want.slice(0, 4)) { const bytes = await fetchPiece(id, p, pieceLen(b.size)); if (bytes && !keep(id, p, bytes)) return 1; }
		}
		return 0;
	}
	/** what this node's staked key shows today, for the pieces it keeps and has not shown yet */
	function proofs(who) {
		const s = state(), day = s.heart?.day; if (!day) return [];
		return mine().filter(([id, p]) => { const b = blobOf(id); if (!b || b.asleep || s.time > b.until) return false; const at_ = b.holders?.[p + ':' + who]; if (at_ !== undefined) return at_ < day[0]; return Object.keys(b.holders ?? {}).filter((k) => k.startsWith(p + ':') && b.holders[k] >= day[0] - BLOB.staleDays).length < BLOB.slots; })
			.slice(0, 20).map(([id, p]) => proofOf(id, p, read(id, p), day[1], who));
	}
	return { keep, handle, round, proofs, whole, used, mine, forget: drop };
}
