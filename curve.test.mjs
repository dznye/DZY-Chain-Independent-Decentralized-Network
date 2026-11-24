// Free DZY by a round trip (found 22 Nov 2026), written as the attack: buy from the sale, close the lock at once. Closing
// walks the sale curve back down, so nothing is ever left over: not in one go, not in pieces, not through the book, not by
// many people in any order. Run: node curve.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import { RULES } from './v2/rules.mjs';
import { saleBackFor, saleCost, saleUnitsFor } from './v2/sale.mjs';

const DZY = 1e8, E = 1e9, dzy = (n) => Math.round(n * DZY);
let pass = 0; const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
let chains = 0;
async function world(close = 0) {
	const chain = 'dznye-curve-t' + ++chains, K = await Promise.all([0, 0, 0, 0].map(() => newKey())), [V, A, B, C] = K;
	const s = await L.sunGenesis({ chain, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [[V, 8_400], [A, 1], [B, 1], [C, 1]].map(([k, n]) => ({ to: k.address, units: dzy(n), paid: dzy(n) / 100, proof: 't' })) });
	L.testExchangeFrom(chain, 1); L.testXUnlimitedFrom?.(chain, 1); L.testCloseFrom(chain, close);
	let n = 0; const send = async (k, type, data) => { s.time += 1000; s.height++; return L.applyTx(s, await L.signTx(k.secret, { chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, V.address); };
	const price = (usd = 3_000) => send(V, 'x.price', { p: { ETH: usd * 1_000_000 } });
	const buy = async (k, usd) => { await price(); await send(V, 'x.deposit', { net: 'base', coin: 'ETH', amount: Math.floor(usd / 3_000 * E), tx: '0x' + (++n).toString(16).padStart(64, '0'), to: k.address }); };
	return { s, V, A, B, C, send, price, buy, bal: (k, a = 'DZY') => L.balanceOf(s, k.address, a), lock: (k) => s.x?.locks?.[k.address + ':ETH'] ?? 0 };
}
const whole = (s) => assert.equal(L.holdings(s).DZY, 12_000_000 * DZY);
const solvent = (s) => { if (!s.x) return; const held = Object.values(s.x.vaults).reduce((a, b) => a + b, 0), owed = (s.assets.xETH?.supply ?? 0) + Object.values(s.x.locks ?? {}).reduce((a, b) => a + b, 0) + (s.x.pot?.ETH ?? 0); assert.equal(held, owed); };

await test('The attack as it worked: before the fix a $10,000 round trip keeps thousands of DZY (so this test can see it)', async () => {
	const w = await world(1e9), b0 = w.bal(w.A); await w.buy(w.A, 10_000); await w.price(); await w.send(w.A, 'x.close', { coin: 'ETH', to: 'wallet' });
	assert.ok(w.bal(w.A) - b0 > dzy(4_000)); whole(w.s); return `${((w.bal(w.A) - b0) / DZY).toFixed(0)} DZY`;
});
await test('With it: $100 to $500,000, closed at once, leaves no DZY over (beyond a rounding of a few shards), and gives back the coin less 0.1%', async () => {
	for (const usd of [100, 1_000, 10_000, 85_000, 500_000]) {
		const w = await world(), b0 = w.bal(w.A); await w.buy(w.A, usd); const put = w.lock(w.A); await w.price();
		await w.send(w.A, 'x.close', { coin: 'ETH', to: 'wallet' });
		const left = w.bal(w.A) - b0, got = w.bal(w.A, 'xETH');
		assert.ok(left <= 2_000, `$${usd}: ${left} shards left over`); assert.ok(got <= put - Math.floor(put / 1000) + 1 && got >= put * 0.9985 - 1 || left < 0, `$${usd}: ${got} of ${put}`);
		whole(w.s); solvent(w.s);
	}
});
await test('In pieces: a lock closed a tenth at a time (keeping the rest locked) never gives more than at once', async () => {
	const w = await world(), b0 = w.bal(w.A); await w.buy(w.A, 50_000); const put = w.lock(w.A), got0 = w.bal(w.A) - b0;
	for (let i = 0; i < 12 && w.lock(w.A); i++) { await w.price(); await w.send(w.A, 'x.close', { coin: 'ETH', to: 'wallet', dzy: Math.min(Math.ceil(got0 / 10), w.bal(w.A)), keep: true }).catch((e) => assert.match(e.message, /hold less|too small/)); }
	const coin = w.bal(w.A, 'xETH') + w.lock(w.A), left = w.bal(w.A) - b0;
	assert.ok(coin <= put && left <= 20_000, `${coin} of ${put}, ${left} shards over`); whole(w.s); solvent(w.s);
});
await test('Many people, any order: 60 random buys and closes, then everyone closes: all together they never end with more DZY and coin than they began with', async () => {
	let seed = 11, closes = 0; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 8) % n; };
	const w = await world(), P = [w.A, w.B, w.C], b0 = P.reduce((n, k) => n + w.bal(k), 0); let put = 0; const sold0 = w.s.sun.sold;
	for (let i = 0; i < 60; i++) { const k = P[rnd(3)]; if (rnd(2)) { const usd = 10 + rnd(30_000); put += Math.floor(usd / 3_000 * E); await w.buy(k, usd); } else if (w.lock(k)) { await w.price(); await w.send(k, 'x.close', { coin: 'ETH', to: 'wallet' }).then(() => closes++, (e) => assert.match(e.message, /hold less/)); } whole(w.s); solvent(w.s); }
	for (let r = 0; r < 4; r++) for (const k of P) if (w.lock(k)) { await w.price(); await w.send(k, 'x.close', { coin: 'ETH', to: 'wallet', dzy: Math.max(1, Math.min(w.bal(k), w.s.sun.sold)), keep: true }).catch((e) => assert.match(e.message, /hold less|too small/)); }
	const coin = P.reduce((n, k) => n + w.bal(k, 'xETH'), 0), left = P.reduce((n, k) => n + w.bal(k), 0) - b0, locked = P.reduce((n, k) => n + w.lock(k), 0);
	assert.ok(closes > 5, 'too few closes: this tests nothing'); assert.ok(coin + locked <= put, 'more coin than went in');
	// what they hold in DZY is exactly what the sale sold them, and it is paid for by what is still locked or was left to the pot
	assert.ok(w.s.sun.sold - sold0 === left || Math.abs(w.s.sun.sold - sold0 - left) < 100_000, `${w.s.sun.sold - sold0} sold, ${left} held`);
	assert.ok(Number(saleCost(RULES, BigInt(sold0), BigInt(Math.max(sold0, w.s.sun.sold)))) <= ((locked + (w.s.x?.pot?.ETH ?? 0)) / E * 3_000 * 1e6) + 2e5, 'DZY held that nobody paid for');
});
await test('The curve both ways, exactly: for any amount, what it buys is what it costs back (to the shard that rounding keeps for the chain)', async () => {
	for (const sold of [0n, 850_252_820_610n, 40_000_000_000_000n, 250_000_000_000_000n]) for (const usd of [1_000_000n, 777_777_777n, 85_000_000_000n, 2_000_000_000_000n]) {
		const u = saleUnitsFor(RULES, sold, usd), back = saleBackFor(RULES, sold + u, usd);
		assert.ok(back >= u || saleCost(RULES, sold, sold + u) < usd - 1n || back + 2_000n >= u, `${sold} ${usd}: ${u} bought, ${back} back`); assert.ok(u - back <= 2_000n, `${u - back} over`);
	}
	assert.equal(saleBackFor(RULES, 5n, 10n ** 18n), 5n);
});
await test('The live chain: the rule starts at block 8,300, and before it nothing differs', async () => {
	assert.equal(L.closeOnCurve({ chain: 'dznye-mainnet', height: 8_298 }), false); assert.equal(L.closeOnCurve({ chain: 'dznye-mainnet', height: 8_299 }), true);
});
console.log(`\n${pass} tests passed`);
process.exit(0);
