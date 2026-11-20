// Records: an app's data on the chain (sign-ups, profiles, orders, entries, documents), written as attacks.
// Run: node chain/records.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';

const [V, A, B, P] = await Promise.all([newKey(), newKey(), newKey(), newKey()]);
const CHAIN = 'dznye-records-test', T0 = 1_800_000_000_000, DZY = 1_000_000;
const fresh = () => L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0, sales: [
	{ to: A.address, units: 1_000 * DZY, paid: 200 * DZY, proof: 'test' }, { to: B.address, units: 100 * DZY, paid: 20 * DZY, proof: 'test' }, { to: P.address, units: 1, paid: 1, proof: 'test' }] });
const tx = async (s, k, type, data) => { const t = { chain: CHAIN, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }; try { return await L.signTx(k.secret, t); } catch { return { ...t, sig: '00'.repeat(64) }; } };
const send = async (s, k, type, data) => L.applyTx(s, await tx(s, k, type, data), s.time, V.address);
async function refused(s, k, type, data, why) {
	const before = canon(s), t = await tx(s, k, type, data);
	await assert.rejects(() => L.applyTx(s, t, s.time, V.address), why, `accepted: ${type} ${JSON.stringify(data).slice(0, 120)}`);
	assert.equal(canon(s), before, 'a refused transaction changed the state');
}
const whole = (s, where) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); };
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };

await test('put a record: any small value, under the writer\'s own address; it pays for its size, to the Sun, once', async () => {
	const s = await fresh(), sun0 = s.treasury, a0 = L.balanceOf(s, A.address);
	const order = { item: 'blue mug', qty: 2, total: '18.50', paid: true };
	await send(s, A, 'record.put', { space: 'shop', key: 'order-1042', value: order });
	const r = L.recordOf(s, A.address, 'shop', 'order-1042');
	assert.deepEqual(r.value, order); assert.equal(r.at, T0);
	const fee = L.recordFee('shop', 'order-1042', { value: order });
	assert.equal(s.treasury - sun0, fee, 'the storage fee did not reach the Sun');
	assert.equal(a0 - L.balanceOf(s, A.address), fee + s.fee, 'the writer paid something else');
	whole(s, 'a record');
	return `a ${canon(order).length}-character order costs ${fee / DZY} DZY to keep, for good`;
});
await test('update and delete: the writer replaces or removes its own record; deleting what is not there is refused', async () => {
	const s = await fresh();
	await send(s, A, 'record.put', { space: 'profile', key: 'me', value: { name: 'Ada', city: 'Kathmandu' } });
	await send(s, A, 'record.put', { space: 'profile', key: 'me', value: { name: 'Ada', city: 'Pokhara' } });
	assert.equal(L.recordOf(s, A.address, 'profile', 'me').value.city, 'Pokhara');
	await send(s, A, 'record.delete', { space: 'profile', key: 'me' });
	assert.equal(L.recordOf(s, A.address, 'profile', 'me'), null);
	await refused(s, A, 'record.delete', { space: 'profile', key: 'me' }, /no such record/);
});
await test('a file\'s record: its SHA-256 and where to find it (https, ipfs, ar), not the file itself', async () => {
	const s = await fresh(), hash = 'ab'.repeat(32);
	await send(s, A, 'record.put', { space: 'docs', key: 'contract-7', hash, link: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' });
	assert.equal(L.recordOf(s, A.address, 'docs', 'contract-7').hash, hash);
	for (const d of [{ space: 'docs', key: 'x', link: 'https://a.example/f' }, { space: 'docs', key: 'x', hash: 'zz' }, { space: 'docs', key: 'x', hash, link: 'ftp://a.example/f' }, { space: 'docs', key: 'x', hash, link: 'javascript:alert(1)' }])
		await refused(s, A, 'record.put', d);
});
await test('nobody writes over anyone else: each writer has its own records in a space; an app reads its space across every writer', async () => {
	const s = await fresh();
	await send(s, A, 'record.put', { space: 'coffee-club', key: 'signup', value: { name: 'Ada' } });
	await send(s, B, 'record.put', { space: 'coffee-club', key: 'signup', value: { name: 'Bo' } });
	assert.equal(L.recordOf(s, A.address, 'coffee-club', 'signup').value.name, 'Ada');
	assert.equal(L.recordOf(s, B.address, 'coffee-club', 'signup').value.name, 'Bo');
	const all = L.spaceRecords(s, 'coffee-club');
	assert.deepEqual(all.map((r) => r.value.name).sort(), ['Ada', 'Bo']); assert.ok(all.every((r) => r.writer && r.key === 'signup'));
	assert.deepEqual(L.recordsOf(s, A.address, 'coffee-club').map((r) => r.key), ['signup']);
	return 'two sign-ups in one app\'s space, each owned by the person who made it';
});
await test('refused, leaving no trace: too big, a bad space or key, both or neither of value and hash, no DZY for the fee, an unexpected field', async () => {
	const s = await fresh();
	const bad = [{ space: 'shop', key: 'k', value: 'x'.repeat(1_001) }, { space: 'Shop!', key: 'k', value: 1 }, { space: '', key: 'k', value: 1 }, { space: 'shop', key: '', value: 1 }, { space: 'shop', key: 'a/b', value: 1 },
		{ space: 'shop', key: 'k' }, { space: 'shop', key: 'k', value: 1, hash: 'ab'.repeat(32) }, { space: 'shop', key: 'k', value: 1, extra: 2 }, { space: 'x'.repeat(33), key: 'k', value: 1 }, { space: 'shop', key: 'k'.repeat(65), value: 1 }];
	for (const d of bad) await refused(s, A, 'record.put', d);
	await refused(s, P, 'record.put', { space: 'shop', key: 'k', value: 'hello' }, /fee|DZY/); // holds a single unit: not enough for the storage fee
});
await test('limits and agreement: 10,000 records an account at most; records are part of the fingerprint every node checks', async () => {
	const s = await fresh();
	for (let i = 0; i < 10_000; i++) await send(s, A, 'record.put', { space: 'log', key: 'e' + i, value: i });
	await refused(s, A, 'record.put', { space: 'log', key: 'one-more', value: 1 }, /10000 records/);
	await send(s, A, 'record.put', { space: 'log', key: 'e5', value: 'replacing one is fine' });
	const x = await fresh(), y = await fresh();
	await send(x, A, 'record.put', { space: 's', key: 'k', value: 1 });
	await send(y, A, 'record.put', { space: 's', key: 'k', value: 2 });
	assert.notEqual(await L.stateRoot(x), await L.stateRoot(y));
	whole(s, 'ten thousand records');
});
console.log(`${pass} tests passed`);
