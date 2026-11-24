// Business offers (ledger.ts BIZ), written as attacks: off until their block; an offer is bought again and again, with a
// short note; an appointment or a reservation is booked for an open slot only (its day, its hours, on the step, not past,
// not too far ahead), never past its seats; a badly made offer is refused when it is written; and nothing else changes
// for an ordinary item. Run: node biz.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, [V, A, B, C] = await Promise.all([0, 0, 0, 0].map(() => newKey())); let chains = 0;
const T0 = Date.UTC(2027, 0, 4, 6, 0); // a Monday, 06:00 UTC
async function fresh({ on = 2 } = {}) {
	const n = 'dznye-biz-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); L.testExchangeVaults(n, { base: '0x' + '11'.repeat(20) }); L.testCheckoutV2From(n, 1); if (on !== null) L.testBizFrom(n, on);
	const s = await L.sunGenesis({ chain: n, time: T0, validators: [V.address], seedWait: 0, sales: [V, A, B, C].map((k) => ({ to: k.address, units: 5_000 * DZY, paid: 50 * DZY, proof: 't' })) });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1; return s;
}
const send = async (s, k, type, data = {}) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, t, s.time, V.address); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s), t = s.time; await assert.rejects(() => send(s, k, type, data), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused action changed something'); };
const whole = (s) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) if (!id.startsWith('x')) assert.equal(h[id] ?? 0, a.supply, id); };
// Mondays to Fridays, 09:00 to 17:00 in UTC+2 (tz 120), hour-long slots, 2 seats
const HOURS = { days: [1, 2, 3, 4, 5], from: 540, to: 1020, step: 60, seats: 2, tz: 120 };
const at = (day, hh, mm = 0) => Date.UTC(2027, 0, 4 + day, hh - 2, mm); // day 0 = Monday the 4th; hh in the business's own time
const put = async (s, value, key = 'offer') => { if (!s.creators?.[A.address]) await send(s, A, 'creator.join', {}); return send(s, A, 'record.put', { space: 'items', key, value }); };
const buy = (s, k, more = {}, key = 'offer') => send(s, k, 'item.buy', { seller: A.address, item: key, asset: 'DZY', max: 1_000 * DZY, ...more });

await test('off before its block: no note, no time, and a repeat purchase is still refused', async () => {
	const s = await fresh({ on: 1_000 }); await put(s, { title: 'Coffee', usd: 3_000_000, biz: 'order' });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY, note: 'oat milk' }, /not expected/);
	await buy(s, B); await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY }, /already own/);
	assert.equal(L.bizFrom('dznye-mainnet'), 11_100);
});
await test('an order is bought again and again, with a note, and the business sees each one, newest last', async () => {
	const s = await fresh(); await put(s, { title: 'Coffee', usd: 3_000_000, biz: 'order' });
	await buy(s, B, { note: 'Oat milk, table 4' }); await buy(s, B); await buy(s, C, { note: 'To go' });
	assert.deepEqual(s.biz[A.address].map((e) => [e.by === B.address ? 'B' : 'C', e.note ?? '']), [['B', 'Oat milk, table 4'], ['B', ''], ['C', 'To go']]);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY, note: 'x'.repeat(141) }, /at most 140/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY, at: at(0, 10) }, /not something booked/);
	whole(s);
});
await test('a booking: only an open slot (its day, its hours, on the step, not past, not too far), never past its seats', async () => {
	const s = await fresh(); await put(s, { title: 'Haircut', usd: 20_000_000, biz: 'book', book: HOURS });
	await refused(s, B, 'order.open', { seller: A.address, item: 'offer', net: 'base', coin: 'USDC' }, /booked with a coin/); // no time could go with it
	await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY }, /choose a time/);
	for (const [when, why] of [[at(5, 10), /closed that day/], [at(1, 8), /open times/], [at(1, 16, 30), /open times/], [at(1, 17), /open times/], [at(1, 10) + 1, /whole minutes/], [T0 - 60_000, /passed/], [T0 + 200 * 86_400_000, /too far/]])
		await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY, at: when }, why);
	await buy(s, B, { at: at(0, 10), note: 'Short on the sides' }); await buy(s, C, { at: at(0, 10) });
	await refused(s, B, 'item.buy', { seller: A.address, item: 'offer', asset: 'DZY', max: 1_000 * DZY, at: at(0, 10) }, /full/);
	await buy(s, B, { at: at(0, 16) }); // the last slot of the day: 16:00 to 17:00
	assert.equal(s.slots[`${A.address}/offer/${at(0, 10)}`], 2); assert.equal(s.biz[A.address].length, 3); assert.equal(s.biz[A.address][0].at, at(0, 10));
	whole(s);
});
await test('a badly made offer is refused when it is written; an ordinary item is as it was', async () => {
	const s = await fresh();
	for (const [value, why] of [[{ title: 'X', usd: 1_000_000, biz: 'spa' }, /biz: one of/], [{ title: 'X', usd: 1_000_000, biz: 'book' }, /book:/], [{ title: 'X', usd: 1_000_000, biz: 'order', book: HOURS }, /book:/],
		[{ title: 'X', usd: 1_000_000, biz: 'table', book: { ...HOURS, days: [7] } }, /book:/], [{ title: 'X', usd: 1_000_000, biz: 'table', book: { ...HOURS, to: 500 } }, /book:/], [{ title: 'X', usd: 1_000_000, biz: 'order', every: 'month' }, /only a pass/]]) {
		if (!s.creators?.[A.address]) await send(s, A, 'creator.join', {});
		await refused(s, A, 'record.put', { space: 'items', key: 'bad', value }, why);
	}
	await put(s, { title: 'Gym', usd: 30_000_000, biz: 'pass', every: 'month' }, 'gym'); await put(s, { title: 'Song', usd: 1_000_000 }, 'song');
	await buy(s, B, {}, 'song'); await refused(s, B, 'item.buy', { seller: A.address, item: 'song', asset: 'DZY', max: 1_000 * DZY }, /already own/);
	await refused(s, B, 'item.buy', { seller: A.address, item: 'song', asset: 'DZY', max: 1_000 * DZY, note: 'hi' }, /business offer's note/);
	whole(s);
});
console.log(`\n${pass} business tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
