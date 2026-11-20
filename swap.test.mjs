// One-tap swaps and matching orders, written as attacks: a swap fills the open offers for its pair cheapest first, each
// only while it beats the pool, then the pool for the rest, all at once or not at all; an offer made with `fill` trades
// with the offers that meet its price first (each at its maker's own price) and leaves the rest open at its own price.
// Every refused transaction leaves no trace, and nothing is ever created or lost. Run: node chain/swap.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import { applyTx, balanceOf, DZY, genesis, holdings, nonceOf, poolQuote, signTx, swapPlan } from './src/ledger.ts';

const CHAIN = 'dznye-swap-test', T0 = 1_000_000;
const auth = await newKey(), alice = await newKey(), bob = await newKey(), eve = await newKey(), carl = await newKey();
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const send = async (s, who, type, data, time = T0) => applyTx(s, await tx(s, who, type, data), time);
const refuses = async (s, who, type, data, why) => { const before = canon(s); await assert.rejects(applyTx(s, await tx(s, who, type, data), T0), why); assert.equal(canon(s), before, 'a refused transaction changed the state'); };
const balanced = (s, where = '') => { const h = holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); assert.equal(s.assets.DZY.supply, s.assets.DZY.minted, 'DZY destroyed'); };
const bal = (s, k, a = 'DZY') => balanceOf(s, k.address, a);
const lastOffer = (s) => Object.keys(s.offers).at(-1);
async function fresh() {
	const s = await genesis(CHAIN, auth.address, T0);
	for (const [id, decimals] of [['MEME', 0], ['GOLD', 2]]) s.assets[id] = { symbol: id, name: id, issuer: auth.address, supply: 0, minted: 0, mintable: true, decimals };
	for (const who of [alice, bob, eve, carl]) {
		await send(s, auth, 'mint', { asset: 'DZY', amount: 10_000 * DZY, to: who.address });
		await send(s, auth, 'mint', { asset: 'MEME', amount: 10_000_000, to: who.address });
		await send(s, auth, 'mint', { asset: 'GOLD', amount: 10_000_000, to: who.address });
	}
	await send(s, alice, 'pool.open', { asset: 'MEME', dzy: 100 * DZY, token: 1_000_000 }); // 10,000 MEME a DZY
	return s;
}

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };

await test('a swap fills the cheapest offers first, then the pool for the rest, in one step; each maker gets exactly their price', async () => {
	const s = await fresh();
	await send(s, eve, 'offer.create', { give: { asset: 'MEME', amount: 100_000 }, want: { asset: 'DZY', amount: 8 * DZY } }); // 12,500 a DZY
	await send(s, bob, 'offer.create', { give: { asset: 'MEME', amount: 100_000 }, want: { asset: 'DZY', amount: 5 * DZY } }); // 20,000 a DZY: the best
	const viaPool = poolQuote(s, 'DZY', 'MEME', 7 * DZY).out;
	const plan = swapPlan(s, carl.address, 'DZY', 'MEME', 20 * DZY);
	assert.deepEqual(plan.fills.map((f) => s.offers[f.key].maker), [bob.address, eve.address], 'not cheapest first');
	await refuses(s, carl, 'swap', { give: 'DZY', want: 'MEME', amount: 20 * DZY, min: plan.out + 1 }, /less than your minimum/);
	await refuses(s, carl, 'swap', { give: 'DZY', want: 'MEME', amount: 20_000 * DZY, min: 1 }, /not enough balance/);
	await refuses(s, carl, 'swap', { give: 'DZY', want: 'DZY', amount: DZY, min: 1 }, /same asset/);
	const c0 = bal(s, carl), m0 = bal(s, carl, 'MEME'), b0 = bal(s, bob), e0 = bal(s, eve);
	await send(s, carl, 'swap', { give: 'DZY', want: 'MEME', amount: 20 * DZY, min: plan.out });
	assert.equal(bal(s, carl, 'MEME') - m0, 200_000 + viaPool, 'not both offers plus the pool for the rest');
	assert.equal(c0 - bal(s, carl), 20 * DZY + (s.fee ?? 0), 'paid more than the amount');
	assert.equal(bal(s, bob) - b0, 5 * DZY); assert.equal(bal(s, eve) - e0, 8 * DZY);
	assert.equal(Object.keys(s.offers).length, 0);
	balanced(s, 'swap');
	return `20 DZY → ${200_000 + viaPool} MEME (the pool alone: ${poolQuote(await fresh(), 'DZY', 'MEME', 20 * DZY).out})`;
});

await test('the pool wins where it is better: a worse offer is left alone; part of an offer is taken at its own price', async () => {
	const s = await fresh();
	await send(s, bob, 'offer.create', { give: { asset: 'MEME', amount: 50_000 }, want: { asset: 'DZY', amount: 10 * DZY } }); // 5,000 a DZY: worse than the pool
	const worse = lastOffer(s);
	await send(s, carl, 'swap', { give: 'DZY', want: 'MEME', amount: DZY, min: 1 });
	assert.equal(s.offers[worse].give.amount, 50_000, 'a worse offer was filled');
	await send(s, eve, 'offer.create', { give: { asset: 'MEME', amount: 1_000_000 }, want: { asset: 'DZY', amount: 50 * DZY } }); // 20,000 a DZY
	const big = lastOffer(s), m0 = bal(s, carl, 'MEME');
	await send(s, carl, 'swap', { give: 'DZY', want: 'MEME', amount: 3 * DZY, min: 60_000 });
	assert.equal(bal(s, carl, 'MEME') - m0, 60_000, 'part of the offer, not at its price');
	assert.deepEqual([s.offers[big].give.amount, s.offers[big].want.amount], [940_000, 47 * DZY], 'what is left is not at the same price');
	balanced(s, 'pool wins');
});

await test('own offers and ended offers are never filled; token for token goes through both pools or straight through offers', async () => {
	const s = await fresh();
	await send(s, carl, 'offer.create', { give: { asset: 'MEME', amount: 100_000 }, want: { asset: 'DZY', amount: DZY } }); // a great price, but carl's own
	const mine = lastOffer(s);
	await send(s, bob, 'offer.create', { give: { asset: 'MEME', amount: 100_000 }, want: { asset: 'DZY', amount: DZY }, until: T0 + 10 });
	const ended = lastOffer(s);
	await applyTx(s, await tx(s, carl, 'swap', { give: 'DZY', want: 'MEME', amount: DZY, min: 1 }), T0 + 100);
	assert.ok(s.offers[mine] && s.offers[ended], 'an own or ended offer was filled');
	await refuses(s, carl, 'swap', { give: 'GOLD', want: 'MEME', amount: 100, min: 1 }, /nothing to trade against/); // no GOLD pool, no offers
	await send(s, eve, 'offer.create', { give: { asset: 'MEME', amount: 1_000 }, want: { asset: 'GOLD', amount: 500 } });
	const g0 = bal(s, carl, 'GOLD');
	await send(s, carl, 'swap', { give: 'GOLD', want: 'MEME', amount: 500, min: 1_000 });
	assert.equal(g0 - bal(s, carl, 'GOLD'), 500);
	await send(s, alice, 'pool.open', { asset: 'GOLD', dzy: 100 * DZY, token: 1_000_000 });
	const q = poolQuote(s, 'GOLD', 'MEME', 10_000).out, m0 = bal(s, carl, 'MEME');
	await send(s, carl, 'swap', { give: 'GOLD', want: 'MEME', amount: 10_000, min: q });
	assert.equal(bal(s, carl, 'MEME') - m0, q, 'GOLD → DZY → MEME is not the two pools');
	balanced(s, 'token for token');
});

await test('an offer made with fill trades with the offers that meet its price, each at its maker\'s price, and leaves the rest open at its own', async () => {
	const s = await fresh();
	await send(s, bob, 'offer.create', { give: { asset: 'MEME', amount: 100_000 }, want: { asset: 'DZY', amount: 5 * DZY } }); // 20,000 a DZY
	await send(s, eve, 'offer.create', { give: { asset: 'MEME', amount: 100_000 }, want: { asset: 'DZY', amount: 10 * DZY } }); // 10,000 a DZY: too dear for carl
	const evesOffer = lastOffer(s);
	await refuses(s, carl, 'offer.create', { give: { asset: 'DZY', amount: 10 * DZY }, want: { asset: 'MEME', amount: 150_000 }, fill: 'yes' }, /fill: true or false/);
	const c0 = bal(s, carl), m0 = bal(s, carl, 'MEME');
	await send(s, carl, 'offer.create', { give: { asset: 'DZY', amount: 10 * DZY }, want: { asset: 'MEME', amount: 150_000 }, fill: true }); // at least 15,000 a DZY
	assert.equal(bal(s, carl, 'MEME') - m0, 100_000, 'bob\'s offer was not filled');
	assert.equal(c0 - bal(s, carl), 10 * DZY + (s.fee ?? 0), 'carl did not pay 5 DZY to bob and put 5 in the open offer');
	const rest = s.offers[lastOffer(s)];
	assert.deepEqual([rest.maker, rest.give.amount, rest.want.amount], [carl.address, 5 * DZY, 75_000], 'the rest is not open at carl\'s price');
	assert.equal(s.offers[evesOffer].give.amount, 100_000, 'an offer dearer than carl\'s price was filled');
	// a later seller who meets carl's price fills carl's open offer at carl's price
	// (an order stops once it has what it asked for: eve asks 4 DZY, gets them at carl's price, and keeps the rest of her MEME)
	const e0 = bal(s, eve), em0 = bal(s, eve, 'MEME');
	await send(s, eve, 'offer.create', { give: { asset: 'MEME', amount: 75_000 }, want: { asset: 'DZY', amount: 4 * DZY }, fill: true });
	assert.equal(bal(s, eve) - e0, 4 * DZY - (s.fee ?? 0), 'eve did not get 4 DZY from carl');
	assert.equal(em0 - bal(s, eve, 'MEME'), 60_000, 'eve did not pay carl\'s price (15,000 MEME a DZY)');
	const left = Object.values(s.offers).find((o) => o.maker === carl.address);
	assert.deepEqual([left.give.amount, left.want.amount], [DZY, 15_000], 'carl\'s offer did not keep his price');
	balanced(s, 'matching');
});

await test('500 random offers (some matching), swaps, takes and cancels: nothing created or lost, and no swap ever gives less than its minimum', async () => {
	const s = await fresh();
	await send(s, alice, 'pool.open', { asset: 'GOLD', dzy: 100 * DZY, token: 1_000_000 });
	let seed = 11; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); };
	const people = [alice, bob, eve, carl], assets = ['DZY', 'MEME', 'GOLD'], size = { DZY: 20 * DZY, MEME: 200_000, GOLD: 20_000 };
	let ok = 0, no = 0, swaps = 0;
	for (let i = 0; i < 500; i++) {
		const k = people[rnd(4)], a = assets[rnd(3)], b = assets.filter((x) => x !== a)[rnd(2)], r = rnd(10);
		try {
			if (r < 4) await send(s, k, 'offer.create', { give: { asset: a, amount: 1 + rnd(size[a]) }, want: { asset: b, amount: 1 + rnd(size[b]) }, ...(rnd(2) ? { fill: true } : {}) });
			else if (r < 7) {
				const amount = 1 + rnd(size[a]), plan = swapPlan(s, k.address, a, b, amount), b0 = bal(s, k, b), min = Math.max(1, Math.floor(plan.out * 0.99));
				await send(s, k, 'swap', { give: a, want: b, amount, min });
				assert.ok(bal(s, k, b) - b0 + (b === 'DZY' ? s.fee ?? 0 : 0) >= min, `step ${i}: a swap gave less than its minimum`);
				swaps++;
			} else if (r < 9) { const ids = Object.keys(s.offers); await send(s, k, 'offer.take', { id: ids[rnd(ids.length)] }); }
			else { const ids = Object.keys(s.offers).filter((id) => s.offers[id].maker === k.address); await send(s, k, 'offer.cancel', { id: ids[rnd(ids.length)] }); }
			ok++;
		} catch (e) { if (e instanceof assert.AssertionError) throw e; no++; }
		balanced(s, `step ${i}`);
	}
	return `${ok} went through (${swaps} swaps), ${no} refused; ${Object.keys(s.offers).length} offers open at the end`;
});

console.log(`\n${pass} tests passed`);
