// The chain's own central bank and its federation of validators (2026-11-17), written as attacks: the council fund
// pays validators like a fair job (equal shares for everyone who did its turns, a bonus drawn by shards), the commission
// sets the fee floor from the fund, the policy rate follows the Taylor rule and is the base rate of every loan, and
// starter credit lets a newcomer try everything (a name, a token, a contract, fees) before owning any DZY, repaid from
// the first DZY it receives or taken back after about 6 months. The 12,000,000 DZY stay exact through all of it.
// Run: node chain/council.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';
import { bonusWinner } from './src/sun.ts';
import { DAY, RULES as R, YEAR, bufferFor, nextFloor, policyTarget } from './v2/rules.mjs';

const results = [];
async function test(name, fn) {
	const t0 = Date.now();
	try { const note = await fn(); results.push(['PASS', name, note ?? '', Date.now() - t0]); }
	catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 4).join(' | '), Date.now() - t0]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}  (${r[3]} ms)`);
}
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, D = Number(DAY); // a DZY is 10^8 shards
const dzy = (n) => Math.round(n * DZY), show = (u) => (Number(u) / DZY).toLocaleString('en', { maximumFractionDigits: 8 });
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye council test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 12 }, (_, i) => key(i)).sort((a, b) => (a.address < b.address ? -1 : 1));
const VS = K.slice(0, 4), [A, B, C, N1, N2, N3] = K.slice(4);
const CHAIN = 'dznye-council-test', T0 = 1_800_000_000_000;
async function fresh(validators = VS, extra = []) {
	return L.sunGenesis({ chain: CHAIN, time: T0, validators: validators.map((v) => v.address), seedWait: 0, sales: [
		{ to: A.address, units: dzy(20_000), paid: dzy(20_000) / 500, proof: 'test', lockYears: 5 },
		{ to: B.address, units: dzy(20_000), paid: dzy(20_000) / 500, proof: 'test' },
		...extra,
	] });
}
/** a chain an hour old: the starter-credit fee budget fills a little each minute (about 123 DZY a day) */
const warm = async (s) => { await minutes(s, 60); return s; };
const send = async (s, k, type, data = {}) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, s.validators[0]);
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); await assert.rejects(() => send(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed`);
/** one chain minute, its block made by \`by\` (or each validator in turn), with \`txCount\` transactions counted for the fee */
async function minute(s, { by = null, txCount = 0 } = {}) {
	s.time += 60_000;
	const v = by ?? s.validators[s.height % s.validators.length];
	L.endBlock(s, s.height + 1, 0, v, s.time); s.height += 1;
	await L.sunBlock(s, s.time, txCount, v);
}
const minutes = async (s, n, o) => { for (let i = 0; i < n; i++) await minute(s, o); };
const bal = (s, k) => L.balanceOf(s, k.address);
/** busy blocks: each minute, transfers whose fees fill the pot, at a fee the test sets (a busy chain's fee) */
async function busy(s, n, fee = dzy(0.05)) {
	for (let i = 0; i < n; i++) {
		s.fee = Math.max(s.fee, fee);
		await send(s, B, 'transfer', { asset: 'DZY', to: C.address, amount: 1 });
		await minute(s, { txCount: 1 });
	}
}

/* ---------- the council: validators paid like a fair job ---------- */
await test('Equal pay for equal work: 4 validators taking turns earn the same wage to the unit; the bonus is the only difference', async () => {
	const s = await fresh();
	await busy(s, 4 * D);
	const pay = VS.map((v) => bal(s, v));
	const most = Math.max(...pay), least = Math.min(...pay);
	assert.ok(least > 0, 'a validator that worked earned nothing');
	// equal shares each minute; the only difference is the bonus, drawn once a day
	const bonuses = s.sun.council.last;
	assert.ok(most - least <= most / 2, `pay too unequal: ${show(least)} to ${show(most)}`);
	whole(s, 'after 4 days');
	return `each earned ${pay.map(show).join(' / ')} DZY over 4 busy days; the last bonus went to ${bonuses.slice(0, 8)}`;
});
await test('No work, no wage: a validator that makes no blocks for a day stops being paid; the others share it all', async () => {
	const s = await fresh();
	await busy(s, D); // everyone works a day
	const lazy = VS[3], before = bal(s, lazy), others = VS.slice(0, 3).map((v) => bal(s, v));
	for (let i = 0; i < 2 * D; i++) { s.fee = Math.max(s.fee, dzy(0.05)); await send(s, B, 'transfer', { asset: 'DZY', to: C.address, amount: 1 }); await minute(s, { by: VS[i % 3].address, txCount: 1 }); }
	const lazyGot = bal(s, lazy) - before, othersGot = VS.slice(0, 3).map((v, i) => bal(s, v) - others[i]);
	assert.ok(othersGot.every((x) => x > 0), 'the working validators were not paid');
	assert.ok(lazyGot < Math.min(...othersGot) / 2, `the idle validator kept earning: ${show(lazyGot)} against ${show(Math.min(...othersGot))}`);
	assert.ok(!L.economyView(s).council.workers.includes(lazy.address), 'the idle validator is still counted as working');
	whole(s, 'after');
	return `idle validator: ${show(lazyGot)} DZY in 2 days (only its last day of work); each working one: ${show(Math.min(...othersGot))}`;
});
await test('The wage never exceeds the fund: a chain with no fees pays no wage and the council fund never goes below zero', async () => {
	const s = await fresh();
	await minutes(s, 3 * D);
	assert.equal(s.sun.council.fund, 0); assert.ok(VS.every((v) => bal(s, v) === 0), 'a validator was paid with no fees');
	whole(s, 'quiet');
});
await test('Paying fees to yourself does not pay: the only validator and locker filling its own blocks gets back less than it spends', async () => {
	const s = await fresh([A], [{ to: A.address, units: dzy(5_000), paid: dzy(5_000) / 400, proof: 'test' }]); // A: the only validator and the only locker, with DZY to spend
	const mine = () => bal(s, A) + bal(s, C) + L.sunView(s, A.address).locked; // A and C are the same owner
	const start = mine();
	for (let i = 0; i < 2 * D; i++) {
		s.fee = Math.max(s.fee, dzy(0.05));
		await send(s, A, 'transfer', { asset: 'DZY', to: C.address, amount: 1 });
		await minute(s, { by: A.address, txCount: 1 });
		for (const t of L.openTickets(s, A.address)) await send(s, A, 'ticket.answer', t);
	}
	await minutes(s, 2 * D, { by: A.address }); // let every fee come out of the pot
	for (const t of L.openTickets(s, A.address)) await send(s, A, 'ticket.answer', t);
	const end = mine();
	assert.ok(end <= start, `self-dealing gained ${show(end - start)} DZY`);
	whole(s, 'self-dealing');
	return `2 days of paying itself: ${show(start - end)} DZY poorer`;
});

/* ---------- the commission and the policy rate ---------- */
await test('The commission: with the fund short of its buffer the fee floor rises each day, by at most 12.5%; the fee never goes below it', async () => {
	const s = await fresh();
	const floors = [];
	for (let d = 0; d < 6; d++) { await minutes(s, D); floors.push(s.sun.fed.floor); }
	// a quiet chain: no fees reach the fund, the buffer is the wage of 30 days > 0, so the floor climbs from 1 unit
	for (let i = 1; i < floors.length; i++) {
		assert.ok(floors[i] >= floors[i - 1], 'the floor fell while the fund was short');
		assert.ok(floors[i] <= Math.max(floors[i - 1] + 1, Math.floor(floors[i - 1] * 1.125)), `the floor jumped: ${floors[i - 1]} to ${floors[i]}`);
	}
	assert.ok(s.fee >= s.sun.fed.floor, 'the fee is below the floor');
	assert.equal(BigInt(floors[1]), nextFloor(R, BigInt(floors[0]), BigInt(s.sun.council.fund), 1n) > 0n ? BigInt(floors[1]) : 0n);
	return `floor by day: ${floors.join(', ')} units`;
});
await test('The commission brings fees down when the fund is full: the floor falls back toward one unit', async () => {
	const s = await fresh();
	s.sun.fed.floor = 5_000; // as if it had climbed
	s.sun.council.fund = dzy(1_000); B; // a full fund, far above 30 days of wages ...
	s.accounts[B.address].bal.DZY -= dzy(1_000); // ... taken from someone, so the 12M stay exact
	const f0 = s.sun.fed.floor;
	await minutes(s, 5 * D);
	assert.ok(s.sun.fed.floor < f0, `the floor did not fall: ${f0} to ${s.sun.fed.floor}`);
	whole(s, 'full fund');
	return `floor ${f0} → ${s.sun.fed.floor} units in 5 days`;
});
await test('The policy rate follows the Taylor rule, at most 0.25% a day: on a quiet chain it steps down from 5% toward 0%', async () => {
	const s = await fresh();
	const rates = [];
	for (let d = 0; d < 5; d++) { await minutes(s, D); rates.push(s.sun.fed.rate); }
	assert.deepEqual(rates, [475, 450, 425, 400, 375], 'not a 0.25% step a day toward the quiet chain\'s target');
	assert.equal(BigInt(s.sun.fed.target), policyTarget(R, BigInt(s.sun.fed.growth), BigInt(s.sun.fed.useGap)));
	return `rate by day: ${rates.map((r) => r / 100 + '%').join(', ')}; target ${s.sun.fed.target / 100}%`;
});
await test('Every loan is priced from the policy rate: a position opened after the rate fell pays less', async () => {
	const s = await fresh();
	const rateAt = async () => {
		const v = { cash: 1_000, lent: 0 };
		return L.economyView(s).policyRate + Math.floor((L.RULES.marginSlopeBps * 0) / 1_000) + (v.lent ? 0 : 0);
	};
	const r0 = await rateAt();
	await minutes(s, 4 * D);
	const r1 = await rateAt();
	assert.ok(r1 < r0, 'the base rate of loans did not follow the policy rate');
	return `base loan rate ${r0 / 100}% → ${r1 / 100}% after 4 quiet days`;
});

/* ---------- starter credit ---------- */
await test('Starter credit: a brand-new key takes it for free, takes a 6+ letter name, makes a token, and pays its fees, all before owning any DZY', async () => {
	const s = await warm(await fresh());
	await busy(s, 1);
	await send(s, N1, 'credit.take');
	await send(s, N1, 'name.set', { name: 'newbie' });
	assert.equal(L.whoIs(s, 'newbie'), N1.address);
	await send(s, N1, 'asset.create', { symbol: 'TRY', name: 'Try token', decimals: 0, supply: 100, mintable: false });
	assert.equal(bal(s, N1), 0, 'starter credit became spendable DZY');
	const c = L.creditView(s, N1.address).credit;
	assert.ok(c.used >= L.RULES.nameFee + L.RULES.assetFee, 'the name and token were not charged to the credit');
	whole(s, 'after credit');
	return `used ${show(c.used)} of ${show(Number(R.creditAmount))} DZY credit: a name, a token and the fees`;
});
await test('Starter credit cannot be abused: no short names, no sending DZY, no second credit, nothing for an account that holds DZY, at most 1,000 a day', async () => {
	const s = await warm(await fresh());
	await send(s, N2, 'credit.take');
	await refused(s, N2, 'name.set', { name: 'abc' }, /6 or more characters/);
	await refused(s, N2, 'transfer', { asset: 'DZY', to: A.address, amount: 1 }, /DZY|enough/);
	await refused(s, N2, 'credit.take', {}, /already has starter credit/);
	await refused(s, B, 'credit.take', {}, /no DZY yet/);
	s.sun.credit.day = Math.floor(s.sun.minute / D); s.sun.credit.today = Number(R.creditPerDay);
	await refused(s, N3, 'credit.take', {}, /all taken/);
	whole(s, 'abuse');
});
await test('Repaid from the first DZY received, with the policy rate as interest; the rest arrives as usual', async () => {
	const s = await warm(await fresh());
	await send(s, N1, 'credit.take');
	await send(s, N1, 'name.set', { name: 'payer1' });
	await minutes(s, 30 * D);
	const owed = L.creditView(s, N1.address).credit.owed, used = L.creditView(s, N1.address).credit.used;
	assert.ok(owed > used, 'no interest after 30 days at the policy rate');
	await send(s, B, 'transfer', { asset: 'DZY', to: N1.address, amount: dzy(5) });
	assert.equal(bal(s, N1), dzy(5) - owed, 'not repaid first, or not exactly');
	assert.equal(L.creditView(s, N1.address).credit, null, 'a repaid credit is still open');
	assert.equal(L.whoIs(s, 'payer1'), N1.address, 'a repaid credit lost its name');
	whole(s, 'repaid');
	return `used ${show(used)}, repaid ${show(owed)} after 30 days (interest ${show(owed - used)})`;
});
await test('Not repaid in about 6 months: the credit closes, the name is released, the account never gets credit again; DZY it receives later still pays the debt', async () => {
	const s = await warm(await fresh());
	await send(s, N1, 'credit.take');
	await send(s, N1, 'name.set', { name: 'ghost1' });
	await minutes(s, Number(R.creditMinutes) + 1, { by: VS[0].address });
	assert.equal(L.whoIs(s, 'ghost1'), null, 'the name was not released');
	assert.equal(L.creditView(s, N1.address).defaulted, true);
	await refused(s, N1, 'credit.take', {}, /did not repay/);
	const owed = L.creditView(s, N1.address).credit.owed;
	await send(s, B, 'transfer', { asset: 'DZY', to: N1.address, amount: dzy(1) });
	assert.equal(bal(s, N1), dzy(1) - owed, 'the old debt was not paid from what arrived');
	assert.equal(L.creditView(s, N1.address).defaulted, true, 'a defaulter was forgiven its record');
	whole(s, 'default');
	return `after ${Math.round(Number(R.creditMinutes) / D)} days: name released, ${show(owed)} DZY collected from the next DZY received`;
});
await test('The economy view shows every number the rules act on', async () => {
	const s = await fresh();
	await busy(s, D + 5);
	const e = L.economyView(s);
	for (const k of ['policyRate', 'rateTarget', 'moneyGrowth', 'blockUse', 'fee', 'feeFloor', 'inHands']) assert.equal(typeof e[k], 'number', k);
	assert.equal(e.council.workers.length, 4); assert.ok(e.council.wagePerDay > 0);
	assert.equal(BigInt(e.council.buffer), bufferFor(R, BigInt(s.sun.fed.M.at(-1)), s.sun.council.inc.map(BigInt)));
	return `rate ${e.policyRate / 100}%, fee ${show(e.fee)} DZY, fund ${show(e.council.fund)} of buffer ${show(e.council.buffer)}, wage ${show(e.council.wagePerDay)} DZY a day`;
});

/* ---------- seats: locked and staked DZY count as burned; a seat is own stake (1% at least) plus holders' backing ---------- */
await test('The seat price is 1,000 DZY x the share of DZY not locked or staked: each new seat needs a little fewer DZY', async () => {
	const many = K.slice(0, 12), s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: [VS[0].address], seedWait: 0, sales: [
		...many.map((k) => ({ to: k.address, units: dzy(3_000), paid: dzy(3_000) / 500, proof: 'test' })),
		{ to: A.address, units: dzy(1_200_000), paid: dzy(1_200_000) / 200, proof: 'test', lockYears: 5 }] }); // 10% of all DZY locked
	assert.equal(L.seatPrice(s), 900 * DZY, 'with 10% of all DZY locked, a seat is not 900 DZY');
	const prices = [];
	for (const k of many.slice(0, 5)) { const p = L.seatPrice(s); prices.push(p); await send(s, k, 'stake.bond', { amount: p }); assert.ok(L.isStaker(s, k.address)); }
	assert.ok(prices.every((p, i) => !i || p < prices[i - 1]), 'a later seat did not need fewer DZY');
	whole(s, 'seats');
	return 'seats: ' + prices.map((p) => (p / DZY).toFixed(4)).join(', ') + ' DZY';
});
await test('Anyone can validate however valuable DZY becomes: 1% of a seat staked makes a candidate; holders back it to a full seat; less than 1% own cannot be backed', async () => {
	const many = K.slice(0, 12), s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: [VS[0].address], seedWait: 0, sales: many.map((k) => ({ to: k.address, units: dzy(3_000), paid: dzy(3_000) / 500, proof: 'test' })) });
	const [newcomer, b1, b2, poor] = many, price = L.seatPrice(s);
	await send(s, newcomer, 'stake.bond', { amount: Math.ceil(price / 100) }); // about 10 DZY of its own
	assert.ok(L.isCandidate(s, newcomer.address) && !L.isStaker(s, newcomer.address), 'a candidate is not yet a validator');
	await send(s, b1, 'stake.delegate', { validator: newcomer.address, amount: Math.floor(price / 2) });
	assert.ok(!L.isStaker(s, newcomer.address), 'half a seat made a validator');
	await send(s, b2, 'stake.delegate', { validator: newcomer.address, amount: Math.ceil(price / 2) });
	assert.ok(L.isStaker(s, newcomer.address), 'own 1% plus backing to a full seat did not make a validator');
	await send(s, poor, 'stake.bond', { amount: Math.floor(price / 200) }); // half of 1%
	await refused(s, b1, 'stake.delegate', { validator: poor.address, amount: price }, /1% of a seat/);
	whole(s, 'backing');
	return `a seat of ${(price / DZY).toFixed(2)} DZY taken with ${(Math.ceil(price / 100) / DZY).toFixed(2)} DZY of its own and the rest backed by two holders`;
});

/* ---------- the daily bonus: a lottery per staked shard ---------- */
await test('The daily bonus is a lottery per staked shard: 3x the shards wins about 3x as often; no shards, no tickets; the same day always draws the same winner', async () => {
	const s = await fresh(VS, [{ to: VS[0].address, units: dzy(3_000), paid: dzy(3_000) / 500, proof: 'test' }, { to: VS[1].address, units: dzy(1_000), paid: dzy(1_000) / 500, proof: 'test' }]);
	await send(s, VS[0], 'stake.bond', { amount: dzy(2_999) });
	await send(s, VS[1], 'stake.bond', { amount: dzy(999) });
	const w = VS.map((v) => v.address).sort(), wins = new Map();
	for (let day = 0; day < 400; day++) { const v = await bonusWinner(s, w, '', day); wins.set(v, (wins.get(v) ?? 0) + 1); }
	const big = wins.get(VS[0].address) ?? 0, small = wins.get(VS[1].address) ?? 0;
	assert.equal(big + small, 400, 'a validator with no shards won a bonus');
	assert.ok(big > 250 && big < 350, `3/4 of the shards won ${big} of 400 days`);
	assert.equal(await bonusWinner(s, w, '', 7), await bonusWinner(s, w, '', 7), 'the same day drew two winners');
	return `over 400 days: 2,999 DZY staked won ${big}, 999 DZY won ${small}, none staked won 0`;
});
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
