// Reward points with real value (points.create / points.mint / points.redeem), written as attacks: every point has its
// DZY behind it, held by the chain; anyone holding points cashes them in at the fixed rate whenever they like; the
// issuer can neither make points without paying their backing nor take the backing back; points move like any token
// (sent, given as shop cashback, traded); and the 12,000,000 DZY stay exact. Run: node chain/points.test.mjs
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
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye points test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const [V, SHOP, A, B] = Array.from({ length: 4 }, (_, i) => key(i));
const CHAIN = 'dznye-points-test', T0 = 1_800_000_000_000;
const fresh = () => L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0,
	sales: [SHOP, A, B].map((k) => ({ to: k.address, units: dzy(5_000), paid: dzy(5_000) / 500, proof: 'test' })) });
const apply = async (s, k, type, data) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, V.address);
const send = async (s, k, type, data = {}) => { s.time += 1000; return apply(s, k, type, data); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); await assert.rejects(() => apply(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed`);
const bal = (s, k, a = 'DZY') => L.balanceOf(s, k.address, a);
const backed = (s, p) => assert.equal(s.assets[p].backed.reserve, s.assets[p].supply * s.assets[p].backed.per, 'reserve is not exactly supply × value');
const make = async (s, value = dzy(0.01)) => 'a' + (await send(s, SHOP, 'points.create', { symbol: 'CAFE', name: 'Cafe points', value })).slice(0, 16);

await test('Making points costs 1 DZY; minting 1,000 points worth 0.01 DZY each takes exactly 10 DZY from the issuer into the backing', async () => {
	const s = await fresh(), p = await make(s), b0 = bal(s, SHOP);
	await send(s, SHOP, 'points.mint', { asset: p, amount: 1_000 });
	assert.equal(b0 - bal(s, SHOP), dzy(10) + (s.fee ?? 0));
	assert.equal(bal(s, SHOP, p), 1_000);
	backed(s, p); whole(s, 'mint');
});
await test('A customer who gets points cashes them in for DZY at the fixed rate, any time, without asking the issuer', async () => {
	const s = await fresh(), p = await make(s);
	await send(s, SHOP, 'points.mint', { asset: p, amount: 500, to: A.address });
	const a0 = bal(s, A);
	await send(s, A, 'points.redeem', { asset: p, amount: 200 });
	assert.equal(bal(s, A) - a0, dzy(2) - (s.fee ?? 0));
	assert.equal(bal(s, A, p), 300);
	backed(s, p); whole(s, 'redeem');
});
await test('The issuer cannot make points without paying, mint someone else\'s points, burn the backing away, or take it back', async () => {
	const s = await fresh(), p = await make(s, dzy(100));
	await refused(s, SHOP, 'points.mint', { asset: p, amount: 100 }, /need 10000 DZY/);
	await refused(s, A, 'points.mint', { asset: p, amount: 1 }, /only the issuer/);
	await refused(s, SHOP, 'mint', { asset: p, amount: 1, to: SHOP.address }, /fixed supply/);
	await send(s, SHOP, 'points.mint', { asset: p, amount: 10, to: A.address });
	await refused(s, SHOP, 'points.redeem', { asset: p, amount: 1 }, /not enough points/);
	await refused(s, A, 'burn', { asset: p, amount: 1 }, /cashed in, not burned/);
	backed(s, p); whole(s, 'attacks');
});
await test('Points move like any token: sent between people, and given as a shop\'s cashback; every holder can still cash in', async () => {
	const s = await fresh(), p = await make(s);
	await send(s, SHOP, 'points.mint', { asset: p, amount: 10_000 });
	await send(s, SHOP, 'shop.set', { pay: 'DZY', reward: p, num: 10, den: DZY, name: 'Cafe' }); // 10 points per DZY paid
	await send(s, SHOP, 'shop.fund', { asset: p, amount: 5_000 });
	await send(s, A, 'shop.pay', { shop: SHOP.address, asset: 'DZY', amount: dzy(20) });
	assert.equal(bal(s, A, p), 200, 'no cashback in points');
	await send(s, A, 'transfer', { asset: p, to: B.address, amount: 50 });
	await send(s, B, 'points.redeem', { asset: p, amount: 50 });
	backed(s, p); whole(s, 'shop and send');
	return 'paid 20 DZY, got 200 points back (worth 2 DZY), gave 50 to a friend who cashed them in';
});
await test('500 random mints, sends and cash-ins: the backing is always exactly the points in existence times their value', async () => {
	const s = await fresh(), p = await make(s, 12_345);
	let seed = 7; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); }; // the high bits: an LCG's low bits barely change
	for (let i = 0; i < 500; i++) {
		const k = [A, B][rnd(2)], held = bal(s, k, p);
		try {
			const r = rnd(3);
			if (r === 0 || !held) await send(s, SHOP, 'points.mint', { asset: p, amount: 1 + rnd(5_000), to: k.address });
			else if (r === 1) await send(s, k, 'points.redeem', { asset: p, amount: 1 + rnd(held) });
			else await send(s, k, 'transfer', { asset: p, to: (k === A ? B : A).address, amount: 1 + rnd(held) });
		} catch (e) { throw new Error(`step ${i}: ${e.message}`); }
		backed(s, p);
	}
	for (const k of [A, B]) { const held = bal(s, k, p); if (held) await send(s, k, 'points.redeem', { asset: p, amount: held }); }
	assert.equal(s.assets[p].supply, 0); assert.equal(s.assets[p].backed.reserve, 0, 'DZY left behind with no points');
	whole(s, 'random');
});
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
