// Who signed an Ethereum transaction takes about a millisecond to work out. A block full of them is worked out side by side,
// on other cores, by the chain's own code (src/evmcore.ts decodeTx); the answers only go where the same answer would be
// worked out otherwise (evmledger.ts `decoded`). A worker that fails or is slow changes nothing: the main program does it itself.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

if (!isMainThread) {
	const { decodeTx, unhex } = await import('../src/evmcore.ts');
	parentPort.on('message', ({ id, raws, chainId }) => parentPort.postMessage({ id, out: raws.map((raw) => { try { return decodeTx(unhex(raw), chainId); } catch { return null; } }) }));
}
export function decoderPool(size = Math.max(1, Math.min(6, availableParallelism() - 2))) {
	const workers = [], waiting = new Map(); let next = 0, stopped = false;
	const start = () => { const w = new Worker(new URL(import.meta.url), { execArgv: ['--no-warnings'] }); w.unref(); w.on('message', ({ id, out }) => { waiting.get(id)?.(out); waiting.delete(id); }); w.on('error', () => { const i = workers.indexOf(w); if (i >= 0) workers.splice(i, 1); }); workers.push(w); };
	const ask = (w, raws, chainId) => new Promise((ok) => { const id = ++next, t = setTimeout(() => { waiting.delete(id); ok(null); }, 4_000); waiting.set(id, (out) => { clearTimeout(t); ok(out); }); w.postMessage({ id, raws, chainId }); });
	return {
		/** decode these (a null where one is not valid, or was not done) */
		async decode(raws, chainId) {
			if (stopped || raws.length < 8) return raws.map(() => null);
			while (workers.length < size) start();
			const n = workers.length, parts = Array.from({ length: n }, () => []); raws.forEach((r, i) => parts[i % n].push(i));
			const out = raws.map(() => null);
			await Promise.all(parts.map(async (idx, w) => { if (!idx.length) return; const got = await ask(workers[w], idx.map((i) => raws[i]), chainId); if (got) idx.forEach((i, j) => { out[i] = got[j]; }); }));
			return out;
		},
		async stop() { stopped = true; await Promise.all(workers.splice(0).map((w) => w.terminate())); },
	};
}
