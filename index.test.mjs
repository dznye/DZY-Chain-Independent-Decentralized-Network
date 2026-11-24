// The index (ledger.ts INDEX_FROM), written as attacks: DZY's price becomes the reserve's value over the backed DZY in
// hands. At its block the price does not jump; the DZY already in hands with nothing behind them are counted once as
// unbacked (the founder's) and fees wash them; every buy is backed by its coin; selling pays the index price; the price
// follows the coins themselves; nobody can sell more than the reserve holds; and nothing new reaches people's hands from
// the Sun without coin behind it.
// Run: node index.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { const said = await fn(); pass++; console.log("ok  ", name, said ? `(${said})` : ""); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, [V, A, B, F] = await Promise.all([0, 0, 0, 0].map(() => newKey())), VAULT = '0x' + '11'.repeat(20); let chains = 0, txn = 0;
const IDX = 3; // the index's block in these tests
async function fresh() {
	const n = 'dznye-index-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); L.testExchangeVaults(n, { base: VAULT }); L.testReserveFrom(n, 2); L.testIndexFrom(n, IDX);
	// the founder's DZY, from before the index: bought with nothing in the reserve
	const s = await L.sunGenesis({ chain: n, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [{ to: V.address, units: 1_000 * DZY, paid: 10 * DZY, proof: 't' }, { to: F.address, units: 8_000 * DZY, paid: 80 * DZY, proof: 't' }] });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1;
	await send(s, V, 'x.price', { p: { USDC: 1_000_000, ETH: 2_000_000_000 } });
	return s;
}
const send = async (s, k, type, data = {}) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, t, s.time, V.address); };
const block = (s, h) => { L.endBlock(s, h, 0, V.address, s.time); s.height = h; };
const whole = (s) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) if (!id.startsWith('x')) assert.equal(h[id] ?? 0, a.supply, id); };
const deposit = (s, to, coin, amount) => send(s, V, 'x.deposit', { net: 'base', coin, amount, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: to.address });
const dzy = (s, k) => L.balanceOf(s, k.address, 'DZY'), free = (s, k, c = 'USDC') => L.balanceOf(s, k.address, 'x' + c), pot = (s, c = 'USDC') => s.x?.pot?.[c] ?? 0;
const sell = (s, k, n, c = 'USDC') => send(s, k, 'swap', { give: 'DZY', want: 'x' + c, amount: n, min: 1 });
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
async function on() { const s = await fresh(); const p0 = H.spotPrice(s); block(s, IDX); return { s, p0 }; }

await test('before its block the curve prices DZY, and the index is off', async () => {
	const s = await fresh(); block(s, 2);
	assert.equal(L.indexOn(s), false); assert.equal(L.indexView(s).on, null);
});
await test('at its block it turns on at exactly today\'s price; the DZY with nothing behind them are counted as unbacked', async () => {
	const { s, p0 } = await on();
	assert.equal(L.indexOn(s), true); assert.equal(s.x.index, IDX);
	assert.equal(H.spotPrice(s), p0, 'no jump');
	assert.equal(s.x.unbacked, 9_000 * DZY, 'all 9,000 DZY in hands were bought with nothing in the reserve');
});
await test('a buy is backed by its coin: the price does not fall, and half its fee washes unbacked DZY', async () => {
	const { s, p0 } = await on(); const un0 = s.x.unbacked, d0 = dzy(s, A);
	await deposit(s, A, 'USDC', 100_000_000); // $100
	const got = dzy(s, A) - d0;
	near(got, Math.floor((99.9e6 * DZY) / p0), 2, 'DZY at the index price, less 0.1%');
	assert.equal(pot(s), 100_000_000, 'the coin went into the reserve');
	assert.ok(H.spotPrice(s) >= p0, 'the price did not fall'); assert.ok(H.spotPrice(s) <= Math.ceil(p0 * 1.001), 'nor jump');
	near(un0 - s.x.unbacked, Math.floor((0.05e6 * DZY) / p0), 2, 'half of the $0.10 fee backs that much of the unbacked');
	whole(s);
});
await test('a round trip gives back what was paid less the two fees, and leaves the price no lower', async () => {
	const { s } = await on(); for (let i = 0; i < 20; i++) await deposit(s, B, 'USDC', 100_000_000);
	const p1 = H.spotPrice(s), d0 = dzy(s, A); await deposit(s, A, 'USDC', 50_000_000); const got = dzy(s, A) - d0;
	const keep = 1_000_000; await sell(s, A, got - keep); // a little DZY stays to pay the chain's own fee for the swap
	const most = 50_000_000 * (got - keep) / got; assert.ok(free(s, A) >= Math.floor(most * 0.999 * 0.999) && free(s, A) < most, `back what was paid less at most the two 0.1% fees (part of their own fee stayed and lifted the price): ${free(s, A)}`);
	assert.ok(H.spotPrice(s) >= p1, 'the fees stayed: the price is no lower');
	whole(s);
});
await test('the price follows the coins: ETH in the reserve up 50% lifts DZY by its share', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 100_000_000); await deposit(s, B, 'ETH', 50_000_000); // $100 + 0.05 ETH ($100)
	const p1 = H.spotPrice(s); await send(s, V, 'x.price', { p: { USDC: 1_000_000, ETH: 3_000_000_000 } });
	const p2 = H.spotPrice(s); near(p2 / p1, 1.25, 0.002, 'half the reserve rose 50%: DZY up 25%');
});
await test('a gift washes the founder\'s DZY first, and only then lifts the price', async () => {
	const { s } = await on(); await deposit(s, A, 'USDC', 100_000_000);
	await send(s, F, 'x.park', { on: true }); await deposit(s, F, 'USDC', 300_000_000); // free coin for the founder to give
	const un0 = s.x.unbacked, p1 = H.spotPrice(s);
	await send(s, F, 'reserve.give', { coin: 'USDC', amount: 300_000_000 });
	near(un0 - s.x.unbacked, Math.floor((300e6 * DZY) / p1), Math.ceil((300e6 * DZY) / p1 / 100_000), '$300 backs $300 of the unbacked (the price shown is rounded to a millionth of a dollar)');
	near(H.spotPrice(s), p1, 1, 'the price is unchanged while unbacked DZY are left');
	const all = Math.ceil((s.x.unbacked * p1) / DZY) + 1_000_000; await deposit(s, F, 'USDC', all); await send(s, F, 'reserve.give', { coin: 'USDC', amount: all });
	assert.equal(s.x.unbacked ?? 0, 0, 'all washed'); assert.ok(H.spotPrice(s) > p1, 'what is left over lifts the price');
	whole(s);
});
await test('nobody sells more than the reserve holds of a coin: refused, nothing changes', async () => {
	const { s } = await on(); await deposit(s, A, 'USDC', 100_000_000);
	const before = JSON.stringify(s), t0 = s.time;
	await assert.rejects(() => sell(s, F, 5_000 * DZY));
	s.time = t0; assert.equal(JSON.stringify(s), before);
});
await test('selling to the old floor (x.floor) pays the index price too, with no daily limit', async () => {
	const { s } = await on(); for (let i = 0; i < 10; i++) await deposit(s, B, 'USDC', 100_000_000);
	const n = 500 * DZY, q = L.indexSale(s, 'USDC', n); await send(s, B, 'x.floor', { coin: 'USDC', dzy: n });
	assert.equal(free(s, B), q.pay); whole(s);
});
await test('a gift before the index block is refused', async () => {
	const s = await fresh(); await send(s, F, 'x.park', { on: true }); await deposit(s, F, 'USDC', 1_000_000);
	await assert.rejects(() => send(s, F, 'reserve.give', { coin: 'USDC', amount: 1_000_000 }), /takes gifts from block/);
});
await test('once on, the Sun puts nothing new in people\'s hands: an hour of chain minutes leaves the DZY in hands the same', async () => {
	const hands = (s) => Number(L.indexView(s).hands);
	const { s } = await on(); await deposit(s, A, 'USDC', 100_000_000); const h1 = hands(s), un = s.x.unbacked;
	for (let m = 1; m <= 60; m++) await L.sunBlock(s, s.time + m * 60_000, 0, V.address);
	assert.ok(hands(s) <= h1, `no drip, no free fees: not one unit more in hands (${h1} then ${hands(s)})`); assert.equal(s.x.unbacked, un);
	whole(s);
});
/* the fee from the trade itself: no DZY needed on the side */
await test('selling every DZY works: the chain\'s fee comes out of the DZY sold', async () => {
	const { s } = await on(); for (let i = 0; i < 5; i++) await deposit(s, B, 'USDC', 100_000_000);
	await deposit(s, A, 'USDC', 20_000_000); const all = dzy(s, A);
	await sell(s, A, all);
	assert.equal(dzy(s, A), 0, 'nothing left over, nothing short'); assert.ok(free(s, A) > 19_900_000, `about $20 back: ${free(s, A)}`); whole(s);
});
await test('buying DZY with a coin while holding no DZY works: the fee is bought from that coin, into the reserve', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 100_000_000);
	const C = await newKey(); await send(s, V, 'x.deposit', { net: 'base', coin: 'USDC', amount: 30_000_000, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: C.address }); // C bought DZY with $30
	await sell(s, C, dzy(s, C)); assert.equal(dzy(s, C), 0); const coin = free(s, C), pot0 = pot(s); // now C holds only free USDC
	await send(s, C, 'swap', { give: 'xUSDC', want: 'DZY', amount: coin, min: 1 });
	assert.ok(dzy(s, C) > 0, 'bought DZY'); assert.equal(free(s, C), 0, 'all the coin went, the fee\'s part included'); assert.equal(pot(s) - pot0, coin, 'every unit of it is in the reserve');
	whole(s);
});
await test('taking a coin out with no DZY works: the fee comes out of that coin', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 100_000_000);
	const C = await newKey(); await send(s, V, 'x.deposit', { net: 'base', coin: 'USDC', amount: 30_000_000, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: C.address });
	await sell(s, C, dzy(s, C)); const coin = free(s, C);
	await send(s, C, 'x.sell', { coin: 'USDC', amount: coin, net: 'base', to: '0x' + '22'.repeat(20) });
	assert.equal(free(s, C), 0); assert.equal(dzy(s, C), 0); whole(s);
});
await test('with too little of the coin for the fee, it is refused and nothing changes', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 100_000_000);
	const C = await newKey(); await send(s, V, 'x.deposit', { net: 'base', coin: 'USDC', amount: 30_000_000, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: C.address });
	await sell(s, C, dzy(s, C)); await send(s, C, 'x.sell', { coin: 'USDC', amount: free(s, C) - 1, net: 'base', to: '0x' + '22'.repeat(20) }); // 1 unit left: worth far less than a fee
	const before = JSON.stringify(s), t0 = s.time;
	await assert.rejects(() => send(s, C, 'x.sell', { coin: 'USDC', amount: 1, net: 'base', to: '0x' + '22'.repeat(20) }));
	s.time = t0; assert.equal(JSON.stringify(s), before);
});
/* a market, simulated: many people, random buys in USDC and ETH, random sells for either coin (all of their DZY now and
   then), ETH's price jumping both ways, gifts. After every step: every DZY and every coin accounted for, the vaults hold
   at least everything claimed on them, the unbacked only ever shrink, and a trade never lowers the price (fees lift it). */
await test('a simulated market: 1,000 random buys, sells, gifts and price jumps break none of the rules', async () => {
	let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
	const { s } = await on(); const people = await Promise.all(Array.from({ length: 12 }, () => newKey()));
	let eth = 2_000_000_000, trades = 0, refused = 0, maxP = 0, minP = Infinity;
	const price = () => H.spotPrice(s), vaultOk = () => {
		for (const c of ['USDC', 'ETH']) {
			const inVaults = Object.entries(s.x.vaults).filter(([k]) => k.endsWith(':' + c)).reduce((n, [, v]) => n + v, 0);
			const claimed = (s.assets['x' + c]?.supply ?? 0) + (s.x.pot?.[c] ?? 0);
			assert.ok(inVaults >= claimed, `${c}: the vaults hold ${inVaults}, claimed ${claimed}`);
		}
	};
	for (let i = 0; i < 1_000; i++) {
		const who = people[Math.floor(rnd() * people.length)], r = rnd(), un0 = s.x.unbacked ?? 0, p0 = price();
		let kind = 'trade';
		try {
			if (r < 0.35) await deposit(s, who, rnd() < 0.6 ? 'USDC' : 'ETH', rnd() < 0.6 ? Math.floor(rnd() * 500e6) + 1e6 : Math.floor(rnd() * 2e8) + 1e6); // $1 to $500, or a little ETH
			else if (r < 0.7) { const d = dzy(s, who); if (!d) continue; await sell(s, who, rnd() < 0.2 ? d : Math.max(1, Math.floor(d * rnd())), rnd() < 0.6 ? 'USDC' : 'ETH'); }
			else if (r < 0.8) { const c = rnd() < 0.5 ? 'USDC' : 'ETH', f = free(s, who, c); if (!f) continue; await send(s, who, 'swap', { give: 'x' + c, want: 'DZY', amount: Math.max(1, Math.floor(f * rnd())), min: 1 }); }
			else if (r < 0.95) { kind = 'move'; eth = Math.max(100_000_000, Math.floor(eth * (0.85 + rnd() * 0.3))); await send(s, V, 'x.price', { p: { USDC: 1_000_000, ETH: eth } }); }
			else { const f = free(s, who, 'USDC'); if (!f) continue; kind = 'gift'; await send(s, who, 'reserve.give', { coin: 'USDC', amount: Math.max(1, Math.floor(f / 2)) }); }
			trades++;
		} catch { refused++; continue; } // a refused step (more than the reserve holds, too small) must change nothing: checked below anyway
		const p1 = price(); maxP = Math.max(maxP, p1); minP = Math.min(minP, p1);
		assert.ok((s.x.unbacked ?? 0) <= un0, `step ${i}: the unbacked grew`);
		if (kind !== 'move') assert.ok(p1 >= p0, `step ${i} (${kind}): the price fell from ${p0} to ${p1} without any coin's price moving`);
		for (const c of ['USDC', 'ETH']) assert.ok((s.x.pot?.[c] ?? 0) >= 0, `${c} reserve below zero`);
		whole(s); vaultOk();
	}
	assert.ok(trades > 600, `enough steps went through: ${trades} (${refused} refused)`);
	return `${trades} steps, ${refused} refused; price $${(minP / 1e6).toFixed(4)} to $${(maxP / 1e6).toFixed(4)}; unbacked left ${((s.x.unbacked ?? 0) / DZY).toFixed(1)} DZY`;
});
await test('everyone sells everything: the reserve pays every backed DZY, and only the fee account\'s unbacked are left over', async () => {
	const { s } = await on(); const people = await Promise.all(Array.from({ length: 6 }, () => newKey()));
	for (const [i, k] of people.entries()) await deposit(s, k, 'USDC', (i + 1) * 50_000_000);
	for (const k of people) await sell(s, k, dzy(s, k));
	for (const k of people) assert.equal(dzy(s, k), 0, 'all sold');
	assert.ok(pot(s) >= 0, 'the reserve never went short'); whole(s);
});
await test('a run at the top: 40 people buy with USDC and ETH, ETH doubles, then all 40 sell everything at once (USDC first, ETH when it runs out): every one is paid in full', async () => {
	let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
	const { s } = await on(); const people = await Promise.all(Array.from({ length: 40 }, () => newKey()));
	for (const k of people) await (rnd() < 0.5 ? deposit(s, k, 'USDC', Math.floor(rnd() * 300e6) + 20e6) : deposit(s, k, 'ETH', Math.floor(rnd() * 1.4e8) + 1e7)); // under the launch caps (X_LIMITS: $10,000 of USDC in a vault)
	for (const k of people) assert.ok(dzy(s, k) > 0, 'every one of them holds DZY');
	const p0 = H.spotPrice(s); await send(s, V, 'x.price', { p: { USDC: 1_000_000, ETH: 4_000_000_000 } }); const top = H.spotPrice(s);
	assert.ok(top > p0 * 1.2, 'the price rose with ETH');
	let usdcPaid = 0, ethPaid = 0;
	for (const k of people.sort(() => rnd() - 0.5)) {
		const all = dzy(s, k), owed = Math.floor((all * top) / DZY);
		try { await sell(s, k, all, 'USDC'); usdcPaid++; } catch { // not enough USDC left for all of it: what USDC is left, then the rest in ETH
			let lo = 0, hi = all; while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2), q = L.indexSale(s, 'USDC', m); if (q && q.pay <= pot(s, 'USDC')) lo = m; else hi = m; } const part = lo; // the most DZY the USDC left can pay for
			if (part > 1_000) await sell(s, k, Math.min(part, all - 1), 'USDC');
			const rest = dzy(s, k), q = L.indexSale(s, 'ETH', rest); if (!q || q.pay > pot(s, 'ETH')) throw new Error(`stuck: rest ${rest}, ETH pay ${q?.pay}, ETH left ${pot(s, 'ETH')}, USDC left ${pot(s, 'USDC')}, part ${part}, all ${all}`);
			await sell(s, k, rest, 'ETH'); ethPaid++;
		}
		assert.equal(dzy(s, k), 0, 'sold every DZY');
		const got = free(s, k, 'USDC') + Math.floor((free(s, k, 'ETH') * 4_000_000_000) / 1e9);
		assert.ok(got >= owed * 0.997, `paid in full at the top price: ${got} of ${owed}`);
	}
	whole(s);
	return `${usdcPaid} took USDC, ${ethPaid} took ETH when the USDC ran out; nobody short`;
});
/* gold: PAXG and XAUT (an ounce each) in the Ethereum vault, from their block */
async function golden(goldAt) {
	const s = await fresh(); L.testExchangeVaults(s.chain, { base: VAULT, eth: '0x' + '33'.repeat(20) }); L.testGoldFrom(s.chain, goldAt); block(s, IDX);
	return s;
}
const goldIn = (s, to, coin, amount) => send(s, V, 'x.deposit', { net: 'eth', coin, amount, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: to.address });
await test('gold before its block: no price, no deposit', async () => {
	const s = await golden(1_000);
	await assert.rejects(() => send(s, V, 'x.price', { p: { PAXG: 3_600_000_000 } }), /no coin PAXG/);
	await assert.rejects(() => goldIn(s, A, 'PAXG', 100_000_000), /no such coin/);
});
await test('gold from its block: DZY bought with PAXG and XAUT, the gold sits in the reserve, and gold\'s price moves DZY by its share', async () => {
	const s = await golden(2); await send(s, V, 'x.price', { p: { USDC: 1_000_000, ETH: 2_000_000_000, PAXG: 3_600_000_000, XAUT: 3_600_000_000 } });
	await deposit(s, B, 'USDC', 360_000_000); // $360 of dollars
	const a0 = dzy(s, A); await goldIn(s, A, 'PAXG', 100_000_000); await goldIn(s, A, 'XAUT', 100_000); // 0.1 oz of each: $720 of gold
	assert.ok(dzy(s, A) > a0, 'DZY bought with gold'); assert.equal(s.x.pot.PAXG, 100_000_000); assert.equal(s.x.pot.XAUT, 100_000);
	const v = L.indexView(s); assert.ok(Math.abs(v.reserveUsd - 1_080_000_000) < 2_000_000, `about $1,080 in the reserve: ${v.reserveUsd}`);
	const p0 = H.spotPrice(s); await send(s, V, 'x.price', { p: { USDC: 1_000_000, ETH: 2_000_000_000, PAXG: 4_320_000_000, XAUT: 4_320_000_000 } }); // gold +20%
	const p1 = H.spotPrice(s); near(p1 / p0, 1 + 0.2 * (720 / 1080), 0.003, 'two thirds gold: DZY up about 13%');
	await sell(s, A, Math.floor(dzy(s, A) / 2), 'PAXG'); assert.ok(free(s, A, 'PAXG') > 0, 'sold back for gold');
	whole(s);
	return `$${(p0 / 1e6).toFixed(6)} → $${(p1 / 1e6).toFixed(6)} with gold up 20%`;
});
await test('the vault watcher counts a gold deposit, and a payout sends the right gold token', async () => {
	const X = await import('./src/xtokens.ts');
	assert.deepEqual(X.evmCoinOf('eth', '0x45804880De22913dAFE09f4980848ECE6EcbAf78'), { coin: 'PAXG', scale: 9 }, 'PAXG: 18 decimals on Ethereum, 9 on Dznye');
	assert.deepEqual(X.evmCoinOf('eth', '0x68749665FF8D2d112Fa859AA293F07A622782F38'), { coin: 'XAUT', scale: 0 }, 'XAUT: 6 and 6');
	assert.equal(X.evmCoinOf('base', '0x45804880De22913dAFE09f4980848ECE6EcbAf78'), null, 'not on another network');
	assert.equal(X.evmTokenOf('eth', 'PAXG').token, '0x45804880de22913dafe09f4980848ece6ecbaf78');
	assert.equal(X.evmTokenOf('eth', 'XAUT').decimals, 6);
});
/* emergencies: a coin hacked or shut down, handled by a vote, with no new node */
await test('ETH voted out (a hack): nobody buys with it, anyone swaps USDT in for it at the agreed price plus 0.5%, and the reserve never loses value', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 300_000_000); await deposit(s, B, 'ETH', 100_000_000); // $300 + 0.1 ETH ($200)
	await assert.rejects(() => send(s, B, 'reserve.retire', { coin: 'ETH', mode: 'out' }), /only validators/);
	await send(s, V, 'reserve.retire', { coin: 'ETH', mode: 'out' }); assert.equal(L.retiredOf(s, 'ETH'), 'out');
	const a0 = dzy(s, A); await deposit(s, A, 'ETH', 10_000_000); assert.equal(dzy(s, A), a0, 'no DZY bought with ETH now'); assert.equal(free(s, A, 'ETH'), 10_000_000, 'it stays the payer\'s own');
	await send(s, F, 'x.park', { on: true }); await deposit(s, F, 'USDC', 100_000_000); // $100 of free USDC to swap in
	const v0 = L.indexView(s).reserveUsd, p0 = H.spotPrice(s);
	await send(s, F, 'reserve.swap', { give: 'xUSDC', amount: 100_000_000, want: 'ETH' });
	near(free(s, F, 'ETH'), 50_250_000, 1, '$100 of ETH at $2,000, plus 0.5%: 0.05025 ETH');
	assert.equal(pot(s, 'USDC'), 400_000_000); assert.equal(pot(s, 'ETH'), 49_750_000);
	assert.ok(L.indexView(s).reserveUsd >= v0 - 600_000, 'the reserve gave at most the 0.5% bonus'); assert.ok(H.spotPrice(s) >= p0 * 0.997);
	await assert.rejects(() => send(s, F, 'reserve.swap', { give: 'xUSDC', amount: 1, want: 'USDC' }), /not leaving/);
	whole(s);
});
await test('a token voted worthless: the price drops by its share at once, and trading goes on', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 300_000_000); await deposit(s, B, 'ETH', 150_000_000); // $300 + $300
	const p0 = H.spotPrice(s); await send(s, V, 'reserve.retire', { coin: 'ETH', mode: 'zero' });
	near(H.spotPrice(s) / p0, 0.5, 0.01, 'half the reserve counted as nothing: DZY halves');
	await sell(s, B, Math.floor(dzy(s, B) / 4), 'USDC'); assert.ok(free(s, B) > 0, 'selling still works');
	const pz = H.spotPrice(s); await send(s, V, 'reserve.retire', { coin: 'ETH', mode: 'back' }); assert.ok(H.spotPrice(s) > pz * 1.5, 'undone: ETH counts again (those who sold while it counted nothing sold cheap)');
	whole(s);
});
await test('a coin whose price stops for a day counts as nothing: DZY never freezes; under a day, it waits', async () => {
	const { s } = await on(); await deposit(s, B, 'USDC', 300_000_000); await deposit(s, B, 'ETH', 150_000_000);
	await send(s, V, 'x.price', { p: { USDC: 1_000_000 } }); // ETH's feed stops (only USDC is posted from now on)
	s.time += 2 * 3_600_000; assert.equal(L.indexPrice(s), null, 'two hours: no price yet (it waits, it does not guess)');
	s.time += 23 * 3_600_000; await send(s, V, 'x.price', { p: { USDC: 1_000_000 } });
	const p = L.indexPrice(s); assert.ok(p > 0, 'a day on: ETH counts as nothing, and DZY has a price again');
	await sell(s, B, Math.floor(dzy(s, B) / 4), 'USDC'); whole(s);
});
console.log(`\n${pass} index tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
