// Checkers on a real network on this computer: a founder's node, and a follower node run beside a product with a checker
// key (CHECKER_SECRET). The follower holds no validator key; once its key has 1 DZY staked, it checks in by itself,
// quoting a block it checked, and the chain counts the hour. It never becomes a block maker. Run: node chain/node/checker.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { newKey } from '../src/crypto.ts';
import { signTx, testCrewFrom } from '../src/ledger.ts';
import { startNode } from './server.mjs';

const CHAIN = 'dznye-checker-net-test', DZY = 100_000_000;
testCrewFrom(CHAIN, 1);
const founder = await newKey(), product = await newKey(), idle = await newKey();
const sun = { chain: CHAIN, time: Date.now(), validators: [founder.address], seedWait: 0,
	sales: [product, idle].map((k) => ({ to: k.address, units: 100 * DZY, paid: 20_000_000, proof: 'test' })) };
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const get = async (n, p) => (await fetch(n.url + p)).json();
const send = async (n, who, type, data) => {
	const r = await fetch(n.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) }) });
	return { status: r.status, ...(await r.json()) };
};
const until = async (what, cond, ms = 30_000) => { const end = Date.now() + ms; for (;;) { if (await cond().catch(() => false)) return; if (Date.now() > end) throw new Error('timed out waiting for: ' + what); await new Promise((r) => setTimeout(r, 300)); } };

let pass = 0;
const test = async (name, fn) => { const t = Date.now(); const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : '', `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const open = [];
try {
	const lp = await freePort();
	const lead = await startNode({ port: lp, sun, validator: founder, blockMs: 100, publicUrl: `http://127.0.0.1:${lp}`, allowLocalPeers: true });
	open.push(lead);
	const follower = async (key) => { const n = await startNode({ port: await freePort(), follow: lead.url, followMs: 300, checker: key }); open.push(n); return n; };

	await test('a follower with an unstaked checker key copies the chain but does not check in', async () => {
		await follower(idle);
		await send(lead, product, 'transfer', { asset: 'DZY', to: idle.address, amount: 1 });
		await new Promise((r) => setTimeout(r, 2_000));
		assert.equal((await get(lead, '/nodes')).nodes[idle.address], undefined);
	});
	await test('once its key has 1 DZY staked, a product\'s follower checks in by itself, quoting a block it checked; it stays a checker, not a block maker', async () => {
		const n = await follower(product);
		assert.equal((await send(lead, product, 'stake.bond', { amount: DZY })).ok, true);
		await until('the product\'s node checked in', async () => (await get(lead, '/nodes')).nodes[product.address]?.hrs === 1);
		const seen = (await get(lead, '/nodes')).nodes[product.address];
		assert.equal(seen.url, undefined, 'a follower gave a public address');
		assert.deepEqual((await get(lead, '/')).validators, [founder.address], 'a checker became a block maker');
		assert.equal((await get(n, '/')).role, 'follower');
		return `checked in at chain time ${new Date(seen.at).toISOString().slice(11, 19)}`;
	});
	console.log(`\n${pass} tests passed`);
} catch (e) {
	console.error('FAIL', e.message); process.exitCode = 1;
} finally {
	for (const n of open) await n.stop().catch(() => {});
	testCrewFrom(CHAIN, null);
}
