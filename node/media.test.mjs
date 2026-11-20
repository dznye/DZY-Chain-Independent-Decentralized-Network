// Pictures kept by nodes (media.mjs), written as attacks: a node keeps only the real picture a record points at.
// Run: node chain/node/media.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaKeeper, pointers, fingerprintOk } from './media.mjs';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const webp = (n) => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b[20] = n; return b; };
const idOf = (b) => createHash('sha256').update(b).digest('hex').slice(0, 32);
const real = webp(1), real2 = webp(2), id = idOf(real), id2 = idOf(real2);
const state = { records: {
	[`${A}/page/main`]: { value: { bio: 'hi', photo: `/media/${A}/${id}`, links: [['x', 'https://x.example']] } },
	[`${A}/items/art`]: { value: { title: 'Art', cover: `/media/${A}/${id2}`, sealed: 'zzz' } },
	[`${B}/blocks/p-1`]: { value: { t: 'image', url: 'https://elsewhere.example/p.jpg' } },
	[`${B}/blocks/p-2`]: { value: { t: 'image', url: `/media/${B}/${'0'.repeat(32)}` } },
} };

await test('pointers: every picture address in the records, nothing else', async () => {
	const p = pointers(state).map(([a, i]) => `${a}/${i}`).sort();
	assert.deepEqual(p, [`${A}/${id}`, `${A}/${id2}`, `${B}/${'0'.repeat(32)}`].sort());
});
await test('a node keeps the real pictures, refuses swapped ones, and serves only what it holds', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dz-media-'));
	try {
		const calls = [];
		// the first source lies (sends another picture), the second is honest
		const fetchFn = async (url) => {
			calls.push(url);
			const [, src, addr, pid] = url.match(/^(https:\/\/[^/]+)\/media\/([0-9a-f]{64})\/([0-9a-f]{32})$/);
			if (src === 'https://liar.example') return new Response(webp(99));
			const b = addr === A && pid === id ? real : addr === A && pid === id2 ? real2 : null;
			return b ? new Response(b) : new Response('no', { status: 404 });
		};
		const k = mediaKeeper({ dir, sources: () => ['https://liar.example', 'https://honest.example'], fetchFn });
		assert.equal(await k.round(state), 2); // the two real ones; the third exists nowhere
		assert.ok(k.has(A, id) && k.has(A, id2) && !k.has(B, '0'.repeat(32)));
		const s = k.serve(`/media/${A}/${id}`);
		assert.equal(s.type, 'image/webp'); assert.ok(fingerprintOk(s.body, id));
		assert.equal(k.serve(`/media/${A}/../../etc/passwd`), null); assert.equal(k.serve(`/media/${B}/${'0'.repeat(32)}`), null);
		const before = calls.length;
		assert.equal(await k.round(state), 0); // already kept: copied once, never again
		assert.equal(calls.length - before, 2, 'only the missing one is asked for again');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
console.log(`\n${pass} picture-keeping tests passed`);
