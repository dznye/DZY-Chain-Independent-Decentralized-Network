// The crew upgrade on a real network on this computer: a founder's node and five operators' nodes, talking over HTTP.
// The operators stake, their nodes check in by themselves (with their address), the starting validator hands over once
// four or more are online, the crew makes the blocks, every node finds the crew from the chain, and the chain carries
// on when one operator's node is switched off. Run: node chain/node/crew.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { newKey } from '../src/crypto.ts';
import { signTx, testCrewFrom } from '../src/ledger.ts';
import { startNode } from './server.mjs';

const CHAIN = 'dznye-crew-net-test', DZY = 100_000_000;
testCrewFrom(CHAIN, 1);
const founder = await newKey(), ops = await Promise.all(Array.from({ length: 5 }, () => newKey())), user = await newKey();
const sun = { chain: CHAIN, time: Date.now(), validators: [founder.address], seedWait: 0,
	sales: [...ops, user].map((k) => ({ to: k.address, units: 1_000 * DZY, paid: 200_000_000, proof: 'test' })) };
const timeouts = { propose: 600, vote: 300, grow: 200, gossip: 300, sync: 400 };
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = async (n, p) => (await fetch(n.url + p)).json();
const send = async (n, who, type, data) => {
	const r = await fetch(n.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) }) });
	return { status: r.status, ...(await r.json()) };
};
const until = async (what, cond, ms = 40_000) => { const end = Date.now() + ms; for (;;) { if (await cond().catch(() => false)) return; if (Date.now() > end) throw new Error('timed out waiting for: ' + what); await new Promise((r) => setTimeout(r, 300)); } };

let pass = 0;
const test = async (name, fn) => { const t = Date.now(); const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : '', `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const open = [];
const boot = async (key, peers) => {
	const port = await freePort(), url = `http://127.0.0.1:${port}`;
	const n = await startNode({ port, sun, validator: key, blockMs: 100, timeouts, publicUrl: url, allowLocalPeers: true, peers, watchMs: 300 });
	open.push(n); return n;
};
try {
	const lead = await boot(founder, []);
	const nodes = [];
	for (const k of ops) nodes.push(await boot(k, [lead.url]));
	lead.net.peers.push(...nodes.map((n) => n.url));

	await test('the founder\'s node starts alone; the operators\' nodes wait on standby, copying its blocks', async () => {
		assert.deepEqual((await get(lead, '/')).validators, [founder.address]);
		assert.equal((await send(lead, user, 'transfer', { asset: 'DZY', to: ops[0].address, amount: DZY })).ok, true);
		await until('every node has block 1', async () => (await Promise.all(nodes.map((n) => get(n, '/')))).every((i) => i.height >= 1));
	});
	await test('the operators stake 10 DZY each; their nodes check in by themselves, with their own address', async () => {
		for (const k of ops) assert.equal((await send(lead, k, 'stake.bond', { amount: 10 * DZY })).ok, true);
		await until('five nodes checked in', async () => { const s = await get(lead, '/validators'); return Object.keys((await get(lead, '/nodes').catch(() => ({}))).nodes ?? {}).length >= 5 || s.validators.length >= 4; }, 60_000);
	});
	await test('with four or more online, the starting validator hands over: the crew is the operators, and it makes the blocks', async () => {
		// a crew is drawn once a period from the operators online then: 4 or 5, depending on whether the last check-in landed
		// in the same block as the fourth (both are right; it is kept for the rest of the 10-minute period)
		await until('the crew takes over', async () => { const v = (await get(lead, '/')).validators; return v.length >= 4 && !v.includes(founder.address); }, 60_000);
		const crew = (await get(lead, '/')).validators, before = (await get(lead, '/')).height, had = (await get(lead, '/account/' + ops[1].address)).balances.DZY;
		assert.equal((await send(lead, user, 'transfer', { asset: 'DZY', to: ops[1].address, amount: DZY })).ok, true); // sent to a node not in the crew: it passes it on
		// blocks are made when there is work: this payment makes one (the old check, two blocks, held only when a check-in happened to add another)
		await until('the payment, in a block by the crew', async () => (await get(lead, '/account/' + ops[1].address)).balances.DZY === had + DZY);
		const h = (await get(lead, '/')).height, b = await get(lead, '/block/' + h);
		assert.ok(h > before);
		assert.ok(b.commit.sigs.length > (2 * crew.length) / 3 && b.commit.sigs.every((s) => crew.includes(s.validator)), 'not signed by more than two thirds of the crew');
		return `block ${b.height} signed by ${b.commit.sigs.length} of the crew of ${crew.length} operators`;
	});
	await test('one operator\'s node is switched off: the other four carry on, and every node agrees', async () => {
		await nodes[4].stop(); open.splice(open.indexOf(nodes[4]), 1);
		const before = (await get(lead, '/')).height;
		assert.equal((await send(nodes[0], user, 'transfer', { asset: 'DZY', to: ops[2].address, amount: DZY })).ok, true);
		await until('the payment, in a block made without it', async () => (await get(nodes[0], '/account/' + ops[2].address)).balances.DZY > 990.9 * DZY, 60_000).catch(async (e) => { console.log('debug', JSON.stringify(await Promise.all([lead, ...nodes.slice(0, 4)].map(async (n) => { const i = await get(n, '/'); return { h: i.height, role: i.role, v: i.validators.length, waiting: i.waiting, bal: (await get(n, '/account/' + ops[2].address)).balances.DZY }; })))); throw e; }); // 1,000 bought, 10 staked, a few fees, +1
		assert.ok((await get(nodes[0], '/')).height > before);
		const infos = await Promise.all([lead, ...nodes.slice(0, 4)].map((n) => get(n, '/')));
		const h = Math.min(...infos.map((i) => i.height));
		const hashes = new Set(await Promise.all([lead, ...nodes.slice(0, 4)].map(async (n) => (await get(n, '/block/' + h)).stateRoot)));
		assert.equal(hashes.size, 1, 'the nodes disagree');
		return `all at block ${h} or later, one history`;
	});
	console.log(`\n${pass} tests passed`);
} finally {
	for (const n of open.reverse()) await n.stop().catch(() => {});
	testCrewFrom(CHAIN, null);
}
