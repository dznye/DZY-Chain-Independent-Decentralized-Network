// The shared reserve (ledger.ts RESERVE_FROM), written as attacks: before its block a purchase is a lock in the buyer's
// name, as before; from it, the coin goes into the chain's one reserve; selling DZY back pays the chain's own price for
// them, from the reserve, nothing added or taken but the chain's fee (a round trip gives back what was paid); the price
// comes back down the same curve; no limit but what the reserve holds; and every DZY is always somewhere.
// Run: node reserve.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, [V, A, B] = await Promise.all([0, 0, 0].map(() => newKey())), VAULT = '0x' + '11'.repeat(20); let chains = 0, txn = 0;
async function fresh({ on = 2 } = {}) {
	const n = 'dznye-reserve-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); L.testExchangeVaults(n, { base: VAULT }); if (on !== null) L.testReserveFrom(n, on);
	const s = await L.sunGenesis({ chain: n, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [V, A, B].map((k) => ({ to: k.address, units: 5_000 * DZY, paid: 50 * DZY, proof: 't' })) });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1;
	await send(s, V, 'x.price', { p: { USDC: 1_000_000 } }); return s;
}
const send = async (s, k, type, data = {}) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, t, s.time, V.address); };
const whole = (s) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) if (!id.startsWith('x')) assert.equal(h[id] ?? 0, a.supply, id); };
const deposit = (s, to, usdc) => send(s, V, 'x.deposit', { net: 'base', coin: 'USDC', amount: usdc, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: to.address });
const dzy = (s, k) => L.balanceOf(s, k.address, 'DZY'), usdc = (s, k) => L.balanceOf(s, k.address, 'xUSDC'), pot = (s) => s.x?.pot?.USDC ?? 0;
const sellAll = (s, k, n) => send(s, k, 'swap', { give: 'DZY', want: 'xUSDC', amount: n, min: 1 });

await test('before its block: a purchase is a lock in the buyer\'s own name, as before', async () => {
	const s = await fresh({ on: 1_000 }); await deposit(s, A, 100_000_000);
	assert.equal(L.lockAt(s, `${A.address}:USDC`), 100_000_000); assert.equal(pot(s), 0); assert.equal(L.exchangeView(s).reserve.open, false);
});
await test('from it: the coin goes into the shared reserve, nobody\'s lock', async () => {
	const s = await fresh(); const d0 = dzy(s, A); await deposit(s, A, 100_000_000);
	assert.ok(dzy(s, A) > d0, 'DZY bought'); assert.equal(L.lockAt(s, `${A.address}:USDC`), 0); assert.equal(pot(s), 100_000_000); whole(s);
});
await test('a round trip gives back what was paid: the chain\'s price both ways, the price back where it was', async () => {
	const s = await fresh(); for (let i = 0; i < 30; i++) await deposit(s, B, 100_000_000); // others buy first: $3,000 in the reserve
	const p0 = H.spotPrice(s), d0 = dzy(s, A); await deposit(s, A, 50_000_000); const got = dzy(s, A) - d0; // A pays $50
	assert.ok(H.spotPrice(s) > p0, 'buying lifts the price');
	await sellAll(s, A, got);
	assert.ok(Math.abs(usdc(s, A) - 50_000_000) <= 2, `back what was paid: ${usdc(s, A)} of 50000000`); assert.ok(Math.abs(H.spotPrice(s) - p0) <= 1, 'the price is back where it was');
	whole(s);
});
await test('selling pays the chain\'s price for those DZY right now, as free coin to take out', async () => {
	const s = await fresh(); for (let i = 0; i < 30; i++) await deposit(s, B, 100_000_000);
	const n = 10 * DZY, q = L.reserveSale(s, 'USDC', n); assert.ok(q && q.pay > 0);
	const u0 = usdc(s, A), sold0 = s.sun.sold; await sellAll(s, A, n);
	assert.equal(usdc(s, A) - u0, q.pay); assert.equal(s.sun.sold, sold0 - n, 'the DZY went back to the sale'); whole(s);
});
await test('a free market: no daily limit, only what the reserve holds; more than that is refused, nothing changes', async () => {
	const s = await fresh(); for (let i = 0; i < 10; i++) await deposit(s, B, 100_000_000); // a $1,000 reserve
	const big = 2_000 * DZY, q = L.reserveSale(s, 'USDC', big); assert.ok(q && q.pay < pot(s) && q.pay > 50_000_000, 'a big sale, well past 5%');
	await sellAll(s, A, big); assert.equal(usdc(s, A), q.pay);
	const before = JSON.stringify(s); const all = dzy(s, B) - DZY; assert.ok((L.reserveSale(s, 'USDC', all)?.pay ?? Infinity) > pot(s), 'B holds more DZY than the reserve can pay for'); const t0 = s.time; await assert.rejects(() => sellAll(s, B, all), /nothing to trade against|price moved/); s.time = t0; assert.equal(JSON.stringify(s), before, 'a refused sale changed nothing');
	whole(s);
});
console.log(`\n${pass} reserve tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
