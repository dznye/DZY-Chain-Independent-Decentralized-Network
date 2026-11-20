// Up or Down: price rounds on BTC, ETH and SOL, an hour or a day long, written as attacks. A bet is on the NEXT round:
// betting closes when it starts. Its start and end prices are the chain's own agreed prices (x.price), marked within 10
// minutes of each moment by anyone (the validators' nodes do it by themselves). Winners split the losers' DZY in
// proportion to their stakes, less 2% to the Sun; nobody puts up house money. A round with a missing price, a tie, or
// nobody on one side gives everyone their stake back. Nothing is created or lost. Run: node chain/rounds.test.mjs
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import * as L from './src/ledger.ts';

const results = [];
async function test(name, fn) {
	try { const note = await fn(); results.push(['PASS', name, note ?? '']); }
	catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, 4).join(' | ')]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}`);
}
const DZY = 100_000_000, SUPPLY = 12_000_000 * DZY, HOUR = 3_600_000, DAY = 24 * HOUR, dzy = (n) => Math.round(n * DZY);
function key(i) {
	const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), createHash('sha256').update(`dznye rounds test key ${i}`).digest()]);
	const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
	return { address: Buffer.from(pub, 'base64url').toString('hex'), secret: der.toString('hex') };
}
const K = Array.from({ length: 8 }, (_, i) => key(i));
const VS = K.slice(0, 4), [A, B, C, D] = K.slice(4);
const CHAIN = 'dznye-rounds-test', T0 = 1_800_000_000_000; // a whole hour
const fresh = async () => {
	const s = await L.sunGenesis({ chain: CHAIN, time: T0, validators: VS.map((v) => v.address), seedWait: 0,
		sales: [...[A, B, C, D].map((k) => ({ to: k.address, units: dzy(1_000), paid: dzy(1_000) / 500, proof: 'test' })), ...VS.map((v) => ({ to: v.address, units: dzy(10), paid: dzy(10) / 500, proof: 'test: fees' }))] });
	L.testExchangeFrom(CHAIN, s.height + 1);
	return s;
};
const apply = async (s, k, type, data) => L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, VS[0].address, undefined);
const at = async (s, time, k, type, data = {}) => { s.time = time; s.height += 1; return apply(s, k, type, data); };
const refused = async (s, time, k, type, data, why) => { s.time = time; const before = JSON.stringify(s); await assert.rejects(() => apply(s, k, type, data), why); assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const bal = (s, k) => L.balanceOf(s, k.address, 'DZY');
const prices = async (s, time, p) => { for (const v of VS) await at(s, time, v, 'x.price', { p }); };
const sound = (s, where) => { const h = L.holdings(s); assert.equal(h.DZY, SUPPLY, `${where}: DZY created or destroyed`); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); };
const R = (coin, period, start) => ({ coin, period, start });

await test('a round: bets close at its start; start and end prices marked from the chain\'s own; winners split the losers\' DZY, less 2% to the Sun', async () => {
	const s = await fresh(), start = T0 + HOUR, fee = (n) => Math.ceil((n * L.RULES.roundFeeBps) / 10_000);
	await prices(s, T0 + 10 * 60_000, { BTC: 90_000_000_000 });
	await at(s, T0 + 20 * 60_000, A, 'round.bet', { coin: 'BTC', period: HOUR, side: 'up', amount: dzy(30) });
	await at(s, T0 + 21 * 60_000, B, 'round.bet', { coin: 'BTC', period: HOUR, side: 'up', amount: dzy(10) });
	await at(s, T0 + 22 * 60_000, C, 'round.bet', { coin: 'BTC', period: HOUR, side: 'down', amount: dzy(60) });
	const r = s.rounds[`BTC:${HOUR}:${start}`];
	assert.deepEqual([r.up, r.down], [dzy(40), dzy(60)]);
	await refused(s, T0 + 30 * 60_000, A, 'round.mark', R('BTC', HOUR, start), /not now/); // too early
	await at(s, start + 60_000, D, 'round.mark', R('BTC', HOUR, start)); // anyone may mark
	assert.equal(r.open, 90_000_000_000);
	await at(s, start + 2 * 60_000, D, 'round.bet', { coin: 'BTC', period: HOUR, side: 'down', amount: dzy(5) });
	assert.equal(r.down, dzy(60), 'a bet after the start went into a running round');
	await refused(s, start + 30 * 60_000, A, 'round.claim', R('BTC', HOUR, start), /not over/);
	await prices(s, start + HOUR - 60_000, { BTC: 91_000_000_000 }); // BTC up
	await at(s, start + HOUR + 60_000, D, 'round.mark', R('BTC', HOUR, start));
	assert.equal(r.close, 91_000_000_000);
	const sun0 = s.treasury ?? 0, a0 = bal(s, A), b0 = bal(s, B);
	await at(s, start + HOUR + 2 * 60_000, A, 'round.claim', R('BTC', HOUR, start));
	await at(s, start + HOUR + 3 * 60_000, B, 'round.claim', R('BTC', HOUR, start));
	const ga = Math.floor((dzy(30) * dzy(100)) / dzy(40)), gb = Math.floor((dzy(10) * dzy(100)) / dzy(40));
	assert.equal(bal(s, A) - a0 + (s.fee ?? 0), ga - fee(ga), 'A was not paid 3/4 of the pool less 2%');
	assert.equal(bal(s, B) - b0 + (s.fee ?? 0), gb - fee(gb), 'B was not paid 1/4 of the pool less 2%');
	await refused(s, start + HOUR + 4 * 60_000, C, 'round.claim', R('BTC', HOUR, start), /no round|nothing to collect/); // C lost (and the round is done)
	assert.equal(s.rounds?.[`BTC:${HOUR}:${start}`], undefined, 'a finished round was kept');
	assert.ok((s.treasury ?? 0) - sun0 >= fee(ga) + fee(gb), 'the Sun did not get 2%');
	sound(s, 'flow');
	return `up won: A put 30 and got ${((ga - fee(ga)) / DZY).toFixed(2)} DZY, B put 10 and got ${((gb - fee(gb)) / DZY).toFixed(2)}`;
});

await test('nobody can collect twice, collect a lost bet, mark twice, or mark outside the 10 minutes after a start or end', async () => {
	const s = await fresh(), start = T0 + HOUR;
	await prices(s, T0 + 60_000, { ETH: 3_000_000_000 });
	await at(s, T0 + 2 * 60_000, A, 'round.bet', { coin: 'ETH', period: HOUR, side: 'up', amount: dzy(10) });
	await at(s, T0 + 3 * 60_000, B, 'round.bet', { coin: 'ETH', period: HOUR, side: 'down', amount: dzy(10) });
	await refused(s, start + 11 * 60_000, A, 'round.mark', R('ETH', HOUR, start), /not now/); // the start was missed: 11 minutes late
	await at(s, start + HOUR + 60_000, A, 'round.claim', R('ETH', HOUR, start)); // no start price: everyone's stake back
	await refused(s, start + HOUR + 2 * 60_000, A, 'round.claim', R('ETH', HOUR, start), /nothing to collect/);
	await at(s, start + HOUR + 3 * 60_000, B, 'round.claim', R('ETH', HOUR, start));
	assert.equal(s.rounds?.[`ETH:${HOUR}:${start}`], undefined);
	// a second round, marked properly; marking twice is refused
	const s2 = start + HOUR;
	await at(s, s2 - 30 * 60_000, A, 'round.bet', { coin: 'ETH', period: HOUR, side: 'up', amount: dzy(10) });
	await at(s, s2 - 29 * 60_000, B, 'round.bet', { coin: 'ETH', period: HOUR, side: 'down', amount: dzy(10) });
	await prices(s, s2 - 60_000, { ETH: 3_000_000_000 });
	await at(s, s2 + 60_000, C, 'round.mark', R('ETH', HOUR, s2));
	await refused(s, s2 + 2 * 60_000, C, 'round.mark', R('ETH', HOUR, s2), /not now/);
	await prices(s, s2 + HOUR - 60_000, { ETH: 2_900_000_000 }); // down
	await at(s, s2 + HOUR + 60_000, C, 'round.mark', R('ETH', HOUR, s2));
	await refused(s, s2 + HOUR + 2 * 60_000, A, 'round.claim', R('ETH', HOUR, s2), /lost/);
	await at(s, s2 + HOUR + 3 * 60_000, B, 'round.claim', R('ETH', HOUR, s2));
	sound(s, 'twice');
});

await test('a tie, or nobody on one side, gives everyone their stake back (no fee); bad bets are refused', async () => {
	const s = await fresh(), start = (Math.floor(T0 / DAY) + 1) * DAY; // the next day boundary
	await prices(s, T0 + 60_000, { SOL: 150_000_000 });
	await at(s, T0 + 2 * 60_000, A, 'round.bet', { coin: 'SOL', period: DAY, side: 'up', amount: dzy(7) });
	await at(s, T0 + 3 * 60_000, B, 'round.bet', { coin: 'SOL', period: DAY, side: 'down', amount: dzy(3) });
	await prices(s, start - 60_000, { SOL: 150_000_000 });
	await at(s, start + 60_000, C, 'round.mark', R('SOL', DAY, start));
	await prices(s, start + DAY - 60_000, { SOL: 150_000_000 }); // the same price: a tie
	await at(s, start + DAY + 60_000, C, 'round.mark', R('SOL', DAY, start));
	const a0 = bal(s, A);
	await at(s, start + DAY + 2 * 60_000, A, 'round.claim', R('SOL', DAY, start));
	assert.equal(bal(s, A) - a0 + (s.fee ?? 0), dzy(7), 'a tie did not give the stake back');
	// one side empty
	const s1 = start + DAY * 2;
	await at(s, s1 - HOUR, C, 'round.bet', { coin: 'SOL', period: DAY, side: 'up', amount: dzy(5) });
	await prices(s, s1 - 60_000, { SOL: 150_000_000 }); await at(s, s1 + 60_000, D, 'round.mark', R('SOL', DAY, s1));
	await prices(s, s1 + DAY - 60_000, { SOL: 160_000_000 }); await at(s, s1 + DAY + 60_000, D, 'round.mark', R('SOL', DAY, s1));
	const c0 = bal(s, C);
	await at(s, s1 + DAY + 2 * 60_000, C, 'round.claim', R('SOL', DAY, s1));
	assert.equal(bal(s, C) - c0 + (s.fee ?? 0), dzy(5), 'with nobody on the other side, the stake did not come back whole');
	for (const [d, why] of [[{ coin: 'DOGE', period: HOUR, side: 'up', amount: DZY }, /BTC, ETH or SOL/], [{ coin: 'BTC', period: 60_000, side: 'up', amount: DZY }, /an hour or a day/], [{ coin: 'BTC', period: HOUR, side: 'sideways', amount: DZY }, /up or down/], [{ coin: 'BTC', period: HOUR, side: 'up', amount: 1 }, /at least/], [{ coin: 'BTC', period: HOUR, side: 'up', amount: dzy(5_000) }, /not enough/]])
		await refused(s, s1 + DAY * 3, A, 'round.bet', d, why);
	sound(s, 'void');
});

await test('400 random bets, marks, price moves and collections on three coins and two lengths: nothing created or lost, and no round pays out more than went in', async () => {
	const s = await fresh();
	let seed = 21; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); };
	const people = [A, B, C, D], coins = ['BTC', 'ETH', 'SOL'], P = { BTC: 90_000_000_000, ETH: 3_000_000_000, SOL: 150_000_000 };
	let t = T0, ok = 0, no = 0, paid = 0;
	await prices(s, t + 1000, P);
	for (let i = 0; i < 400; i++) {
		t += 1000 + rnd(9) * 60_000;
		const k = people[rnd(4)], coin = coins[rnd(3)], period = rnd(4) ? HOUR : DAY, r = rnd(10);
		const keys = Object.keys(s.rounds ?? {}), pick = keys[rnd(keys.length)], [pc, pp, ps] = (pick ?? 'BTC:0:0').split(':');
		try {
			if (r < 4) await at(s, t, k, 'round.bet', { coin, period, side: rnd(2) ? 'up' : 'down', amount: L.RULES.roundMin + rnd(dzy(20)) });
			else if (r < 5) { for (const c of coins) P[c] = Math.max(1, Math.round(P[c] * (0.97 + rnd(7) / 100))); await prices(s, t, P); }
			else if (r < 7) await at(s, t, k, 'round.mark', R(pc, Number(pp), Number(ps)));
			else { const before = s.rounds?.[pick]?.left ?? 0; await at(s, t, k, 'round.claim', R(pc, Number(pp), Number(ps))); paid++; assert.ok((s.rounds?.[pick]?.left ?? 0) <= before, 'a claim added to a round'); }
			ok++;
		} catch (e) { if (e instanceof assert.AssertionError) throw e; no++; }
		for (const [id, rd] of Object.entries(s.rounds ?? {})) assert.ok(rd.left >= 0 && rd.left <= rd.up + rd.down, `step ${i}: round ${id} owes more than it holds`);
		sound(s, `step ${i}`);
	}
	return `${ok} went through (${paid} collections), ${no} refused; ${Object.keys(s.rounds ?? {}).length} rounds open`;
});

L.testExchangeFrom(CHAIN, null);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
