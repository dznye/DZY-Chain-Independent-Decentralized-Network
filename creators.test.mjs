// Creators: tips with a message, and items for sale (a picture, a video, a song, a file, a numbered edition), written
// as attacks. Every refused transaction must leave the state exactly as it was.
// Run: node chain/creators.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';

const [V, A, B, C] = await Promise.all([newKey(), newKey(), newKey(), newKey()]);
const CHAIN = 'dznye-creators-test', T0 = 1_800_000_000_000, DZY = 1_000_000;
const OWNER = L.RULES.saleFeeTo;
const fresh = async () => {
	const s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0, sales: [
		{ to: A.address, units: 1_000 * DZY, paid: 200 * DZY, proof: 'test' }, { to: B.address, units: 100 * DZY, paid: 20 * DZY, proof: 'test' }, { to: C.address, units: 100 * DZY, paid: 20 * DZY, proof: 'test' }] });
	return s;
};
const tx = async (s, k, type, data) => { const t = { chain: CHAIN, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }; return L.signTx(k.secret, t); };
const send = async (s, k, type, data) => L.applyTx(s, await tx(s, k, type, data), s.time, V.address);
async function refused(s, k, type, data, why) {
	const before = canon(s), t = await tx(s, k, type, data);
	await assert.rejects(() => L.applyTx(s, t, s.time, V.address), why, `accepted: ${type} ${JSON.stringify(data).slice(0, 120)}`);
	assert.equal(canon(s), before, 'a refused transaction changed the state');
}
const whole = (s, where) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); };
const bal = (s, k) => L.balanceOf(s, typeof k === 'string' ? k : k.address);
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const sell = (s, item, value) => send(s, A, 'record.put', { space: 'items', key: item, value });

await test('a tip: the creator gets 99.5%, the owner 0.5%, and the message shows in the tip box', async () => {
	const s = await fresh(), a0 = bal(s, A), o0 = bal(s, OWNER), b0 = bal(s, B), amount = 10 * DZY;
	await send(s, B, 'tip', { to: A.address, amount, msg: 'love the stream!' });
	const fee = amount * 50 / 10_000;
	assert.equal(bal(s, A) - a0, amount - fee); assert.equal(bal(s, OWNER) - o0, fee);
	assert.equal(b0 - bal(s, B), amount + s.fee, 'the tipper paid something else');
	const box = s.tipboxes[A.address];
	assert.equal(box.n, 1); assert.equal(box.total.DZY, amount); assert.equal(box.last[0].msg, 'love the stream!'); assert.equal(box.last[0].from, B.address);
	whole(s, 'a tip');
	return `10 DZY tip: ${(amount - fee) / DZY} to the creator, ${fee / DZY} to the owner`;
});
await test('tips: refused to yourself, above your balance, with a long message, or with extra fields', async () => {
	const s = await fresh();
	await refused(s, A, 'tip', { to: A.address, amount: DZY }, /yourself/);
	await refused(s, B, 'tip', { to: A.address, amount: 10_000 * DZY }, /not enough/);
	await refused(s, B, 'tip', { to: A.address, amount: DZY, msg: 'x'.repeat(141) }, /at most 140/);
	await refused(s, B, 'tip', { to: A.address, amount: DZY, fee: 0 }, /not expected/);
	await refused(s, B, 'tip', { to: 'not-an-address', amount: DZY }, /bad creator/);
});
await test('the tip box keeps the last 20 messages and the full totals', async () => {
	const s = await fresh();
	for (let i = 0; i < 25; i++) await send(s, B, 'tip', { to: A.address, amount: DZY / 10, msg: 'tip ' + i });
	const box = s.tipboxes[A.address];
	assert.equal(box.n, 25); assert.equal(box.total.DZY, 25 * DZY / 10); assert.equal(box.last.length, 20); assert.equal(box.last[19].msg, 'tip 24'); assert.equal(box.last[0].msg, 'tip 5');
});
await test('buy an item: exactly its price, 0.5% to the owner, and the buyer owns it for good', async () => {
	const s = await fresh(), price = 5 * DZY;
	await sell(s, 'song-1', { title: 'My song', kind: 'audio', price, sealed: 'abc' });
	const a0 = bal(s, A), o0 = bal(s, OWNER);
	await send(s, B, 'item.buy', { seller: A.address, item: 'song-1', asset: 'DZY', amount: price });
	const fee = price * 50 / 10_000;
	assert.equal(bal(s, A) - a0, price - fee); assert.equal(bal(s, OWNER) - o0, fee);
	const o = s.owned[`${B.address}/${A.address}/song-1`]; assert.equal(o.at, s.time); assert.equal(o.asset, 'DZY'); assert.equal(o.paid, price); assert.ok(o.usd > 0, 'the dollar value is kept');
	assert.equal(s.sales[`${A.address}/song-1`].n, 1); assert.equal(s.sales[`${A.address}/song-1`].total, price);
	whole(s, 'a sale');
});
await test('item attacks: a changed price, the wrong coin, buying twice, your own item, no such item, not for sale, extra fields', async () => {
	const s = await fresh(), price = 5 * DZY;
	await sell(s, 'pic', { title: 'Pic', kind: 'image', price });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price - 1 }, /price changed/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price + 1 }, /price changed/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'pic', asset: 'USDC', amount: price }, /price changed/);
	await refused(s, A, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price }, /your own item/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'nothing', asset: 'DZY', amount: price }, /no such item/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price, paid: true }, /not expected/);
	await send(s, B, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price }, /already own/);
	await sell(s, 'pic', { title: 'Pic', kind: 'image', price, off: true });
	await refused(s, C, 'item.buy', { seller: A.address, item: 'pic', asset: 'DZY', amount: price }, /not for sale/);
	await sell(s, 'bad', { title: 'Bad', price: -5 });
	await refused(s, C, 'item.buy', { seller: A.address, item: 'bad', asset: 'DZY', amount: -5 }, /no such item/);
});
await test('the price moved after the buyer looked: the old price is refused, the new one works', async () => {
	const s = await fresh();
	await sell(s, 'vid', { title: 'Vid', kind: 'video', price: 2 * DZY });
	await sell(s, 'vid', { title: 'Vid', kind: 'video', price: 50 * DZY });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'vid', asset: 'DZY', amount: 2 * DZY }, /price changed/);
	await send(s, B, 'item.buy', { seller: A.address, item: 'vid', asset: 'DZY', amount: 50 * DZY });
});
await test('editions: an item of 1 sells once, then it is sold out; each buyer holds a numbered edition (#2 of 3)', async () => {
	const s = await fresh();
	await sell(s, 'nft-1', { title: 'One of one', kind: 'nft', price: DZY, editions: 1 });
	await send(s, B, 'item.buy', { seller: A.address, item: 'nft-1', asset: 'DZY', amount: DZY });
	await refused(s, C, 'item.buy', { seller: A.address, item: 'nft-1', asset: 'DZY', amount: DZY }, /sold out/);
	assert.equal(s.owned[`${B.address}/${A.address}/nft-1`].ed, 1, 'edition #1');
	await sell(s, 'print', { title: 'Print', kind: 'nft', price: DZY, editions: 3 });
	await send(s, B, 'item.buy', { seller: A.address, item: 'print', asset: 'DZY', amount: DZY });
	await send(s, C, 'item.buy', { seller: A.address, item: 'print', asset: 'DZY', amount: DZY });
	assert.equal(s.owned[`${B.address}/${A.address}/print`].ed, 1); assert.equal(s.owned[`${C.address}/${A.address}/print`].ed, 2, 'numbered in order: #2 of 3');
});
await test('a buyer without enough DZY is refused, and nothing moves', async () => {
	const s = await fresh();
	await sell(s, 'big', { title: 'Course', kind: 'file', price: 500 * DZY });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'big', asset: 'DZY', amount: 500 * DZY }, /not enough/);
});
await test('a buyer cannot make an ownership record by hand: "owned" is not a record space anyone writes', async () => {
	const s = await fresh();
	await send(s, B, 'record.put', { space: 'owned', key: 'x', value: { seller: A.address } });
	assert.equal(s.owned, undefined, 'a record made ownership');
});

/* ---- dollar prices, any priced coin, memberships ---- */
// a claim on dollars (xUSDC) as the vaults would make it: issued by nobody, 6 decimals; B holds 100 of them
const withDollars = (s) => { s.assets.xUSDC = { symbol: 'XUSDC', name: 'Claim on USD Coin', issuer: '0'.repeat(64), supply: 100_000_000, minted: 100_000_000, mintable: false, decimals: 6 }; (s.accounts[B.address] ??= { nonce: 0, bal: {} }).bal.xUSDC = 100_000_000; return s; };
await test('a $5 item: pay 5 xUSDC exactly; a $0.05 one in DZY at the chain\'s own price; the seller gets 99.5% of what was paid', async () => {
	const s = withDollars(await fresh());
	await sell(s, 'beat', { title: 'Beat', kind: 'audio', usd: 5_000_000 });
	const a0 = L.balanceOf(s, A.address, 'xUSDC'), o0 = L.balanceOf(s, OWNER, 'xUSDC');
	await send(s, B, 'item.buy', { seller: A.address, item: 'beat', asset: 'xUSDC', max: 5_000_000 });
	assert.equal(L.balanceOf(s, A.address, 'xUSDC') - a0, 5_000_000 - 25_000); assert.equal(L.balanceOf(s, OWNER, 'xUSDC') - o0, 25_000);
	assert.equal(s.owned[`${B.address}/${A.address}/beat`].usd, 5_000_000); assert.equal(s.sales[`${A.address}/beat`].usd, 5_000_000);
	const need = L.usdCost(s, 'DZY', 50_000); assert.ok(need > 0);
	await sell(s, 'beat2', { title: 'Beat 2', kind: 'audio', usd: 50_000 });
	await send(s, C, 'item.buy', { seller: A.address, item: 'beat2', asset: 'DZY', max: need });
	assert.ok(L.usdWorth(s, 'DZY', need) >= 49_999, 'paid at least the dollar price');
	whole(s, 'dollar sales');
	return `$0.05 = ${need / 1e8} DZY at the sale price`;
});
await test('dollar item attacks: a max below the price, a coin with no price, an exact amount instead of max, a made-up claim', async () => {
	const s = withDollars(await fresh());
	await sell(s, 'x', { title: 'X', usd: 5_000_000 });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'x', asset: 'xUSDC', max: 4_999_999 }, /price changed/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'x', asset: 'xETH', max: 10 ** 12 }, /no price/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'x', asset: 'xUSDC', amount: 5_000_000 }, /max/);
	await send(s, A, 'asset.create', { symbol: 'XUSDT', name: 'fake', decimals: 6, supply: 0, mintable: true }).catch(() => {}); // anyone's own token is never a dollar
	s.assets.xFAKE = { symbol: 'XFAKE', name: 'fake', issuer: A.address, supply: 1, minted: 1, mintable: true, decimals: 6 };
	await refused(s, B, 'item.buy', { seller: A.address, item: 'x', asset: 'xFAKE', max: 10 ** 12 }, /no price/);
});
await test('a membership: 30 days a payment, paying again adds 30 days, the dollar price each time', async () => {
	const s = withDollars(await fresh());
	await sell(s, 'club', { title: 'Members', kind: 'other', usd: 3_000_000, every: 'month' });
	await send(s, B, 'item.buy', { seller: A.address, item: 'club', asset: 'xUSDC', max: 3_000_000 });
	const k = `${B.address}/${A.address}/club`, first = s.owned[k].until;
	assert.equal(first, s.time + L.MONTH_MS);
	await send(s, B, 'item.buy', { seller: A.address, item: 'club', asset: 'xUSDC', max: 3_000_000 });
	assert.equal(s.owned[k].until, first + L.MONTH_MS, 'renewing early adds to the end');
	assert.equal(s.sales[`${A.address}/club`].n, 2);
	await sell(s, 'bad', { title: 'Bad', usd: 1_000_000, every: 'week' });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'bad', asset: 'xUSDC', max: 1_000_000 }, /no such item/);
});
await test('tips keep a dollar total when the coin has a price', async () => {
	const s = withDollars(await fresh());
	await send(s, B, 'tip', { to: A.address, asset: 'xUSDC', amount: 3_000_000, msg: 'coffee' });
	await send(s, B, 'tip', { to: A.address, amount: DZY });
	const box = s.tipboxes[A.address];
	assert.ok(box.usd > 3_000_000); assert.equal(box.last[0].usd, 3_000_000);
});

/* ---- checkout from any wallet or exchange: order.open → order.paid → order.attest (validators) ---- */
const TX = (n) => '0x' + n.toString(16).padStart(64, '0');
const orderOf = (s, buyer) => Object.entries(s.orders ?? {}).find(([, o]) => o.buyer === buyer.address);
await test('an outside payment: exact unique amount to the creator\'s own address; validators confirm; the buyer owns it; the creator owes 0.5%', async () => {
	const s = await fresh();
	await sell(s, 'pack', { title: 'Pack', kind: 'audio', usd: 5_000_000, sealed: 'x' });
	await send(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'USDC' });
	const [id, o] = orderOf(s, B);
	assert.equal(o.payTo, (await import('./src/crypto.ts')).toBase58(A.address), 'paid to the creator\'s own Solana address');
	assert.equal(o.base, 5_000_000); assert.ok(o.due > o.base && o.due - o.base < 10_000, 'a few smallest units over, unique');
	await send(s, B, 'order.paid', { id, tx: '5'.repeat(88) });
	await send(s, V, 'order.attest', { id, tx: '5'.repeat(88), amount: o.due });
	assert.ok(s.owned[`${B.address}/${A.address}/pack`], 'owned'); assert.equal(s.orders, undefined, 'the order is done');
	assert.equal(s.feeOwed[A.address], 25_000, '0.5% of $5 owed'); assert.equal(s.sales[`${A.address}/pack`].usd, 5_000_000);
	assert.ok(s.xseen[`sol:${'5'.repeat(88)}`], 'that payment can never count again');
	whole(s, 'an outside sale');
});
await test('checkout attacks: someone else names the payment, a used payment, too little, another order\'s exact amount, no 0x address, no price, too many open', async () => {
	const s = await fresh();
	await sell(s, 'pack', { title: 'Pack', usd: 5_000_000 });
	await refused(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'base', coin: 'USDC' }, /no address on that network/);
	await refused(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'SOL' }, /no price/);
	await refused(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'base', coin: 'SOL' }, /cannot be paid on that network/);
	await refused(s, A, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'USDC' }, /your own item/);
	await send(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'USDC' });
	await send(s, C, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'USDC' });
	const [idB, oB] = orderOf(s, B), [idC, oC] = orderOf(s, C);
	assert.notEqual(oB.due, oC.due, 'two open orders never ask the same amount');
	await refused(s, C, 'order.paid', { id: idB, tx: '6'.repeat(88) }, /someone else/);
	await send(s, C, 'order.paid', { id: idC, tx: '6'.repeat(88) });
	await refused(s, V, 'order.attest', { id: idC, tx: '7'.repeat(88), amount: oC.due }, /not the payment this checkout named/);
	await refused(s, V, 'order.attest', { id: idC, tx: '6'.repeat(88), amount: 4_000_000 }, /less than the price/);
	await refused(s, V, 'order.attest', { id: idC, tx: '6'.repeat(88), amount: oB.due }, /belongs to another checkout/); // C names B's exact payment
	await refused(s, B, 'order.attest', { id: idC, tx: '6'.repeat(88), amount: oC.due }, /only a validator/);
	await send(s, V, 'order.attest', { id: idC, tx: '6'.repeat(88), amount: 4_960_000 }); // an exchange took its fee: 99.2% of the price counts
	assert.ok(s.owned[`${C.address}/${A.address}/pack`]);
	await refused(s, B, 'order.paid', { id: idB, tx: '6'.repeat(88) }, /already counted/);
});
await test('fees owed for outside sales are paid from the creator\'s next earnings on Dznye; past $20 owed, no new outside checkouts', async () => {
	const s = await fresh();
	s.feeOwed = { [A.address]: 10_000 }; // $0.01 owed
	const o0 = bal(s, OWNER), a0 = bal(s, A);
	await send(s, B, 'tip', { to: A.address, amount: 10 * DZY });
	const owedDzy = L.usdCost(s, 'DZY', 10_000);
	assert.equal(bal(s, OWNER) - o0, 10 * DZY * 50 / 10_000 + owedDzy, 'the 0.5% and what was owed');
	assert.equal(bal(s, A) - a0, 10 * DZY - 10 * DZY * 50 / 10_000 - owedDzy);
	assert.equal(s.feeOwed?.[A.address], undefined, 'paid off');
	s.feeOwed = { [A.address]: 20_000_001 };
	await sell(s, 'pack', { title: 'Pack', usd: 1_000_000 });
	await refused(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'USDC' }, /cannot take outside payments/);
});
await test('the creator settles fees by hand; an ended checkout anyone may clear', async () => {
	const s = await fresh();
	s.feeOwed = { [A.address]: 50_000 };
	await send(s, A, 'fee.settle', {});
	assert.equal(s.feeOwed?.[A.address], undefined);
	await refused(s, A, 'fee.settle', {}, /owe no fees/);
	await sell(s, 'pack', { title: 'Pack', usd: 1_000_000 });
	await send(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'sol', coin: 'USDC' });
	const [id] = orderOf(s, B);
	await refused(s, C, 'order.cancel', { id }, /still open/);
	s.time += L.RULES.orderLife + L.RULES.orderGrace + 1;
	await send(s, C, 'order.cancel', { id });
	assert.equal(s.orders, undefined);
});
await test('a buyer moves their purchases into their wallet: only the key that holds them can; memberships keep the later end', async () => {
	const s = await fresh(), W = C; // C plays the buyer's new wallet
	await sell(s, 'pack', { title: 'Pack', price: DZY });
	await sell(s, 'club', { title: 'Club', usd: 1_000, every: 'month' });
	await send(s, B, 'item.buy', { seller: A.address, item: 'pack', asset: 'DZY', amount: DZY });
	await send(s, B, 'item.buy', { seller: A.address, item: 'club', asset: 'DZY', max: 10 ** 9 });
	await send(s, W, 'item.buy', { seller: A.address, item: 'club', asset: 'DZY', max: 10 ** 9 });
	await send(s, W, 'item.buy', { seller: A.address, item: 'club', asset: 'DZY', max: 10 ** 9 }); // W's membership runs longer
	const wUntil = s.owned[`${W.address}/${A.address}/club`].until;
	await refused(s, A, 'owned.move', { to: W.address }, /owns nothing/); // someone else cannot move B's
	await refused(s, B, 'owned.move', { to: B.address }, /bad account/);
	await send(s, B, 'owned.move', { to: W.address });
	assert.ok(s.owned[`${W.address}/${A.address}/pack`], 'moved'); assert.equal(s.owned[`${B.address}/${A.address}/pack`], undefined, 'gone from the old key');
	assert.equal(s.owned[`${W.address}/${A.address}/club`].until, wUntil, 'the longer membership is kept');
	await refused(s, B, 'owned.move', { to: W.address }, /owns nothing/);
});

await test('names: 4 letters or more as before; 1 to 3 letters are premium, from $5, rising with every one taken', async () => {
	const s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0, sales: [
		{ to: A.address, units: 1_000 * L.DZY, paid: 200 * L.DZY, proof: 'test' }, { to: B.address, units: 1_000 * L.DZY, paid: 200 * L.DZY, proof: 'test' }, { to: C.address, units: 100 * DZY, paid: 20 * DZY, proof: 'test' }] });
	L.testNamesV2From(CHAIN, 0);
	try {
		await refused(s, B, 'name.set', { name: 'x'.repeat(21) }, /a name is 4 to 20/);
		await refused(s, B, 'name.set', { name: 'a--b' }, /a name is 4 to 20/);
		await send(s, B, 'name.set', { name: 'bobby' }); // 4 or more: 0.1 DZY, as before
		assert.equal(s.names.bobby, B.address);
		// the price ladder: 1 letter $5, $10, $15; 2 letters $5, $7.50; 3 letters $5, $6.25
		assert.equal(L.premiumNameUsd(s, 1), 5_000_000); assert.equal(L.premiumNameUsd(s, 2), 5_000_000); assert.equal(L.premiumNameUsd(s, 3), 5_000_000);
		const o0 = bal(s, OWNER), cost = L.usdCost(s, 'DZY', 5_000_000);
		await send(s, A, 'name.set', { name: 'z' });
		assert.equal(s.names.z, A.address); assert.equal(bal(s, OWNER) - o0, cost);
		assert.equal(L.premiumNameUsd(s, 1), 10_000_000);
		await send(s, B, 'name.set', { name: 'y' });
		assert.equal(L.premiumNameUsd(s, 1), 15_000_000);
		await send(s, A, 'name.set', { name: 'ab' }); assert.equal(L.premiumNameUsd(s, 2), 7_500_000); // A gives up @z for @ab
		assert.equal(s.names.z, undefined, 'the old name is free again');
		await send(s, B, 'name.set', { name: 'ace' }); assert.equal(L.premiumNameUsd(s, 3), 6_250_000);
		assert.deepEqual(s.premiumSold, { 1: 2, 2: 1, 3: 1 });
		await refused(s, C, 'name.set', { name: 'ace' }, /taken/);
		await refused(s, C, 'name.set', { name: 'q' }, /premium name: \$15/); // C cannot pay $15
		await refused(s, C, 'name.grant', { name: 'cc', to: C.address }, /only the founder/);
		whole(s, 'premium names');
		return `@z $5, @y $10; next 1-letter $15, 2-letter $7.50, 3-letter $6.25`;
	} finally { L.testNamesV2From(CHAIN, null); }
});
await test('names: before the switch-on block the old rule holds (3 letters for 0.1 DZY, no premium)', async () => {
	const s = await fresh();
	await refused(s, B, 'name.set', { name: 'ab' }, /a name is 3 to 20/);
	await send(s, B, 'name.set', { name: 'bob' });
	assert.equal(s.names.bob, B.address);
	await refused(s, A, 'name.grant', { name: 'aa', to: A.address }, /not open yet/);
});

console.log(`\n${pass} creator tests passed`);
