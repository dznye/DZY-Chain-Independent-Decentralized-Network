// The Heart upgrade on real nodes on this computer, talking over HTTP: the two attacks that worked before it (found 22 Nov
// 2026: 50 DZY going offline stopped the chain, 201 DZY took it), lying and dead peers, private addresses, and how long a
// payment takes to be final among several validators. Run: node node/heart.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { newKey } from '../src/crypto.ts';
import { RULES, signTx, testCrewFrom } from '../src/ledger.ts';
import { testHeartFrom } from '../src/heart.ts';
import { privateHost } from '../src/node.ts';
import { startNode } from './server.mjs';

RULES.crewEveryMs = 2_000; // TEST: a new draw every 2 seconds instead of every 10 minutes
const DZY = 100_000_000, wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = async (n, p) => (await fetch(n.url + p)).json();
const timeouts = { propose: 600, vote: 300, grow: 200, gossip: 300, sync: 400 };
let pass = 0;
const test = async (name, fn) => { const t = Date.now(); const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : '', `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const until = async (what, cond, ms = 100_000) => { const end = Date.now() + ms; for (;;) { if (await cond().catch(() => false)) return; if (Date.now() > end) throw new Error('timed out waiting for: ' + what); await wait(100); } };
let made = 0, clashes = 0;
/** a founder's node (100 DZY staked, 1,000 locked) and others' (each with its stake), all in the first crew of the Heart rules */
async function network(stakes, extraPeers = [], founderStake = 100) {
	const CHAIN = `dznye-heart-net-${++made}`; testCrewFrom(CHAIN, 1);
	const founder = await newKey(), others = await Promise.all(stakes.map(() => newKey())), user = await newKey(), all = [founder, ...others, user];
	testHeartFrom(CHAIN, 3, [founder.address]); // from block 3, by the Heart rules: the founder stakes first, as on the live chain
	const sun = { chain: CHAIN, time: Date.now(), validators: [founder.address], seedWait: 0, sales: all.map((k) => ({ to: k.address, units: 2_000 * DZY, paid: 400_000_000, proof: 'test' })) };
	const boot = async (key, peers) => { const port = await freePort(), url = `http://127.0.0.1:${port}`; return startNode({ port, sun, validator: key, blockMs: 100, timeouts, publicUrl: url, allowLocalPeers: true, peers: [...peers, ...extraPeers], watchMs: 300 }); };
	const once = async (n, who, type, data) => { const r = await fetch(n.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) }) }); return { status: r.status, ...(await r.json()) }; };
	// a validator's own node signs its check-ins with the same key: if one lands between asking for the next number and using it, ask again (only for that)
	const send = async (n, who, type, data) => { for (let i = 0; ; i++) { const r = await once(n, who, type, data); if (i >= 4 || !/nonce must be/.test(r.error ?? '')) return r; clashes++; await wait(50); } };
	const a = await boot(founder, []), rest = [];
	for (const k of others) rest.push(await boot(k, [a.url]));
	a.net.peers.push(...rest.map((n) => n.url));
	{ const r = await send(a, founder, 'stake.bond', { amount: founderStake * DZY }); assert.equal(r.ok, true, 'stake ' + JSON.stringify(r)); }
	await until('block 1', async () => (await get(a, '/')).height >= 1);
	{ const r = await send(a, founder, 'lock', { amount: 1_000 * DZY, years: 1 }); assert.equal(r.ok, true, 'lock ' + JSON.stringify(r)); }
	await until('the upgrade started', async () => (await get(a, '/heart')).on === true);
	for (const [i, k] of others.entries()) if (stakes[i]) { const r = await send(a, k, 'stake.bond', { amount: stakes[i] * DZY }); assert.equal(r.ok, true, JSON.stringify(r)); }
	await until('the others checked in', async () => { const { nodes } = await get(a, '/nodes'); return others.every((k, i) => !stakes[i] || Object.hasOwn(nodes, k.address)); });
	const nudge = async () => { await send(a, user, 'transfer', { asset: 'DZY', to: founder.address, amount: 5 }); return (await get(a, '/')).validators.length === 1 + stakes.filter(Boolean).length; };
	await until('everyone is in the crew', async () => { await wait(500); return nudge(); }, 60_000).catch(async (e) => { console.log(JSON.stringify(await get(a, '/heart')).slice(0, 1500), JSON.stringify((await get(a, '/nodes'))).slice(0, 600), (await get(a, '/')).validators.length); throw e; });
	return { CHAIN, a, rest, founder, others, user, send, stop: async () => { for (const n of [a, ...rest]) await n.stop(); } };
}
const goesThrough = async (net, node, from, to, ms) => { const had = (await get(node, '/account/' + to.address)).balances.DZY ?? 0; const r = await net.send(node, from, 'transfer', { asset: 'DZY', to: to.address, amount: DZY }); assert.equal(r.ok, true, JSON.stringify(r)); const t = Date.now(); while (Date.now() - t < ms) { if (((await get(node, '/account/' + to.address)).balances.DZY ?? 0) > had) return Date.now() - t; await wait(50); } return null; };

await test('The 50 DZY attack: a newcomer joins and goes offline. Before, the chain stopped; now the payment goes through', async () => {
	const net = await network([50]);
	const p = await get(net.a, '/validators');
	await net.rest[0].stop();
	const ms = await goesThrough(net, net.a, net.user, net.founder, 40_000);
	assert.notEqual(ms, null, 'the chain stopped'); await net.stop();
	return `founder ${p.power[net.founder.address]}, newcomer ${p.power[net.others[0].address]}, needed ${p.neededPower}; final after ${(ms / 1000).toFixed(1)}s`;
});
await test('The 201 DZY attack: a newcomer with twice the founder\'s stake, the founder offline. Before, it made blocks alone; now it cannot', async () => {
	const net = await network([201]);
	const p = await get(net.a, '/validators');
	await net.a.stop();
	const ms = await goesThrough(net, net.rest[0], net.user, net.others[0], 15_000);
	assert.equal(ms, null, 'the newcomer made a block alone'); await net.stop();
	return `its say: ${p.power[net.others[0].address]} of ${p.totalPower}, needed ${p.neededPower}`;
});
await test('Nine newcomers with 1,900 DZY each (170 times the founder\'s stake): they go offline all at once, and the chain goes on', async () => {
	const net = await network(Array(9).fill(1_900));
	const p = await get(net.a, '/validators'), theirs = net.others.reduce((n, k) => n + (p.power[k.address] ?? 0), 0);
	for (const n of net.rest) await n.stop();
	const ms = await goesThrough(net, net.a, net.user, net.founder, 60_000);
	assert.notEqual(ms, null, 'the chain stopped'); await net.stop();
	return `together ${(theirs / p.totalPower * 100).toFixed(1)}% of the say; final after ${(ms / 1000).toFixed(1)}s`;
});
await test('Dead peers, and peers that lie about their height or send made-up blocks: a node that was away still catches up', async () => {
	const lies = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url.startsWith('/blocks') ? { blocks: [{ height: 2, prev: 'x', txs: [], commit: { round: 0, sigs: [] } }] } : { height: 999_999, last: 'f'.repeat(64) })); });
	await new Promise((ok) => lies.listen(0, '127.0.0.1', ok));
	const dead = `http://127.0.0.1:${await freePort()}`, liar = `http://127.0.0.1:${lies.address().port}`;
	const net = await network([10, 0], [liar, dead, liar + '/b', dead + '/c']);
	for (let i = 0; i < 12; i++) await goesThrough(net, net.a, net.user, net.founder, 20_000);
	const want = (await get(net.a, '/')).height;
	await until('the standby node has every block', async () => (await get(net.rest[1], '/')).height >= want, 40_000);
	const h = (await get(net.rest[1], '/')).height, x = await get(net.a, '/block/' + want), y = await get(net.rest[1], '/block/' + want);
	assert.equal(x.stateRoot, y.stateRoot); await net.stop(); lies.close();
	return `${h} blocks, four bad peers among its six`;
});
await test('An address inside a private network is never called, whatever a validator writes on the chain', async () => {
	for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '172.16.0.9', '100.64.0.1', '0.0.0.0', '[::1]', '[fd00::1]', '[fe80::1]', 'router.local', 'db.internal', '2130706433', '0x7f000001', 'x.localhost']) assert.ok(privateHost(h), h);
	for (const h of ['chain.dznye.com', '8.8.8.8', '172.15.0.1', '100.128.0.1', 'local.example', 'lan.example.org']) assert.ok(!privateHost(h), h);
});
await test('Crowds and floods: reading is limited per address; a crowd of addresses cannot wipe another\'s count', async () => {
	const net = await network([]);
	const core = net.a.core, ask = (ip) => core.handle({ method: 'GET', path: '/', query: new URLSearchParams(), body: '', auth: '', ip });
	let refused = 0; for (let i = 0; i < 1_300; i++) if ((await ask('9.9.9.9')).status === 429) refused++;
	assert.equal(refused, 100);
	for (let i = 0; i < 8_000; i++) await ask('5.5.' + (i >> 8) + '.' + (i & 255));
	assert.equal((await ask('9.9.9.9')).status, 429, 'a crowd wiped the count'); assert.equal((await ask('local')).status, 200);
	await net.stop();
});
await test('How long until a payment is final, with several validators (all on this one computer: no internet in between)', async () => {
	const out = [];
	for (const n of [1, 4, 7]) {
		const net = await network(Array(n - 1).fill(20)), times = [];
		for (let i = 0; i < 15; i++) { const ms = await goesThrough(net, net.a, net.user, net.founder, 30_000); if (ms !== null) times.push(ms); }
		times.sort((x, y) => x - y); out.push(`${n} validator${n > 1 ? 's' : ''}: ${times[Math.floor(times.length / 2)]} ms (worst ${times.at(-1)} ms)`); await net.stop();
	}
	return out.join('; ');
});
console.log(`\n${pass} tests passed${clashes ? ` (${clashes} number clashes with a node's own check-in, asked again)` : ''}`);
process.exit(0);
