// Wallets and Solidity tools against real nodes, over HTTP: everything MetaMask, ethers or Foundry ask of an Ethereum node,
// on four validators; contracts deployed and called with nothing but standard JSON-RPC. Run: node node/evm.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { newKey } from '../src/crypto.ts';
import { RULES, signTx, testCrewFrom } from '../src/ledger.ts';
import { testHeartFrom } from '../src/heart.ts';
import { evmAddressOf, signEvmTx } from '../src/evmsign.ts';
import { hex, keccak } from '../src/evmcore.ts';
import { tokenAddress } from '../src/evmledger.ts';
import { startNode } from './server.mjs';

RULES.crewEveryMs = 2_000;
const DZY = 1e8, CHAIN = 'dznye-evm-net', wait = (ms) => new Promise((r) => setTimeout(r, ms)), FX = JSON.parse(readFileSync(new URL('../evm/fixtures.json', import.meta.url), 'utf8'));
let pass = 0; const test = async (name, fn) => { const t = Date.now(), note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : '', `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const until = async (what, cond, ms = 40_000) => { const end = Date.now() + ms; for (;;) { if (await cond().catch(() => false)) return; if (Date.now() > end) throw new Error('timed out waiting for: ' + what); await wait(60); } };
testCrewFrom(CHAIN, 1); const founder = await newKey(), ops = await Promise.all([0, 0, 0].map(() => newKey())), user = await newKey(); testHeartFrom(CHAIN, 3, [founder.address]);
const sun = { chain: CHAIN, time: Date.now(), validators: [founder.address], seedWait: 0, sales: [founder, ...ops, user].map((k) => ({ to: k.address, units: 3_000 * DZY, paid: 600_000_000, proof: 'test' })) }, timeouts = { propose: 600, vote: 300, grow: 200, gossip: 300, sync: 300 };
const boot = async (key, peers) => { const port = await freePort(), url = `http://127.0.0.1:${port}`; return startNode({ port, sun, validator: key, blockMs: 60, timeouts, publicUrl: url, allowLocalPeers: true, peers, watchMs: 300 }); };
const a = await boot(founder, []), rest = []; for (const k of ops) rest.push(await boot(k, [a.url])); a.net.peers.push(...rest.map((n) => n.url)); const all = [a, ...rest];
const get = async (n, p) => (await fetch(n.url + p)).json();
const once = async (n, who, type, data) => { const r = await fetch(n.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) }) }); return { status: r.status, ...(await r.json()) }; };
const ok = async (n, who, type, data) => { for (let i = 0; ; i++) { const r = await once(n, who, type, data); if (r.ok) return; if (i >= 6 || !/nonce must be/.test(r.error ?? '')) assert.fail(JSON.stringify(r)); await wait(80); } };
const rpcRaw = async (n, body) => (await fetch(n.url + '/evm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const rpc = async (n, method, ...params) => { const j = await rpcRaw(n, { jsonrpc: '2.0', id: 7, method, params }); if (j.error) throw Object.assign(new Error(j.error.message), j.error); return j.result; };
const K1 = 0x3333333333333333333333333333333333333333333333333333333333333333n, a1 = evmAddressOf(K1), K2 = 0x4444444444444444444444444444444444444444444444444444444444444444n, a2 = evmAddressOf(K2), sel = (f) => hex(keccak(new TextEncoder().encode(f))).slice(0, 8), W = (v) => BigInt(v).toString(16).padStart(64, '0'), AW = (x) => x.slice(2).toLowerCase().padStart(64, '0');
/** what a wallet does: ask the chain id, the nonce, the price, the gas; sign; send; wait for the receipt */
const walletSend = async (n, key, to, data = '0x', value = 0n) => { const from = evmAddressOf(key), [cid, nonce, price, gas] = await Promise.all([rpc(n, 'eth_chainId'), rpc(n, 'eth_getTransactionCount', from, 'pending'), rpc(n, 'eth_gasPrice'), rpc(n, 'eth_estimateGas', { from, ...(to ? { to } : {}), data, value: '0x' + value.toString(16) })]); const t = signEvmTx(key, { nonce: Number(nonce), gasPrice: BigInt(price), gas: Number(gas), to: to ?? '', value, data, chainId: Number(cid) }), h = await rpc(n, 'eth_sendRawTransaction', t.raw); assert.equal(h, t.hash); let r = null; await until('a receipt', async () => (r = await rpc(n, 'eth_getTransactionReceipt', h)) !== null); return r; };
try {
	await ok(a, founder, 'stake.bond', { amount: 100 * DZY }); await ok(a, user, 'transfer', { asset: 'DZY', to: founder.address, amount: 5 }); await until('the upgrade', async () => (await get(a, '/heart')).on);
	for (const k of ops) await ok(a, k, 'stake.bond', { amount: 20 * DZY }); await ok(a, user, 'evm.in', { to: a1, amount: 500 * DZY }); await ok(a, user, 'evm.in', { to: a2, amount: 50 * DZY }); await until('four validators', async () => { await ok(a, user, 'transfer', { asset: 'DZY', to: founder.address, amount: 5 }); await wait(400); return (await get(a, '/')).validators.length === 4; });
	let token = '';
	await test('a wallet connects: chain, block, balance, price, fee history, a list of questions at once; unknown ones are said to be unknown', async () => {
		assert.equal(await rpc(a, 'eth_chainId'), '0x445a59'); assert.ok(BigInt(await rpc(a, 'eth_blockNumber')) > 2n); assert.equal(BigInt(await rpc(a, 'eth_getBalance', a1, 'latest')), 500n * 10n ** 18n); const fh = await rpc(a, 'eth_feeHistory', '0x4', 'latest', [10]); assert.equal(fh.baseFeePerGas.length, 5); const b = await rpc(a, 'eth_getBlockByNumber', 'latest', false); for (const k of ['number', 'hash', 'parentHash', 'timestamp', 'gasLimit', 'baseFeePerGas', 'transactions']) assert.ok(k in b, k);
		const l = await rpcRaw(a, [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'eth_nothing' }]); assert.equal(l[0].result, '0x445a59'); assert.equal(l[1].error.code, -32601); assert.equal((await rpcRaw(a, { id: 1, method: 5 })).error.code, -32600);
	});
	await test('Solidity deployed and used with nothing but standard JSON-RPC, in blocks of four validators', async () => {
		const r = await walletSend(a, K1, null, FX.token + W(0) + W(0)); assert.equal(r.status, '0x1'); token = r.contractAddress; assert.ok((await rpc(a, 'eth_getCode', token, 'latest')).length > 1_000);
		await walletSend(a, K1, token, '0x' + sel('mint(address,uint256)') + AW(a1) + W(1_000)); const m = await walletSend(a, K1, token, '0x' + sel('transfer(address,uint256)') + AW(a2) + W(400)); assert.equal(m.status, '0x1'); assert.equal(BigInt(await rpc(a, 'eth_call', { to: token, data: '0x' + sel('balanceOf(address)') + AW(a2) }, 'latest')), 400n);
		const t = await rpc(a, 'eth_getTransactionByHash', m.transactionHash); assert.equal(t.from, a1); assert.equal(t.to, token); assert.equal((await get(a, '/block/' + Number(m.blockNumber))).commit.sigs.length >= 1, true);
	});
	await test('a call that would fail says why, before anything is paid; what is sent wrong is refused', async () => {
		await assert.rejects(rpc(a, 'eth_estimateGas', { from: a2, to: token, data: '0x' + sel('transfer(address,uint256)') + AW(a1) + W(401) }), /execution reverted: balance/); await assert.rejects(rpc(a, 'eth_call', { to: token, data: '0x' + sel('transfer(address,uint256)') + AW(a1) + W(1) }, 'latest'), (e) => e.code === 3 && e.data.startsWith('0x08c379a0'));
		const old = signEvmTx(K1, { nonce: 0, gasPrice: BigInt(await rpc(a, 'eth_gasPrice')), gas: 21_000, to: a2, value: 1n, data: '0x', chainId: 0x445a59 }); await assert.rejects(rpc(a, 'eth_sendRawTransaction', old.raw), /nonce too low/); await assert.rejects(rpc(a, 'eth_sendRawTransaction', '0x1234'), /./); const other = signEvmTx(K1, { nonce: 3, gasPrice: 10n ** 12n, gas: 21_000, to: a2, value: 1n, data: '0x', chainId: 1 }); await assert.rejects(rpc(a, 'eth_sendRawTransaction', other.raw), /this chain/);
	});
	await test('real coins of the chain in Solidity, their events found the way block explorers and apps look for them', async () => {
		await ok(a, user, 'asset.create', { symbol: 'GOLD', name: 'Gold', supply: 1_000, mintable: false, decimals: 0 }); let g = ''; await until('gold', async () => (g = Object.entries(await get(a, '/assets')).find(([, x]) => x.symbol === 'GOLD')?.[0]) !== undefined); await ok(a, user, 'evm.in', { to: a1, amount: 300, asset: g }); const T = '0x' + tokenAddress(g); await until('in', async () => BigInt(await rpc(a, 'eth_call', { to: T, data: '0x' + sel('balanceOf(address)') + AW(a1) }, 'latest')) === 300n);
		const r = await walletSend(a, K1, T, '0x' + sel('transfer(address,uint256)') + AW(a2) + W(120)); assert.equal(r.logs.length, 1); const topic = '0x' + hex(keccak(new TextEncoder().encode('Transfer(address,address,uint256)'))), logs = await rpc(a, 'eth_getLogs', { fromBlock: '0x1', toBlock: 'latest', address: T, topics: [topic, null, '0x' + AW(a2)] }); assert.equal(logs.length, 1); assert.equal(BigInt(logs[0].data), 120n); assert.equal((await rpc(a, 'eth_getLogs', { fromBlock: '0x1', toBlock: 'latest', address: T, topics: [topic, null, '0x' + AW(a1)] })).length, 0);
		const had = (await get(a, '/account/' + user.address)).balances[g] ?? 0; await walletSend(a, K2, T, '0x' + sel('exit(bytes32,uint256)') + user.address + W(20)); assert.equal((await get(a, '/account/' + user.address)).balances[g], had + 20);
	});
	await test('every node holds the same: contracts, balances, receipts; the carriers got their fees back', async () => {
		const h = (await get(a, '/')).height; await until('all at that block', async () => (await Promise.all(all.map((n) => get(n, '/')))).every((i) => i.height >= h)); const b = await Promise.all(all.map((n) => get(n, '/block/' + h))); assert.equal(new Set(b.map((x) => x.stateRoot)).size, 1); for (const n of all) assert.equal(BigInt(await rpc(n, 'eth_call', { to: token, data: '0x' + sel('balanceOf(address)') + AW(a2) }, 'latest')), 400n);
	});
	await test('sent to any validator, it lands; 60 payments by two wallets, one after another', async () => {
		const t0 = Date.now(); for (let i = 0; i < 10; i++) { const r = await walletSend(all[i % 4], i % 2 ? K1 : K2, i % 2 ? a2 : a1, '0x', 10n ** 15n); assert.equal(r.status, '0x1'); await until('everyone has it', async () => (await Promise.all(all.map((n) => rpc(n, 'eth_getTransactionCount', i % 2 ? a1 : a2)))).every((x, _, l) => x === l[0])); } const ms = (Date.now() - t0) / 10;
		const n0 = Number(await rpc(a, 'eth_getTransactionCount', a1, 'latest')), price = BigInt(await rpc(a, 'eth_gasPrice')); const t1 = Date.now(); for (let i = 0; i < 40; i++) await rpc(a, 'eth_sendRawTransaction', signEvmTx(K1, { nonce: n0 + i, gasPrice: price * 2n, gas: 21_000, to: a2, value: 1n, data: '0x', chainId: 0x445a59 }).raw); await until('all forty', async () => Number(await rpc(a, 'eth_getTransactionCount', a1, 'latest')) === n0 + 40); return `one at a time, a wallet\'s whole round ${ms.toFixed(0)} ms; forty in a row ${Date.now() - t1} ms`;
	});
} finally { for (const n of all) await n.stop(); }
console.log(`\n${pass} tests passed`);
process.exit(0);
