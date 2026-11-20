// The vault helper (node/vaultwatch.mjs): it only names payments, written as attacks. Run: node vaultwatch.test.mjs
import assert from 'node:assert/strict';
import { lookOnce, vaultsOf } from './node/vaultwatch.mjs';
import { DEPOSIT_TOPIC } from './src/xwatch.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };
const V = '0x' + 'ab'.repeat(20), TO = 'cd'.repeat(32), ZERO = '0x' + '0'.repeat(40);
const w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0'), t = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const log = (addr, i) => ({ address: addr, topics: [DEPOSIT_TOPIC, t(ZERO), t('0x' + '11'.repeat(20)), '0x' + TO], data: w(10n ** 15n), transactionHash: '0x' + String(i).padStart(64, '0'), logIndex: '0x0' });
const exchange = { coins: { BNB: { vaults: { bsc: V } }, USDT: { vaults: { bsc: V } }, SOL: { vaults: { sol: 'SoLvault' } } } };
globalThis.fetch = async () => ({ ok: true, json: async () => exchange });

await test('only Ethereum-style vaults with a real address are read; Solana and junk are left out', async () => {
	assert.deepEqual(vaultsOf(exchange), { bsc: V });
	assert.deepEqual(vaultsOf({ coins: { X: { vaults: { bsc: 'not-an-address', nochain: V } } } }), {});
	assert.deepEqual(vaultsOf(null), {});
});
await test('a look names each payment into the vault once, and nothing paid elsewhere; the next look starts after it', async () => {
	const sent = [], state = { bsc: 100 };
	const rpc = async (m, p) => (m === 'eth_blockNumber' ? '0x' + (150).toString(16) : m === 'eth_getLogs' ? [log(V, 1), { ...log(V, 1), logIndex: '0x1' }, log('0x' + 'ee'.repeat(20), 2)] : null);
	const n = await lookOnce({ api: 'x', state, rpcFor: () => rpc, post: async (a, net, tx) => { sent.push([net, tx]); return true; } });
	assert.equal(n, 1);
	assert.deepEqual(sent, [['bsc', '0x' + '1'.padStart(64, '0')]], 'a payment was named twice, or a deposit into another contract was named');
	assert.equal(state.bsc, 151);
});
await test('when the chain\'s nodes do not answer, nothing is skipped: the same blocks are read again next look', async () => {
	const state = { bsc: 100 };
	await lookOnce({ api: 'x', state, rpcFor: () => async (m) => { if (m === 'eth_getLogs') throw new Error('limit exceeded'); return '0x' + (150).toString(16); }, post: async () => true });
	assert.equal(state.bsc, 100, 'blocks were skipped after a failed read');
});
await test('it never reads more than 2,000 blocks at a time, and it only ever posts transaction names (no key, no amounts)', async () => {
	const state = { bsc: 0 }, ranges = [], bodies = [];
	await lookOnce({ api: 'x', state, rpcFor: () => async (m, p) => { if (m === 'eth_blockNumber') return '0x' + (10_000).toString(16); ranges.push([Number(BigInt(p[0].fromBlock)), Number(BigInt(p[0].toBlock))]); return [log(V, 7)]; }, post: async (a, net, tx) => { bodies.push({ net, tx }); return true; } });
	assert.ok(ranges.every(([f, to]) => to - f <= 2_000), 'a range wider than public nodes allow');
	assert.deepEqual(Object.keys(bodies[0]).sort(), ['net', 'tx']);
});
console.log(`\n${pass} tests passed`);
