// Personal deposit addresses (src/deposit.ts): buying DZY by simply sending dollars to an address of one's own, from an
// exchange or any wallet, with no memo and no Dznye wallet at the moment of paying. A real node and validator, with
// stand-ins for Base and Solana. Also: a hint naming less than was paid cannot shrink a purchase.
// Run: node chain/node/deposit.test.mjs
import assert from 'node:assert/strict';
import { newKey } from '../src/crypto.ts';
import { depositEvm, depositSol } from '../src/deposit.ts';
import { EVM } from '../src/evm.ts';
import { associatedTokenAccount, onCurve, USDT_MINT } from '../src/solana.ts';
import { fromSolana } from '../src/crypto.ts';
import { startNode } from './server.mjs';
// @ts-ignore: plain JavaScript shared with the tested model
import { RULES } from '../v2/rules.mjs';
// @ts-ignore
import { saleUnitsFor } from '../v2/sale.mjs';

const V = await newKey();
const CHAIN = 'dznye-deposit-test';
const sun = { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [{ to: V.address, units: 10_000_000_000, paid: 2_000_000_000, proof: 'test', lockYears: 10 }] };
const get = async (n, p) => (await fetch(n.url + p)).json();
const post = async (n, p, body) => { const r = await fetch(n.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const until = async (what, ok, ms = 20_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ok()) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error('timed out waiting for ' + what); };
const dzy = async (n, a) => (await get(n, '/account/' + a)).balances?.DZY ?? 0;

/* a stand-in Base: USDC transfers, each in a block; blocks become final when `fin` passes them */
const USDC = EVM.base.usdc, EVT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = (v) => v.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const memoHex = (m) => Buffer.from(m).toString('hex');
const base = { fin: 100, txs: new Map() };
const baseSend = (to, usd, memo = '') => { const hash = '0x' + (base.txs.size + 1).toString(16).padStart(64, 'a'); base.fin += 2; base.txs.set(hash, { to, amount: BigInt(Math.round(usd * 1e6)), memo, block: base.fin }); return hash; };
const logOf = (t) => ({ address: USDC, topics: [EVT, '0x' + word('0x1111111111111111111111111111111111111111'), '0x' + word(t.to)], data: '0x' + t.amount.toString(16) });
const evmRpc = (net) => async (method, params) => {
	if (net !== 'base') throw new Error('no node for ' + net);
	if (method === 'eth_getBlockByNumber') return { number: '0x' + base.fin.toString(16) };
	if (method === 'eth_getLogs') {
		const q = params[0], from = Number(q.fromBlock), to = Number(q.toBlock), want = q.topics[2];
		return [...base.txs].filter(([, t]) => t.block >= from && t.block <= to && want.includes('0x' + word(t.to))).map(([h, t]) => ({ ...logOf(t), transactionHash: h }));
	}
	const t = base.txs.get(params[0]);
	if (!t) return null;
	if (method === 'eth_getTransactionByHash') return { to: USDC, chainId: '0x2105', input: '0xa9059cbb' + word(t.to) + word(t.amount.toString(16)) + memoHex(t.memo) };
	if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x' + t.block.toString(16), logs: [logOf(t)] };
	throw new Error('unexpected ' + method);
};
/* a stand-in Solana: token payments to an owner, found through the owner's token account */
const sol = new Map(); // signature → { owner, mint, amount }
const solanaRpc = async (method, params) => {
	if (method === 'getSignaturesForAddress') {
		const out = [];
		for (const [sig, p] of sol) if ((await associatedTokenAccount(p.owner, p.mint)) === params[0]) out.push({ signature: sig, err: null });
		return out.reverse();
	}
	if (method === 'getTransaction') {
		const p = sol.get(params[0]);
		return p ? { meta: { err: null, innerInstructions: [], preTokenBalances: [{ mint: p.mint, owner: p.owner, uiTokenAmount: { amount: '0' } }], postTokenBalances: [{ mint: p.mint, owner: p.owner, uiTokenAmount: { amount: String(p.amount) } }] }, transaction: { message: { accountKeys: [], instructions: [] } } } : null;
	}
	throw new Error('unexpected ' + method);
};

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const open = [];
try {
	await test('every account has its own deposit addresses: fixed by its Dznye address, different for each, a real Solana point and a plain 0x address', async () => {
		const a = await newKey(), b = await newKey();
		const [ea, eb, sa, sb] = await Promise.all([depositEvm(a.address), depositEvm(b.address), depositSol(a.address), depositSol(b.address)]);
		assert.match(ea, /^0x[0-9a-f]{40}$/); assert.notEqual(ea, eb);
		assert.equal(ea, await depositEvm(a.address), 'not the same address twice');
		assert.notEqual(sa, sb); assert.ok(onCurve(Buffer.from(fromSolana(sa), 'hex')), 'the Solana deposit address is not a point, so wallets would refuse it');
		await assert.rejects(depositEvm('xyz'));
		return `e.g. ${ea} and ${sa}`;
	});

	const node = await startNode({ port: 0, sun, validator: V, blockMs: 40, evmRpc, solanaRpc, watchMs: 100 }); open.push(node);
	await test('the watch request: checked, slowed down when flooded, and answered with the addresses', async () => {
		const k = await newKey();
		assert.equal((await post(node, '/sun/watch', { to: 'nope' })).status, 400);
		assert.equal((await post(node, '/sun/watch', { to: k.address, net: 'base', tx: '0x12' })).status, 400, 'a bad payment id was taken');
		assert.equal((await post(node, '/sun/watch', { to: k.address, net: 'doge', tx: '0x' + '1'.repeat(64) })).status, 400, 'an unknown chain was taken');
		const r = await post(node, '/sun/watch', { to: k.address });
		assert.equal(r.ok, true); assert.equal(r.evm, await depositEvm(k.address)); assert.equal(r.sol, await depositSol(k.address));
		let slowed = 0; for (let i = 0; i < 12; i++) if ((await post(node, '/sun/watch', { to: k.address })).status === 429) slowed++;
		assert.ok(slowed >= 1, 'a flood was never slowed down');
	});
	await test('USDC sent on Base to a buyer\'s deposit address buys DZY: no memo, no hint, nothing from the buyer but the payment', async () => {
		const buyer = await newKey(), other = await newKey();
		await new Promise((r) => setTimeout(r, 61_000 / 60)); // the watch allowance above refills (10 a minute per address)
		await until('the watch to be accepted', async () => (await post(node, '/sun/watch', { to: buyer.address })).ok === true, 70_000);
		const sold0 = (await get(node, '/sun')).sold;
		baseSend(await depositEvm(buyer.address), 25);
		baseSend(await depositEvm(buyer.address), 0.5); // under $1: buys nothing (and is burned all the same)
		baseSend(await depositEvm(other.address), 40); // to an address nobody asked to watch: nothing yet
		await until('the deposit to be credited', async () => (await dzy(node, buyer.address)) > 0);
		await new Promise((r) => setTimeout(r, 800));
		const got = await dzy(node, buyer.address);
		assert.equal(got, Number(saleUnitsFor(RULES, BigInt(sold0), 25_000_000n)), 'not what $25 buys on the curve');
		assert.equal(await dzy(node, other.address), 0, 'an unwatched address was credited');
		return `$25 bought ${got / 1e6} DZY; the $0.50 bought nothing`;
	});
	await test('a payment the buyer names is found even for an address nobody watched, and credited to that address\'s owner only', async () => {
		const owner = await newKey(), stranger = await newKey();
		const hash = baseSend(await depositEvm(owner.address), 10);
		await until('the request to be taken', async () => (await post(node, '/sun/watch', { to: stranger.address, net: 'base', tx: hash })).ok === true, 70_000);
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(await dzy(node, stranger.address), 0, 'someone else\'s deposit was credited to whoever named it');
		await until('the request to be taken', async () => (await post(node, '/sun/watch', { to: owner.address, net: 'base', tx: hash })).ok === true, 70_000);
		await until('the named payment to be credited', async () => (await dzy(node, owner.address)) > 0);
		await until('the payment to be reported as done', async () => (await post(node, '/sun/watch', { to: owner.address, net: 'base', tx: hash })).done === true, 70_000);
	});
	await test('USDT on Solana to the deposit address buys DZY, found by the validator itself', async () => {
		const buyer = await newKey();
		await until('the watch to be accepted', async () => (await post(node, '/sun/watch', { to: buyer.address })).ok === true, 70_000);
		sol.set('8'.repeat(88), { owner: await depositSol(buyer.address), mint: USDT_MINT, amount: 12_000_000 });
		await until('the Solana deposit to be credited', async () => (await dzy(node, buyer.address)) > 0);
		return `$12 of USDT bought ${(await dzy(node, buyer.address)) / 1e6} DZY`;
	});
	await test('a hint naming LESS than was paid cannot shrink a purchase: the validator confirms what really arrived', async () => {
		const buyer = await newKey(), sold0 = (await get(node, '/sun')).sold;
		const hash = baseSend('0x000000000000000000000000000000000000dead', 30, 'dzy-sun:' + buyer.address); // the burn address, with the memo
		await until('the hint to be taken', async () => (await post(node, '/sun/hint', { net: 'base', token: 'USDC', amount: 2_000_000, tx: hash, to: buyer.address })).ok === true, 70_000);
		await until('the purchase to be credited', async () => (await dzy(node, buyer.address)) > 0);
		assert.equal(await dzy(node, buyer.address), Number(saleUnitsFor(RULES, BigInt(sold0), 30_000_000n)), 'credited the hint\'s $2, not the $30 paid');
	});
} finally {
	for (const n of open) await n.stop();
}
console.log(`${pass} tests passed`);
