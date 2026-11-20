// The Dznye dollar (DUSD), written as attacks. Anyone with free vault coin (xBTC, xETH, xSOL, xUSDC) locks it in a loan
// and borrows DUSD, at most 2/3 of the coin's value (150%). The loan's interest (5% a year, plus 0.1% on borrowing) is
// taken from its coin when it closes and goes to the pot, the floor behind DZY: the chain's income, for every holder. A
// loan worth less than 120% of what it owes may be closed by anyone who pays its debt, for the coin plus 5%. Nobody can
// borrow past the line, take another's coin, or close a loan that still owes; DUSD in existence is always exactly the
// debt owed; every unit of vault coin stays accounted for. Run: node chain/dusd.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';

const results = [];
async function test(name, fn) {
	try { const note = await fn(); results.push(['PASS', name, note ?? '']); }
	catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 4).join(' | ')]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}`);
}
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, YEAR = 365.25 * 24 * 3600 * 1000, dzy = (n) => Math.round(n * DZY);
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye dusd test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 8 }, (_, i) => key(i));
const VS = K.slice(0, 4), [A, B, C, D] = K.slice(4);
const CHAIN = 'dznye-dusd-test', T0 = 1_800_000_000_000;
const fresh = async () => {
	const s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: VS.map((v) => v.address), seedWait: 0,
		sales: [...[A, B, C, D].map((k) => ({ to: k.address, units: dzy(1_000), paid: dzy(1_000) / 500, proof: 'test' })), ...VS.map((v) => ({ to: v.address, units: dzy(10), paid: dzy(10) / 500, proof: 'test: fees' }))] });
	L.testExchangeFrom(CHAIN, s.height + 1);
	return s;
};
const apply = async (s, k, type, data) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, VS[0].address, undefined);
const send = async (s, k, type, data = {}) => { s.time += 1000; s.height += 1; return apply(s, k, type, data); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); await assert.rejects(() => apply(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const bal = (s, k, a = 'DZY') => L.balanceOf(s, k.address, a);
const prices = async (s, p) => { for (const v of VS) await send(s, v, 'x.price', { p }); };
let txid = 0;
const payment = () => (++txid).toString(16).padStart(64, 'c');
/** free vault coin for `k`: parked, then deposited and confirmed by three of four validators */
const park = async (s, k, coin, net, amount) => { if (!s.x?.park?.[k.address]) await send(s, k, 'x.park', { on: true }); const tx = payment(); for (const v of VS.slice(0, 3)) await send(s, v, 'x.deposit', { net, coin, amount, tx, to: k.address }); };
const loans = (s) => s.x?.loans ?? {};
const lastLoan = (s) => Object.keys(loans(s)).at(-1);
/** the books balance: DUSD in existence = principal owed; vault coin = free coin + locks + pot (loans hold free coin) */
const sound = (s, where) => {
	const owed = Object.values(loans(s)).reduce((n, l) => n + l.debt, 0);
	assert.equal(s.assets.DUSD?.supply ?? 0, owed, `${where}: DUSD in existence is not the debt owed`);
	const h = L.holdings(s);
	for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`);
	assert.equal(h.DZY, SUPPLY, `${where}: DZY created or destroyed`);
	for (const coin of Object.keys(L.X_COINS)) {
		const held = Object.entries(s.x?.vaults ?? {}).filter(([k]) => k.endsWith(':' + coin)).reduce((n, [, v]) => n + v, 0);
		const locked = Object.entries(s.x?.locks ?? {}).filter(([k]) => k.endsWith(':' + coin)).reduce((n, [, v]) => n + v, 0);
		assert.equal(held, (s.assets['x' + coin]?.supply ?? 0) + locked + (s.x?.pot?.[coin] ?? 0), `${where}: ${coin} not accounted for`);
	}
};

await test('Borrow DUSD against free ETH, at most 2/3 of its value; the coin is held by the loan, nobody else can touch it', async () => {
	const s = await fresh();
	await prices(s, { ETH: 3_000_000_000 });
	await park(s, A, 'ETH', 'base', 1_000_000_000); // 1 ETH = $3,000
	await refused(s, A, 'loan.open', { coin: 'ETH', coll: 1_000_000_000, dusd: 2_000_000_001 }, /at most 2,000 DUSD/);
	await refused(s, A, 'loan.open', { coin: 'ETH', coll: 2_000_000_000, dusd: 1_000_000 }, /free ETH/);
	await refused(s, A, 'loan.open', { coin: 'DOGE', coll: 1, dusd: 1 }, /no such coin/);
	await send(s, A, 'loan.open', { coin: 'ETH', coll: 1_000_000_000, dusd: 2_000_000_000 });
	const id = lastLoan(s);
	assert.equal(bal(s, A, 'DUSD'), 2_000_000_000, 'no 2,000 DUSD');
	assert.equal(bal(s, A, 'xETH'), 0, 'the coin was not held by the loan');
	await refused(s, B, 'loan.close', { id }, /not your loan/);
	await refused(s, B, 'loan.withdraw', { id, coll: 1 }, /not your loan/);
	await refused(s, A, 'loan.borrow', { id, dusd: 1 }, /at most/); // already at the line
	await refused(s, A, 'loan.close', { id }, /still owes/);
	await refused(s, B, 'loan.liquidate', { id }, /healthy/);
	sound(s, 'borrow');
	return `1 ETH ($3,000) lent 2,000 DUSD`;
});

await test('Interest: 5% a year (plus 0.1% on borrowing) is taken from the coin when the loan closes, and goes to the pot behind DZY', async () => {
	const s = await fresh();
	await prices(s, { ETH: 3_000_000_000 });
	await park(s, A, 'ETH', 'base', 1_000_000_000);
	await send(s, A, 'loan.open', { coin: 'ETH', coll: 1_000_000_000, dusd: 1_000_000_000 }); // $1,000
	const id = lastLoan(s);
	s.time += YEAR; // a year later
	await prices(s, { ETH: 3_000_000_000 });
	await send(s, A, 'loan.repay', { id, dusd: 1_000_000_000 });
	assert.equal(bal(s, A, 'DUSD'), 0);
	const pot0 = s.x.pot?.ETH ?? 0, e0 = bal(s, A, 'xETH');
	await send(s, A, 'loan.close', { id });
	const interest = (s.x.pot?.ETH ?? 0) - pot0; // in gwei of ETH
	const usd = interest * 3_000 / 1e9;
	assert.ok(usd > 50 && usd < 52, `interest $${usd.toFixed(2)}, not about $51 (5% a year on $1,000, plus 0.1%)`);
	assert.equal(bal(s, A, 'xETH') - e0, 1_000_000_000 - interest, 'the rest of the coin did not go back');
	assert.equal(loans(s)[id], undefined);
	sound(s, 'interest');
	return `a year on $1,000: $${usd.toFixed(2)} of ETH to the pot`;
});

await test('Anyone may repay; anyone may close a loan below 120%: they pay its debt and get its coin worth the debt plus 5%; the rest goes back to the owner', async () => {
	const s = await fresh();
	await prices(s, { ETH: 3_000_000_000 });
	await park(s, A, 'ETH', 'base', 1_000_000_000);
	await send(s, A, 'loan.open', { coin: 'ETH', coll: 1_000_000_000, dusd: 1_800_000_000 }); // $1,800 on $3,000: 166%
	const id = lastLoan(s);
	await park(s, B, 'ETH', 'base', 2_000_000_000);
	await send(s, B, 'loan.open', { coin: 'ETH', coll: 2_000_000_000, dusd: 1_900_000_000 }); // B borrows DUSD to liquidate with
	await prices(s, { ETH: 2_000_000_000 }); // ETH falls to $2,000: A's loan is at 111%
	const b0 = bal(s, B, 'xETH'), a0 = bal(s, A, 'xETH'), pot0 = s.x.pot?.ETH ?? 0;
	await send(s, B, 'loan.liquidate', { id });
	const got = bal(s, B, 'xETH') - b0;
	assert.ok(Math.abs(got * 2_000 / 1e9 - 1_890) < 1, `the liquidator got $${got * 2_000 / 1e9}, not the debt plus 5% ($1,890)`);
	assert.ok(bal(s, A, 'xETH') - a0 > 0, 'the owner did not get the rest back');
	assert.ok((s.x.pot?.ETH ?? 0) > pot0, 'the interest did not go to the pot');
	assert.equal(loans(s)[id], undefined);
	await refused(s, C, 'loan.liquidate', { id: 'l' + '0'.repeat(16) }, /no such loan/);
	sound(s, 'liquidate');
});

await test('Add and take out coin, borrow more and repay part: every step keeps the loan above 150%', async () => {
	const s = await fresh();
	await prices(s, { SOL: 150_000_000, BTC: 90_000_000_000 });
	await park(s, A, 'SOL', 'sol', 20_000_000_000); // 20 SOL = $3,000
	await send(s, A, 'loan.open', { coin: 'SOL', coll: 10_000_000_000, dusd: 500_000_000 });
	const id = lastLoan(s);
	await send(s, A, 'loan.add', { id, coll: 10_000_000_000 });
	await send(s, A, 'loan.borrow', { id, dusd: 1_400_000_000 }); // $1,900 on $3,000
	await refused(s, A, 'loan.withdraw', { id, coll: 2_000_000_000 }, /150%/);
	await send(s, A, 'loan.repay', { id, dusd: 900_000_000 });
	await send(s, A, 'loan.withdraw', { id, coll: 2_000_000_000 });
	await refused(s, A, 'loan.repay', { id, dusd: 2_000_000_000 }, /owes less|more than/);
	sound(s, 'steps');
});

await test('With no agreed price, nothing can be borrowed, taken out or liquidated (repaying always works)', async () => {
	const s = await fresh();
	await prices(s, { ETH: 3_000_000_000 });
	await park(s, A, 'ETH', 'base', 1_000_000_000);
	await send(s, A, 'loan.open', { coin: 'ETH', coll: 1_000_000_000, dusd: 1_000_000_000 });
	const id = lastLoan(s);
	s.time += 61 * 60_000; // the price is stale
	await refused(s, A, 'loan.borrow', { id, dusd: 1 }, /price/);
	await refused(s, A, 'loan.withdraw', { id, coll: 1 }, /price/);
	await refused(s, B, 'loan.liquidate', { id }, /price/);
	await send(s, A, 'loan.repay', { id, dusd: 1_000_000_000 });
	sound(s, 'no price');
});

await test('500 random loans, price moves, repayments and liquidations on four coins: DUSD is always exactly the debt, and every coin is accounted for', async () => {
	const s = await fresh();
	let seed = 9; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); };
	const P = { BTC: 90_000_000_000, ETH: 3_000_000_000, SOL: 150_000_000, USDC: 1_000_000 }, NET = { BTC: 'btc', ETH: 'base', SOL: 'sol', USDC: 'base' };
	await prices(s, P);
	const people = [A, B, C, D], coins = Object.keys(P);
	for (const k of people) for (const c of coins) await park(s, k, c, NET[c], L.X_LIMITS[c].deposit);
	let ok = 0, no = 0, liq = 0;
	for (let i = 0; i < 500; i++) {
		const k = people[rnd(4)], coin = coins[rnd(4)], ids = Object.keys(loans(s)), id = ids[rnd(ids.length)], r = rnd(14);
		try {
			if (r < 3) { const coll = 1 + rnd(bal(s, k, 'x' + coin)); await send(s, k, 'loan.open', { coin, coll, dusd: 1 + Math.floor((coll * P[coin] / 10 ** L.X_COINS[coin].decimals) * (0.5 + rnd(16) / 100)) }); } // near the line, so falling prices make some liquidatable
			else if (r < 5) { for (const c of coins) P[c] = Math.max(1, Math.round(P[c] * (0.75 + rnd(50) / 100))); s.time += rnd(30) * 24 * 3600 * 1000; await prices(s, P); }
			else if (r < 7) await send(s, k, 'loan.repay', { id, dusd: 1 + rnd(Math.max(1, bal(s, k, 'DUSD'))) });
			else if (r < 8) await send(s, k, 'loan.borrow', { id, dusd: 1 + rnd(1_000_000_000) });
			else if (r < 9) await send(s, k, 'loan.add', { id, coll: 1 + rnd(Math.max(1, bal(s, k, 'x' + loans(s)[id]?.coin))) });
			else if (r < 10) await send(s, k, 'loan.withdraw', { id, coll: 1 + rnd(Math.max(1, loans(s)[id]?.coll ?? 1)) });
			else if (r < 12) { await send(s, k, 'loan.liquidate', { id }); liq++; }
			else if (r < 13) await send(s, k, 'loan.close', { id });
			else await send(s, k, 'transfer', { asset: 'DUSD', to: people[rnd(4)].address, amount: 1 + rnd(Math.max(1, bal(s, k, 'DUSD'))) });
			ok++;
		} catch (e) { if (e instanceof assert.AssertionError) throw e; no++; }
		sound(s, `step ${i}`);
	}
	const pot = coins.map((c) => `${c} ${s.x.pot?.[c] ?? 0}`).join(', ');
	return `${ok} went through (${liq} liquidations), ${no} refused; ${Object.keys(loans(s)).length} loans open, ${(s.assets.DUSD?.supply ?? 0) / 1e6} DUSD owed; the pot earned ${pot}`;
});

L.testExchangeFrom(CHAIN, null);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
