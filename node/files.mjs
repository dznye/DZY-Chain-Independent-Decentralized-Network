// Creators' files, kept by nodes that choose to (FILES_MB: how many megabytes; 0, the default, keeps none). A node reads
// which files exist from its own copy of the chain (items' `file`), copies each one's encrypted parts once, checks every
// part against the fingerprint, and serves them at the wallet's own addresses. It holds no key and cannot open any. A file
// @dzy took down (a hidden record naming it: f) is dropped and never copied again.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEX64 = /^[0-9a-f]{64}$/, PART = 4_194_304 + 28, FILE_MAX = 60_000_000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** the files the chain's items name, newest first, and the ones taken down */
export function wanted(state, founder) {
	const list = new Map(), gone = new Set();
	for (const [k, r] of Object.entries(state?.records ?? {})) {
		const [writer, space] = k.split('/'), v = r?.value; if (!v || typeof v !== 'object') continue;
		if (space === 'items' && HEX64.test(v.file ?? '') && (list.get(v.file) ?? -1) < r.at) list.set(v.file, r.at);
		if (space === 'hidden' && writer === founder && HEX64.test(v.f ?? '')) gone.add(v.f);
	}
	return { ids: [...list].filter(([id]) => !gone.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id), gone };
}
/** the keeper: `dir` holds the files, at most `budget` bytes; `sources()` lists where to copy from */
export function fileKeeper({ dir, budget, sources, founder, fetchFn = fetch }) {
	const at = (id) => join(dir, id), has = (id) => HEX64.test(id) && existsSync(join(at(id), 'm'));
	const used = () => { try { return readdirSync(dir).reduce((n, id) => n + readdirSync(at(id)).reduce((m, f) => m + statSync(join(at(id), f)).size, 0), 0); } catch { return 0; } };
	async function bytes(src, path, most) { const r = await fetchFn(src.replace(/\/+$/, '') + path, { signal: AbortSignal.timeout(60_000) }); if (!r.ok || Number(r.headers.get('content-length') ?? 0) > most) return null; const b = Buffer.from(await r.arrayBuffer()); return b.length > most ? null : b; }
	async function copy(id, room) {
		for (const src of sources()) try {
			const raw = await bytes(src, `/file/${id}/m`, 4000); if (!raw) continue;
			const m = JSON.parse(raw.toString()), parts = m.parts;
			if (!Number.isSafeInteger(m.size) || m.size < 1 || m.size > FILE_MAX || !Array.isArray(parts) || parts.length !== Math.max(1, Math.ceil(m.size / (PART - 28))) || !parts.every((p) => HEX64.test(p)) || sha(Buffer.from(parts.join(''))) !== id) continue; // a lying source: the next one
			if (m.size + 28 * parts.length > room) return false;
			const tmp = at(id) + '.part'; rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
			let ok = true;
			for (let n = 0; n < parts.length && ok; n++) { const b = await bytes(src, `/file/${id}/${n}`, PART); if (!b || sha(b) !== parts[n]) ok = false; else writeFileSync(join(tmp, String(n)), b); }
			if (!ok) { rmSync(tmp, { recursive: true, force: true }); continue; }
			writeFileSync(join(tmp, 'm'), JSON.stringify({ size: m.size, parts })); renameSync(tmp, at(id)); return true;
		} catch { /* not answering: the next source */ }
		return false;
	}
	/** one round: drop what was taken down, then copy at most one file (they are big) while there is room */
	async function round(state) {
		const { ids, gone } = wanted(state, founder); let n = 0;
		for (const id of gone) if (existsSync(at(id))) rmSync(at(id), { recursive: true, force: true });
		if (!budget) return 0;
		const room = budget - used();
		for (const id of ids) { if (n >= 1) break; if (!has(id) && room > 0 && (await copy(id, room))) n++; }
		return n;
	}
	/** serve GET /file/<id>/m and /file/<id>/<n>, or null */
	function serve(pathname) {
		const m = pathname.match(/^\/file\/([0-9a-f]{64})\/(m|\d{1,2})$/); if (!m || !has(m[1])) return null;
		const f = join(at(m[1]), m[2]); return existsSync(f) ? { body: readFileSync(f), type: m[2] === 'm' ? 'application/json' : 'application/octet-stream' } : null;
	}
	return { round, serve, has, used };
}
