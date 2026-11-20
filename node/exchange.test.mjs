// The exchange on a real node over HTTP: GET /exchange shows every vault against the claims on it; before it opens, the
// node still gives burn addresses; once open, it refuses to hand out a burn address at all (nothing is burned any more),
// and a deposit confirmed by the validator shows up in GET /exchange/<address>. Run: node chain/node/exchange.test.mjs
import assert from 'node:assert/strict';
import { newKey } from '../src/crypto.ts';
import { signTx, testExchangeFrom, testExchangeVaults } from '../src/ledger.ts';
import { startNode } from './server.mjs';

const CHAIN = 'dznye-exchange-net-test', DZY = 100_000_000;
const V = await newKey(), A = await newKey();
const sun = { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [V, A].map((k) => ({ to: k.address, units: 100 * DZY, paid: 20_000_000, proof: 'test' })) };
const node = await startNode({ port: 0, sun, validator: V, blockMs: 50 });
const get = async (p) => (await fetch(node.url + p)).json();
const post = async (p, body) => { const r = await fetch(node.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const send = async (k, type, data) => post('/tx', { tx: await signTx(k.secret, { chain: CHAIN, from: k.address, nonce: (await get('/account/' + k.address)).nextNonce, type, data }) });
const until = async (what, cond) => { for (let i = 0; i < 100; i++) { if (await cond().catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out: ' + what); };
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
try {
	await test('closed: GET /exchange says so, and the node still gives burn addresses for buying', async () => {
		const x = await get('/exchange');
		assert.equal(x.open, false); assert.equal(x.from, null); assert.deepEqual(Object.keys(x.coins), ['BTC', 'ETH', 'SOL', 'USDC', 'USDT', 'BNB', 'POL', 'AVAX']);
		assert.notEqual((await post('/sun/watch', { to: A.address })).status, 410);
	});
	await test('open: the node refuses to hand out a burn address, lists the vaults, and shows a confirmed deposit as DZY with the coin locked in the buyer name', async () => {
		testExchangeFrom(CHAIN, (await get('/')).height + 1);
		testExchangeVaults(CHAIN, { btc: 'bc1qtestvault0000000000000000000000000000', base: '0x' + '11'.repeat(20) });
		const w = await post('/sun/watch', { to: A.address });
		assert.equal(w.status, 410); assert.match(w.error, /Nothing is burned/);
		assert.equal((await send(V, 'x.price', { p: { BTC: 90_000_000_000 } })).ok, true);
		assert.equal((await send(V, 'x.deposit', { net: 'btc', coin: 'BTC', amount: 100_000, tx: 'f'.repeat(64), to: A.address })).ok, true);
		await until('the deposit', async () => (await get('/exchange/' + A.address)).locks.BTC === 100_000);
		const x = await get('/exchange');
		assert.equal(x.open, true); assert.equal(x.coins.BTC.vaults.btc, 'bc1qtestvault0000000000000000000000000000');
		assert.equal(x.coins.BTC.total, 100_000); assert.equal(x.coins.BTC.locked, 100_000); assert.equal(x.coins.BTC.claims, 0); assert.equal(x.coins.BTC.price, 90_000_000_000);
		assert.ok((await get('/account/' + A.address)).balances.DZY > 100 * DZY, 'no DZY for the deposit');
		return `0.001 BTC deposited: locked in A's name ${x.coins.BTC.locked} sats, vault ${x.coins.BTC.total} sats`;
	});
	console.log(`\n${pass} tests passed`);
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { testExchangeFrom(CHAIN, null); testExchangeVaults(CHAIN, null); await node.stop(); }
