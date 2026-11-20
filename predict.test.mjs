// Prediction markets, written as attacks. Anyone asks a yes/no question with a closing time (it costs 1 DZY, to the Sun).
// Before it closes, 1 DZY makes 1 YES and 1 NO (and a YES and a NO always make 1 DZY back), so every share is fully backed;
// YES and NO trade on the order book like any token. After it closes, validators with more than two thirds of the say
// settle it: YES, NO, or VOID (each share then worth half). The winning shares pay 1 DZY each, less 1% to the Sun
// (validators and holders) and 0.5% to the market's maker. Nobody can make shares without paying, settle early, settle
// twice, or take out more DZY than went in; nothing is created or lost. Run: node chain/predict.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import { applyTx, balanceOf, DZY, genesis, holdings, nonceOf, RULES, signTx } from './src/ledger.ts';

const CHAIN = 'dznye-predict-test', T0 = 1_000_000, HOUR = 3_600_000;
const auth = await newKey(), maker = await newKey(), yes = await newKey(), no = await newKey(), eve = await newKey(), v2 = await newKey(), v3 = await newKey(), v4 = await newKey();
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const send = async (s, who, type, data, time = T0) => applyTx(s, await tx(s, who, type, data), time);
const refuses = async (s, who, type, data, why, time = T0) => { const before = canon(s); await assert.rejects(applyTx(s, await tx(s, who, type, data), time), why); assert.equal(canon(s), before, 'a refused transaction must change nothing'); };
const balanced = (s, where = '') => { const h = holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); assert.equal(s.assets.DZY.supply, s.assets.DZY.minted, 'DZY destroyed'); };
/** every market's DZY covers its shares: what it holds is at least the larger of YES and NO outstanding (before it settles) */
const backed = (s, where = '') => { for (const [id, m] of Object.entries(s.markets ?? {})) if (!m.outcome) assert.ok(m.pool >= Math.max(s.assets[id + 'Y'].supply, s.assets[id + 'N'].supply), `${where}: market ${id} holds ${m.pool} for ${s.assets[id + 'Y'].supply} YES / ${s.assets[id + 'N'].supply} NO`); };
const bal = (s, k, a = 'DZY') => balanceOf(s, k.address, a);
async function fresh(validators = [auth.address]) {
	const s = await genesis(CHAIN, auth.address, T0, validators);
	for (const who of [maker, yes, no, eve]) await send(s, auth, 'mint', { asset: 'DZY', amount: 1_000 * DZY, to: who.address });
	return s;
}
const ask = (extra = {}) => ({ question: 'Will BTC close above $100,000 on 2027-01-01?', until: T0 + 24 * HOUR, ...extra });
const mk = (id) => 'p' + id.slice(0, 16);

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };

await test('ask, make shares, trade them, settle, collect: the winner gets 1 DZY a share less 1.5% (1% to the Sun, 0.5% to the maker)', async () => {
	const s = await fresh();
	const sun0 = s.treasury ?? 0;
	const id = mk(await send(s, maker, 'market.create', ask()));
	assert.equal((s.treasury ?? 0) - sun0, RULES.marketFee, 'asking did not cost 1 DZY to the Sun');
	await send(s, yes, 'market.mint', { id, amount: 100 * DZY });
	assert.deepEqual([bal(s, yes, id + 'Y'), bal(s, yes, id + 'N')], [100 * DZY, 100 * DZY]);
	// yes sells its NO shares to no at 0.40 DZY each, on the order book
	await send(s, yes, 'offer.create', { give: { asset: id + 'N', amount: 100 * DZY }, want: { asset: 'DZY', amount: 40 * DZY } });
	await send(s, no, 'offer.take', { id: Object.keys(s.offers).at(-1) });
	assert.equal(bal(s, no, id + 'N'), 100 * DZY);
	await refuses(s, auth, 'market.settle', { id, outcome: 'YES' }, /still open/);
	await refuses(s, yes, 'market.redeem', { id }, /not settled/);
	await refuses(s, yes, 'market.mint', { id, amount: DZY }, /closed/, T0 + 25 * HOUR);
	await refuses(s, maker, 'market.settle', { id, outcome: 'YES' }, /only validators/, T0 + 25 * HOUR);
	await refuses(s, auth, 'market.settle', { id, outcome: 'MAYBE' }, /YES, NO or VOID/, T0 + 25 * HOUR);
	await send(s, auth, 'market.settle', { id, outcome: 'YES' }, T0 + 25 * HOUR);
	await refuses(s, auth, 'market.settle', { id, outcome: 'NO' }, /already settled/, T0 + 26 * HOUR);
	const y0 = bal(s, yes), m0 = bal(s, maker), sun1 = s.treasury ?? 0;
	await send(s, yes, 'market.redeem', { id }, T0 + 26 * HOUR);
	const sunCut = Math.ceil(100 * DZY * RULES.marketSunBps / 10_000), makerCut = Math.ceil(100 * DZY * RULES.marketMakerBps / 10_000);
	assert.equal(bal(s, yes) - y0 + (s.fee ?? 0), 100 * DZY - sunCut - makerCut, 'the winner was not paid 1 DZY a share less 1.5%');
	assert.equal((s.treasury ?? 0) - sun1 - (s.fee ?? 0), sunCut, 'the Sun did not get 1%');
	assert.equal(bal(s, maker) - m0, makerCut, 'the maker did not get 0.5%');
	assert.equal(bal(s, yes, id + 'Y'), 0);
	await refuses(s, no, 'market.redeem', { id }, /no winning shares/, T0 + 26 * HOUR); // NO lost
	balanced(s, 'flow');
	return `yes paid 60 DZY net for 100 YES and collected ${(100 * DZY - sunCut - makerCut) / DZY} DZY; the Sun ${sunCut / DZY}, the maker ${makerCut / DZY}`;
});

await test('a YES and a NO always make 1 DZY back before settling; shares can never be made without paying', async () => {
	const s = await fresh();
	const id = mk(await send(s, maker, 'market.create', ask()));
	await send(s, yes, 'market.mint', { id, amount: 50 * DZY });
	const y0 = bal(s, yes);
	await send(s, yes, 'market.merge', { id, amount: 20 * DZY });
	assert.equal(bal(s, yes) - y0 + (s.fee ?? 0), 20 * DZY, 'a pair did not make 1 DZY back');
	await refuses(s, yes, 'market.merge', { id, amount: 31 * DZY }, /hold less/);
	await refuses(s, eve, 'market.mint', { id, amount: 2_000 * DZY }, /not enough/);
	await refuses(s, eve, 'mint', { asset: id + 'Y', amount: 1, to: eve.address }, /./);
	backed(s, 'merge'); balanced(s, 'merge');
});

await test('VOID: each share is worth half; and with four validators one cannot settle alone', async () => {
	const s = await fresh([auth.address, v2.address, v3.address, v4.address]);
	const id = mk(await send(s, maker, 'market.create', ask()));
	await send(s, yes, 'market.mint', { id, amount: 10 * DZY });
	await send(s, yes, 'transfer', { asset: id + 'N', to: no.address, amount: 10 * DZY });
	const late = T0 + 25 * HOUR;
	await send(s, auth, 'market.settle', { id, outcome: 'VOID' }, late);
	await send(s, v2, 'market.settle', { id, outcome: 'VOID' }, late);
	assert.ok(!s.markets[id].outcome, 'two of four settled it');
	await refuses(s, v2, 'market.settle', { id, outcome: 'VOID' }, /already voted/, late);
	await send(s, v3, 'market.settle', { id, outcome: 'VOID' }, late);
	assert.equal(s.markets[id].outcome, 'VOID');
	const n0 = bal(s, no);
	await send(s, no, 'market.redeem', { id }, late);
	const gross = 5 * DZY, cut = Math.ceil(gross * RULES.marketSunBps / 10_000) + Math.ceil(gross * RULES.marketMakerBps / 10_000);
	assert.equal(bal(s, no) - n0 + (s.fee ?? 0), gross - cut, 'a VOID share was not worth half');
	balanced(s, 'void');
});

await test('bad questions are refused: no text, too long, closing in the past or more than a year away', async () => {
	const s = await fresh();
	await refuses(s, maker, 'market.create', ask({ question: '' }), /question/);
	await refuses(s, maker, 'market.create', ask({ question: 'x'.repeat(301) }), /question/);
	await refuses(s, maker, 'market.create', ask({ until: T0 - 1 }), /future/);
	await refuses(s, maker, 'market.create', ask({ until: T0 + 400 * 24 * HOUR }), /within a year/);
	await refuses(s, maker, 'market.mint', { id: 'p' + '0'.repeat(16), amount: 1 }, /no such market/);
});

await test('300 random markets, shares, trades, merges, settlements and collections: every market stays backed, and nothing is created or lost', async () => {
	const s = await fresh();
	let seed = 3; const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return Math.floor((seed / 2 ** 31) * m); };
	const people = [maker, yes, no, eve];
	let t = T0, ok = 0, refused = 0, settled = 0;
	for (let i = 0; i < 300; i++) {
		t += rnd(3) * HOUR;
		const k = people[rnd(4)], ids = Object.keys(s.markets ?? {}), id = ids[rnd(ids.length)], r = rnd(10);
		try {
			if (r < 1 || !ids.length) await send(s, k, 'market.create', ask({ until: t + (1 + rnd(48)) * HOUR }), t);
			else if (r < 4) await send(s, k, 'market.mint', { id, amount: 1 + rnd(50 * DZY) }, t);
			else if (r < 5) await send(s, k, 'market.merge', { id, amount: 1 + rnd(Math.max(1, Math.min(bal(s, k, id + 'Y'), bal(s, k, id + 'N')))) }, t);
			else if (r < 6) await send(s, k, 'transfer', { asset: id + (rnd(2) ? 'Y' : 'N'), to: people[rnd(4)].address, amount: 1 + rnd(Math.max(1, bal(s, k, id + 'Y'))) }, t);
			else if (r < 7) { await send(s, auth, 'market.settle', { id, outcome: ['YES', 'NO', 'VOID'][rnd(3)] }, t); settled++; }
			else await send(s, k, 'market.redeem', { id }, t);
			ok++;
		} catch (e) { if (e instanceof assert.AssertionError) throw e; refused++; }
		backed(s, `step ${i}`); balanced(s, `step ${i}`);
	}
	return `${ok} went through (${settled} settlements), ${refused} refused; ${Object.keys(s.markets ?? {}).length} markets`;
});

console.log(`\n${pass} tests passed`);
