// Streams: pay by the minute (subscriptions, salaries, rent, AI compute), written as attacks. Run: node chain/streams.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';

const [V, A, B, C] = await Promise.all([newKey(), newKey(), newKey(), newKey()]);
const CHAIN = 'dznye-streams-test', T0 = 1_800_000_000_000, MIN = 60_000, DZY = 1_000_000;
const fresh = () => L.sunGenesis({ chain: CHAIN, time: T0, validators: [V.address], seedWait: 0, sales: [
	{ to: A.address, units: 1_000 * DZY, paid: 200 * DZY, proof: 'test' }, { to: B.address, units: 100 * DZY, paid: 20 * DZY, proof: 'test' }, { to: C.address, units: 10 * DZY, paid: 2 * DZY, proof: 'test' }] }); // C, a third party, holds a little (the Sun pays no fees for empty accounts)
const tx = async (s, k, type, data) => { const t = { chain: CHAIN, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }; try { return await L.signTx(k.secret, t); } catch { return { ...t, sig: '00'.repeat(64) }; } };
const send = async (s, k, type, data, at = s.time) => L.applyTx(s, await tx(s, k, type, data), at, V.address);
async function refused(s, k, type, data, why, at = s.time) {
	const before = canon(s), t = await tx(s, k, type, data);
	await assert.rejects(() => L.applyTx(s, t, at, V.address), why, `accepted: ${type} ${JSON.stringify(data)}`);
	assert.equal(canon(s), before, 'a refused transaction changed the state');
}
const bal = (s, k, asset = 'DZY') => L.balanceOf(s, k.address, asset);
const whole = (s, where) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${where}: supply of ${id}`); };
const sid = (s) => Object.keys(s.streams ?? {}).at(-1);
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };

await test('open a stream: the deposit leaves the payer and flows to the receiver at so much a minute, with nothing sent while it runs', async () => {
	const s = await fresh(), a0 = bal(s, A);
	await send(s, A, 'stream.open', { to: B.address, perMinute: 10_000, deposit: 10 * DZY, note: 'design work, by the minute' });
	const id = sid(s), st = s.streams[id];
	assert.ok(id.startsWith('s')); assert.equal(st.from, A.address); assert.equal(st.to, B.address); assert.equal(st.perMinute, 10_000);
	assert.ok(a0 - bal(s, A) >= 10 * DZY); whole(s, 'opened');
	assert.deepEqual(L.streamView(s, id, T0 + 30 * MIN + 59_000), { ...L.streamView(s, id, T0 + 30 * MIN), now: T0 + 30 * MIN + 59_000 }, 'part of a minute counted');
	assert.equal(L.streamView(s, id, T0 + 30 * MIN).owed, 300_000);
	return `0.01 DZY a minute; after 30 minutes 0.3 DZY is owed, with no transaction`;
});
await test('withdraw: the receiver collects what has flowed, whenever it likes; only the receiver can; a part minute waits', async () => {
	const s = await fresh();
	await send(s, A, 'stream.open', { to: B.address, perMinute: 10_000, deposit: 10 * DZY });
	const id = sid(s), b0 = bal(s, B);
	await refused(s, B, 'stream.withdraw', { id }, /nothing has flowed yet/, T0 + 59_000);
	await send(s, B, 'stream.withdraw', { id }, T0 + 30 * MIN + 59_000);
	assert.equal(bal(s, B) - b0, 300_000 - 1, 'withdrew the wrong amount'); // minus its own fee (one unit)
	await refused(s, C, 'stream.withdraw', { id }, /only its receiver/, T0 + 40 * MIN);
	await refused(s, A, 'stream.withdraw', { id }, /only its receiver/, T0 + 40 * MIN);
	await send(s, B, 'stream.withdraw', { id }, T0 + 90 * MIN);
	assert.equal(bal(s, B) - b0, 900_000 - 2, 'the second withdrawal is off');
	whole(s, 'after');
});
await test('stop: either side, at any time; the receiver gets what flowed, the payer the rest, to the unit', async () => {
	for (const who of [A, B]) {
		const s = await fresh();
		await send(s, A, 'stream.open', { to: B.address, perMinute: 10_000, deposit: 10 * DZY });
		const id = sid(s), a0 = bal(s, A), b0 = bal(s, B);
		await send(s, who, 'stream.stop', { id }, T0 + 100 * MIN + 30_000);
		const fee = 1;
		assert.equal(bal(s, B) - b0 + (who === B ? fee : 0), 1 * DZY, 'the receiver did not get 100 minutes');
		assert.equal(bal(s, A) - a0 + (who === A ? fee : 0), 9 * DZY, 'the payer did not get the rest');
		assert.equal(s.streams?.[id], undefined);
		await refused(s, A, 'stream.stop', { id }, /no such stream/, T0 + 101 * MIN);
		whole(s, 'stopped');
	}
	const s = await fresh();
	await send(s, A, 'stream.open', { to: B.address, perMinute: 10_000, deposit: 10 * DZY });
	await refused(s, C, 'stream.stop', { id: sid(s) }, /only its payer or receiver/);
});
await test('running dry: never more than the deposit flows; a top-up restarts it from now, with no back-pay for the dry time', async () => {
	const s = await fresh();
	await send(s, A, 'stream.open', { to: B.address, perMinute: 10_000, deposit: 1 * DZY }); // 100 minutes' worth
	const id = sid(s);
	assert.equal(L.streamView(s, id, T0 + 1_000 * MIN).owed, 1 * DZY, 'flowed past the deposit');
	await send(s, A, 'stream.topup', { id, amount: 2 * DZY }, T0 + 1_000 * MIN);
	assert.equal(L.streamView(s, id, T0 + 1_000 * MIN).owed, 1 * DZY);
	assert.equal(L.streamView(s, id, T0 + 1_050 * MIN).owed, 1 * DZY + 500_000, 'the dry time was back-paid, or the top-up did not flow');
	await refused(s, B, 'stream.topup', { id, amount: DZY }, /only its payer/, T0 + 1_050 * MIN);
	const b0 = bal(s, B);
	await send(s, B, 'stream.withdraw', { id }, T0 + 1_050 * MIN);
	assert.equal(bal(s, B) - b0, 1_500_000 - 1);
	await send(s, B, 'stream.withdraw', { id }, T0 + 5_000 * MIN); // the rest: 1.5 DZY, then it is finished
	assert.equal(bal(s, B) - b0, 3 * DZY - 2); assert.equal(s.streams?.[id], undefined, 'a finished stream was kept');
	whole(s, 'dry and topped up');
});
await test('any token can stream (credits, points, a game coin); bad streams are refused and leave no trace', async () => {
	const s = await fresh();
	await send(s, A, 'asset.create', { symbol: 'CRED', name: 'AI credits', decimals: 0, supply: 100_000, mintable: false });
	const cred = Object.keys(s.assets).find((k) => s.assets[k].symbol === 'CRED');
	await send(s, A, 'stream.open', { to: B.address, asset: cred, perMinute: 7, deposit: 700 });
	await send(s, B, 'stream.withdraw', { id: sid(s) }, T0 + 60 * MIN);
	assert.equal(bal(s, B, cred), 420); whole(s, 'a token stream');
	const bad = [{ to: B.address, perMinute: 0, deposit: DZY }, { to: B.address, perMinute: -1, deposit: DZY }, { to: B.address, perMinute: 1.5, deposit: DZY }, { to: B.address, perMinute: 10, deposit: 9 },
		{ to: A.address, perMinute: 10, deposit: 100 }, { to: 'nobody', perMinute: 10, deposit: 100 }, { to: B.address, perMinute: 10, deposit: 10_000 * DZY }, { to: B.address, perMinute: 10, deposit: 100, asset: 'NOPE' },
		{ to: B.address, perMinute: 10, deposit: 100, note: 'x'.repeat(200) }, { to: B.address, perMinute: 10, deposit: 100, extra: 1 }];
	for (const d of bad) await refused(s, A, 'stream.open', d);
	await refused(s, A, 'stream.withdraw', { id: 'snope' }, /no such stream/);
});
await test('limits and agreement: at most 100 open streams a payer; streams are part of the fingerprint every node checks', async () => {
	const s = await fresh();
	for (let i = 0; i < 100; i++) await send(s, A, 'stream.open', { to: B.address, perMinute: 1, deposit: 10 });
	await refused(s, A, 'stream.open', { to: B.address, perMinute: 1, deposit: 10 }, /100 open streams/);
	const x = await fresh(), y = await fresh();
	await send(x, A, 'stream.open', { to: B.address, perMinute: 1, deposit: 10 });
	await send(y, A, 'stream.open', { to: B.address, perMinute: 2, deposit: 10 });
	assert.notEqual(await L.stateRoot(x), await L.stateRoot(y), 'two different streams gave the same fingerprint');
	whole(s, 'a hundred streams');
});
console.log(`${pass} tests passed`);
