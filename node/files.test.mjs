// Files kept by nodes (files.mjs): only real ones, only within the room given, dropped when taken down.
// Run: node chain/node/files.test.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileKeeper, wanted } from './files.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex'), A = 'a'.repeat(64), DZY = 'd'.repeat(64), X = 'e'.repeat(64);
const make = (size) => { const n = Math.max(1, Math.ceil(size / 4_194_304)), parts = Array.from({ length: n }, (_, i) => randomBytes((i < n - 1 ? 4_194_304 : size - 4_194_304 * (n - 1)) + 28)), hashes = parts.map(sha); return { id: sha(Buffer.from(hashes.join(''))), size, parts, hashes }; };
const f1 = make(5_000_000), f2 = make(1000), f3 = make(2000);
const state = (more = {}) => ({ records: { [`${A}/items/one`]: { at: 1, value: { file: f1.id } }, [`${A}/items/two`]: { at: 2, value: { file: f2.id } }, [`${A}/items/bad`]: { at: 3, value: { file: '../x' } }, [`${A}/page/p`]: { at: 4, value: { file: f3.id } }, ...more } });
const server = (o = {}) => async (url) => { const [, host, id, w] = url.match(/^https:\/\/([^/]+)\/file\/([0-9a-f]{64})\/(m|\d+)$/), f = [f1, f2, f3].find((x) => x.id === id); if (!f || host === 'down') return new Response('no', { status: 404 }); if (w === 'm') return new Response(JSON.stringify(host === 'liar' ? { size: 10, parts: [sha('x')] } : { size: f.size, parts: f.hashes })); return new Response(host === 'swap' ? randomBytes(f.parts[Number(w)].length) : f.parts[Number(w)]); };
let pass = 0; const test = async (n, fn) => { const dir = mkdtempSync(join(tmpdir(), 'dz-files-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } pass++; console.log('ok  ', n); };
const keep = (dir, budget, list) => fileKeeper({ dir, budget, founder: DZY, sources: () => list.map((x) => 'https://' + x), fetchFn: server() });

await test('only files items name, newest first; only @dzy takes one down', async () => {
	assert.deepEqual(wanted(state(), DZY).ids, [f2.id, f1.id]); assert.deepEqual(wanted(state({ [`${X}/hidden/h`]: { at: 5, value: { f: f1.id } } }), DZY).ids, [f2.id, f1.id]); assert.deepEqual(wanted(state({ [`${DZY}/hidden/h`]: { at: 5, value: { f: f1.id } } }), DZY).ids, [f2.id]);
});
await test('lying, swapping and silent sources are passed over; the real file is kept whole and served', async (dir) => {
	const k = keep(dir, 1e8, ['down', 'liar', 'swap', 'honest']); assert.equal(await k.round(state()), 1); assert.equal(await k.round(state()), 1); assert.equal(await k.round(state()), 0);
	assert.equal(sha(k.serve(`/file/${f1.id}/1`).body), f1.hashes[1]); assert.deepEqual(JSON.parse(k.serve(`/file/${f1.id}/m`).body), { size: f1.size, parts: f1.hashes }); for (const bad of ['/file/x/m', `/file/${f1.id}/9`, `/file/${f1.id}/../m`, `/file/${f3.id}/m`]) assert.equal(k.serve(bad), null);
	assert.equal(existsSync(join(dir, f1.id + '.part')), false);
});
await test('nothing wrong is ever kept', async (dir) => { const k = keep(dir, 1e8, ['liar', 'swap']); assert.equal(await k.round(state()), 0); assert.equal(k.used(), 0); });
await test('no room, no copy; none by default', async (dir) => { assert.equal(await keep(dir, 0, ['honest']).round(state()), 0); const k = keep(dir, 2000, ['honest']); assert.equal(await k.round(state()), 1); assert.ok(k.has(f2.id) && !k.has(f1.id)); assert.equal(await k.round(state()), 0); assert.ok(k.used() < 2000); });
await test('taken down: dropped, and not copied again', async (dir) => { const k = keep(dir, 1e8, ['honest']); await k.round(state()); assert.ok(k.has(f2.id)); const s = state({ [`${DZY}/hidden/h`]: { at: 9, value: { f: f2.id } } }); await k.round(s); await k.round(s); assert.ok(!k.has(f2.id) && k.has(f1.id)); });
console.log(`\n${pass} file-keeping tests passed`);
