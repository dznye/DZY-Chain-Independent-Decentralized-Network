// The DZY index on a real node, with fake coins: the node runs its own blocks; a validator posts coin prices and confirms
// vault deposits in USDC and ETH as they would arrive; people buy, sell all, buy back with coin while holding no DZY, take
// coin out, and ETH's price jumps. Everything goes through the node's own API (POST /tx, GET /exchange), as the wallet does.
// Run: node node/index.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newKey } from '../src/crypto.ts';
import * as L from '../src/ledger.ts';
import * as H from '../src/heart.ts';
import { startNode } from './server.mjs';

const CHAIN = 'dznye-index-net', DZY = 1e8, IDX = 6, VAULT = '0x' + '11'.repeat(20), wait = (ms) => new Promise((r) => setTimeout(r, ms)); let pass = 0, txn = 0;
const test = async (name, fn) => { const t = Date.now(), n = await fn(); pass++; console.log('ok  ', name, n ? '— ' + n : '', `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const [V, F, A, B] = await Promise.all([0, 0, 0, 0].map(() => newKey()));
L.testCrewFrom(CHAIN, 1); H.testHeartFrom(CHAIN, 2, [V.address]); L.testExchangeFrom(CHAIN, 1); L.testExchangeVaults(CHAIN, { base: VAULT }); L.testReserveFrom(CHAIN, 2); L.testIndexFrom(CHAIN, IDX);
const fake = { USDC: 1_000_000, ETH: 2_000_000_000 }; // the fake coins' prices: the node reads these as it would read the markets
const node = await startNode({ port: 0, validator: V, blockMs: 40, priceRead: async () => ({ ...fake }), watchMs: 300, dataDir: mkdtempSync(join(tmpdir(), 'dzy-index-')), mediaFrom: null, sun: { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [{ to: V.address, units: 1_000 * DZY, paid: 10 * DZY, proof: 't' }, { to: F.address, units: 8_000 * DZY, paid: 80 * DZY, proof: 't' }] } });
node.core.allow = () => true;
const U = node.url, get = async (p) => (await fetch(U + p)).json();
const post = async (body) => { const r = await fetch(U + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const until = async (f, ms = 20_000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await wait(50); } };
/** sign and send, then wait until the account's nonce shows it went in (or throw what the node said) */
async function send(k, type, data) {
	const n = (await get('/account/' + k.address)).nextNonce, tx = await L.signTx(k.secret, { chain: CHAIN, from: k.address, nonce: n, type, data });
	const r = await post({ tx }); if (r.status !== 200) throw new Error(r.body?.error ?? `status ${r.status}`);
	await until(async () => L.nonceOf(node.core.state, k.address) >= n); // in a block, not just waiting for one
}
const deposit = (to, coin, amount) => send(V, 'x.deposit', { net: 'base', coin, amount, tx: '0x' + (++txn).toString(16).padStart(64, '0'), to: to.address });
const bal = async (k, a = 'DZY') => (await get('/account/' + k.address)).balances?.[a] ?? 0;
const ix = async () => (await get('/exchange')).index;
const whole = () => assert.equal(L.holdings(node.core.state).DZY, 12e6 * DZY, 'every DZY is somewhere');
try {
	await test('the node turns the index on at its block, at today\'s price, and says so at GET /exchange', async () => {
		for (let i = 0; i < 40 && !(await ix()).on; i++) await send(F, 'transfer', { asset: 'DZY', to: V.address, amount: 1 }); // each payment makes a block (idle, a block a minute)
		await until(async () => (await ix()).on);
		const i = await ix(); assert.ok(i.on >= IDX); assert.equal(i.unbacked, 9_000 * DZY, 'the founder\'s 9,000 DZY counted as unbacked'); assert.ok(i.price > 0);
		return `on at block ${i.on}, $${(i.price / 1e6).toFixed(6)}`;
	});
	await test('buying with fake USDC and ETH through the vault: DZY arrive, the coins sit in the reserve, the price holds', async () => {
		const p0 = (await ix()).price;
		await deposit(A, 'USDC', 200_000_000); await deposit(B, 'ETH', 100_000_000); // $200, and 0.1 ETH ($200)
		await until(async () => (await bal(A)) > 0 && (await bal(B)) > 0);
		const i = await ix(); assert.ok(i.price >= p0, 'no lower'); assert.ok(i.reserveUsd >= 399_000_000, `about $400 in the reserve: ${i.reserveUsd}`);
		assert.deepEqual(i.held.map((h) => h.coin).sort(), ['ETH', 'USDC']); whole();
		return `A ${(await bal(A) / DZY).toFixed(2)} DZY, B ${(await bal(B) / DZY).toFixed(2)} DZY; unbacked now ${(i.unbacked / DZY).toFixed(4)}`;
	});
	await test('ETH up 50%: DZY up by ETH\'s share of what stands behind it', async () => {
		const p0 = (await ix()).price; fake.ETH = 3_000_000_000; // the market moves; the node posts it on its own
		await until(async () => { await send(F, 'transfer', { asset: 'DZY', to: V.address, amount: 1 }); return (await ix()).price > p0 * 1.05; });
		const p1 = (await ix()).price; assert.ok(p1 > p0 * 1.1 && p1 < p0 * 1.3, `${p0} → ${p1}`);
		return `$${(p0 / 1e6).toFixed(6)} → $${(p1 / 1e6).toFixed(6)}`;
	});
	await test('A sells every DZY for USDC (the fee from the DZY sold), buys back with that USDC while holding none, then takes the rest out', async () => {
		const b0 = await bal(B); await deposit(B, 'USDC', 600_000_000); await until(async () => (await bal(B)) > b0); // enough USDC in the reserve to pay A in USDC
		const all = await bal(A); await send(A, 'swap', { give: 'DZY', want: 'xUSDC', amount: all, min: 1 });
		assert.equal(await bal(A), 0); const usdc = await bal(A, 'xUSDC'); assert.ok(usdc > 0);
		await send(A, 'swap', { give: 'xUSDC', want: 'DZY', amount: Math.floor(usdc / 2), min: 1 }); assert.ok((await bal(A)) > 0, 'bought back with no DZY on the side');
		const left = await bal(A, 'xUSDC'); await send(A, 'x.sell', { coin: 'USDC', amount: left, net: 'base', to: '0x' + '22'.repeat(20) });
		assert.equal(await bal(A, 'xUSDC'), 0); whole();
		return `sold all, got $${(usdc / 1e6).toFixed(2)}; bought back; took out the rest`;
	});
	await test('selling more than the reserve holds is refused by the node, and nothing moves', async () => {
		const before = await bal(F); await assert.rejects(() => send(F, 'swap', { give: 'DZY', want: 'xUSDC', amount: 8_000 * DZY, min: 1 }));
		assert.equal(await bal(F), before); whole();
	});
	await test('a gift from the founder washes the founder\'s DZY first', async () => {
		await send(F, 'x.park', { on: true }); await deposit(F, 'USDC', 100_000_000); await until(async () => (await bal(F, 'xUSDC')) > 0);
		const u0 = (await ix()).unbacked; await send(F, 'reserve.give', { coin: 'USDC', amount: await bal(F, 'xUSDC') });
		const u1 = (await ix()).unbacked; assert.ok(u1 < u0, `${u0} → ${u1}`); whole();
		return `${((u0 - u1) / DZY).toFixed(2)} of the founder's DZY now backed`;
	});
	await test('GET /price answers the price of DZY in a few bytes, the same as /exchange says', async () => {
		const r = await fetch(U + '/price'), text = await r.text(), d = JSON.parse(text), i = await ix();
		assert.equal(d.price, i.price); assert.equal(d.index, i.on); assert.ok(text.length < 200, `${text.length} bytes`);
		return `${text.length} bytes`;
	});
	await test('GET /price/stream: the price at once, then silence while blocks change nothing, then one word when it moves', async () => {
		const ac = new AbortController(), r = await fetch(U + '/price/stream', { signal: ac.signal }), reader = r.body.getReader(), dec = new TextDecoder();
		assert.equal(r.headers.get('content-type'), 'text/event-stream');
		const said = []; let buf = '', open = true;
		const listen = async () => {
			while (open) {
				const { value, done } = await reader.read().catch(() => ({ done: true }));
				if (done) return;
				buf += dec.decode(value);
				let i = buf.indexOf('\n\n');
				while (i >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); if (ev.startsWith('data: ')) said.push(JSON.parse(ev.slice(6))); i = buf.indexOf('\n\n'); }
			}
		};
		listen();
		await until(async () => said.length === 1); const first = said[0].price;
		for (let i = 0; i < 4; i++) await send(F, 'transfer', { asset: 'DZY', to: V.address, amount: 1 }); // blocks where the price does not move
		await wait(300); assert.equal(said.length, 1, 'nothing said while nothing moved');
		fake.ETH = Math.floor(fake.ETH * 1.2); // the market moves
		await until(async () => { await send(F, 'transfer', { asset: 'DZY', to: V.address, amount: 1 }); return said.length > 1; });
		assert.ok(said.at(-1).price > first, 'the new, higher price'); open = false; ac.abort();
		return `${said.length} words: $${(first / 1e6).toFixed(6)} → $${(said.at(-1).price / 1e6).toFixed(6)}`;
	});
} finally { await node.stop(); }
console.log(`\n${pass} index tests passed on a real node`); process.exit(0);
