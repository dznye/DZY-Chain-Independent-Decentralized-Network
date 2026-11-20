// Shops keep their orders on the chain: open a shop with just a name, and every payment to it (shop.pay) is logged in
// the shop's own record, the last 100, so a seller sees its orders without scanning blocks. Run: node chain/shop-orders.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';

const [V, A, B, C] = await Promise.all([newKey(), newKey(), newKey(), newKey()]), CHAIN = 'dznye-shop-test', DZY = 1_000_000, T0 = 1_800_000_000_000;
const fresh = () => L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0, sales: [{ to: A.address, units: 100 * DZY, paid: 20 * DZY, proof: 't' }, { to: B.address, units: 1_000 * DZY, paid: 200 * DZY, proof: 't' }] });
const send = async (s, k, type, data) => L.applyTx(s, await L.signTx(k.secret, { chain: CHAIN, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, V.address);
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };

await test('open a shop with just a name, no cashback; removing a cashback it never had is still refused', async () => {
	const s = await fresh();
	await send(s, A, 'shop.set', { pay: 'DZY', reward: 'DZY', num: 0, den: 1, name: 'Corner Café' });
	assert.equal(s.shops[A.address].name, 'Corner Café'); assert.deepEqual(s.shops[A.address].rules, {});
	await assert.rejects(() => send(s, A, 'shop.set', { pay: 'DZY', reward: 'DZY', num: 0, den: 1 }), /no cashback for that to remove/);
});
await test('every payment to a shop is an order on the chain: who, what, how much, when, and the order it names', async () => {
	const s = await fresh();
	await send(s, A, 'shop.set', { pay: 'DZY', reward: 'DZY', num: 0, den: 1, name: 'Corner Café' });
	s.time = T0 + 60_000;
	await send(s, B, 'shop.pay', { shop: A.address, asset: 'DZY', amount: 4_500_000, order: 'latte-7f3a' });
	assert.deepEqual(s.shops[A.address].orders, [{ order: 'latte-7f3a', from: B.address, asset: 'DZY', amount: 4_500_000, at: T0 + 60_000 }]);
	await send(s, B, 'shop.pay', { shop: A.address, asset: 'DZY', amount: 1_000_000 });
	assert.equal(s.shops[A.address].orders.length, 2); assert.equal(s.shops[A.address].orders[1].order, undefined);
	const b0 = canon(s.accounts[C.address] ?? null);
	await send(s, B, 'shop.pay', { shop: C.address, asset: 'DZY', amount: 1_000_000, order: 'x' }); // not a shop: paid, nothing logged
	assert.equal(s.shops[C.address], undefined); assert.notEqual(canon(s.accounts[C.address]), b0);
});
await test('the last 100 orders are kept, newest last; older ones fall away (the payments themselves stay in the blocks)', async () => {
	const s = await fresh();
	await send(s, A, 'shop.set', { pay: 'DZY', reward: 'DZY', num: 0, den: 1, name: 'Busy shop' });
	for (let i = 0; i < 105; i++) await send(s, B, 'shop.pay', { shop: A.address, asset: 'DZY', amount: 1, order: 'o' + i });
	const o = s.shops[A.address].orders;
	assert.equal(o.length, 100); assert.equal(o[0].order, 'o5'); assert.equal(o.at(-1).order, 'o104');
	const h = L.holdings(s); assert.equal(h.DZY, s.assets.DZY.supply);
});
console.log(`${pass} tests passed`);
