// A shop's 40 free days (ledger.ts JOIN_TRIAL), written as attacks: before its block a shop owes its $5 at once, as before;
// from it, sales in the first 40 days are the creator's in full (less the creators' fee); from day 40 the $5 is taken from
// the next sale; and it can be paid early in any coin the chain prices, once, to the fee account. Run: node jointrial.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, DAY = 86_400_000, [V, A, B] = await Promise.all([0, 0, 0].map(() => newKey())); let chains = 0;
async function fresh({ on = 2 } = {}) {
	const n = 'dznye-trial-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); L.testCheckoutV2From(n, 1); if (on !== null) L.testJoinTrialFrom(n, on);
	const s = await L.sunGenesis({ chain: n, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [V, A, B].map((k) => ({ to: k.address, units: 5_000 * DZY, paid: 50 * DZY, proof: 't' })) });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1; return s;
}
const send = async (s, k, type, data = {}) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, t, s.time, V.address); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s), t = s.time; await assert.rejects(() => send(s, k, type, data), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused action changed something'); };
const whole = (s) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) if (!id.startsWith('x')) assert.equal(h[id] ?? 0, a.supply, id); };
const bal = (s, k) => L.balanceOf(s, k.address, 'DZY'), FOUNDER = L.RULES.saleFeeTo;
const sell = async (s, key) => { await send(s, A, 'record.put', { space: 'items', key, value: { title: key, usd: 20_000_000 } }); const a0 = bal(s, A); await send(s, B, 'item.buy', { seller: A.address, item: key, asset: 'DZY', max: 1_000 * DZY }); return bal(s, A) - a0; };

await test('before its block: the $5 is owed at once and taken from the first sale, as before', async () => {
	const s = await fresh({ on: 1_000 }); await send(s, A, 'creator.join', {});
	assert.equal(L.feeOwedOf(s, A.address), L.CREATOR_JOIN_USD); assert.equal(s.joinDue, undefined);
	await sell(s, 'one'); assert.equal(L.feeOwedOf(s, A.address), 0, 'taken from the first sale');
});
await test('the first 40 days are free: sales are the creator\'s in full; from day 40 the $5 comes from the next sale', async () => {
	const s = await fresh(); await send(s, A, 'creator.join', {});
	assert.equal(L.feeOwedOf(s, A.address), 0); assert.equal(L.joinDueAt(s, A.address), 0); assert.ok(s.joinDue[A.address] > s.time);
	const early = await sell(s, 'early'); // inside the free days
	s.time += 41 * DAY; assert.equal(L.joinDueAt(s, A.address), L.CREATOR_JOIN_USD, 'due now');
	const late = await sell(s, 'late');
	assert.ok(late < early, 'the $5 came out of the sale after day 40'); assert.equal(s.joinDue, undefined); assert.equal(L.feeOwedOf(s, A.address), 0);
	const again = await sell(s, 'again'); assert.equal(again, early, 'and only once'); whole(s);
});
await test('paid early, in any coin the chain prices, to the founder\'s account; then nothing more is owed', async () => {
	const s = await fresh(); await send(s, A, 'creator.join', {}); const f0 = L.balanceOf(s, FOUNDER, 'DZY');
	await refused(s, A, 'fee.pay', { asset: 'DZY', max: 1 }, /price changed/);
	await send(s, A, 'fee.pay', { asset: 'DZY', max: 1_000 * DZY });
	assert.ok(L.balanceOf(s, FOUNDER, 'DZY') > f0, 'the founder\'s account was paid'); assert.equal(s.joinDue, undefined);
	await refused(s, A, 'fee.pay', { asset: 'DZY', max: 1_000 * DZY }, /owes nothing/);
	s.time += 41 * DAY; const full = await sell(s, 'after'); s.time += 1; const again = await sell(s, 'after2'); assert.equal(full, again, 'never taken twice'); whole(s);
});
console.log(`\n${pass} free-days tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
