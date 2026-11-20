// Volunteer nodes on a chain with the Sun: a node lists one only while a staked account vouches for it. Volunteers
// earn nothing; the stake (at least 1% of a seat) makes a fake one costly, and taking the stake out takes it off the list.
// Run: node chain/node/volunteer.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { newKey, sign } from '../src/crypto.ts';
import { signTx, volunteerMessage } from '../src/ledger.ts';
import { startNode } from './server.mjs';

const V = await newKey(), A = await newKey(), B = await newKey();
const CHAIN = 'dznye-volunteer-test', DZY = 100_000_000;
const sun = { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [
	{ to: A.address, units: 500 * DZY, paid: 100 * DZY, proof: 'test' },
	{ to: B.address, units: 500 * DZY, paid: 100 * DZY, proof: 'test' },
] };
const get = async (n, p) => (await fetch(n.url + p)).json();
const post = async (n, p, body) => { const r = await fetch(n.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const send = async (n, who, type, data) => post(n, '/tx', { tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) });
const settle = async (n) => { for (let i = 0; i < 200; i++) { if ((await get(n, '/')).waiting === 0) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('the node never made a block'); };
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const open = [];
/** a volunteer node following the main one, at a known address, vouched for as given */
async function volunteer(main, vouch) {
	const port = await freePort(), url = `http://127.0.0.1:${port}`;
	const operator = vouch ? await vouch(url) : undefined;
	const n = await startNode({ port, follow: main.url, followMs: 0, publicUrl: url, allowLocalPeers: true, operator });
	open.push(n); await n.sync();
	return n;
}
try {
	const main = await startNode({ port: 0, sun, validator: V, blockMs: 40, allowLocalPeers: true }); open.push(main);
	const say = (url) => post(main, '/peers', { url });
	const signed = (who, as = who) => async (url) => ({ address: as.address, sig: await sign(who.secret, volunteerMessage(CHAIN, url)) });

	await test('a volunteer with no staked account behind it is not listed', async () => {
		const n = await volunteer(main);
		assert.match((await say(n.url)).error, /no staked account vouching/);
		assert.ok(!(await get(main, '/peers')).peers.includes(n.url));
	});
	await test('a vouch signed by someone else is refused', async () => {
		const n = await volunteer(main, signed(B, A)); // B signs, claiming to be A
		assert.match((await say(n.url)).error, /not signed for that address/);
	});
	let good;
	await test('a vouching account with no stake is refused; with 1% of a seat staked the volunteer is listed', async () => {
		good = await volunteer(main, signed(A));
		assert.match((await say(good.url)).error, /1% of a seat staked/);
		const seat = (await get(main, '/validators')).seatPrice, part = Math.ceil(seat / 100);
		assert.equal((await send(main, A, 'stake.bond', { amount: part })).ok, true); await settle(main);
		assert.equal((await say(good.url)).ok, true);
		assert.ok((await get(main, '/peers')).peers.includes(good.url));
		return `staked ${(part / DZY).toFixed(2)} DZY (1% of a ${(seat / DZY).toFixed(2)} DZY seat); it earns nothing for it`;
	});
	await test('taking the stake out takes the volunteer off the list', async () => {
		const bond = (await get(main, '/account/' + A.address)).stake.bond;
		assert.equal((await send(main, A, 'stake.unbond', { amount: bond })).ok, true); await settle(main);
		assert.ok(!(await get(main, '/peers')).peers.includes(good.url));
	});
	await test("a validator's node vouches for itself: a volunteer lists it with no stake of its own", async () => {
		const port = await freePort(), url = `http://127.0.0.1:${port}`;
		const lead = await startNode({ port, sun, validator: V, blockMs: 40, publicUrl: url, allowLocalPeers: true }); open.push(lead);
		assert.equal((await get(lead, '/')).operator.address, V.address);
		assert.equal(await good.core.addPeer(url), '');
		assert.ok(good.core.peers().includes(url));
	});
	console.log(`\n${pass} tests passed`);
} finally {
	for (const n of open.reverse()) await n.stop().catch(() => {});
}
