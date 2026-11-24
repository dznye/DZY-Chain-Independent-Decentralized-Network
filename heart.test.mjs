// The Heart upgrade, written as attacks and promises: power is stake x time; a raffle by power for every block; newcomers,
// however rich or many, can neither stop nor take the chain; fees in five parts, exact to the shard, the exchange's in the
// coin they were paid in; and a fingerprint that covers the whole state. Run: node heart.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';
import { produceBlock, quorum, replay, roundOf, turns, verifyBlock, weights } from './src/block.ts';
import { commit, seal } from './src/layer.ts';

globalThis.DZNYE_ROOT_CHECK = true; // every fingerprint is also computed from nothing, and must agree
const results = [];
async function test(name, fn) {
	const t0 = Date.now();
	try { const note = await fn(); results.push(['PASS', name]); console.log(`PASS  ${name}${note ? '  — ' + note : ''}  (${Date.now() - t0} ms)`); }
	catch (e) { results.push(['FAIL', name]); console.log(`FAIL  ${name}  — ${(e.stack ?? e.message).split('\n').slice(0, 6).join(' | ')}`); }
}
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, dzy = (n) => Math.round(n * DZY), DAY = 1440;
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye heart test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 120 }, (_, i) => key(i)), [F, W, X, Y, Z2, U1, U2] = K, CROWD = K.slice(10);
const T0 = 1_800_000_000_000;
let chains = 0;
const fresh = async (who = [F, W, X, Y, Z2, U1, U2], units = 2_000, validators = [F]) => {
	const chain = `dznye-heart-t${++chains}`; L.testCrewFrom(chain, 1);
	return L.sunGenesis({ chain, time: T0, validators: validators.map((v) => v.address), seedWait: 0, sales: who.map((k) => ({ to: k.address, units: dzy(Array.isArray(units) ? units[who.indexOf(k)] : units), paid: dzy(Array.isArray(units) ? units[who.indexOf(k)] : units) / 100, proof: 'test' })) });
};
const send = async (s, k, type, data = {}) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, s.validators[0]);
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); await assert.rejects(() => send(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, where) => assert.equal(L.holdings(s).DZY, SUPPLY, `${where}: DZY created or destroyed (${L.holdings(s).DZY - SUPPLY})`);
async function minute(s, txCount = 0, round = 0) {
	s.time += 60_000;
	const turn = turns(s, s.height + 1), v = turn(round);
	L.endBlock(s, s.height + 1, round, v, s.time); s.height += 1;
	await L.sunBlock(s, s.time, txCount, v);
	return v;
}
const minutes = async (s, n) => { for (let i = 0; i < n; i++) await minute(s); };
const check = async (s, k) => send(s, k, 'node.checkin', { seen: [s.height, s.last], url: `https://n${k.address.slice(0, 8)}.example` });
/** hours pass, these keys checking in every 20 minutes */
async function hours(s, n, keys) { await minutes(s, 6); for (let i = 0; i < n * 3; i++) { for (const k of keys) await check(s, k); await minutes(s, 20); } }
/** the same, quickly: the clocks set as if the hours had passed (the rules of the clock are tested on their own) */
const aged = (s, k, h) => { s.nodes[k.address] = { ...s.nodes[k.address], on: h * 1000, ch: H.chainHour(s) }; };
const start = async (s, at) => { H.testHeartFrom(s.chain, at ?? s.height + 2); await minute(s); assert.ok(s.heart, 'the upgrade did not start'); };
const founded = async (stake = 100, who, units) => { const s = await fresh(who, units); await send(s, F, 'stake.bond', { amount: dzy(stake) }); await check(s, F); await minutes(s, 2); await start(s); return s; };
const redraw = async (s, keys) => { for (const k of keys) if (s.time - (s.nodes?.[k.address]?.at ?? 0) >= 5 * 60_000 || !s.nodes?.[k.address]) await check(s, k); await minutes(s, 11); };
const say = (s, k) => weights(s).power[k.address] ?? 0;

await test('Before its block the upgrade changes nothing: the same chain, fingerprint for fingerprint', async () => {
	const go = async (from) => { const s = await fresh(); s.chain = 'dznye-heart-same'; L.testCrewFrom(s.chain, 1); H.testHeartFrom(s.chain, from); await send(s, F, 'stake.bond', { amount: dzy(100) }); await check(s, F); await minutes(s, 40); return L.stateRoot(s); };
	assert.equal(await go(null), await go(1_000)); H.testHeartFrom('dznye-heart-same', null);
	const s = await fresh();
	await refused(s, F, 'layer.open', { name: 'early', kind: 'app', ops: [F.address], wait: 600_000 }, /Heart/);
	await refused(s, F, 'grant.propose', { to: W.address, asset: 'DZY', amount: 1, reason: 'early' }, /Heart/);
	assert.equal(H.heartFrom('dznye-mainnet'), 8_760, 'the live chain switches at the block its owner set, and no other'); assert.equal(H.heartFrom('any-other-chain'), Infinity);
});

await test('A real chain crosses the switch: blocks made, checked by a second copy, and replayed from genesis by the rules alone', async () => {
	const s0 = await fresh(); H.testHeartFrom(s0.chain, 4);
	let a = structuredClone(s0), b = structuredClone(s0); seal(a); seal(b);
	const blocks = [];
	const block = async (txs = []) => { const made = await produceBlock(a, txs, a.time + 60_000, F, Math.max(0, roundOf(a, a.height + 1, F.address))); blocks.push(made.block); a = commit(made.state); b = commit(await verifyBlock(b, JSON.parse(JSON.stringify(made.block)))); assert.equal(a.last, b.last); };
	const tx = (k, type, data, plus = 1) => L.signTx(k.secret, { chain: a.chain, from: k.address, nonce: L.nonceOf(a, k.address) + plus, type, data });
	await block([await tx(F, 'stake.bond', { amount: dzy(100) })]);
	await block([await tx(F, 'node.checkin', { seen: [a.height, a.last], url: 'https://f.example' }), await tx(W, 'stake.bond', { amount: dzy(60) })]);
	await block(); assert.ok(a.heart && a.heart.from === 4);
	await block([await tx(W, 'node.checkin', { seen: [a.height, a.last], url: 'https://w.example' })]);
	let joined = false;
	for (let i = 0; i < 25; i++) { await block([await tx(U1, 'transfer', { asset: 'DZY', to: U2.address, amount: 1000 })]); joined ||= a.validators.includes(W.address); }
	assert.ok(joined, 'the newcomer never joined: this tests nothing');
	const end = await replay(s0, blocks);
	assert.equal(end.last, a.last); whole(end, 'replayed');
	return `${blocks.length} blocks, ${a.validators.length} validators`;
});

await test('The clock: one hour for each hour online; four lost for each hour away; a chain that stands still costs nobody anything', async () => {
	const s = await founded();
	await send(s, W, 'stake.bond', { amount: dzy(10) });
	await hours(s, 5, [F, W]);
	const h5 = H.ownHours(s, W.address) / 1000;
	assert.ok(h5 >= 5 && h5 <= 6, `${h5} hours`);
	s.time += 30 * 24 * 3_600_000; // the chain stands still for a month: no blocks
	await check(s, W);
	assert.ok(H.ownHours(s, W.address) / 1000 >= h5, 'a stopped chain cost hours');
	await hours(s, 2, [F]); // W away for two hours
	await check(s, W);
	const after = H.ownHours(s, W.address) / 1000;
	assert.ok(after < h5 && after >= 1, `${after} hours after being away`);
	whole(s, 'clock');
});

await test('Added stake starts its own clock: 2 old DZY does not make 1,000 DZY old; the power already earned is kept exactly', async () => {
	const s = await founded();
	await send(s, W, 'stake.bond', { amount: dzy(2) }); await check(s, W); aged(s, W, 2_000);
	const before = H.stakeTime(s, W.address);
	await send(s, W, 'stake.bond', { amount: dzy(1_000) });
	const after = H.stakeTime(s, W.address);
	assert.ok(after <= before && before - after <= 1_100n, `${before} -> ${after}`);
	assert.ok(!H.isProven(s, W.address), '1,000 new DZY were proven at once');
	aged(s, W, 2_100);
	assert.ok(H.stakeTime(s, W.address) >= before + 100n * 1002n * 1000n - 3_000n, 'the new stake does not earn its hours');
});
await test('Backing someone with a fortune and taking it back does not touch the time they earned', async () => {
	const s = await founded(100, [F, W, X], [2_000, 2_000, 100_000]);
	aged(s, F, 1_000);
	const before = H.stakeTime(s, F.address);
	await send(s, X, 'stake.delegate', { validator: F.address, amount: dzy(90_000) });
	assert.equal(H.stakeTime(s, F.address), before, 'new backing counted at once');
	await send(s, X, 'stake.undelegate', { validator: F.address, amount: dzy(90_000) });
	assert.equal(H.stakeTime(s, F.address), before);
	assert.equal(s.backed, undefined);
	whole(s, 'backing');
});

for (const [what, stakes] of [['50 DZY, the stake that stopped the chain before', [50]], ['201 DZY, the stake that took it before', [201]], ['100,000 DZY', [100_000]], ['1,000,000 DZY over 60 keys', Array(60).fill(16_000)]])
	await test(`Newcomers with ${what}: they join and make blocks, but the founder alone still finishes every block, and they alone none`, async () => {
		const who = CROWD.slice(0, stakes.length), s = await founded(100, [F, ...who], [2_000, ...stakes.map((x) => x + 10)]);
		for (const [i, k] of who.entries()) await send(s, k, 'stake.bond', { amount: dzy(stakes[i]) });
		for (let t = 0; t < 3; t++) await redraw(s, [F, ...who]);
		for (const k of who) aged(s, k, 700); // 29 days of patience: still not proven
		await redraw(s, [F, ...who]);
		const w = weights(s), theirs = who.reduce((n, k) => n + say(s, k), 0);
		assert.ok(theirs > 0, 'they did not join at all');
		assert.ok(say(s, F) >= w.need, `the founder has ${say(s, F)} of ${w.need} needed`);
		assert.ok(theirs < w.need && w.total - theirs >= w.need, 'they can take or stop it');
		whole(s, 'newcomers');
		return `theirs: ${(theirs / w.total * 100).toFixed(1)}% of the say, from ${stakes.reduce((a, b) => a + b, 0).toLocaleString('en-US')} DZY`;
	});

await test('Four keys of one person, 30 days online with 100 DZY each: still no takeover (the anchors step back only with 10,000 DZY proven)', async () => {
	const who = CROWD.slice(0, 4), s = await founded(100, [F, ...who], [2_000, 300, 300, 300, 300]);
	for (const k of who) { await send(s, k, 'stake.bond', { amount: dzy(150) }); await check(s, k); aged(s, k, 800); }
	await redraw(s, [F, ...who]);
	assert.ok(who.every((k) => H.isProven(s, k.address)) && !s.heart.open);
	assert.ok(say(s, F) >= weights(s).need);
});
await test('Once four proven validators with 10,000 DZY are online the anchors are like everyone else, and the chain is everyone\'s', async () => {
	const who = CROWD.slice(0, 5), s = await founded(1_000, [F, ...who], [2_000, 4_000, 4_000, 4_000, 4_000, 60_000]);
	aged(s, F, 2_000);
	for (const k of who) { await send(s, k, 'stake.bond', { amount: dzy(k === who[4] ? 50_000 : 3_000) }); await check(s, k); aged(s, k, k === who[4] ? 5 : 2_000); }
	await redraw(s, [F, ...who]);
	assert.equal(s.heart.open, true);
	const w = weights(s), rich = say(s, who[4]);
	assert.ok(say(s, F) < w.need, 'the founder still decides alone');
	assert.ok(rich > 0 && rich * 4 <= w.total + 4, 'the unproven fortune holds more than a quarter');
	assert.ok(w.total - say(s, who[0]) >= w.need, 'one proven validator going offline stops the chain');
	return `${s.validators.length} validators; the largest holds ${(Math.max(...Object.values(w.power)) / w.total * 100).toFixed(0)}%`;
});
await test('Whoever joins just before the switch is no anchor: the anchors are the chain\'s starting validators, and on the live chain they are written down', async () => {
	const s = await fresh(); H.testHeartFrom(s.chain, 8, [F.address]);
	await send(s, W, 'stake.bond', { amount: dzy(1_900) }); await check(s, W); await send(s, F, 'stake.bond', { amount: dzy(100) }); await check(s, F);
	await minutes(s, 12);
	assert.deepEqual(s.heart.anchors, [F.address]); assert.ok(say(s, F) >= weights(s).need);
	const src = (await import('node:fs')).readFileSync(new URL('./src/heart.ts', import.meta.url), 'utf8'), g = JSON.parse((await import('node:fs')).readFileSync(new URL('./launch/dznye-mainnet.genesis.json', import.meta.url), 'utf8'));
	for (const v of (g.sun ?? g).validators) assert.ok(src.includes(`'${v}'`), 'the live chain\'s starting validator is not the anchor');
});
await test('The anchors are not dropped because a check-in was late, nor benched, while they carry the chain', async () => {
	const s = await founded(); await send(s, W, 'stake.bond', { amount: dzy(1_000) });
	for (let i = 0; i < 10; i++) { await check(s, W); await minutes(s, 10); } // F does not check in for 100 minutes
	assert.ok(s.validators.includes(F.address) && say(s, F) >= weights(s).need);
});

await test('The raffle: over 4,000 blocks each validator is drawn in proportion to its power, and nobody else is', async () => {
	const s = await founded(100, [F, W, X, Y], 3_000);
	for (const [k, n] of [[W, 20], [X, 10]]) { await send(s, k, 'stake.bond', { amount: dzy(n) }); await check(s, k); }
	for (const k of [F, W, X]) aged(s, k, 500);
	await redraw(s, [F, W, X]);
	const n = {}, turn = (h) => turns(s, h)(0), { power, total } = weights(s);
	for (let h = 1; h <= 4_000; h++) n[turn(h)] = (n[turn(h)] ?? 0) + 1;
	for (const k of [F, W, X]) { const want = 4_000 * power[k.address] / total, got = n[k.address] ?? 0; assert.ok(Math.abs(got - want) < 4 * Math.sqrt(want) + 5, `${got} turns, ${want.toFixed(0)} by its power`); }
	assert.equal(Object.keys(n).length, 3);
	assert.equal(turns(s, 7)(3), turns(structuredClone(s), 7)(3), 'two nodes draw differently');
	return [F, W, X].map((k) => `${(power[k.address] / total * 100).toFixed(0)}% of the power, ${(n[k.address] / 40).toFixed(0)}% of the blocks`).join('; ');
});
await test('Missing turns: a day of hours each, benched after three; the next one drawn makes the block', async () => {
	const s = await founded(100, [F, W, X], 3_000);
	await send(s, W, 'stake.bond', { amount: dzy(30) }); await check(s, W); aged(s, W, 600); aged(s, F, 600);
	await redraw(s, [F, W]);
	const h0 = H.ownHours(s, W.address); let misses = 0;
	for (let i = 0; i < 400 && s.stakes[W.address].jailed === undefined; i++) {
		const t = turns(s, s.height + 1);
		if (t(0) === W.address && t(1) === F.address) { misses++; await minute(s, 0, 1); } else if (t(0) === F.address) { const st = s.stakes[W.address].missed; await minute(s); assert.equal(s.stakes[W.address].missed, st); } else { s.height += 1; }
		if (i % 40 === 0 && s.time - s.nodes[F.address].at > 400_000) await check(s, F);
	}
	assert.equal(misses, 3, 'not benched after three');
	assert.ok(H.ownHours(s, W.address) <= h0 - 3 * 24_000 + 3_000);
	await minute(s); assert.ok(!s.validators.includes(W.address));
});
await test('More than 64 validators: a quarter of the power never gets a third of the seats (by luck it did, one draw in twenty, before)', async () => {
	const who = CROWD.slice(0, 100), s = await founded(100, [F, ...who], [2_000, ...who.map(() => 500)]);
	for (const k of who) { await send(s, k, 'stake.bond', { amount: dzy(100) }); await check(s, k); }
	for (const k of who) aged(s, k, 2_000);
	await send(s, F, 'stake.bond', { amount: dzy(100) }); aged(s, F, 2_000);
	s.heart.anchors = [F.address];
	{ // everyone has their chance: over the periods the sample changes, and every one of the hundred is drawn sometimes
		const ever = new Set(), seen = new Set();
		for (let e = 0; e < 60; e++) { s.last = createHash('sha256').update('y' + e).digest('hex'); const c = H.drawHeartCrew(s, s.time, e); seen.add(JSON.stringify(c.powers)); for (const a of c.validators) ever.add(a); }
		assert.ok(seen.size > 20, `only ${seen.size} different samples`); assert.equal(ever.size, 101);
	}
	// as if the network were open: 25 of the 100 are one attacker
	const bad = new Set(who.slice(0, 25).map((k) => k.address));
	let worst = 0, oldWorst = 0, oldOver = 0;
	for (let e = 0; e < 300; e++) {
		s.last = createHash('sha256').update('x' + e).digest('hex');
		const c = H.drawHeartCrew(s, s.time, e), tot = Object.values(c.powers).reduce((a, b) => a + b, 0), b = Object.entries(c.powers).filter(([a]) => bad.has(a)).reduce((n, [, p]) => n + p, 0);
		worst = Math.max(worst, b / tot);
		const o = L.drawCrew(s, who.map((k) => k.address), e), ot = Object.values(o.powers).reduce((a, x) => a + x, 0), ob = Object.entries(o.powers).filter(([a]) => bad.has(a)).reduce((n, [, p]) => n + p, 0);
		oldWorst = Math.max(oldWorst, ob / ot); if (ob * 3 >= ot) oldOver++;
	}
	assert.ok(worst < 1 / 3, `an attacker with a quarter got ${(worst * 100).toFixed(1)}%`);
	return `worst of 300 draws: ${(worst * 100).toFixed(1)}% now; the old draw's worst ${(oldWorst * 100).toFixed(1)}%, a third or more in ${oldOver} of 300`;
});

await test('Fees: 40% validators, 30% behind DZY, 5% least working, 10% contributors, 15% lockers; exact to the shard, even a shard a minute', async () => {
	const s = await founded(100, [F, W, X, U1, U2], 3_000);
	await send(s, X, 'lock', { amount: dzy(500), years: 3 });
	await minutes(s, 3);
	const x0 = { pot: s.sun.council.pot ?? 0, least: s.heart.least, grants: s.heart.grants, val: s.sun.valPool + s.sun.roundPot };
	const hold0 = s.heart.hold, spent = { v: 0, l: 0, g: 0, k: 0, b: 0 }; let n = 0;
	for (const r of [1, 1, 1, 1, 1, 2, 3, 7, 1_000, 1, 999_983, 12_345]) { n += r; const p = H.splitCarry(s, r); for (const k in p) spent[k] += p[k]; }
	assert.equal(Object.values(spent).reduce((a, b) => a + b, 0) + s.heart.hold, n + hold0); s.heart.hold -= n; // (undo: those fees came from nowhere)
	for (const [k, bp] of [['v', 4000], ['l', 500], ['g', 1000], ['k', 1500], ['b', 3000]]) assert.ok(Math.abs(spent[k] - n * bp / 10_000) <= 1, `${k}: ${spent[k]} of ${n}`);
	assert.ok(x0.grants >= 0);
	s.heart.hold = hold0; s.heart.owe = { v: 0, l: 0, g: 0, k: 0, b: hold0 * 10_000 };
	whole(s, 'after undoing');
	// a whole day for real: 60 payments with a fee of 1,000,000 shards each
	s.fee = 1_000_000; s.sun.fed.floor = 1_000_000;
	const before = { grants: s.heart.grants, f: L.balanceOf(s, F.address) };
	let paid = 0;
	for (let i = 0; i < 60; i++) { s.fee = 1_000_000; await send(s, U1, 'transfer', { asset: 'DZY', to: U2.address, amount: 10 }); paid += 1_000_000; await minute(s); }
	s.fee = 1; s.sun.fed.floor = 1; // from here the check-ins cost next to nothing, so these 0.6 DZY are the day's fees
	whole(s, 'fees paid');
	for (let d = 0; d < 12; d++) { for (let h = 0; h < 72; h++) { if (s.time - s.nodes[F.address].at > 1_000_000) await check(s, F); await minutes(s, 20); } }
	whole(s, 'twelve days later');
	const grants = s.heart.grants - before.grants;
	assert.ok(Math.abs(grants / paid - 0.1) < 0.005, `contributors got ${(grants / paid * 100).toFixed(2)}%`);
	return `${paid / DZY} DZY of fees: contributors' fund ${(grants / paid * 100).toFixed(1)}% (the rest of the check-ins' own fees included)`;
});
await test('The least working: those online all day who made fewer blocks than their share, share their 5% by stake x time; splitting keys gains nothing', async () => {
	const s = await founded(100, [F, W, X, Y], 3_000);
	for (const k of [W, X, Y]) await send(s, k, 'stake.bond', { amount: dzy(20) });
	for (const k of [F, W, X, Y]) { if (!s.nodes[k.address] || s.time - s.nodes[k.address].at > 300_000) await check(s, k); s.nodes[k.address] = { ...s.nodes[k.address], hrs: 20 }; aged(s, k, 100); }
	const l = H.leastWorking(s, { [F.address]: 900, [W.address]: 50, [X.address]: 0, [Y.address]: 3 });
	assert.deepEqual(l.map(([a]) => a).sort(), [W.address, X.address, Y.address].sort(), 'not those who made fewer blocks than their share');
	assert.deepEqual(H.leastWorking(s, { [F.address]: 0 }), []); // nobody made any: nobody made fewer
	// a crowd of tiny keys (low addresses, no blocks) must not take the pay of those with real stake
	const crowd = CROWD.slice(0, 60); for (const k of crowd) { s.stakes[k.address] = { bond: dzy(1) }; s.nodes[k.address] = { url: 'https://c.example', at: s.time, hrs: 24, on: 100_000, ch: H.chainHour(s) }; }
	const all = H.leastWorking(s, { [F.address]: 900, [W.address]: 1 }), tot = all.reduce((n, [, w]) => n + w, 0n), theirs = all.filter(([a]) => crowd.some((k) => k.address === a)).reduce((n, [, w]) => n + w, 0n);
	assert.ok(all.some(([a]) => a === X.address), 'the crowd pushed a real one out'); assert.equal(theirs * 120n, tot * 60n, 'the crowd got more than its stake x time');
	for (const k of crowd) { delete s.stakes[k.address]; delete s.nodes[k.address]; }
	const alone = H.share(1_000, [['a', 100n]], () => {}), got = {};
	H.share(1_000, [['a', 100n], ['b', 50n], ['b2', 50n]], (a, n) => { got[a] = n; });
	assert.equal(alone, 0); assert.ok(got.b + got.b2 <= got.a);
});
await test('Paying yourself through your own contract always loses: its maker gets back at most a tenth of its fees', async () => {
	const s = await founded(100, [F, W, U1], 3_000);
	await send(s, U1, 'contract.deploy', { code: { functions: { f: { body: 1 } } } });
	const at = Object.keys(s.contracts)[0];
	s.fee = 1_000_000; const b0 = L.balanceOf(s, U1.address);
	for (let i = 0; i < 20; i++) { s.fee = 1_000_000; await send(s, U1, 'contract.call', { contract: at, fn: 'f', args: [] }); }
	const cost = b0 - L.balanceOf(s, U1.address), got = [];
	s.heart.grants += cost; // even if the fund holds far more
	H.payMakers(s, (a, n) => got.push([a, n])); s.heart.grants -= cost;
	assert.equal(got.length, 1); assert.ok(got[0][1] > 0 && got[0][1] <= cost / 10 + 1, `${got[0][1]} back of ${cost}`);
});
await test('Contributors are paid by vote: more than two thirds of the stake, never more than the fund holds', async () => {
	const s = await founded(100, [F, W, X], 3_000);
	await send(s, W, 'stake.bond', { amount: dzy(100) });
	s.heart.grants = 5_000; s.treasury -= 5_000;
	await send(s, W, 'grant.propose', { to: X.address, asset: 'DZY', amount: 4_000, reason: 'built a layer' });
	const id = Object.keys(s.heart.props)[0];
	await send(s, W, 'grant.vote', { id, yes: true });
	assert.equal(s.heart.grants, 5_000, 'half the stake was enough');
	await refused(s, X, 'grant.vote', { id, yes: true }, /staked/);
	const b = L.balanceOf(s, X.address); await send(s, F, 'grant.vote', { id, yes: true });
	assert.equal(L.balanceOf(s, X.address) - b, 4_000); assert.equal(s.heart.grants, 1_000);
	await send(s, W, 'grant.propose', { to: W.address, asset: 'DZY', amount: 999_999, reason: 'too much' });
	const id2 = Object.keys(s.heart.props)[0]; await send(s, W, 'grant.vote', { id: id2, yes: true }); await send(s, F, 'grant.vote', { id: id2, yes: true });
	assert.equal(s.heart.grants, 1_000); whole(s, 'grants');
});
await test('The exchange\'s fees are paid out in the very coin: validators, least working, lockers; 30% (and a little more) stays behind DZY; the vaults always cover everything', async () => {
	const s = await founded(100, [F, W, X, U1, U2], 3_000); L.testExchangeFrom(s.chain, s.height + 1);
	await send(s, X, 'lock', { amount: dzy(500), years: 3 });
	await send(s, W, 'stake.bond', { amount: dzy(20) }); await check(s, W); aged(s, W, 500); aged(s, F, 500);
	const coinOk = (where) => { const held = Object.entries(s.x?.vaults ?? {}).filter(([k]) => k.endsWith(':ETH')).reduce((n, [, v]) => n + v, 0), owed = (s.assets.xETH?.supply ?? 0) + Object.entries(L.locksOfX(s) ?? {}).filter(([k]) => k.endsWith(':ETH')).reduce((n, [, v]) => n + v, 0) + (s.x?.pot?.ETH ?? 0) + (H.heartCoin(s).ETH ?? 0); assert.equal(held, owed, `${where}: the vaults hold ${held}, ${owed} is owed`); };
	await send(s, F, 'x.price', { p: { ETH: 3_000_000_000 } });
	await send(s, U1, 'x.park', { on: true });
	await send(s, F, 'x.deposit', { net: 'base', coin: 'ETH', amount: 10_000_000_000, tx: '0x' + 'ab'.repeat(32), to: U1.address });
	coinOk('deposit');
	const pot0 = s.x?.pot?.ETH ?? 0;
	await send(s, U1, 'x.sell', { coin: 'ETH', amount: 2_000_000_000, net: 'base', to: '0x00000000000000000000000000000000000d0e01' });
	const fee = 2_000_000, pot = s.x.pot.ETH - pot0;
	assert.equal(pot, fee * 0.3); assert.deepEqual(s.heart.coin, { v: { ETH: fee * 0.4 }, l: { ETH: fee * 0.05 }, g: { ETH: fee * 0.1 }, k: { ETH: fee * 0.15 } });
	coinOk('after the fee');
	for (const k of [F, W]) s.nodes[k.address] = { ...s.nodes[k.address], hrs: 20 };
	s.sun.work = { [F.address]: 900, [W.address]: 100 };
	for (let i = 0; i < 80 && s.heart.coin.v.ETH; i++) { for (const k of [F, W]) { if (s.time - s.nodes[k.address].at > 900_000) await check(s, k); s.nodes[k.address] = { ...s.nodes[k.address], hrs: 20 }; } for (let q = 0; q < 4; q++) { await minutes(s, 5); for (const t of L.openTickets(s, X.address)) await send(s, X, 'ticket.answer', t); } }
	coinOk('after pay day'); whole(s, 'after pay day');
	const got = (k) => L.balanceOf(s, k.address, 'xETH');
	assert.ok(got(F) > 0 && got(W) > 0 && got(X) === fee * 0.15, `${got(F)} ${got(W)} ${got(X)}`);
	assert.ok(got(F) + got(W) <= fee * 0.45 + 2 && got(F) + got(W) >= fee * 0.45 - 4);
	// and it is real: the locker takes it out of the vault
	await send(s, X, 'x.sell', { coin: 'ETH', amount: got(X), net: 'base', to: '0x00000000000000000000000000000000000d0e01' }); coinOk('taken out');
	L.testExchangeFrom(s.chain, null);
	return `of a 0.002 ETH fee: founder ${got(F) / 1e9}, newcomer ${got(W) / 1e9} ETH; locker's 0.0003 ETH taken out`;
});

await test('The fingerprint covers the whole state: the exchange, the creators\' fee, hours and funds cannot be altered in a copy handed to a new node', async () => {
	const s = await founded(); s.x = { vaults: { 'eth:ETH': 5 }, free: {}, pot: { ETH: 5 } };
	const base = await L.stateRoot(structuredClone(s));
	for (const [what, f] of [['pot', (t) => { t.x.pot.ETH = 999; }], ['vault', (t) => { t.x.vaults['eth:ETH'] = 6; }], ['lock', (t) => { t.xlocks = { [F.address + ':ETH']: 5 }; }], ['lock hidden inside the exchange', (t) => { t.x.locks = { [F.address + ':ETH']: 5 }; }], ['creators\' fee', (t) => { t.saleFeeBps = 2000; }], ['premium names', (t) => { t.premiumSold = { 1: 9 }; }], ['recent hashes', (t) => { t.recent.hashes[0] = '0'.repeat(64); }], ['hours', (t) => { t.nodes[F.address].on = 9e6; }], ['grants fund', (t) => { t.heart.grants = 9; }], ['anchors', (t) => { t.heart.anchors = [W.address]; }], ['raffle seed', (t) => { t.crew.seed = '0'.repeat(64); }]]) {
		const t = structuredClone(s); f(t); assert.notEqual(await L.stateRoot(t), base, `${what} can be altered`);
	}
});
await test('A block past the size every node takes is refused by every node', async () => {
	const s0 = await fresh([F, U1]); H.testHeartFrom(s0.chain, 2);
	let a = structuredClone(s0); seal(a); a = commit((await produceBlock(a, [], a.time + 1000, F)).state); assert.ok(a.heart);
	const list = Array.from({ length: 100 }, (_, i) => [CROWD[i % 100].address, 10 + i]), txs = [];
	for (let i = 1; i <= 260; i++) txs.push(await L.signTx(U1.secret, { chain: a.chain, from: U1.address, nonce: i, type: 'transfer.many', data: { asset: 'DZY', to: list } }));
	await assert.rejects(produceBlock(a, txs, a.time + 1000, F, 0), /too big/);
});
await test('Contracts from the upgrade on: a swap formula that failed at 1 DZY works at any size; hashes; nothing new before it', async () => {
	const code = { functions: { q: { view: true, args: ['x', 'y', 'dx'], body: ['muldiv', ['arg', 'y'], ['arg', 'dx'], ['+', ['arg', 'x'], ['arg', 'dx']]] }, h: { view: true, args: ['t'], body: ['sha256', ['arg', 't']] }, z: { view: true, body: ['muldiv', 9007199254740991, 9007199254740991, 1] }, o: { view: true, body: ['muldiv', 1, 1, 0] } } };
	const old = await fresh(); await refused(old, U1, 'contract.deploy', { code }, /unknown operation/);
	const s = await founded(); await send(s, U1, 'contract.deploy', { code }); const at = Object.keys(s.contracts)[0];
	for (const [x, y, dx] of [[1, 1, 1], [10_000, 10_000, 0.01], [1_000_000, 5_000_000, 12_345]]) assert.equal(BigInt(L.viewContract(s, at, 'q', [x, y, dx].map(dzy)).value), BigInt(dzy(y)) * BigInt(dzy(dx)) / (BigInt(dzy(x)) + BigInt(dzy(dx))));
	assert.equal(L.viewContract(s, at, 'h', ['dzy']).value, createHash('sha256').update('dzy').digest('hex'));
	assert.throws(() => L.viewContract(s, at, 'z', []), /too large/); assert.throws(() => L.viewContract(s, at, 'o', []), /zero/);
});

/* ---------- the moving price, the treasury, blocks by weight, places ---------- */
const market = async (units = [8_400, 60, 60, 60]) => {
	const s = await fresh([F, W, X, Y], units); L.testExchangeFrom(s.chain, 1); L.testXUnlimitedFrom?.(s.chain, 1);
	await send(s, F, 'stake.bond', { amount: dzy(100) }); await check(s, F); await minutes(s, 2); await start(s);
	let n = 0; const price = () => send(s, F, 'x.price', { p: { ETH: 3_000_000_000, USDC: 1_000_000 } });
	const buy = async (k, usd) => { await price(); await send(s, F, 'x.deposit', { net: 'base', coin: 'ETH', amount: Math.floor(usd / 3_000 * 1e9), tx: '0x' + (++n).toString(16).padStart(64, '0'), to: k.address }); };
	const close = async (k) => { await price(); await send(s, k, 'x.close', { coin: 'ETH', to: 'wallet' }); };
	return { s, price, buy, close, spot: () => H.spotPrice(s) / 1e6 };
};
await test('The price moves with trading: it goes on exactly where it was, small buys lift it, closing brings it back down, $1,000 moves it about 7%', async () => {
	const s = await fresh([F, W, X, Y], [8_400, 60, 60, 60]); L.testExchangeFrom(s.chain, 1);
	await send(s, F, 'stake.bond', { amount: dzy(100) }); await check(s, F); await minutes(s, 2);
	const p0 = L.exchangeView(s).dzyPrice; await start(s); assert.ok(Math.abs(H.spotPrice(s) - p0) <= 2, `${p0} -> ${H.spotPrice(s)}`);
	const m = await market(), out = [];
	for (const usd of [10, 100, 1_000]) { const a = m.spot(); await m.buy(W, usd); out.push(`$${usd}: +${((m.spot() / a - 1) * 100).toFixed(2)}%`); assert.ok(m.spot() > a); }
	const top = m.spot(); await m.close(W); assert.ok(m.spot() < top); const base = (await market()).spot(); assert.ok(Math.abs(m.spot() - base) < 0.00002, `${m.spot()} against ${base}`);
	whole(m.s, 'price'); return out.join(', ') + '; closing brought it back';
});
await test('On the moving price a round trip still leaves nothing over, from $100 to $100,000', async () => {
	for (const usd of [100, 1_000, 10_000, 100_000]) { const m = await market(), b0 = L.balanceOf(m.s, W.address); await m.buy(W, usd); await m.close(W); const left = L.balanceOf(m.s, W.address) - b0; assert.ok(left <= 5_000, `$${usd}: ${left} shards over`); whole(m.s, 'round'); }
});
await test('Pushing the price up for a moment buys nothing cheaply: what is priced in dollars uses the hour\'s average; a lasting price counts after an hour', async () => {
	const m = await market(), before = L.usdCost(m.s, 'DZY', 5_000_000); await m.buy(W, 20_000);
	const spot = m.spot(), now = L.usdCost(m.s, 'DZY', 5_000_000);
	assert.ok(spot > 0.2); assert.equal(now, before, `$5 cost ${before / DZY} DZY, and ${now / DZY} after the push`);
	for (let i = 0; i < 18; i++) { await minutes(m.s, 20); await check(m.s, F); }
	assert.ok(L.usdCost(m.s, 'DZY', 5_000_000) < before * 0.75, 'the average never follows'); whole(m.s, 'average');
});
await test('The treasury cannot be emptied by going round: the attack that took two thirds of it in a minute now loses money, and at most 5% leaves in a day', async () => {
	const m = await market(), s = m.s;
	await m.price(); await send(s, Y, 'x.park', { on: true }); await m.buy(Y, 3_000_000); // $3M of honest trading, for the fee
	s.x.pot = { ETH: 1_000_000_000 }; s.x.vaults['base:ETH'] += 1_000_000_000; // a treasury of $3,000, worth more per DZY than the price
	const pot0 = s.x.pot.ETH, f0 = L.xFloor(s, s.time).perDzy; assert.ok(f0 > H.spotPrice(s), 'the backing is not above the price: this tests nothing');
	let put = 0, loops = 0;
	for (; loops < 60; loops++) { const b0 = L.balanceOf(s, W.address); await m.buy(W, 60); put += 60; const got = L.balanceOf(s, W.address) - b0; if (got <= 0) break; try { await send(s, W, 'x.floor', { coin: 'ETH', dzy: got }); } catch (e) { assert.match(e.message, /5% of the ETH/); break; } }
	const out = L.balanceOf(s, W.address, 'xETH') / 1e9 * 3_000, lost = pot0 - s.x.pot.ETH;
	assert.ok(lost <= pot0 * 0.05 + 1, `${lost} left in a day`); assert.ok(out < put * 0.82, `put in $${put}, took out $${out}`);
	whole(s, 'treasury'); return `$${put} in, $${out.toFixed(0)} out; the treasury lost ${(lost / pot0 * 100).toFixed(1)}%`;
});
await test('The chain never sells DZY below 1.25 times its backing, to the shard; and sells none while a coin behind it has no agreed price', async () => {
	const m = await market(), s = m.s; await m.price(); await send(s, Y, 'x.park', { on: true }); await m.buy(Y, 3_000);
	s.x.pot = { ETH: 1_000_000_000 }; s.x.vaults['base:ETH'] += 1_000_000_000;
	const f = L.xFloor(s, s.time).perDzy / 1e6, b0 = L.balanceOf(s, W.address); await m.buy(W, 60); const got = (L.balanceOf(s, W.address) - b0) / DZY;
	assert.ok(got > 0 && got <= 60 / (1.25 * f) + 0.001, `${got} DZY for $60, with $${f} behind each`);
	s.x.pot.BTC = 5; // a coin nobody reads a price for
	const b1 = L.balanceOf(s, W.address); await m.buy(W, 60); assert.equal(L.balanceOf(s, W.address), b1, 'sold with a backing nobody can value');
	assert.ok(L.balanceOf(s, W.address, 'xETH') > 0, 'the coin did not stay the buyer\'s own');
});
await test('Exactly 1% of what is taken out stays behind', async () => {
	const m = await market(), s = m.s; await m.price(); await send(s, Y, 'x.park', { on: true }); await m.buy(Y, 3_000);
	s.x.pot = { ETH: 100_000_000 }; s.x.vaults['base:ETH'] += 100_000_000;
	const f = L.xFloor(s, s.time), n = dzy(300), gross = Number(BigInt(n) * f.usd * 1_000_000_000n / (f.hands * 3_000_000_000n)), x0 = L.balanceOf(s, F.address, 'xETH');
	await send(s, F, 'x.floor', { coin: 'ETH', dzy: n }); const got = L.balanceOf(s, F.address, 'xETH') - x0; assert.equal(got, gross - Math.ceil(gross / 100));
});
await test('The biggest block is what four fifths of the say can take: three quarters declaring more is not enough', async () => {
	const s = await founded(100, [F, W], 3_000); await send(s, W, 'stake.bond', { amount: dzy(2_000) }); await minutes(s, 6);
	await send(s, F, 'node.checkin', { seen: [s.height, s.last], url: 'https://f.example', big: 8_000_000 }); await check(s, W); await minutes(s, 11);
	assert.ok(say(s, W) > 0); assert.equal(s.heart.can, 1_400_000);
	await send(s, W, 'node.checkin', { seen: [s.height, s.last], url: 'https://w.example', big: 5_000_000 }); await minutes(s, 11); assert.equal(s.heart.can, 5_000_000);
});
await test('Taking DZY out of the backing honestly: 1% stays, so what stands behind everyone else\'s DZY rises', async () => {
	const m = await market(), s = m.s; await m.price(); await send(s, Y, 'x.park', { on: true }); await m.buy(Y, 3_000);
	s.x.pot = { ETH: 100_000_000 }; s.x.vaults['base:ETH'] += 100_000_000;
	const f0 = L.xFloor(s, s.time); await send(s, F, 'x.floor', { coin: 'ETH', dzy: dzy(300) }); const f1 = L.xFloor(s, s.time);
	assert.ok(Number(f1.usd) / Number(f1.hands) > Number(f0.usd) / Number(f0.hands)); whole(s, 'exit');
	await refused(s, F, 'x.floor', { coin: 'ETH', dzy: dzy(2_000) }, /5% of the ETH/);
	for (let d = 0; d < 73; d++) { await minutes(s, 20); await check(s, F); } await m.price(); await send(s, F, 'x.floor', { coin: 'ETH', dzy: dzy(300) }); // the next day
});
await test('Blocks by weight: the limit grows an eighth after a full block, shrinks after a quiet one, never past what four fifths of the say declared', async () => {
	const s = await founded(100, [F, W], 3_000); const h = s.heart; h.size = 1_400_000;
	H.sizeAfter(s, 1_000_000); assert.equal(h.size, 1_400_000, 'grew past what the validators said they take');
	await minutes(s, 6); await send(s, F, 'node.checkin', { seen: [s.height, s.last], url: 'https://f.example', big: 8_000_000 }); await minutes(s, 11); assert.equal(h.can, 8_000_000);
	const z0 = h.size; H.sizeAfter(s, z0); assert.equal(h.size, z0 + Math.floor(z0 / 8)); for (let i = 0; i < 60; i++) H.sizeAfter(s, h.size); assert.equal(h.size, 8_000_000);
	for (let i = 0; i < 60; i++) H.sizeAfter(s, 0); assert.equal(h.size, 250_000);
	await minutes(s, 6); await refused(s, F, 'node.checkin', { seen: [s.height, s.last], url: 'https://f.example', big: 99_000_000 }, /biggest block/);
});
await test('Baggage: an action pays one fee for every 1,000 characters; small ones pay as before; the fee rises while blocks are full', async () => {
	const s = await founded(100, [F, U1], 3_000), fee = s.fee, of = (type, data) => L.feeFor(s, { from: U1.address, type, data }) / fee;
	assert.equal(of('transfer', { asset: 'DZY', to: U1.address, amount: 5 }), 1); assert.equal(of('transfer', { asset: 'DZY', to: W.address, amount: 5 }), 10, 'the first to pay an account pays for its place');
	assert.equal(of('record.put', { v: 'x'.repeat(900) }), 1); assert.equal(of('layer.prove', { v: 'x'.repeat(4_300) }), 5); assert.equal(of('layer.prove', { v: 'x'.repeat(9_500) }), 10);
	const many = Array.from({ length: 100 }, (_, i) => [CROWD[i].address, 10]); assert.equal(of('transfer.many', { asset: 'DZY', to: many }), Math.max(5, H.sizeFees(JSON.stringify({ asset: 'DZY', to: many }).length)) + 9 * 100, 'a hundred new accounts');
	s.fee = 100_000; const full = s.heart.size; await L.sunBlock(s, s.time, 10, F.address, full); assert.ok(s.fee > 100_000); const up = s.fee; await L.sunBlock(s, s.time, 10, F.address, 10); assert.ok(s.fee < up);
});
await test('A block of heavy contract calls is limited by their gas: it takes a moment to check, not many seconds', async () => {
	const { fits } = await import('./src/block.ts'); const s = await founded();
	const calls = (s.heart.size = 1_400_000, Array.from({ length: 2_000 }, (_, i) => ({ chain: s.chain, from: U1.address, nonce: i, type: 'contract.call', data: { contract: 'a'.repeat(64), fn: 'f', gas: 200_000 }, sig: 'f'.repeat(128) })));
	const n = fits(calls, 5_000, H.roomOf(s)); assert.equal(n, Math.floor(1_400_000 * 6 / 200_000)); return `${n} calls of the most gas, not 2,000`;
});
await test('A place among the block makers costs a little more for each one there, all of it a stake; who joined keeps their price; checking stays 1 DZY', async () => {
	const who = CROWD.slice(0, 60), s = await founded(100, [F, W, X, ...who], [2_000, 100, 100, ...who.map(() => 50)]);
	const p1 = H.seatEntry(s, W.address); assert.equal(p1, Math.floor(dzy(1) * 51 * 51 / 2500));
	await send(s, W, 'stake.bond', { amount: p1 }); await check(s, W);
	for (const k of who) { await send(s, k, 'stake.bond', { amount: dzy(10) }); await check(s, k); }
	const p62 = H.seatEntry(s, X.address); assert.equal(p62, Math.floor(dzy(1) * 112 * 112 / 2500));
	await send(s, X, 'stake.bond', { amount: dzy(1) }); await refused(s, X, 'node.checkin', { seen: [s.height, s.last], url: 'https://x.example' }, /takes 5\.0176 DZY/);
	await send(s, X, 'node.checkin', { seen: [s.height, s.last] }); // checks, for 1 DZY
	await minutes(s, 6); await check(s, W); assert.equal(s.nodes[W.address].seat, p1, 'the price went up for someone already there');
	whole(s, 'places'); return `1st after the founder ${p1 / DZY} DZY, 62nd ${p62 / DZY} DZY`;
});
await test('A whole market for real: 3 people, 200 random buys, closes, swaps to the floor and payments, hour after hour: every DZY and every coin accounted for', async () => {
	let seed = 5; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 8) % n; };
	const m = await market([8_400, 60, 60, 60]), s = m.s, P = [W, X, Y]; let done = 0;
	const coin = (w) => { const held = Object.values(s.x?.vaults ?? {}).reduce((a, b) => a + b, 0), owed = (s.assets.xETH?.supply ?? 0) + Object.values(L.locksOfX(s) ?? {}).reduce((a, b) => a + b, 0) + (s.x?.pot?.ETH ?? 0) + (H.heartCoin(s).ETH ?? 0); assert.equal(held, owed, w); };
	for (let i = 0; i < 200; i++) {
		const k = P[rnd(3)];
		try {
			switch (rnd(6)) {
				case 0: case 1: await m.buy(k, 5 + rnd(2_000)); break;
				case 2: await m.close(k); break;
				case 3: await m.price(); await send(s, k, 'x.floor', { coin: 'ETH', dzy: 1 + rnd(dzy(50)) }); break;
				case 4: await send(s, k, 'transfer', { asset: 'DZY', to: P[rnd(3)].address, amount: 1 + rnd(1e8) }); break;
				case 5: await minutes(s, 1 + rnd(30)); if (s.time - s.nodes[F.address].at > 400_000) await check(s, F); break;
			}
			done++;
		} catch { /* refused: fine */ }
		whole(s, 'market ' + i); coin('market ' + i);
	}
	assert.ok(done > 100); return `${done} done; price $${m.spot().toFixed(4)}`;
});
const bad = results.filter(([r]) => r === 'FAIL').length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
