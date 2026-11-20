// The node on a PC running a chain with the Sun (src/sun.ts): payments and older features over HTTP, nobody can issue
// DZY, empty blocks keep the chain's minutes moving, the validator collects its own winnings, and a follower replays
// everything to the same fingerprint. Waits for real clock minutes, so it takes about two minutes.
// Run: node chain/node/sun.test.mjs
import assert from 'node:assert/strict';
import { newKey } from '../src/crypto.ts';
import { signTx } from '../src/ledger.ts';
import { startNode } from './server.mjs';
import { USDC_MINT } from '../src/solana.ts';

const V = await newKey(), A = await newKey(), B = await newKey();
const CHAIN = 'dznye-node-test';
const sun = { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [
	{ to: V.address, units: 10_000_000_000, paid: 2_000_000_000, proof: 'test', lockYears: 10 },
	{ to: A.address, units: 50_000_000_000, paid: 10_000_000_000, proof: 'test' },
] };
const get = async (n, p) => (await fetch(n.url + p)).json();
const post = async (n, p, body) => { const r = await fetch(n.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
const send = async (n, who, type, data) => post(n, '/tx', { tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) });
const settle = async (n) => { for (let i = 0; i < 200; i++) { if ((await get(n, '/')).waiting === 0) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('the node never made a block'); };
const until = async (what, ok, ms = 90_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ok()) return; await new Promise((r) => setTimeout(r, 500)); } throw new Error('timed out waiting for ' + what); };

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const open = [];
try {
	const main = await startNode({ port: 0, sun, validator: V, blockMs: 40 }); open.push(main);
	await test('a PC leads a chain with the Sun: 12,000,000 DZY accounted for, the first purchase on record, the genesis settings published', async () => {
		const i = await get(main, '/');
		assert.equal(i.role, 'leader'); assert.equal(i.chain, CHAIN); assert.equal(i.authority, '0'.repeat(64));
		const s = await get(main, '/sun');
		assert.equal(s.sun + s.unsold + s.locked + s.circulating + s.pots, 12_000_000 * 100_000_000); // in shards
		assert.equal(s.rules.constants.validatorBp, '4000');
		assert.deepEqual((await get(main, '/genesis')).sunGenesis, sun);
	});
	await test('payments and older features work; nobody can issue DZY', async () => {
		assert.equal((await send(main, A, 'transfer', { asset: 'DZY', to: B.address, amount: 3_000_000 })).ok, true);
		assert.equal((await send(main, A, 'asset.create', { symbol: 'GOLD', name: 'Game gold', decimals: 0, supply: 100, mintable: false })).ok, true);
		await settle(main);
		assert.equal((await get(main, '/account/' + B.address)).balances.DZY, 3_000_000);
		assert.match((await send(main, A, 'mint', { asset: 'DZY', to: A.address, amount: 1 })).error, /only the issuer/);
		assert.match((await send(main, A, 'treasury.spend', { to: A.address, amount: 1, reason: 'mine now' })).error, /Sun/);
	});
	await test('a quiet chain keeps its minutes: empty blocks once a minute, and the validator collects its own winnings', async () => {
		const h0 = (await get(main, '/')).height;
		await until('a chain minute', async () => (await get(main, '/sun')).minute >= 1, 75_000); // the next clock minute: at most 60 s away
		assert.ok((await get(main, '/')).height > h0, 'no block was made on a quiet chain');
		await until('the validator to collect a prize', async () => (await get(main, '/sun/' + V.address)).won > 0);
		const v = await get(main, '/sun/' + V.address);
		return `chain minute ${(await get(main, '/sun')).minute}; the validator has collected ${v.won / 1e6} DZY with nothing unlocked to start`;
	});
	await test('a follower replays every block, from the published genesis settings alone, to the same fingerprint', async () => {
		const copy = await startNode({ port: 0, follow: main.url, followMs: 100 }); open.push(copy);
		await until('the follower to catch up', async () => { const [a, b] = await Promise.all([get(main, '/'), get(copy, '/')]); return a.height === b.height && a.last === b.last; }, 30_000);
		assert.equal((await get(copy, '/')).role, 'follower');
		assert.deepEqual(await get(copy, '/sun/' + V.address), await get(main, '/sun/' + V.address));
	});
	await test('buying from the Sun: dollars burned on (a stand-in) Solana; the buyer only tells the node (nothing on the chain, no fee, no DZY needed); the validator finds the payment itself and confirms it; a payment whose memo names someone else buys nothing', async () => {
		const BURN = '1nc1nerator11111111111111111111111111111111', burned = new Map(); // signature → what our stand-in Solana holds
		const solanaRpc = async (method, [sig]) => {
			if (method === 'getSignaturesForAddress') return [];
			const p = burned.get(sig);
			return p ? { meta: { err: null, innerInstructions: [], preTokenBalances: [{ mint: USDC_MINT, owner: BURN, uiTokenAmount: { amount: '0' } }], postTokenBalances: [{ mint: USDC_MINT, owner: BURN, uiTokenAmount: { amount: String(p.amount) } }] },
				transaction: { message: { accountKeys: [], instructions: [{ program: 'spl-memo', parsed: p.memo }] } } } : null;
		};
		const buyer = await newKey(), cheat = await newKey(), S1 = '5'.repeat(88), S2 = '6'.repeat(88);
		const shop = await startNode({ port: 0, sun: { ...sun, chain: 'dznye-buy-test', time: Date.now() }, validator: V, blockMs: 40, solanaRpc, watchMs: 100 }); open.push(shop);
		const hint = (to, tx, amount = 50_000_000) => post(shop, '/sun/hint', { net: 'sol', token: 'USDC', amount, tx, to });
		assert.equal((await hint(buyer.address, S1)).ok, true);
		assert.equal((await hint(cheat.address, S2)).ok, true); // the cheat says a payment is theirs, but its memo names the buyer
		assert.equal((await hint(buyer.address, S1, 999_999)).status, 400, 'a purchase under $1 was taken');
		assert.equal((await post(shop, '/sun/hint', { net: 'sol', token: 'USDC', amount: 5e6, tx: S1, to: buyer.address, extra: 1 })).status, 400);
		await new Promise((r) => setTimeout(r, 1_000));
		assert.equal((await get(shop, '/account/' + buyer.address)).balances?.DZY ?? 0, 0, 'credited before anything was paid');
		burned.set(S2, { memo: 'dzy-sun:' + buyer.address, amount: 50_000_000 });
		burned.set(S1, { memo: 'dzy-sun:' + buyer.address, amount: 50_000_000 });
		await until('the purchase to be confirmed', async () => ((await get(shop, '/account/' + buyer.address)).balances?.DZY ?? 0) > 0, 15_000);
		await new Promise((r) => setTimeout(r, 1_000));
		assert.equal((await get(shop, '/account/' + cheat.address)).balances?.DZY ?? 0, 0, 'a payment naming someone else bought DZY');
		assert.equal((await hint(buyer.address, S1)).done, true, 'a counted payment is not reported as done');
		let refused = 0; for (let i = 0; i < 12; i++) if ((await hint(buyer.address, '7'.repeat(88))).status === 429) refused++;
		assert.ok(refused >= 1, 'a flood of hints from one address was never slowed down');
		const got = (await get(shop, '/account/' + buyer.address)).balances.DZY;
		return `$50 burned bought ${got / 1e6} DZY with no transaction from the buyer; the hint naming the wrong person bought nothing; ${refused} of 12 rapid hints slowed down`;
	});
} finally {
	for (const n of open) await n.stop();
}
console.log(`${pass} tests passed`);
