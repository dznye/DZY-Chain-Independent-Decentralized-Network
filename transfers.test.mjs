// Cheap transfers (2026-11-17): free daily transactions for lockers (like staking for bandwidth on Tron, shared by the
// DZY each has locked) and batch payments (like a cheap lane: up to 100 payments in one transaction, one fee per 20).
// Also: amounts in shards (1 DZY = 100,000,000), and the 12,000,000 DZY exact throughout.
// Run: node chain/transfers.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';
import { DAY, RULES as R } from './v2/rules.mjs';

const results = [];
async function test(name, fn) {
	const t0 = Date.now();
	try { const note = await fn(); results.push(['PASS', name, note ?? '', Date.now() - t0]); }
	catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 4).join(' | '), Date.now() - t0]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}  (${r[3]} ms)`);
}
const DZY = L.DZY, SUPPLY = 12_000_000 * DZY, D = Number(DAY);
const dzy = (n) => Math.round(n * DZY);
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye transfers test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 130 }, (_, i) => key(i)).sort((a, b) => (a.address < b.address ? -1 : 1));
const [V, A, B, C, S1, S2] = K;
const people = K.slice(10, 130);
const fresh = () => L.sunGenesis({ chain: 'dznye-transfers-test', time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [
	{ to: A.address, units: dzy(10_000), paid: dzy(10_000) / 500, proof: 'test' },
	{ to: B.address, units: dzy(10_000), paid: dzy(10_000) / 500, proof: 'test' },
	{ to: C.address, units: dzy(1_000), paid: dzy(1_000) / 500, proof: 'test', lockYears: 2 },
	{ to: C.address, units: dzy(100), paid: dzy(100) / 500, proof: 'test' }, // and some to spend
	{ to: S1.address, units: dzy(500), paid: dzy(500) / 500, proof: 'test', lockYears: 2 },
	{ to: S2.address, units: dzy(500), paid: dzy(500) / 500, proof: 'test', lockYears: 2 },
] });
const send = async (s, k, type, data = {}) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, V.address);
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); await assert.rejects(() => send(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed`);
const minute = async (s) => { s.time += 60_000; L.endBlock(s, s.height + 1, 0, V.address, s.time); s.height += 1; await L.sunBlock(s, s.time, 0, V.address); };
const bal = (s, k) => L.balanceOf(s, k.address);

await test('Shards: 1 DZY is 100,000,000 shards; 12,000,000 DZY are exact; the smallest fee is one shard', async () => {
	const s = await fresh();
	assert.equal(DZY, 100_000_000); assert.equal(s.assets.DZY.decimals, 8);
	assert.ok(Number.isSafeInteger(SUPPLY) && SUPPLY * 7 < Number.MAX_SAFE_INTEGER, 'not enough headroom');
	assert.equal(s.fee, 1); whole(s, 'genesis');
	await send(s, A, 'transfer', { asset: 'DZY', to: B.address, amount: 1 }); // one shard
	assert.equal(bal(s, B), dzy(10_000) + 1);
	whole(s, 'one shard sent');
});
await test('Batch payments: 100 people paid in one transaction, for one fee per 20 payments (5 fees here)', async () => {
	const s = await fresh();
	s.fee = 1_000; // a busier fee, so the saving shows
	const to = people.slice(0, 100).map((k, i) => [k.address, dzy(1) + i]);
	const before = bal(s, A), total = to.reduce((n, [, a]) => n + a, 0);
	await send(s, A, 'transfer.many', { asset: 'DZY', to });
	assert.equal(before - bal(s, A), total + 5 * 1_000, 'not the payments plus 5 fees');
	assert.ok(people.slice(0, 100).every((k, i) => bal(s, k) === dzy(1) + i), 'someone was paid the wrong amount');
	whole(s, 'after 100 payments');
	return `100 payments cost 5 fees instead of 100 (20x cheaper per payment)`;
});
await test('Batch payments refuse what they must: over 100, paying yourself, a bad address, more than the balance; a refusal leaves no trace', async () => {
	const s = await fresh();
	await refused(s, A, 'transfer.many', { asset: 'DZY', to: people.slice(0, 101).map((k) => [k.address, 1]) }, /1 to 100 payments|too big/);
	await refused(s, A, 'transfer.many', { asset: 'DZY', to: [[A.address, 1]] }, /yourself/);
	await refused(s, A, 'transfer.many', { asset: 'DZY', to: [['nobody', 1]] }, /bad receiver/);
	await refused(s, A, 'transfer.many', { asset: 'DZY', to: [[B.address, dzy(6_000)], [C.address, dzy(6_000)]] }, /not enough/);
	await refused(s, A, 'transfer.many', { asset: 'DZY', to: [] }, /1 to 100 payments/);
	whole(s, 'refusals');
});
await test('Free transactions for lockers: each chain day, a share of 1,440,000 by DZY locked; then the fee again; the next day it starts over', async () => {
	const s = await fresh();
	await minute(s);
	const left = L.lockFreeLeft(s, C.address), share = Math.floor(Number(R.freePerDay) * dzy(1_000) / s.sun.L);
	assert.equal(left, share, 'not the locker\'s share by DZY locked');
	assert.equal(L.lockFreeLeft(s, A.address), 0, 'an account with nothing locked got free transactions');
	s.fee = 5_000;
	const b0 = bal(s, C);
	await send(s, C, 'transfer', { asset: 'DZY', to: A.address, amount: dzy(1) });
	assert.equal(b0 - bal(s, C), dzy(1), 'a locker paid a fee while it had free transactions');
	assert.equal(L.lockFreeLeft(s, C.address), share - 1);
	s.sun.free[C.address] = [Math.floor(s.sun.minute / D), share]; // used them all today
	const b1 = bal(s, C);
	await send(s, C, 'transfer', { asset: 'DZY', to: A.address, amount: dzy(1) });
	assert.equal(b1 - bal(s, C), dzy(1) + s.fee, 'no fee once the day\'s free transactions were used');
	for (let i = 0; i < D; i++) await minute(s);
	assert.equal(L.lockFreeLeft(s, C.address), share, 'the free transactions did not start over the next day');
	whole(s, 'free transactions');
	return `the 1,000 DZY locker gets ${share.toLocaleString('en')} free transactions a day`;
});
await test('Splitting a lock across accounts gains nothing: two lockers of 500 get what one of 1,000 gets, together', async () => {
	const s = await fresh();
	await minute(s);
	const one = L.lockFreeLeft(s, C.address), two = L.lockFreeLeft(s, S1.address) + L.lockFreeLeft(s, S2.address);
	assert.ok(Math.abs(one - two) <= 1, `one lock of 1,000: ${one}; two of 500: ${two}`);
});

const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
