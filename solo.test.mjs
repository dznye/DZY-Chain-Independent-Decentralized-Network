// The 12-cent shutdown (found 22 Nov 2026), written as the attack: the live chain's first node runs on a host that
// cannot reach other validators (Cloudflare: no net). One outsider staking 1 DZY, with a node that says it has a public
// address, used to make that node refuse everything. Also: a block is filled by size, so it always fits what nodes take.
// Run: node solo.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import { fits, MAX_BLOCK_BYTES, replay, txBytes } from './src/block.ts';
import { NodeCore } from './src/node.ts';

const DZY = 1e8;
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const memStore = () => {
	let st = null, q = [], seq = 0; const blocks = [], notes = new Map();
	return { blocksAll: blocks, loadState: () => st, commit(b, s, n) { st = JSON.parse(JSON.stringify(s)); blocks[b.height] = b; q.splice(0, n); }, queueAdd(tx) { q.push({ seq: ++seq, tx }); }, queueList: () => [...q], queueDrop(k) { q = q.filter((x) => x.seq !== k); }, block: (h) => blocks[h] ?? null, blocks: (f, n) => blocks.slice(f, f + n).filter(Boolean), noteGet: (k) => notes.get(k) ?? null, noteSet: (k, v) => notes.set(k, v) };
};
async function boot(name, founderStake = 100, outsiderStake = 1) {
	L.testCrewFrom(name, 1);
	const founder = await newKey(), out = await newKey(), store = memStore();
	const sun = { chain: name, time: Date.now() - 5_000, validators: [founder.address], seedWait: 0, sales: [founder, out].map((k) => ({ to: k.address, units: 2000 * DZY, paid: 400_000_000, proof: 'test' })) };
	const core = new NodeCore({ sun, validator: founder, selfUrl: 'https://f.example', blockMs: 20 }, store, () => {});
	await core.start();
	const send = async (k, type, data) => core.handle({ method: 'POST', path: '/tx', query: new URLSearchParams(), auth: '', ip: '1.1.1.1', body: JSON.stringify({ tx: await L.signTx(k.secret, { chain: name, from: k.address, nonce: core.seq.pendingNonce(k.address) + 1, type, data }) }) });
	await send(out, 'stake.bond', { amount: outsiderStake * DZY }); await core.tick();
	await send(out, 'node.checkin', { seen: [core.state.height, core.state.last], url: 'https://o.example' }); await core.tick();
	await send(founder, 'stake.bond', { amount: founderStake * DZY }); await core.tick();
	await send(founder, 'node.checkin', { seen: [core.state.height, core.state.last], url: 'https://f.example' }); await core.tick();
	return { founder, out, store, core, send };
}

await test('one outsider with 1 DZY joins: the first node keeps making blocks, and every one passes a full check', async () => {
	const { core, send, founder, out, store } = await boot('dznye-solo-a');
	assert.equal(core.state.validators.length, 2, 'the outsider did not join: this test tests nothing');
	assert.equal(core.broken ?? '', '');
	for (let i = 0; i < 12; i++) {
		const r = await send(founder, 'transfer', { asset: 'DZY', to: out.address, amount: 1_000 + i });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		const h = core.state.height; await core.tick(); assert.equal(core.state.height, h + 1, 'no block was made');
	}
	const blocks = store.blocksAll.filter(Boolean), end = await replay(core.genesis, blocks);
	assert.equal(end.last, core.state.last);
	assert.ok(blocks.some((b) => b.round > 0), 'it never had to skip the outsider\'s turn');
	return `${blocks.length} blocks, replayed from genesis by the rules alone`;
});
await test('without more than two thirds of the say it does NOT carry on alone (that would be a fork): it stops and says why', async () => {
	const { core } = await boot('dznye-solo-b', 100, 60);
	assert.match(core.broken, /other validators/);
});
await test('a block takes what fits: never past the size every node accepts, the rest waits for the next', async () => {
	const big = Array.from({ length: 500 }, (_, i) => ({ chain: 'x', from: 'a', nonce: i, type: 'transfer.many', data: { asset: 'DZY', to: Array.from({ length: 100 }, () => ['a'.repeat(64), 1]) }, sig: 'f'.repeat(128) }));
	const n = fits(big, 500), size = big.slice(0, n).reduce((t, x) => t + txBytes(x), 0);
	assert.ok(n > 0 && n < 500 && size <= MAX_BLOCK_BYTES);
	assert.equal(fits(big.slice(0, 3), 500), 3); assert.equal(fits(big, 7), 7);
	return `${n} of 500 of the biggest transactions (${(size / 1e6).toFixed(2)} MB)`;
});
console.log(`\n${pass} tests passed`);
process.exit(0);
