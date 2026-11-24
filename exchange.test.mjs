// The exchange (EXCHANGE.md), written as attacks: DZY against BTC, ETH, SOL and USDC held in vaults on their own chains.
// Nothing is burned once it opens; a deposit counts only when more than two thirds of the validators confirm it; a price
// counts only when they agree; selling back never pays more coin than the claims given up, so no vault ever owes more
// than it holds; a coin that falls lets its holder take it back for fewer DZY, one that rises needs more; and the
// 12,000,000 DZY stay exact through all of it. Run: node chain/exchange.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';

const results = [];
async function test(name, fn) {
	const t0 = Date.now();
	try { const note = await fn(); results.push(['PASS', name, note ?? '', Date.now() - t0]); }
	catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 4).join(' | '), Date.now() - t0]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}  (${r[3]} ms)`);
}
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, SAT = 100_000_000, dzy = (n) => Math.round(n * DZY);
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye exchange test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 8 }, (_, i) => key(i));
const VS = K.slice(0, 4), [A, B, C, SHOP] = K.slice(4);
const CHAIN = 'dznye-exchange-test', T0 = 1_800_000_000_000;
const BTC_TO = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', ETH_TO = '0x00000000000000000000000000000000000d0e01';
const fresh = async () => {
	const s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: VS.map((v) => v.address), seedWait: 0,
		sales: [...[A, B, C, SHOP].map((k) => ({ to: k.address, units: dzy(1_000), paid: dzy(1_000) / 500, proof: 'test' })),
			...VS.map((v) => ({ to: v.address, units: dzy(10), paid: dzy(10) / 500, proof: 'test: fees' }))] });
	return s;
};
let txn = 0;
const apply = async (s, k, type, data) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, VS[0].address, undefined);
const send = async (s, k, type, data = {}) => { s.time += 1000; s.height += 1; txn++; return apply(s, k, type, data); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); await assert.rejects(() => apply(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed`);
const lock = (s, k, coin) => s.x?.locks?.[k.address + ':' + coin] ?? 0, pot = (s, coin) => s.x?.pot?.[coin] ?? 0;
const locked = (s, coin) => Object.entries(s.x?.locks ?? {}).filter(([k]) => k.endsWith(':' + coin)).reduce((n, [, v]) => n + v, 0);
/** every unit of coin in the vaults is accounted for, exactly: someone's free claims, someone's lock, or the pot */
const solvent = (s, where) => { for (const coin of Object.keys(L.X_COINS)) { const held = Object.entries(s.x?.vaults ?? {}).filter(([k]) => k.endsWith(':' + coin)).reduce((n, [, v]) => n + v, 0); const owed = (s.assets['x' + coin]?.supply ?? 0) + locked(s, coin) + pot(s, coin); assert.equal(held, owed, `${where}: the ${coin} vaults hold ${held} but claims + locks + pot = ${owed}`); } };
const bal = (s, k, a = 'DZY') => L.balanceOf(s, k.address, a);
/** every validator reads the same prices (µ$ per whole coin) */
const prices = async (s, p, who = VS) => { for (const v of who) await send(s, v, 'x.price', { p }); };
/** a deposit confirmed by `by` validators (three of the four unless said: more than two thirds, so it counts) */
const deposit = async (s, d, by = VS.slice(0, 3)) => { for (const v of by) await send(s, v, 'x.deposit', d); };
let txid = 0;
const payment = () => (++txid).toString(16).padStart(64, 'a');
const open = async () => { const s = await fresh(); L.testExchangeFrom(CHAIN, s.height + 1); return s; };


await test('Before it opens, the exchange refuses everything; once open, nothing can be bought by burning money any more', async () => {
	L.testExchangeFrom(CHAIN, null);
	const s = await fresh();
	await refused(s, VS[0], 'x.price', { p: { BTC: 90_000_000_000 } }, /not open/);
	L.testExchangeFrom(CHAIN, s.height + 1);
	await refused(s, VS[0], 'sun.attest', { net: 'base', token: 'USDC', amount: 5_000_000, tx: '0x' + 'ab'.repeat(32), to: A.address }, /nothing is burned/);
	whole(s, 'open');
});

await test('A deposit counts only when more than two thirds of the validators confirm the same details, and only once; it buys DZY and the coin is locked in the buyer\'s own name', async () => {
	const s = await open();
	await prices(s, { BTC: 90_000_000_000 });
	const d = { net: 'btc', coin: 'BTC', amount: 1_000_000, tx: payment(), to: A.address }; // 0.01 BTC
	await refused(s, A, 'x.deposit', d, /only a validator/);
	await deposit(s, d, VS.slice(0, 2));
	assert.equal(lock(s, A, 'BTC'), 0, 'two of four validators were enough');
	const a0 = bal(s, A);
	await deposit(s, d, VS.slice(2, 3));
	assert.equal(lock(s, A, 'BTC'), 1_000_000, 'three of four did not lock it');
	assert.equal(bal(s, A, 'xBTC'), 0, 'a lock became a token someone could send away');
	const got = bal(s, A) - a0;
	assert.ok(got > dzy(7_000) && got < dzy(8_000), `0.01 BTC at $90,000 bought ${got / DZY} DZY`);
	await refused(s, VS[3], 'x.deposit', d, /already counted/);
	solvent(s, 'deposit'); whole(s, 'deposit');
	return `0.01 BTC ($900) bought ${(got / DZY).toFixed(2)} DZY; the 0.01 BTC is locked in A's name`;
});

await test('A lock belongs only to its owner: nobody else can close it, send it, offer it or sell it', async () => {
	const s = await open();
	await prices(s, { ETH: 3_000_000_000 });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: A.address });
	await refused(s, B, 'x.close', { coin: 'ETH', net: 'base', to: ETH_TO }, /no ETH locked/);
	await refused(s, A, 'transfer', { asset: 'xETH', to: B.address, amount: 1 }, /not enough|balance|no such asset/);
	await refused(s, A, 'offer.create', { give: { asset: 'xETH', amount: 1 }, want: { asset: 'DZY', amount: 1 } }, /not enough|balance|no such asset/);
	await refused(s, A, 'x.sell', { coin: 'ETH', amount: 1, net: 'base', to: ETH_TO }, /free ETH|claims on less/);
	assert.equal(lock(s, A, 'ETH'), 1_000_000_000);
	solvent(s, 'own only'); whole(s, 'own only');
});

await test('Closing a lock when the coin fell: fewer DZY get the whole lock back, and the owner keeps the rest of their DZY', async () => {
	const s = await open();
	await prices(s, { BTC: 90_000_000_000 });
	await deposit(s, { net: 'btc', coin: 'BTC', amount: 1_000_000, tx: payment(), to: A.address });
	const bought = bal(s, A) - dzy(1_000);
	await prices(s, { BTC: 45_000_000_000 }); // BTC halves
	const a0 = bal(s, A);
	await send(s, A, 'x.close', { coin: 'BTC', net: 'btc', to: BTC_TO }); // no amount: the whole lock
	const back = a0 - bal(s, A);
	assert.ok(back < bought * 0.55 && back > bought * 0.45, `returned ${back / DZY} DZY of ${bought / DZY} for the whole 0.01 BTC`);
	assert.equal(lock(s, A, 'BTC'), 0);
	const p = Object.values(s.xpays).at(-1);
	assert.equal(p.amount, 1_000_000 - 1_000, 'not 0.01 BTC less 0.1%');
	assert.equal(pot(s, 'BTC'), 1_000, 'the 0.1% did not go to the pot');
	solvent(s, 'fell'); whole(s, 'fell');
	return `BTC halved: ${(back / DZY).toFixed(2)} of ${(bought / DZY).toFixed(2)} DZY returned for the whole lock`;
});

await test('Closing a lock when the coin rose: the owner gets what their DZY buy today, and the rest of the lock goes to the pot (or stays locked if they choose)', async () => {
	const s = await open();
	await prices(s, { ETH: 3_000_000_000 });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: A.address });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: B.address });
	const aBought = bal(s, A) - dzy(1_000);
	await prices(s, { ETH: 6_000_000_000 }); // ETH doubles: the DZY bought now cover about half the lock
	await refused(s, A, 'x.close', { coin: 'ETH', dzy: bal(s, A) + 1, net: 'base', to: ETH_TO }, /you hold less DZY/);
	await send(s, A, 'x.close', { coin: 'ETH', dzy: aBought, net: 'base', to: ETH_TO });
	const p = Object.values(s.xpays).at(-1);
	assert.ok(p.amount > 470_000_000 && p.amount < 600_000_000, `paid ${p.amount} gwei for DZY bought with 1 ETH at half the price`);
	assert.equal(lock(s, A, 'ETH'), 0, 'the lock was not closed');
	assert.equal(pot(s, 'ETH'), 1_000_000_000 - p.amount, 'the rest of the lock (and the fee) did not go to the pot');
	const potA = pot(s, 'ETH'), bBought = bal(s, B) - dzy(1_000);
	await send(s, B, 'x.close', { coin: 'ETH', dzy: Math.floor(bBought / 2), net: 'base', to: ETH_TO, keep: true });
	assert.ok(lock(s, B, 'ETH') > 700_000_000, 'keep: the rest did not stay locked');
	assert.ok(pot(s, 'ETH') - potA < 2_000_000, 'keep: more than the fee went to the pot');
	solvent(s, 'rose'); whole(s, 'rose');
	return `ETH doubled: A got ${(p.amount / 1e9).toFixed(3)} ETH; the pot now holds ${(pot(s, 'ETH') / 1e9).toFixed(3)} ETH`;
});

await test('Parking: an account can choose to keep deposits as free coin on Dznye (no DZY bought); free coin trades on the order book, any pair, and pays 0.05% of the coin to the pot', async () => {
	const s = await open();
	await prices(s, { ETH: 3_000_000_000, SOL: 150_000_000 });
	await send(s, A, 'x.park', { on: true });
	const a0 = bal(s, A);
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: A.address });
	assert.equal(bal(s, A), a0, 'a parked deposit bought DZY');
	assert.equal(bal(s, A, 'xETH'), 1_000_000_000);
	await send(s, B, 'x.park', { on: true });
	await deposit(s, { net: 'sol', coin: 'SOL', amount: 20_000_000_000, tx: payment(), to: B.address });
	// ETH for SOL, between two people, no pool: A offers 1 ETH for 20 SOL, B takes it
	await send(s, A, 'offer.create', { give: { asset: 'xETH', amount: 1_000_000_000 }, want: { asset: 'xSOL', amount: 20_000_000_000 } });
	const id = Object.keys(s.offers).at(-1);
	await send(s, B, 'offer.take', { id });
	assert.equal(bal(s, B, 'xETH'), 1_000_000_000 - 500_000, 'the taker did not get the coin less 0.05%');
	assert.equal(bal(s, A, 'xSOL'), 20_000_000_000, 'the maker was charged twice');
	assert.equal(pot(s, 'ETH'), 500_000);
	// B takes the ETH out on Base: free coin needs no DZY
	await send(s, B, 'x.sell', { coin: 'ETH', amount: bal(s, B, 'xETH'), net: 'base', to: ETH_TO });
	await send(s, A, 'x.park', { on: false });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 100_000_000, tx: payment(), to: A.address });
	assert.ok(bal(s, A) > a0, 'unparked, a deposit bought no DZY');
	solvent(s, 'park'); whole(s, 'park');
	return 'ETH for SOL between two people, no pool; 0.0005 ETH to the pot';
});

await test('The floor: anyone can sell DZY to the pot at the pot\'s value per DZY in hands, never above it; the floor never falls from it; the DZY go back to the sale, not burned', async () => {
	const s = await open();
	await refused(s, A, 'x.floor', { coin: 'ETH', dzy: dzy(1) }, /the pot holds no|no ETH in the pot/);
	await prices(s, { ETH: 3_000_000_000 });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: B.address });
	await prices(s, { ETH: 6_000_000_000, BTC: 90_000_000_000 });
	await send(s, B, 'x.close', { coin: 'ETH', dzy: dzy(10), net: 'base', to: ETH_TO }); // closes cheaply: most of the lock goes to the pot
	const f0 = L.exchangeView(s).floor;
	assert.ok(f0.usd > 0 && f0.sats > 0, 'no floor');
	const a0 = bal(s, A), sale0 = s.sun.salePot;
	await send(s, A, 'x.floor', { coin: 'ETH', dzy: dzy(100) });
	const got = bal(s, A, 'xETH');
	const worth = got * 6_000 / 1e9; // dollars
	assert.ok(worth <= 100 * (f0.usd + 1) / 1e6, `paid $${worth} for 100 DZY at a floor of $${f0.usd / 1e6}`);
	assert.ok(worth > 100 * f0.usd / 1e6 * 0.999, 'paid well under the floor');
	assert.equal(a0 - bal(s, A), dzy(100) + (s.fee ?? 0)); // and the usual transaction fee
	assert.equal(s.sun.salePot - sale0, dzy(100), 'the DZY did not go back to the sale');
	assert.ok(L.exchangeView(s).floor.usd >= f0.usd, 'selling at the floor lowered it');
	await refused(s, A, 'x.floor', { coin: 'SOL', dzy: dzy(1) }, /no SOL in the pot/); // (the whole pot can never be overdrawn: all DZY in hands are worth exactly the pot at the floor)
	await refused(s, A, 'x.floor', { coin: 'ETH', dzy: bal(s, A) + 1 }, /you hold less DZY/);
	s.time += 61 * 60_000; // the price goes stale
	await refused(s, A, 'x.floor', { coin: 'ETH', dzy: dzy(1) }, /price/);
	solvent(s, 'floor'); whole(s, 'floor');
	return `floor $${(f0.usd / 1e6).toFixed(6)} (${f0.sats} sats) per DZY; 100 DZY sold to the pot for $${worth.toFixed(4)} of ETH`;
});

await test('Swap: DZY against a vault coin always has a price, with no pool: free coin buys DZY from the sale (locked in the buyer\'s name); DZY someone earned (a validator\'s pay) sells to people\'s offers first, then the pot at the floor', async () => {
	const s = await open();
	await prices(s, { ETH: 3_000_000_000, BTC: 90_000_000_000 });
	// A parks 1 ETH and swaps it for DZY: nobody offers DZY and there is no pool, so the sale sells it, and the ETH becomes A's lock
	await send(s, A, 'x.park', { on: true });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: A.address });
	const plan = L.swapPlan(s, A.address, 'xETH', 'DZY', 1_000_000_000);
	assert.ok(plan.out > 0 && !plan.fills.length, 'no sale price for free coin');
	const a0 = bal(s, A);
	await send(s, A, 'swap', { give: 'xETH', want: 'DZY', amount: 1_000_000_000, min: plan.out });
	assert.equal(bal(s, A) - a0 + (s.fee ?? 0), plan.out, 'not the sale price');
	assert.equal(lock(s, A, 'ETH'), 1_000_000_000, 'the coin did not become A\'s lock');
	assert.equal(bal(s, A, 'xETH'), 0);
	// ETH doubles; A closes the lock with a few DZY, so most of it goes to the pot: now the floor has ETH behind it
	await prices(s, { ETH: 6_000_000_000, BTC: 90_000_000_000 });
	await send(s, A, 'x.close', { coin: 'ETH', dzy: dzy(10), net: 'base', to: ETH_TO });
	// SHOP holds DZY it never bought with coin (like a validator's pay) and cashes some for ETH
	const floor = L.exchangeView(s).floor.usd, sell = dzy(100);
	const atFloor = L.swapPlan(s, SHOP.address, 'DZY', 'xETH', sell).out;
	assert.ok(atFloor > 0, 'no way to cash DZY for ETH with no pool and no offers');
	assert.ok(atFloor * 6_000 / 1e9 <= 100 * (floor + 1) / 1e6, 'paid above the floor');
	// C parks ETH and offers more ETH per DZY than the floor pays: a swap fills C first
	await send(s, C, 'x.park', { on: true });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 100_000_000, tx: payment(), to: C.address });
	await send(s, C, 'offer.create', { give: { asset: 'xETH', amount: 10_000_000 }, want: { asset: 'DZY', amount: dzy(50) } }); // 0.2 mETH a DZY, above the floor
	const both = L.swapPlan(s, SHOP.address, 'DZY', 'xETH', sell);
	assert.equal(both.fills.length, 1, 'the better offer was not used first');
	assert.ok(both.out > atFloor, 'the offer did not improve the price');
	const e0 = bal(s, SHOP, 'xETH'), c0 = bal(s, C);
	await send(s, SHOP, 'swap', { give: 'DZY', want: 'xETH', amount: sell, min: both.out });
	assert.equal(bal(s, SHOP, 'xETH') - e0, both.out);
	assert.equal(bal(s, C) - c0, dzy(50), 'C was not paid its price');
	await refused(s, SHOP, 'swap', { give: 'DZY', want: 'xETH', amount: sell, min: both.out * 10 }, /less than your minimum/);
	solvent(s, 'swap legs'); whole(s, 'swap legs');
	return `1 ETH → ${(plan.out / DZY).toFixed(2)} DZY from the sale; 100 earned DZY → ${(both.out / 1e9).toFixed(6)} ETH (offer first, then the floor), against ${(atFloor / 1e9).toFixed(6)} at the floor alone`;
});

await test('Limits: a deposit over the limit, or after the sale has nothing left, is kept as free coin for its owner, who can take it straight back', async () => {
	const s = await open();
	await prices(s, { BTC: 90_000_000_000 });
	const a0 = bal(s, A);
	await deposit(s, { net: 'btc', coin: 'BTC', amount: L.X_LIMITS.BTC.deposit + 1, tx: payment(), to: A.address });
	assert.equal(bal(s, A), a0, 'DZY given past the deposit limit');
	await send(s, A, 'x.sell', { coin: 'BTC', amount: L.X_LIMITS.BTC.deposit + 1, net: 'btc', to: BTC_TO });
	assert.equal(bal(s, A, 'xBTC'), 0);
	solvent(s, 'limits'); whole(s, 'limits');
});

await test('Limits lifted (block-gated): before the block an over-limit deposit is free coin; from it on the same deposit buys DZY and a lock, which can be undone', async () => {
	const s = await open();
	await prices(s, { BTC: 90_000_000_000 });
	const lift = s.height + 12;
	L.testXUnlimitedFrom(CHAIN, lift);
	try {
		assert.equal(L.exchangeView(s).coins.BTC.limits.deposit, L.X_LIMITS.BTC.deposit, 'limits shown before the lift');
		const a0 = bal(s, A), over = L.X_LIMITS.BTC.vault + 1; // past the deposit limit AND the vault limit
		await deposit(s, { net: 'btc', coin: 'BTC', amount: over, tx: payment(), to: A.address });
		assert.equal(bal(s, A), a0, 'DZY given before the lift');
		assert.equal(bal(s, A, 'xBTC'), over, 'kept as free coin before the lift');
		while (s.height + 1 < lift) await send(s, VS[0], 'x.price', { p: { BTC: 90_000_000_000 } });
		assert.deepEqual(L.exchangeView(s).coins.BTC.limits, {}, 'limits shown after the lift');
		const owned = bal(s, A, 'xBTC');
		await deposit(s, { net: 'btc', coin: 'BTC', amount: over, tx: payment(), to: A.address });
		assert.ok(bal(s, A) > a0, 'DZY given after the lift');
		assert.equal(lock(s, A, 'BTC'), over, 'locked in the buyer\'s own name after the lift');
		assert.equal(bal(s, A, 'xBTC'), owned, 'no extra free coin after the lift');
		solvent(s, 'lift'); whole(s, 'lift');
		await send(s, A, 'x.close', { coin: 'BTC', to: 'wallet' });
		assert.equal(lock(s, A, 'BTC'), 0, 'the lock closes');
		assert.ok(bal(s, A, 'xBTC') > owned, 'the coin comes back as free coin');
		solvent(s, 'lift undone'); whole(s, 'lift undone');
		return `deposit limit ${L.X_LIMITS.BTC.deposit}, vault limit ${L.X_LIMITS.BTC.vault}: both gone from block ${lift}`;
	} finally { L.testXUnlimitedFrom(CHAIN, null); }
});

await test('The lift is only for a chain that names it: with no block set (and on mainnet until its block) the limits hold', async () => {
	const s = await open();
	assert.equal(L.xUnlimited(s), false, 'a chain with no lift block');
	const m = await L.sunGenesis({ chain: 'dznye-mainnet', time: T0, validators: VS.map((v) => v.address), seedWait: 0, sales: [{ to: A.address, units: dzy(10), paid: dzy(10) / 500, proof: 'test' }] });
	assert.equal(L.xUnlimited(m, 1), false, 'mainnet before its block');
});

await test('vault checkout (block-gated): a shop opens for $5 owed; an outside payment lands in the vault; the creator gets 99.5% as that coin on Dznye, the founder 0.5% and the $5 at once', async () => {
	const s = await open();
	await prices(s, { USDC: 1_000_000 });
	const VAULT = '0x' + 'ab'.repeat(20);
	for (const v of VS.slice(0, 3)) await send(s, v, 'x.vault', { net: 'base', address: VAULT });
	await send(s, A, 'record.put', { space: 'items', key: 'pack', value: { title: 'Brush pack', kind: 'file', usd: 10_000_000, sealed: 'sealed-test' } });
	L.testCheckoutV2From(CHAIN, s.height + 2);
	try {
		await send(s, C, 'x.price', {}).catch(() => {}); // a block passes: the upgrade is on from here
		while (!L.checkoutV2(s)) { s.height += 1; }
		await refused(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'base', coin: 'USDC' }, /not opened their shop/);
		await send(s, A, 'creator.join', {});
		assert.equal(L.feeOwedOf(s, A.address), L.CREATOR_JOIN_USD, '$5 owed on joining');
		await refused(s, A, 'creator.join', {}, /already open/);
		await refused(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'arb', coin: 'USDC' }, /network Dznye has a vault on/); // no vault listed there
		await send(s, B, 'order.open', { seller: A.address, item: 'pack', net: 'base', coin: 'USDC' });
		const [id, o] = Object.entries(s.orders).find(([, x]) => x.buyer === B.address);
		assert.equal(o.payTo, VAULT, 'the buyer pays the vault, not the creator'); assert.equal(o.vault, true);
		const tx = '0x' + 'cd'.repeat(32);
		await send(s, B, 'order.paid', { id, tx });
		const owner = L.RULES.saleFeeTo, a0 = bal(s, A, 'xUSDC'), f0 = L.balanceOf(s, owner, 'xUSDC');
		for (const v of VS.slice(0, 3)) await send(s, v, 'order.attest', { id, tx, amount: o.due });
		const fee = Math.floor(o.due * 50 / 10_000);
		assert.equal(L.balanceOf(s, owner, 'xUSDC') - f0, fee + L.CREATOR_JOIN_USD, 'the founder gets the 0.5% and the $5, in USDC on Dznye');
		assert.equal(bal(s, A, 'xUSDC') - a0, o.due - fee - L.CREATOR_JOIN_USD, 'the creator gets the rest');
		assert.equal(L.feeOwedOf(s, A.address), 0, 'nothing owed');
		assert.ok(s.owned[`${B.address}/${A.address}/pack`], 'the buyer owns it');
		solvent(s, 'vault checkout'); whole(s, 'vault checkout');
		return `paid ${o.due} into the vault: creator ${o.due - fee - L.CREATOR_JOIN_USD}, founder ${fee} + $5 join`;
	} finally { L.testCheckoutV2From(CHAIN, null); }
});

await test('the fee setting: only the fee account sets it (0 to 20%), only from the upgrade; a set fee is what the next sale pays', async () => {
	const s = await open();
	await prices(s, { USDC: 1_000_000 });
	await refused(s, A, 'fee.set', { bps: 100 }, /checkout upgrade/);
	L.testCheckoutV2From(CHAIN, s.height + 1);
	try {
		await refused(s, A, 'fee.set', { bps: 100 }, /only the fee account/);
		await refused(s, A, 'fee.clear', { who: B.address, usd: 1 }, /only the fee account/);
		assert.equal(L.feeBpsOf(s), 50, 'the rule until set');
		s.saleFeeBps = 1_000; // as fee.set by the fee account would leave it (10%)
		assert.equal(L.feeBpsOf(s), 1_000);
		const VAULT = '0x' + 'ef'.repeat(20);
		for (const v of VS.slice(0, 3)) await send(s, v, 'x.vault', { net: 'base', address: VAULT });
		await send(s, A, 'record.put', { space: 'items', key: 'print', value: { title: 'Print', kind: 'image', usd: 20_000_000, sealed: 'x' } });
		await send(s, A, 'creator.join', {});
		await send(s, B, 'order.open', { seller: A.address, item: 'print', net: 'base', coin: 'USDC' });
		const [id, o] = Object.entries(s.orders).find(([, x]) => x.buyer === B.address), tx = '0x' + '12'.repeat(32);
		await send(s, B, 'order.paid', { id, tx });
		const f0 = L.balanceOf(s, L.RULES.saleFeeTo, 'xUSDC');
		for (const v of VS.slice(0, 3)) await send(s, v, 'order.attest', { id, tx, amount: o.due });
		assert.equal(L.balanceOf(s, L.RULES.saleFeeTo, 'xUSDC') - f0, Math.floor(o.due / 10) + L.CREATOR_JOIN_USD, '10% and the $5');
		solvent(s, 'fee set'); whole(s, 'fee set');
		assert.equal(L.exchangeView(s).fee.bps, 1_000, 'GET /exchange shows the fee now');
		return `10% taken: ${Math.floor(o.due / 10)} of ${o.due}`;
	} finally { L.testCheckoutV2From(CHAIN, null); }
});

await test('a wallet coin (ETH) pays a checkout in ONE vault deposit naming the order\'s tag; short of the price it stays the buyer\'s; naming it as a plain payment is refused', async () => {
	const s = await open();
	await prices(s, { USDC: 1_000_000, ETH: 3_000_000_000 });
	const VAULT = '0x' + '77'.repeat(20);
	for (const v of VS.slice(0, 3)) await send(s, v, 'x.vault', { net: 'base', address: VAULT });
	await send(s, A, 'record.put', { space: 'items', key: 'song', value: { title: 'Song', kind: 'audio', usd: 30_000_000, sealed: 'x' } });
	L.testCheckoutV2From(CHAIN, s.height + 1);
	try {
		await send(s, A, 'creator.join', {});
		await send(s, B, 'order.open', { seller: A.address, item: 'song', net: 'base', coin: 'ETH' });
		let [id, o] = Object.entries(s.orders).find(([, x]) => x.buyer === B.address);
		assert.equal(o.payTo, VAULT); assert.match(o.tag, /^[0-9a-f]{64}$/, 'a tag for the deposit');
		await refused(s, B, 'order.paid', { id, tx: '0x' + '34'.repeat(32) }, /nothing to name/);
		// short: the buyer keeps it as free coin, the order stays open
		await deposit(s, { net: 'base', coin: 'ETH', amount: Math.floor(o.due / 2), tx: payment(), to: o.tag });
		assert.equal(bal(s, B, 'xETH'), Math.floor(o.due / 2), 'short: the buyer\'s own, as ETH on Dznye'); assert.ok(s.orders?.[id], 'still open');
		const f0 = L.balanceOf(s, L.RULES.saleFeeTo, 'xETH');
		await deposit(s, { net: 'base', coin: 'ETH', amount: o.due, tx: payment(), to: o.tag });
		const fee = Math.floor(o.due * 50 / 10_000);
		assert.ok(s.owned[`${B.address}/${A.address}/song`], 'the buyer owns it'); assert.equal(s.orders?.[id], undefined, 'closed');
		assert.ok(L.balanceOf(s, L.RULES.saleFeeTo, 'xETH') - f0 >= fee, 'the founder gets the fee (and the $5) in ETH on Dznye');
		assert.ok(bal(s, A, 'xETH') > 0, 'the creator gets ETH on Dznye');
		solvent(s, 'eth checkout'); whole(s, 'eth checkout');
		return `one deposit of ${o.due} (ETH units) closed the checkout`;
	} finally { L.testCheckoutV2From(CHAIN, null); }
});

await test('before the upgrade the checkout pays the creator directly, and nobody needs to join', async () => {
	const s = await open();
	assert.equal(L.checkoutV2(s), false);
	assert.equal(L.creatorJoined(s, A.address), true);
	await refused(s, A, 'creator.join', {}, /checkout upgrade/);
});

await test('Attacks: draining a vault through a network that holds less, paying to a bad address, taking out locked coin as free, anyone but a validator posting prices', async () => {
	const s = await open();
	await prices(s, { ETH: 3_000_000_000 });
	await send(s, A, 'x.park', { on: true });
	await deposit(s, { net: 'base', coin: 'ETH', amount: 1_000_000_000, tx: payment(), to: A.address });
	await refused(s, B, 'x.sell', { coin: 'ETH', amount: 1, net: 'base', to: ETH_TO }, /free ETH|claims on less/);
	await refused(s, A, 'x.sell', { coin: 'ETH', amount: 1_000_000_000, net: 'arb', to: ETH_TO }, /arb vault holds less/);
	await refused(s, A, 'x.sell', { coin: 'ETH', amount: 1_000_000_000, net: 'base', to: 'not-an-address' }, /bad base address/);
	await refused(s, A, 'x.sell', { coin: 'ETH', amount: 1_000_000_000, net: 'btc', to: BTC_TO }, /paid out on/);
	await refused(s, A, 'x.close', { coin: 'ETH', net: 'base', to: ETH_TO }, /no ETH locked/);
	await refused(s, A, 'x.price', { p: { ETH: 1 } }, /only a validator/);
	await refused(s, VS[0], 'x.price', { p: { DOGE: 1 } }, /no coin DOGE/);
	await refused(s, A, 'x.park', { on: 'yes' }, /on: true or false/);
	solvent(s, 'attacks'); whole(s, 'attacks');
});

await test('600 random deposits, parks, price moves, closes, floor sales, take-outs, transfers and order-book fills on four coins: every unit of coin is always accounted for, and the 12,000,000 DZY stay exact', async () => {
	const s = await open();
	let seed = 5; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); };
	const P = { BTC: 90_000_000_000, ETH: 3_000_000_000, SOL: 150_000_000, USDC: 1_000_000 };
	await prices(s, P);
	const people = [A, B, C, SHOP], coins = Object.keys(L.X_COINS), to = (net) => net === 'btc' ? BTC_TO : net === 'sol' ? '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' : ETH_TO;
	let ok = 0, no = 0, floor = 0;
	for (let i = 0; i < 600; i++) {
		const k = people[rnd(4)], coin = coins[rnd(4)], net = L.X_COINS[coin].nets[rnd(L.X_COINS[coin].nets.length)], r = rnd(20);
		const f0 = L.exchangeView(s).floor?.usd ?? 0;
		try {
			if (r < 6) await deposit(s, { net, coin, amount: 1 + rnd(L.X_LIMITS[coin].deposit), tx: payment(), to: k.address });
			else if (r < 7) await send(s, k, 'x.park', { on: rnd(2) === 0 });
			else if (r < 9) { for (const c of coins) P[c] = Math.max(1, Math.round(P[c] * (0.7 + rnd(60) / 100))); await prices(s, P); }
			else if (r < 12) await send(s, k, 'x.close', { coin, net, to: rnd(3) ? to(net) : 'wallet', ...(rnd(2) ? { dzy: 1 + rnd(Math.max(1, bal(s, k))) } : {}), ...(rnd(3) ? {} : { keep: true }) });
			else if (r < 14) { await send(s, k, 'x.floor', { coin, dzy: 1 + rnd(Math.max(1, Math.floor(bal(s, k) / 10))) }); floor++; assert.ok((L.exchangeView(s).floor?.usd ?? 0) >= f0, `step ${i}: a floor sale lowered the floor`); }
			else if (r < 16) await send(s, k, 'x.sell', { coin, amount: 1 + rnd(Math.max(1, bal(s, k, 'x' + coin))), net, to: to(net) });
			else if (r < 17) { if (rnd(2)) await send(s, k, 'transfer', { asset: 'x' + coin, to: people[rnd(4)].address, amount: 1 + rnd(Math.max(1, bal(s, k, 'x' + coin))) }); else { const dz = rnd(2), give = dz ? 'DZY' : 'x' + coin, want = dz ? 'x' + coin : 'DZY', amount = 1 + rnd(Math.max(1, Math.floor(bal(s, k, give) / (dz ? 20 : 1)))), plan = L.swapPlan(s, k.address, give, want, amount); await send(s, k, 'swap', { give, want, amount, min: Math.max(1, plan.out) }); } }
			else if (false) await send(s, k, 'transfer', { asset: 'x' + coin, to: people[rnd(4)].address, amount: 1 + rnd(Math.max(1, bal(s, k, 'x' + coin))) });
			else if (r < 19) await send(s, k, 'offer.create', { ...(rnd(2) ? { fill: true } : {}), give: { asset: 'x' + coin, amount: 1 + rnd(Math.max(1, bal(s, k, 'x' + coin))) }, want: rnd(2) ? { asset: 'DZY', amount: 1 + rnd(dzy(50)) } : { asset: 'x' + coins[rnd(4)], amount: 1 + rnd(1e9) } });
			else { const ids = Object.keys(s.offers); if (!ids.length) throw new Error('none'); await send(s, k, 'offer.take', { id: ids[rnd(ids.length)] }); }
			ok++;
		} catch (e) { if (e instanceof assert.AssertionError) throw e; no++; }
		solvent(s, `step ${i}`);
	}
	for (const id of Object.keys(s.offers)) await send(s, people.find((p) => p.address === s.offers[id].maker), 'offer.cancel', { id });
	solvent(s, 'offers cancelled'); whole(s, 'random');
	const pots = coins.map((c) => `${c} ${pot(s, c)}`).join(', ');
	return `${ok} went through (${floor} floor sales), ${no} refused; the pot holds ${pots} (units)`;
});

await test('The new coins (USDT, BNB, POL, AVAX, and USDC on BNB Chain) count only from their block: before it the chain refuses them, as an old node would', async () => {
	const s = await open();
	L.testXMoreFrom(CHAIN, s.height + 6);
	await refused(s, VS[0], 'x.price', { p: { BNB: 586_000_000 } }, /no coin BNB/);
	await refused(s, VS[0], 'x.deposit', { net: 'arb', coin: 'USDT', amount: 5_000_000, tx: payment(), to: A.address }, /no such coin/);
	await refused(s, VS[0], 'x.deposit', { net: 'bsc', coin: 'USDC', amount: 5_000_000, tx: payment(), to: A.address }, /held on/);
	assert.deepEqual(Object.keys(L.exchangeView(s).coins), ['BTC', 'ETH', 'SOL', 'USDC'], 'the new coins showed before their block');
	assert.ok(!L.exchangeView(s).coins.USDC.nets.includes('bsc'), 'USDC on BNB Chain showed before its block');
	await prices(s, { BTC: 90_000_000_000, USDC: 1_000_000 }); // the old coins carry on as before
	while (s.height + 1 < L.xMoreFrom(CHAIN)) { s.height++; s.time += 1000; }
	assert.deepEqual(Object.keys(L.exchangeView(s).coins), ['BTC', 'ETH', 'SOL', 'USDC', 'USDT', 'BNB', 'POL', 'AVAX']);
	L.testXMoreFrom(CHAIN, null);
	whole(s, 'before the new coins');
});

await test('From then on: USDT buys DZY and is locked in the buyer\'s name; BNB too; a payment past a coin\'s limit arrives as that coin, free to take back; nothing is created', async () => {
	const s = await open();
	await prices(s, { BTC: 90_000_000_000, USDC: 1_000_000, USDT: 1_000_000, BNB: 586_000_000, POL: 82_000, AVAX: 7_100_000 });
	const a0 = bal(s, A);
	await deposit(s, { net: 'arb', coin: 'USDT', amount: 50_000_000, tx: payment(), to: A.address }); // 50 USDT
	assert.equal(lock(s, A, 'USDT'), 50_000_000, 'the USDT was not locked in A\'s name');
	const fromUsdt = bal(s, A) - a0;
	assert.ok(fromUsdt > dzy(300) && fromUsdt < dzy(500), `50 USDT bought ${fromUsdt / DZY} DZY`);
	const b0 = bal(s, B);
	await deposit(s, { net: 'bsc', coin: 'BNB', amount: 100_000_000, tx: payment(), to: B.address }); // 0.1 BNB, about $58.60
	const fromBnb = bal(s, B) - b0;
	assert.ok(fromBnb > fromUsdt, `0.1 BNB ($58.60) bought ${fromBnb / DZY} DZY, 50 USDT ${fromUsdt / DZY}`);
	await deposit(s, { net: 'polygon', coin: 'POL', amount: 6_000_000_000_000, tx: payment(), to: C.address }); // 6,000 POL: over the 5,000 a payment
	assert.equal(lock(s, C, 'POL'), 0, 'past the limit, it still bought DZY');
	assert.equal(bal(s, C, 'xPOL'), 6_000_000_000_000, 'past the limit, the POL was not kept for its owner');
	await refused(s, VS[0], 'x.deposit', { net: 'polygon', coin: 'AVAX', amount: 1, tx: payment(), to: C.address }, /held on/);
	solvent(s, 'new coins'); whole(s, 'new coins');
	return `50 USDT bought ${(fromUsdt / DZY).toFixed(1)} DZY; 0.1 BNB bought ${(fromBnb / DZY).toFixed(1)}; 6,000 POL (over the limit) came back as free POL`;
});

await test('Selling back pays the right token at its own decimals: USDT on BNB Chain (18 decimals) and the network\'s own coin', async () => {
	const s = await open();
	await prices(s, { BTC: 90_000_000_000, USDT: 1_000_000, BNB: 586_000_000 });
	L.testExchangeVaults(CHAIN, { bsc: '0x' + '12'.repeat(20) });
	await deposit(s, { net: 'bsc', coin: 'USDT', amount: 2_000_000_000, tx: payment(), to: A.address }); // 2,000 USDT: over the limit, so free coin
	const free = bal(s, A, 'xUSDT');
	assert.equal(free, 2_000_000_000);
	await send(s, A, 'x.sell', { coin: 'USDT', net: 'bsc', to: ETH_TO, amount: 1_000_000_000 });
	const [id, p] = Object.entries(s.xpays).at(-1);
	const { releaseFor } = await import('./src/xrelease.ts');
	const r = releaseFor(s, id, 1);
	assert.equal(r.token, '0x55d398326f99059ff775485246999027b3197955', 'not BNB Chain\'s USDT');
	assert.equal(r.amount, BigInt(p.amount) * 10n ** 12n, 'not scaled to 18 decimals');
	await deposit(s, { net: 'bsc', coin: 'BNB', amount: 5_000_000_000, tx: payment(), to: B.address }); // 5 BNB: over the limit, free
	await send(s, B, 'x.sell', { coin: 'BNB', net: 'bsc', to: ETH_TO, amount: 1_000_000_000 });
	const [id2, p2] = Object.entries(s.xpays).at(-1), r2 = releaseFor(s, id2, 1);
	assert.equal(r2.token, '0x' + '0'.repeat(40), 'BNB is not paid as the network\'s own coin');
	assert.equal(r2.amount, BigInt(p2.amount) * 10n ** 9n);
	L.testExchangeVaults(CHAIN, null);
	solvent(s, 'payouts'); whole(s, 'payouts');
	return `1,000 USDT paid out as ${r.amount} units of BNB Chain's USDT, less 0.1% to the pot`;
});

L.testExchangeFrom(CHAIN, null);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
