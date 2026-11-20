// Coin launches (token.launch), as on pump.fun, written as attacks: a coin is in its own market from the first second;
// buying moves its price up and selling moves it down; nobody, the creator included, can pull its DZY out or add to it;
// the creator gets 0.5% of every trade; selling never takes more DZY than buyers really put in; and the 12,000,000 DZY
// stay exact through hundreds of random trades. Run: node chain/launch.test.mjs
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
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, dzy = (n) => Math.round(n * DZY);
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye launch test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 10 }, (_, i) => key(i));
const [V, CREATOR, A, B, C, NEWBIE] = K;
const CHAIN = 'dznye-launch-test', T0 = 1_800_000_000_000;
const fresh = () => L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0,
	sales: [CREATOR, A, B, C].map((k) => ({ to: k.address, units: dzy(5_000), paid: dzy(5_000) / 500, proof: 'test' })) });
let n = 0;
const send = async (s, k, type, data = {}) => { s.time += 1000 + (n++ % 7); return L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, V.address); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed`);
const price = (s, t) => { const p = s.liquidity[t]; return (p.dzy + (p.virt ?? 0)) / p.token; };
const launch = async (s, k = CREATOR, symbol = 'MOON') => 'a' + (await send(s, k, 'token.launch', { symbol, name: 'To the moon' })).slice(0, 16);
const buy = (s, k, t, d, min = 1) => send(s, k, 'pool.swap', { asset: t, give: 'DZY', amount: dzy(d), min });
const sell = (s, k, t, units, min = 1) => send(s, k, 'pool.swap', { asset: t, give: t, amount: units, min });

await test('A launch costs 1 DZY and puts the whole supply (a billion, 6 decimals) in the coin\'s own market; nobody holds any of it yet', async () => {
	const s = await fresh(), before = L.balanceOf(s, CREATOR.address), t = await launch(s);
	assert.equal(before - L.balanceOf(s, CREATOR.address), L.RULES.assetFee + (s.fee ?? 0), 'not 1 DZY plus the network fee');
	assert.equal(s.assets[t].supply, 1_000_000_000 * 1e6);
	assert.equal(s.liquidity[t].token, 1_000_000_000 * 1e6);
	assert.equal(L.balanceOf(s, CREATOR.address, t), 0, 'the creator got coins for free');
	assert.equal(s.liquidity[t].dzy, 0); assert.equal(s.liquidity[t].shares, 0);
	whole(s, 'launch');
	return `starting price ${(price(s, t) * 1e6 / DZY * 1e9).toFixed(3)} nano-DZY a coin (a market worth 30 DZY on paper)`;
});
await test('Buying moves the price up, selling moves it down; selling back at once returns a little less than was paid (the fees)', async () => {
	const s = await fresh(), t = await launch(s);
	const p0 = price(s, t); await buy(s, A, t, 10);
	const p1 = price(s, t), got = L.balanceOf(s, A.address, t);
	assert.ok(p1 > p0 && got > 0);
	const before = L.balanceOf(s, A.address); await sell(s, A, t, got);
	const back = L.balanceOf(s, A.address) - before;
	assert.ok(price(s, t) < p1, 'selling did not lower the price');
	assert.ok(back < dzy(10) && back > dzy(9.8), `selling back returned ${back / DZY} DZY`);
	whole(s, 'buy and sell');
	return `10 DZY bought ${(got / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} coins; selling them back returned ${(back / DZY).toFixed(4)} DZY`;
});
await test('The creator gets 0.5% of the DZY side of every trade; the treasury its usual cut', async () => {
	const s = await fresh(), t = await launch(s), c0 = L.balanceOf(s, CREATOR.address);
	await buy(s, A, t, 100);
	assert.equal(L.balanceOf(s, CREATOR.address) - c0, dzy(0.5));
	whole(s, 'creator');
});
await test('No rug pull: nobody (the creator included) can take DZY out of a launch, add to it, or lend against it', async () => {
	const s = await fresh(), t = await launch(s);
	await buy(s, A, t, 50);
	await assert.rejects(() => send(s, CREATOR, 'pool.remove', { asset: t, shares: 1 }), /do not have that many shares/);
	await assert.rejects(() => send(s, CREATOR, 'pool.add', { asset: t, dzy: dzy(1), maxToken: 1e12 }), /its own market/);
	await assert.rejects(() => send(s, B, 'vault.deposit', { pool: t, side: 'L', amount: dzy(1) }), /no lending against a launch/);
	whole(s, 'no rug');
});
await test('300 random buys and sells by three people: the DZY in the market is never more than buyers put in, every sell is paid from real DZY, and the 12,000,000 stay exact', async () => {
	const s = await fresh(), t = await launch(s);
	let seed = 11; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); }; // the high bits: an LCG's low bits barely change
	let refused = 0;
	for (let i = 0; i < 300; i++) {
		const k = [A, B, C][rnd(3)], held = L.balanceOf(s, k.address, t);
		try { if (rnd(2) || !held) await buy(s, k, t, 1 + rnd(40)); else await sell(s, k, t, 1 + rnd(held)); } catch { refused++; }
		assert.ok(s.liquidity[t].dzy >= 0);
	}
	// everybody sells everything: every sell is paid, and what is left is the fees' share
	for (const k of [A, B, C]) { const held = L.balanceOf(s, k.address, t); if (held) await sell(s, k, t, held); }
	assert.equal(s.liquidity[t].token, 1_000_000_000 * 1e6, 'not all coins came back');
	assert.ok(s.liquidity[t].dzy >= 0);
	whole(s, 'random trades');
	return `${300 - refused} trades went through; after everyone sold, ${(s.liquidity[t].dzy / DZY).toFixed(4)} DZY of fees stay in the market for good`;
});
await test('Coin for coin through DZY in one step pays both creators; a newcomer can launch on starter credit', async () => {
	const s = await fresh(), x = await launch(s, CREATOR, 'XX'), y = await launch(s, B, 'YY');
	await buy(s, A, x, 20);
	const c0 = L.balanceOf(s, CREATOR.address), b0 = L.balanceOf(s, B.address);
	await send(s, A, 'pool.route', { from: x, to: y, amount: L.balanceOf(s, A.address, x), min: 1 });
	assert.ok(L.balanceOf(s, CREATOR.address) > c0 && L.balanceOf(s, B.address) > b0, 'a creator was not paid');
	assert.ok(L.balanceOf(s, A.address, y) > 0);
	// an hour of chain minutes first, as a live chain has had: the Sun's starter-credit budget fills from them
	for (let i = 0; i < 60; i++) { s.time += 60_000; L.endBlock(s, s.height + 1, 0, V.address, s.time); s.height += 1; await L.sunBlock(s, s.time, 0, V.address); }
	await send(s, NEWBIE, 'credit.take', {});
	const z = await launch(s, NEWBIE, 'NEW');
	assert.ok(s.liquidity[z], 'a newcomer could not launch on credit');
	whole(s, 'route and credit');
});
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
