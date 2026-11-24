// DZY on Solana (ledger.ts wdzy.out, and wDZY paid back into the Solana vault through x.deposit), written as attacks:
// it is off until its block and token are set; going out only ever holds the sender's own DZY (never the Sun's or the
// sale's), within the cap; coming back needs the validators, counts once, and never more than went out; and every DZY is
// always somewhere. Run: node wdzy.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';
import { solReleaseFor } from './src/xrelease.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, [V, A, B] = await Promise.all([0, 0, 0].map(() => newKey())), PROGRAM = 'DznyeVau1t1111111111111111111111111111111111', MINT = 'wDZYmint11111111111111111111111111111111111';
const SOLTO = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', TX = (n) => '5'.repeat(80) + String(n).padStart(8, '0'); let chains = 0;
async function fresh({ on = 2, vault = true } = {}) {
	const n = 'dznye-wdzy-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); if (vault) L.testExchangeVaults(n, { sol: PROGRAM }); if (on !== null) L.testWdzy(n, { from: on, mint: MINT });
	const s = await L.sunGenesis({ chain: n, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [V, A, B].map((k) => ({ to: k.address, units: 5_000 * DZY, paid: 50 * DZY, proof: 't' })) });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1; return s;
}
const send = async (s, k, type, data = {}) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, t, s.time, V.address); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s), t = s.time; await assert.rejects(() => send(s, k, type, data), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused action changed something'); };
const bal = (s, k) => L.balanceOf(s, k.address, 'DZY');
const whole = (s) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) if (!id.startsWith('x')) assert.equal(h[id] ?? 0, a.supply, id); };
const unsold = (s) => s.sun.salePot, sun = (s) => s.treasury;
const back = (s, k, n, amount, to = A.address) => send(s, k, 'x.deposit', { net: 'sol', coin: 'wDZY', amount, tx: TX(n), to });

await test('off before its block, without a listed Solana vault, and on the live chain until the owner sets one', async () => {
	assert.equal(L.wdzyMint('dznye-mainnet'), null); assert.equal(L.wdzyOn({ chain: 'dznye-mainnet', height: 1e9, heart: {} }), false);
	const s = await fresh({ on: 1_000 }); await refused(s, A, 'wdzy.out', { amount: DZY, to: SOLTO }, /not open/); assert.equal(L.exchangeView(s).wdzy.open, false);
	const t = await fresh({ vault: false }); await refused(t, A, 'wdzy.out', { amount: DZY, to: SOLTO }, /not listed/);
});
await test('going out holds only the sender\'s own DZY: the Sun and the sale are untouched, and every DZY is still somewhere', async () => {
	const s = await fresh(), a0 = bal(s, A), u0 = unsold(s), sun0 = sun(s);
	await send(s, A, 'wdzy.out', { amount: 300 * DZY, to: SOLTO });
	assert.ok(a0 - bal(s, A) >= 300 * DZY && a0 - bal(s, A) < 301 * DZY, 'the DZY (and a small fee) left the account');
	assert.equal(s.wdzy.held, 300 * DZY); assert.equal(unsold(s), u0, 'the sale is untouched'); assert.ok(sun(s) >= sun0, 'the Sun is untouched (it only gains fees)');
	const [id, p] = Object.entries(s.xpays).find(([, x]) => x.coin === 'wDZY'); assert.deepEqual([p.net, p.to, p.amount, p.by], ['sol', SOLTO, 300 * DZY, A.address]);
	const r = solReleaseFor(s, id, 1, 'USDCmint'); assert.equal(r.mint, MINT, 'the validators sign it with the wDZY mint'); assert.equal(r.amount, BigInt(300 * DZY)); assert.equal(r.program, PROGRAM);
	whole(s);
});
await test('the cap, the least, the address and the balance', async () => {
	const s = await fresh();
	await refused(s, A, 'wdzy.out', { amount: DZY / 1000, to: SOLTO }, /at least/);
	await refused(s, A, 'wdzy.out', { amount: DZY, to: '0xabc' }, /bad sol address/);
	await refused(s, A, 'wdzy.out', { amount: 10_000_000 * DZY, to: SOLTO }, /at most|not enough/);
	await refused(s, A, 'wdzy.out', { amount: DZY, to: SOLTO, extra: 1 }, /not expected/);
	await refused(s, A, 'wdzy.out', { amount: bal(s, A) + 1, to: SOLTO }, /not enough/);
	L.testWdzy(s.chain, { from: 2, mint: MINT, cap: 1_000 * DZY }); // a small cap, to reach it
	await send(s, A, 'wdzy.out', { amount: 700 * DZY, to: SOLTO });
	await refused(s, B, 'wdzy.out', { amount: 301 * DZY, to: SOLTO }, /at most 1000 DZY .* 300 more can go/);
	await send(s, B, 'wdzy.out', { amount: 300 * DZY, to: SOLTO }); assert.equal(s.wdzy.held, 1_000 * DZY); assert.equal(L.exchangeView(s).wdzy.cap, 1_000 * DZY); whole(s);
});
await test('coming back: only validators, counted once, the DZY to whoever it names, never more than went out', async () => {
	const s = await fresh(); await send(s, A, 'wdzy.out', { amount: 500 * DZY, to: SOLTO }); const b0 = bal(s, B);
	await refused(s, A, 'x.deposit', { net: 'sol', coin: 'wDZY', amount: DZY, tx: TX(1), to: A.address }, /only a validator/);
	await refused(s, V, 'x.deposit', { net: 'sol', coin: 'wDZY', amount: 600 * DZY, tx: TX(2), to: B.address }, /more wDZY came back/);
	await back(s, V, 3, 200 * DZY, B.address); assert.equal(bal(s, B), b0 + 200 * DZY); assert.equal(s.wdzy.held, 300 * DZY);
	await refused(s, V, 'x.deposit', { net: 'sol', coin: 'wDZY', amount: 200 * DZY, tx: TX(3), to: B.address }, /already counted/);
	await refused(s, V, 'x.deposit', { net: 'base', coin: 'wDZY', amount: DZY, tx: TX(4), to: B.address }, /Solana vault/);
	whole(s);
});
await test('coming back needs DZY on Solana switched on (a wDZY deposit before it is nothing)', async () => {
	const s = await fresh({ on: 1_000 }); await refused(s, V, 'x.deposit', { net: 'sol', coin: 'wDZY', amount: DZY, tx: TX(5), to: A.address }, /not open/);
});
console.log(`\n${pass} wDZY tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
