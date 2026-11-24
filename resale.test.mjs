// Resale of numbered editions (resale.list / cancel / buy), written as attacks. The price is all a buyer pays; the fee comes
// out of it: 70% of it to the creator, 30% to the fee account (@dzy). Every refused transaction must leave the state
// exactly as it was, and no coin may be made or lost. Run: node chain/resale.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import { fork, commit } from './src/layer.ts';
import { stateRootOf as stateRoot } from './src/root.ts';

const [V, A, B, C, E] = await Promise.all([newKey(), newKey(), newKey(), newKey(), newKey()]);
const CHAIN = 'dznye-resale-test', T0 = 1_800_000_000_000, DZY = 100_000_000, OWNER = L.RULES.saleFeeTo;
const fresh = async () => L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0, sales: [A, B, C, E].map((k) => ({ to: k.address, units: 1_000 * DZY, paid: 200 * DZY, proof: 'test' })) });
const tx = async (s, k, type, data) => L.signTx(k.secret, { chain: CHAIN, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data });
const send = async (s, k, type, data) => L.applyTx(s, await tx(s, k, type, data), s.time, V.address);
async function refused(s, k, type, data, why) {
	const before = canon(s), t = await tx(s, k, type, data);
	await assert.rejects(() => L.applyTx(s, t, s.time, V.address), why, `accepted: ${type} ${JSON.stringify(data).slice(0, 120)}`);
	assert.equal(canon(s), before, 'a refused transaction changed the state');
}
const whole = (s, where) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); };
const bal = (s, k) => L.balanceOf(s, typeof k === 'string' ? k : k.address);
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const USD = 5_000_000;
/** A sells `n` editions of "art"; B buys #1 */
async function sold(extra = {}, n = 3) {
	const s = await fresh();
	await send(s, A, 'record.put', { space: 'items', key: 'art', value: { title: 'Art', kind: 'nft', usd: USD, editions: n, ...extra } });
	await send(s, B, 'item.buy', { seller: A.address, item: 'art', asset: 'DZY', max: 900 * DZY });
	return s;
}
const it = { seller: A.address, item: 'art' }, list = (usd = 8_000_000, bps = 200) => ({ ...it, usd, bps });
const buy = (usd = 8_000_000, more = {}) => ({ owner: B.address, ...it, asset: 'DZY', usd, max: 900 * DZY, ...more });

await test('a resale: the buyer pays the price and nothing more; 98% to the owner, 1.4% to the creator, 0.6% to @dzy', async () => {
	const s = await sold(); await send(s, B, 'resale.list', list());
	const [a0, b0, c0, o0] = [A, B, C, OWNER].map((k) => bal(s, k)), pay = L.usdCost(s, 'DZY', 8_000_000), fee = Math.floor(pay * 200 / 10_000), creator = Math.floor(fee * 70 / 100);
	await send(s, C, 'resale.buy', buy());
	assert.equal(c0 - bal(s, C), pay + s.fee, 'the buyer paid something else');
	assert.equal(bal(s, B) - b0, pay - fee); assert.equal(bal(s, A) - a0, creator); assert.equal(bal(s, OWNER) - o0, fee - creator);
	assert.equal(s.owned[`${C.address}/${A.address}/art`].ed, 1, 'the edition number moves with it'); assert.ok(!s.owned[`${B.address}/${A.address}/art`], 'the old owner keeps nothing');
	assert.equal(s.listings, undefined); assert.deepEqual(s.resales[`${A.address}/art`], { n: 1, usd: 8_000_000, last: 8_000_000, at: s.time });
	assert.equal(s.sales[`${A.address}/art`].n, 1, 'a resale is not a new edition'); whole(s, 'a resale');
	return `70% / 30% of a 2% fee`;
});
await test('the fee is the creator\'s to set, 1% to 10%; anything else is the 2% everyone gets', () => {
	for (const [v, want] of [[undefined, 200], [100, 100], [500, 500], [99, 200], [1_000, 1_000], [1_001, 200], [0, 200], [-1, 200], [2.5, 200], ['300', 200], [null, 200], [1e9, 200]]) assert.equal(L.resaleBps({ resale: v }), want, String(v));
	for (const pay of [1, 49, 50, 99, 101, 12_345, 1_000_000_007, 9_000_000_000_000_000]) for (const bps of [100, 200, 333, 500, 700, 1_000]) { const x = L.resaleSplit(pay, bps); assert.equal(x.owner + x.creator + x.founder, pay); assert.ok(x.owner >= 0 && x.creator >= 0 && x.founder >= 0); }
});
await test('at 5%: 3.5% to the creator, 1.5% to @dzy', async () => {
	const s = await sold({ resale: 500 }); await send(s, B, 'resale.list', list(10_000_000, 500));
	const a0 = bal(s, A), o0 = bal(s, OWNER), pay = L.usdCost(s, 'DZY', 10_000_000); await send(s, C, 'resale.buy', buy(10_000_000));
	assert.ok(Math.abs((bal(s, A) - a0) / pay - 0.035) < 1e-6); assert.ok(Math.abs((bal(s, OWNER) - o0) / pay - 0.015) < 1e-6); whole(s, '5%');
});
await test('at 7%: 4.9% and 2.1%; at 10%: 7% to the creator, 3% to @dzy, 90% to the owner', async () => {
	for (const [bps, c, f] of [[700, 0.049, 0.021], [1_000, 0.07, 0.03]]) {
		const s = await sold({ resale: bps }); await send(s, B, 'resale.list', list(10_000_000, bps)); const a0 = bal(s, A), o0 = bal(s, OWNER), b0 = bal(s, B), t0 = s.treasury, pay = L.usdCost(s, 'DZY', 10_000_000); await send(s, C, 'resale.buy', buy(10_000_000));
		assert.ok(Math.abs((bal(s, A) - a0) / pay - c) < 1e-6); assert.ok(Math.abs((bal(s, OWNER) - o0) / pay - f) < 1e-6); assert.ok(Math.abs((bal(s, B) - b0) / pay - (1 - bps / 10_000)) < 1e-6);
		assert.deepEqual(s.treasury, t0, 'none of it to the treasury'); whole(s, String(bps));
	}
});
await test('the fee is fixed when it is listed: a creator raising it later takes nothing more, and a stale fee is refused', async () => {
	const s = await sold(); await send(s, B, 'resale.list', list());
	await send(s, A, 'record.put', { space: 'items', key: 'art', value: { title: 'Art', kind: 'nft', usd: USD, editions: 3, resale: 500 } });
	assert.equal(s.listings[`${B.address}/${A.address}/art`].bps, 200);
	await refused(s, B, 'resale.list', list(), /fee changed/);
	const a0 = bal(s, A), pay = L.usdCost(s, 'DZY', 8_000_000); await send(s, C, 'resale.buy', buy()); assert.equal(bal(s, A) - a0, Math.floor(Math.floor(pay * 0.02) * 0.7));
});
await test('listing attacks: not yours, not numbered, too cheap, too dear, extra fields, a bad creator', async () => {
	const s = await sold();
	await refused(s, C, 'resale.list', list(), /do not own/);
	await refused(s, A, 'resale.list', list(), /do not own/);
	await refused(s, B, 'resale.list', list(99_999), /\$0.10/); await refused(s, B, 'resale.list', list(1e15), /\$0.10/);
	await refused(s, B, 'resale.list', { ...list(), free: 1 }, /not expected/); await refused(s, B, 'resale.list', { ...list(), seller: 'x' }, /bad creator/); await refused(s, B, 'resale.list', { ...list(), item: '__proto__/' }, /bad item/);
	await send(s, A, 'record.put', { space: 'items', key: 'file', value: { title: 'File', kind: 'file', usd: USD } });
	await send(s, B, 'item.buy', { seller: A.address, item: 'file', asset: 'DZY', max: 900 * DZY });
	await refused(s, B, 'resale.list', { ...list(), item: 'file' }, /numbered editions/);
});
await test('buying attacks: your own, a changed price, too low a max, nothing for sale, a second one, no money', async () => {
	const s = await sold(); await refused(s, C, 'resale.buy', buy(), /not for sale/);
	await send(s, B, 'resale.list', list());
	await refused(s, B, 'resale.buy', buy(), /your own/); await refused(s, C, 'resale.buy', buy(7_999_999), /price changed/); await refused(s, C, 'resale.buy', buy(8_000_000, { max: 1 }), /price changed/);
	await refused(s, C, 'resale.buy', buy(8_000_000, { asset: 'NOPE' }), /no price/); await refused(s, C, 'resale.buy', buy(8_000_000, { amount: 1 }), /not expected/); await refused(s, C, 'resale.buy', buy(8_000_000, { max: 0 }), /max/);
	await send(s, C, 'item.buy', { seller: A.address, item: 'art', asset: 'DZY', max: 900 * DZY });
	await refused(s, C, 'resale.buy', buy(), /already own/);
	await send(s, B, 'resale.list', list(900_000_000_000)); await refused(s, E, 'resale.buy', buy(900_000_000_000, { max: Number.MAX_SAFE_INTEGER }), /not enough|no price/);
});
await test('sold once: the same listing cannot be bought twice, and the old owner cannot list it again', async () => {
	const s = await sold(); await send(s, B, 'resale.list', list()); await send(s, C, 'resale.buy', buy());
	await refused(s, E, 'resale.buy', buy(), /not for sale/); await refused(s, B, 'resale.list', list(), /do not own/);
	await send(s, C, 'resale.list', list(9_000_000)); await send(s, B, 'resale.buy', { ...buy(9_000_000), owner: C.address }); assert.equal(s.resales[`${A.address}/art`].n, 2); whole(s, 'back and forth');
});
await test('taking it back, and moving what you own, end the offer', async () => {
	const s = await sold(); await send(s, B, 'resale.list', list()); await refused(s, C, 'resale.cancel', it, /do not offer/); await send(s, B, 'resale.cancel', it); assert.equal(s.listings, undefined); await refused(s, B, 'resale.cancel', it, /do not offer/);
	await send(s, B, 'resale.list', list()); await send(s, B, 'owned.move', { to: E.address }); assert.equal(s.listings, undefined); await refused(s, C, 'resale.buy', buy(), /not for sale/);
});
await test('an item deleted before the rule can still be resold, at the 2% everyone gets', async () => {
	const s = await sold({ resale: 500 }); delete s.records[`${A.address}/items/art`];
	await send(s, B, 'resale.list', list()); await send(s, C, 'resale.buy', buy()); whole(s, 'a deleted item');
});
await test('sold means locked: its maker cannot delete it, swap its content, picture or name, or make more of them', async () => {
	const base = { title: 'Art', kind: 'nft', usd: USD, editions: 3, cover: '/media/x', sealed: 'REAL' }, put = (value) => ({ space: 'items', key: 'art', value });
	const s = await sold({ cover: '/media/x', sealed: 'REAL' });
	await refused(s, A, 'record.delete', { space: 'items', key: 'art' }, /cannot be removed/);
	for (const [change, why] of [[{ sealed: 'JUNK' }, /content cannot change/], [{ cover: '/media/y' }, /picture cannot change/], [{ title: 'Other' }, /title cannot change/], [{ kind: 'file' }, /kind cannot change/], [{ every: 'month' }, /every cannot change/], [{ file: 'x' }, /file cannot change/], [{ editions: 1000 }, /not more/], [{ editions: 0 }, /not more/]]) await refused(s, A, 'record.put', put({ ...base, ...change }), why);
	const { sealed: _s, ...bare } = base; await refused(s, A, 'record.put', put(bare), /content cannot change/); const { editions: _e, ...open } = base; await refused(s, A, 'record.put', put(open), /not more/);
	await refused(s, A, 'record.put', { space: 'items', key: 'art', hash: 'a'.repeat(64) }, /cannot be removed/); await refused(s, A, 'record.put', put('x'), /cannot be removed/);
	for (const ok of [{ usd: 9e6 }, { off: true }, { about: 'new words' }, { resale: 700 }, { editions: 2 }, { editions: 1 }]) await send(s, A, 'record.put', put({ ...base, editions: s.records[`${A.address}/items/art`].value.editions, ...ok }));
	await refused(s, A, 'record.put', put({ ...base, editions: 3 }), /not more/); assert.equal(s.records[`${A.address}/items/art`].value.sealed, 'REAL');
});
await test('a capture record: free until sold, then fixed: not changed, deleted, or added afterwards', async () => {
	const c = (sha) => ({ space: 'capture', key: 'art', value: { sha, h: 1, b: 'x', at: 1 } }), s = await fresh(), v = { title: 'Art', kind: 'nft', usd: USD, editions: 3 };
	await send(s, A, 'record.put', c('a')); await send(s, A, 'record.put', c('b')); await send(s, A, 'record.put', { space: 'items', key: 'art', value: v }); await send(s, B, 'item.buy', { seller: A.address, item: 'art', asset: 'DZY', max: 900 * DZY });
	await refused(s, A, 'record.put', c('z'), /capture cannot change/); await refused(s, A, 'record.delete', { space: 'capture', key: 'art' }, /capture cannot change/); assert.equal(s.records[`${A.address}/capture/art`].value.sha, 'b');
	const t = await sold(); await refused(t, A, 'record.put', c('late'), /capture cannot change/); await send(t, E, 'record.put', c('mine'));
});
await test('a file costs by its size, once, to the Sun: nothing to @dzy, nothing for a price change, again for another file', async () => {
	const s = await fresh(), v = { title: 'Film', kind: 'video', usd: USD, file: 'a'.repeat(64), fs: 10_000_000 }, put = (x) => ({ space: 'items', key: 'film', value: x }), sun = () => L.holdings(s).DZY;
	const cost = async (x) => { const a0 = bal(s, A), o0 = bal(s, OWNER), h0 = sun(); await send(s, A, 'record.put', put(x)); assert.equal(bal(s, OWNER), o0); assert.equal(sun(), h0); return a0 - bal(s, A) - s.fee; };
	const words = (x) => L.recordFee('items', 'film', { value: x });
	assert.equal(L.fileFee(10_000_000), DZY / 10, '10 MB is 0.1 DZY'); assert.equal(L.fileFee(60_000_000), DZY * 0.6); assert.equal(L.fileFee(1), 1_000);
	assert.equal(await cost(v), words(v) + DZY / 10); assert.equal(await cost({ ...v, usd: 9e6 }), words({ ...v, usd: 9e6 })); const other = { ...v, file: 'b'.repeat(64), fs: 1_234_567 }; assert.equal(await cost(other), words(other) + 1_235_000); whole(s, 'files');
	for (const bad of [{ fs: 0 }, { fs: 60_000_001 }, { fs: -1 }, { fs: '5' }, { file: 'x' }, { fs: undefined }, { file: undefined }]) { const x = { ...v, ...bad }; for (const k of Object.keys(x)) if (x[k] === undefined) delete x[k]; await refused(s, A, 'record.put', put(x), /at most 60 MB/); }
	const poor = await newKey(); await send(s, A, 'transfer', { asset: 'DZY', to: poor.address, amount: DZY / 20 }); await refused(s, poor, 'record.put', put(v), /does not hold it/);
});
await test('nothing sold yet: its maker changes or deletes it freely; someone else\'s sales never lock it; other records are free', async () => {
	const s = await fresh(), v = { title: 'Art', kind: 'nft', usd: USD, editions: 1, sealed: 'a' };
	await send(s, A, 'record.put', { space: 'items', key: 'art', value: v }); await send(s, E, 'record.put', { space: 'items', key: 'art', value: v }); await send(s, B, 'item.buy', { seller: E.address, item: 'art', asset: 'DZY', max: 900 * DZY });
	await send(s, A, 'record.put', { space: 'items', key: 'art', value: { ...v, sealed: 'b', editions: 9 } }); await send(s, A, 'record.delete', { space: 'items', key: 'art' });
	await send(s, E, 'record.put', { space: 'page', key: 'art', value: { bio: 'x' } }); await send(s, E, 'record.delete', { space: 'page', key: 'art' });
});
await test('a membership may change what it gives, not that it is one, and it cannot be deleted', async () => {
	const s = await fresh(), v = { title: 'Club', kind: 'membership', usd: USD, every: 'month', sealed: 'link1' };
	await send(s, A, 'record.put', { space: 'items', key: 'club', value: v }); await send(s, B, 'item.buy', { seller: A.address, item: 'club', asset: 'DZY', max: 900 * DZY });
	await send(s, A, 'record.put', { space: 'items', key: 'club', value: { ...v, sealed: 'link2' } }); const { every: _x, ...once } = v; await refused(s, A, 'record.put', { space: 'items', key: 'club', value: once }, /every cannot change/); await refused(s, A, 'record.delete', { space: 'items', key: 'club' }, /cannot be removed/);
});
await test('the creator buying one back, and reselling it', async () => {
	const s = await sold(); await send(s, B, 'resale.list', list()); await send(s, A, 'resale.buy', buy()); await send(s, A, 'resale.list', list()); await send(s, C, 'resale.buy', { ...buy(), owner: A.address }); whole(s, 'a buy-back');
});
await test('what a creator owes is taken from their share, and never from the owner selling', async () => {
	L.testCheckoutV2From(CHAIN, 1);
	try {
		const s = await fresh(); await send(s, A, 'creator.join', {});
		await send(s, A, 'record.put', { space: 'items', key: 'art', value: { title: 'Art', kind: 'nft', usd: 1_000_000, editions: 3 } });
		await send(s, B, 'item.buy', { seller: A.address, item: 'art', asset: 'DZY', max: 900 * DZY });
		await send(s, B, 'resale.list', list()); const a0 = bal(s, A), b0 = bal(s, B), o0 = bal(s, OWNER), pay = L.usdCost(s, 'DZY', 8_000_000), fee = Math.floor(pay * 0.02), owed = s.feeOwed[A.address];
		assert.ok(owed > 0); await send(s, C, 'resale.buy', buy());
		assert.equal(bal(s, A) - a0, 0); assert.equal(bal(s, OWNER) - o0, fee); assert.equal(bal(s, B) - b0, pay - fee); assert.ok(s.feeOwed[A.address] < owed); whole(s, 'a debt');
	} finally { L.testCheckoutV2From(CHAIN, null); }
});
await test('before its block: refused, and nothing changes (and the old record rules hold); mainnet starts at 10,000', async () => {
	L.testResaleFrom(CHAIN, 1_000);
	try { const s = await sold(); await refused(s, B, 'resale.list', list(), /not open yet/); await send(s, A, 'record.delete', { space: 'items', key: 'art' }); } finally { L.testResaleFrom(CHAIN, null); }
	assert.equal(L.resaleFrom('dznye-mainnet'), 10_000); assert.equal(L.resaleOn({ chain: 'dznye-mainnet', height: 9_998 }), false); assert.equal(L.resaleOn({ chain: 'dznye-mainnet', height: 9_999 }), true);
});
await test('in a layer and committed, the fingerprint equals the one made from scratch', async () => {
	const s = await sold(), plain = structuredClone(s), l = fork(s);
	await send(l, B, 'resale.list', list()); await send(l, C, 'resale.buy', buy()); commit(l);
	await L.applyTx(plain, await tx(plain, B, 'resale.list', list()), plain.time, V.address); await L.applyTx(plain, await tx(plain, C, 'resale.buy', buy()), plain.time, V.address);
	assert.equal(canon(s), canon(plain)); assert.equal(await stateRoot(s), await stateRoot(plain));
});
console.log(`\n${pass} resale tests passed`);
