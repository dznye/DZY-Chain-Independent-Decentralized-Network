// The crew upgrade (2026-11-17), written as attacks and promises: before its switch-on block nothing changes; from it on,
// anyone with 1 DZY staked whose node checked in is a candidate; the starting validators stay until enough others are
// online; a crew is drawn each period by staked shards (all of them while there are 64 or fewer, else 20%, 64 to 128
// seats), and a node that stops checking in drops out; the day's wage is paid by blocks made and shared with backers
// automatically; cheating costs the operator its whole stake. The 12,000,000 DZY stay exact through all of it.
// Run: node chain/crew.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';
import { sign } from './src/crypto.ts';

const results = [];
async function test(name, fn) {
	const t0 = Date.now();
	try { const note = await fn(); results.push(['PASS', name, note ?? '', Date.now() - t0]); }
	catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 4).join(' | '), Date.now() - t0]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}  (${r[3]} ms)`);
}
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, DAY = 24 * 60;
const dzy = (n) => Math.round(n * DZY);
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye crew test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 14 }, (_, i) => key(i)).sort((a, b) => (a.address < b.address ? -1 : 1));
const START = K.slice(0, 2), OPS = K.slice(2, 8), [B1, B2, B3, PLAYER] = K.slice(8, 12);
const CHAIN = 'dznye-crew-test', T0 = 1_800_000_000_000;
const fresh = () => L.sunGenesis({ chain: CHAIN, time: T0, validators: START.map((v) => v.address), seedWait: 0,
	sales: [...OPS, B1, B2, B3, PLAYER].map((k) => ({ to: k.address, units: dzy(2_000), paid: dzy(2_000) / 500, proof: 'test' })) });
const send = async (s, k, type, data = {}) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, s.validators[0]);
const refused = async (s, k, type, data, why) => { await assert.rejects(() => send(s, k, type, data), why); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed`);
/** one chain minute: a block made by the next validator in turn (as in council.test.mjs) */
async function minute(s, { by = null, txCount = 0 } = {}) {
	s.time += 60_000;
	const v = by ?? s.validators[s.height % s.validators.length];
	L.endBlock(s, s.height + 1, 0, v, s.time); s.height += 1;
	await L.sunBlock(s, s.time, txCount, v);
}
const minutes = async (s, n, o) => { for (let i = 0; i < n; i++) await minute(s, o); };
/** operators stake and their nodes check in */
async function online(s, ops, stake = 10) { for (const k of ops) { await send(s, k, 'stake.bond', { amount: dzy(stake) }); await send(s, k, 'node.checkin', { seen: [s.height, s.last], url: `https://node-${k.address.slice(0, 6)}.example` }); } }

await test('Before its switch-on block nothing changes: the same steps give the very same fingerprint as a chain that never switches on', async () => {
	const run = async (from) => {
		L.testCrewFrom(CHAIN, from);
		const s = await fresh();
		await send(s, OPS[0], 'stake.bond', { amount: dzy(5) });
		await refused(s, OPS[0], 'node.checkin', { seen: [s.height, s.last], url: 'https://n.example' }, /crew upgrade/);
		await minutes(s, 30);
		return L.stateRoot(s);
	};
	const off = await run(null), later = await run(1_000);
	assert.equal(later, off);
	L.testCrewFrom(CHAIN, null);
});

L.testCrewFrom(CHAIN, 1); // from here on, the crew rules from block 1

await test('1 DZY staked makes a candidate (less does not); check-ins need a stake, a real address, and a few minutes between them', async () => {
	const s = await fresh();
	await send(s, OPS[0], 'stake.bond', { amount: dzy(0.5) });
	assert.ok(!L.isCandidate(s, OPS[0].address), 'half a DZY made a candidate');
	await refused(s, OPS[0], 'node.checkin', { seen: [s.height, s.last], url: 'https://n.example' }, /stake at least 1 DZY/);
	await send(s, OPS[0], 'stake.bond', { amount: dzy(0.5) });
	assert.ok(L.isCandidate(s, OPS[0].address));
	await refused(s, OPS[0], 'node.checkin', { seen: [s.height, s.last], url: 'not an address' }, /public address/);
	await send(s, OPS[0], 'node.checkin', { seen: [s.height, s.last], url: 'https://n.example/' });
	assert.equal(s.nodes[OPS[0].address].url, 'https://n.example');
	await refused(s, OPS[0], 'node.checkin', { seen: [s.height, s.last], url: 'https://n.example' }, /a moment ago/);
	await send(s, B1, 'stake.delegate', { validator: OPS[0].address, amount: dzy(100) }); // a 1 DZY candidate can be backed
	whole(s, 'candidates');
});

await test('The starting validators stay until 4 others are online; then the crew is every candidate online, each with a say by its stake', async () => {
	const s = await fresh();
	await online(s, OPS.slice(0, 3)); await minutes(s, 2);
	assert.deepEqual(s.validators, START.map((k) => k.address).sort(), 'three outsiders replaced the starting validators');
	await online(s, OPS.slice(3, 4)); await minutes(s, 2);
	assert.deepEqual(s.validators, OPS.slice(0, 4).map((k) => k.address).sort());
	assert.ok(s.crew && s.crew.validators.length === 4);
	await send(s, B1, 'stake.delegate', { validator: OPS[0].address, amount: dzy(90) }); // OPS[0]: 10 own + 90 backed
	await minutes(s, 11); // the next period draws again
	assert.equal(L.powers(s)[OPS[0].address], 100, 'its say is not its stake in DZY');
	whole(s, 'handover');
	return 'crew: ' + s.validators.map((v) => v.slice(0, 6) + '×' + L.powers(s)[v]).join(', ');
});

await test('A node that stops checking in drops out of the next crew; the chain carries on with the others', async () => {
	const s = await fresh();
	await online(s, OPS.slice(0, 5)); await minutes(s, 2);
	assert.equal(s.validators.length, 5);
	// an hour passes: four check in again, one does not
	await minutes(s, 50);
	for (const k of OPS.slice(0, 4)) await send(s, k, 'node.checkin', { seen: [s.height, s.last], url: `https://node-${k.address.slice(0, 6)}.example` });
	await minutes(s, 25); // past the period that began while its last check-in was still within the hour
	assert.deepEqual(s.validators, OPS.slice(0, 4).map((k) => k.address).sort());
	whole(s, 'offline');
});

await test('Above 64 candidates the crew is 20% of them by lottery (64 to 128 seats); 3x the shards gets about 3x the seats; the same period draws the same crew', async () => {
	const s = await fresh(), fake = (i) => createHash('sha256').update('candidate ' + i).digest('hex');
	const big = fake(0);
	s.stakes = {};
	for (let i = 0; i < 1000; i++) s.stakes[fake(i)] = { bond: i === 0 ? dzy(30) : dzy(10) };
	const names = Object.keys(s.stakes);
	assert.equal(Object.values(L.drawCrew(s, names.slice(0, 300), 1).powers).reduce((a, b) => a + b, 0), 64, '300 candidates: not 64 seats');
	assert.equal(Object.values(L.drawCrew(s, names, 1).powers).reduce((a, b) => a + b, 0), 128, '1,000 candidates: not 128 seats');
	assert.deepEqual(L.drawCrew(s, names, 7), L.drawCrew(s, names, 7));
	let bigSeats = 0, avg = 0;
	for (let e = 0; e < 2000; e++) { const p = L.drawCrew(s, names, e).powers; bigSeats += p[big] ?? 0; avg += Object.values(p).reduce((a, b) => a + b, 0) / names.length; }
	const ratio = bigSeats / avg;
	assert.ok(ratio > 2.6 && ratio < 3.4, `30 DZY got ${ratio.toFixed(2)}x the seats of 10 DZY`);
	return `1,000 candidates: 128 seats a period; 3x the stake got ${ratio.toFixed(2)}x the seats over 2,000 periods`;
});

await test('The day\'s wage is paid by blocks made, and each validator\'s backers get their share automatically (after its commission)', async () => {
	const s = await fresh();
	await online(s, OPS.slice(0, 4), 100);
	await send(s, B1, 'stake.delegate', { validator: OPS[0].address, amount: dzy(300) }); // OPS[0]: 100 own + 300 backed
	await send(s, OPS[0], 'stake.commission', { bp: 2_000 }); // it keeps 20%
	await minutes(s, 2);
	// a busy day: fees fill the council fund; the nodes keep checking in. Nobody is paid until the day ends; then, in the
	// one block that ends it, each validator's pay goes out, shared with its backers
	let op = 0, b1 = 0, midday = null;
	for (let m = 0; m < DAY + 5 && !op; m++) {
		const dayEnds = (s.sun.minute + 1) % DAY === 0; // the minute the day's pay goes out: no transactions, so it shows only pay
		s.fee = Math.max(s.fee, dzy(0.05));
		if (!dayEnds) await send(s, PLAYER, 'transfer', { asset: 'DZY', to: B3.address, amount: 1 });
		if (!dayEnds && m % 30 === 10) for (const k of OPS.slice(0, 4)) await send(s, k, 'node.checkin', { seen: [s.height, s.last], url: `https://node-${k.address.slice(0, 6)}.example` });
		const pre = { op: L.balanceOf(s, OPS[0].address), b1: L.balanceOf(s, B1.address) }, pot = s.sun.council.pot ?? 0;
		await minute(s, { txCount: dayEnds ? 0 : 1 });
		if (m === 600) midday = s.sun.council.pot;
		if (pot > 0 && !s.sun.council.pot) { op = L.balanceOf(s, OPS[0].address) - pre.op; b1 = L.balanceOf(s, B1.address) - pre.b1; }
	}
	assert.ok(midday > 0, 'the wage was not building up for the day');
	assert.ok(b1 > 0, 'the backer got nothing');
	// what came from the validator's pay: commission 20%, then 100:300 by stake
	assert.ok(Math.abs(b1 / (op + b1) - 0.8 * 0.75) < 0.05, `the backer got ${(b1 / (op + b1) * 100).toFixed(1)}% of that validator's pay, not 60%`);
	whole(s, 'a day of pay');
	return `of one validator's pay: the operator ${(op / DZY).toFixed(4)} DZY, its backer ${(b1 / DZY).toFixed(4)} DZY (60% expected: 80% after commission, x 300/400)`;
});

await test('Cheating (signing two different blocks) costs the operator its whole stake; its backers lose 5%', async () => {
	const s = await fresh();
	await online(s, OPS.slice(0, 4), 100);
	await send(s, B1, 'stake.delegate', { validator: OPS[0].address, amount: dzy(200) });
	await minutes(s, 2);
	const v = OPS[0], vote = async (block) => ({ type: 'prevote', height: 1, round: 0, block, validator: v.address, sig: await sign(v.secret, L.voteMessage(CHAIN, 'prevote', 1, 0, block)) });
	await send(s, B2, 'evidence', { a: await vote('aa'.repeat(32)), b: await vote('bb'.repeat(32)) });
	assert.equal(s.stakes[v.address].bond, 0, 'the operator kept some of its stake');
	assert.ok(s.stakes[v.address].tomb, 'the operator was not barred');
	assert.equal(s.delegations[v.address][B1.address], dzy(190), 'the backer did not lose exactly 5%');
	whole(s, 'cheating');
});

/* ---------- checkers: nodes in every product, paid for staying active ---------- */
const check = (s, k, url) => send(s, k, 'node.checkin', { seen: [s.height, s.last], ...(url ? { url } : {}) });

await test('A check-in must quote one of the last 64 blocks by its hash: none, a wrong one, or an old one is refused', async () => {
	const s = await fresh();
	await send(s, OPS[0], 'stake.bond', { amount: dzy(5) });
	await refused(s, OPS[0], 'node.checkin', {}, /seen = \[height, hash\]/);
	await refused(s, OPS[0], 'node.checkin', { seen: [s.height, 'ab'.repeat(32)] }, /follows something else/);
	const old = [s.height, s.last];
	await minutes(s, 70);
	await refused(s, OPS[0], 'node.checkin', { seen: old }, /not one of the last 64/);
	await check(s, OPS[0]);
	assert.equal(s.nodes[OPS[0].address].url, undefined);
	assert.equal(s.recent.hashes.length, 64);
	whole(s, 'quotes');
});

await test('Checkers without a public address are never drawn to make blocks: four of them online leave the starting validators in place', async () => {
	const s = await fresh();
	for (const k of OPS.slice(0, 4)) { await send(s, k, 'stake.bond', { amount: dzy(10) }); await check(s, k); }
	await minutes(s, 12);
	assert.deepEqual(s.validators, START.map((k) => k.address).sort());
	whole(s, 'checkers only');
});

await test("Checkers that stayed active (12+ hours of the day) share 20% of the validators' daily pay by stake: one key of 100 earns what two keys of 50 earn together; 11 hours earns nothing", async () => {
	const s = await fresh();
	const [ONE, HALF1, HALF2, LAZY] = OPS;
	for (const [k, st] of [[ONE, 100], [HALF1, 50], [HALF2, 50], [LAZY, 100]]) await send(s, k, 'stake.bond', { amount: dzy(st) });
	await minutes(s, 2);
	let paid = null;
	for (let m = 0; m < DAY + 5 && !paid; m++) {
		const dayEnds = (s.sun.minute + 1) % DAY === 0;
		s.fee = Math.max(s.fee, dzy(0.05));
		if (!dayEnds) await send(s, PLAYER, 'transfer', { asset: 'DZY', to: B3.address, amount: 1 });
		if (!dayEnds && m % 60 === 5) { for (const k of [ONE, HALF1, HALF2]) await check(s, k); if (m < 11 * 60) await check(s, LAZY); }
		const pre = Object.fromEntries([...OPS.slice(0, 4), ...START].map((k) => [k.address, L.balanceOf(s, k.address)])), pot = s.sun.council.pot ?? 0;
		await minute(s, { txCount: dayEnds ? 0 : 1 });
		if (pot > 0 && !s.sun.council.pot) paid = { pot, got: Object.fromEntries(Object.keys(pre).map((a) => [a, L.balanceOf(s, a) - pre[a]])) };
	}
	assert.ok(paid, 'no pay day came');
	const g = (k) => paid.got[k.address], checkers = g(ONE) + g(HALF1) + g(HALF2), makers = START.reduce((n, k) => n + g(k), 0);
	assert.ok(g(ONE) > 0, 'an active checker got nothing');
	assert.equal(g(LAZY), 0, 'a checker active only 11 hours was paid');
	assert.ok(Math.abs(g(ONE) - (g(HALF1) + g(HALF2))) <= 2, 'splitting a stake over two keys changed the pay');
	assert.ok(Math.abs(checkers / paid.pot - 0.2) < 0.001, `checkers got ${(checkers / paid.pot * 100).toFixed(2)}% of the wage, not 20%`);
	assert.ok(makers > 0 && Object.values(s.nodes).every((n) => !n.hrs), 'block makers unpaid, or the hours did not start again');
	whole(s, 'checker pay');
	return `of the day's wage: checkers ${(checkers / DZY).toFixed(6)} DZY (100 staked: ${(g(ONE) / DZY).toFixed(6)}; 2 x 50: ${((g(HALF1) + g(HALF2)) / DZY).toFixed(6)}), block makers ${(makers / DZY).toFixed(6)}`;
});

L.testCrewFrom(CHAIN, null);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
