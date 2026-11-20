// The exchange end to end, with a real Ethereum chain on this computer (Foundry's anvil, as Base: chain id 8453): the vault
// contract (chain/vaults/evm) is deployed with the Dznye validator's own signer; a buyer deposits 1 ETH into it; the
// validator confirms it on Dznye; the buyer sells back on Dznye; the validator's node signs the release; anyone submits
// it to the vault, which pays exactly the payout, once. Needs Foundry (anvil, forge, solc): FOUNDRY=<its folder>, else
// ~/.foundry/bin or ~/tools/foundry; without it the test says so and passes nothing. Run: node chain/node/xvault.test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { newKey } from '../src/crypto.ts';
import { keccak256 } from '../src/secp.ts';
import { signTx, testExchangeFrom, testExchangeVaults } from '../src/ledger.ts';
import { startNode } from './server.mjs';

const FOUNDRY = process.env.FOUNDRY || [homedir() + '/.foundry/bin', homedir() + '/tools/foundry'].find((d) => existsSync(d + '/anvil') || existsSync(d + '/anvil.exe')) || '', exe = (n) => `${FOUNDRY}/${n}${process.platform === 'win32' ? '.exe' : ''}`;
if (!existsSync(exe('anvil')) || !existsSync(exe('forge'))) { console.log('skipped: Foundry not found (set FOUNDRY to its folder)'); process.exit(0); }
const VAULTS = fileURLToPath(new URL('../vaults/evm/', import.meta.url));
execFileSync(exe('forge'), ['build', '--root', VAULTS, ...(existsSync(exe('solc')) ? ['--use', exe('solc')] : [])], { stdio: 'ignore' });
const BYTECODE = JSON.parse(readFileSync(VAULTS + 'out/DznyeVault.sol/DznyeVault.json', 'utf8')).bytecode.object;

const enc = new TextEncoder(), hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sel = (sig) => hex(keccak256(enc.encode(sig))).slice(0, 8), w = (n) => BigInt(n).toString(16).padStart(64, '0'), aw = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const CHAIN = 'dznye-xvault-test', DZY = 100_000_000;
const V = await newKey(), A = await newKey();
testExchangeFrom(CHAIN, 1);

const port = await freePort(), anvil = spawn(exe('anvil'), ['--chain-id', '8453', '--port', String(port), '--silent'], { stdio: 'ignore' });
const RPC = `http://127.0.0.1:${port}`;
let rid = 0;
async function rpc(method, params = []) { const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; }
for (let i = 0; i < 100; i++) { try { await rpc('eth_chainId'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const node = await startNode({ port: 0, sun: { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [{ to: V.address, units: 100 * DZY, paid: 20_000_000, proof: 'test' }] }, validator: V, blockMs: 50, watchMs: 200,
	// the node's own watchers: this local chain stands in for Base, and a fixed price stands in for the on-chain markets (none here)
	evmRpc: (net) => (net === 'base' ? rpc : null), priceRead: async () => ({ ETH: 3_000_000_000 }), xFinalDepth: 0 });
const get = async (p) => (await fetch(node.url + p)).json();
const send = async (k, type, data) => { const r = await fetch(node.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(k.secret, { chain: CHAIN, from: k.address, nonce: (await get('/account/' + k.address)).nextNonce, type, data }) }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
const until = async (what, cond) => { for (let i = 0; i < 150; i++) { if (await cond().catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out: ' + what); };
/** a transaction's receipt, waiting for it to be mined (a busy computer may take a moment) */
const receipt = async (h) => { for (let i = 0; i < 200; i++) { const r = await rpc('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error('no receipt for ' + h); };
const sendEth = async (from, to, data, value = 0n) => { const h = await rpc('eth_sendTransaction', [{ from, to, data: '0x' + data, value: '0x' + value.toString(16), gas: '0x' + (3_000_000).toString(16) }]); const r = await receipt(h); return { h, ok: r.status === '0x1', r }; };
const ethBalance = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
try {
	const [deployer, buyer, payee, relayer] = await rpc('eth_accounts');
	let vault;
	await test("the vault is deployed on Base (anvil) with the validator's own signer; the node checks it there and lists it on Dznye; a vault signed by anyone else is refused", async () => {
		const { evm } = await get('/exchange/signer');
		assert.match(evm, /^0x[0-9a-f]{40}$/);
		const deploy = async (signer) => { const h = await rpc('eth_sendTransaction', [{ from: deployer, data: BYTECODE + w(64) + w(128) + w(1) + aw(signer) + w(1) + w(1), gas: '0x' + (3_000_000).toString(16) }]); const r = await receipt(h); return { address: r.contractAddress, block: Number(BigInt(r.blockNumber)) }; }; // (address[] [signer], uint64[] [1])
		const list = async (body) => { const r = await fetch(node.url + '/exchange/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
		const fake = await deploy('0x' + '22'.repeat(20));
		const no = await list({ net: 'base', address: fake.address, from: fake.block });
		assert.equal(no.status, 400); assert.match(no.error, /not this chain's validators/);
		assert.match((await list({ net: 'base', address: '0x' + '33'.repeat(20) })).error, /no contract/);
		const v = await deploy(evm);
		vault = v.address;
		assert.equal((await list({ net: 'base', address: vault, from: v.block })).ok, true);
		await until('the vault listed', async () => (await get('/exchange')).coins.ETH.vaults.base?.toLowerCase() === vault.toLowerCase());
		assert.match((await list({ net: 'base', address: vault })).error, /already listed/); // a network's vault is listed once
		return `vault ${vault} listed on Dznye after the node checked it (signer ${evm}); a vault signed by another key was refused`;
	});
	await test("a buyer deposits 1 ETH into the vault; the validator's node finds it by itself and confirms it on Dznye; the buyer gets DZY and 1 ETH locked in its own name", async () => {
		const d = await sendEth(buyer, vault, sel('deposit(bytes32)') + A.address, 10n ** 18n);
		assert.equal(d.ok, true, 'the deposit failed');
		assert.equal(await ethBalance(vault), 10n ** 18n);
		// nobody confirms by hand: the validator's node posts the price and finds the deposit in the vault by itself
		await until('the claims', async () => (await get('/exchange/' + A.address)).locks.ETH === 1_000_000_000);
		const a = await get('/account/' + A.address);
		assert.ok(a.balances.DZY > 1_000 * DZY, 'no DZY for 1 ETH');
		return `1 ETH ($3,000) bought ${(a.balances.DZY / DZY).toFixed(2)} DZY`;
	});
	let payout;
	await test('the buyer closes its lock on Dznye; the validator\'s node signs the release; a relayer submits it; the vault pays exactly the payout, once', async () => {
		await send(A, 'x.close', { coin: 'ETH', net: 'base', to: payee }); // the whole lock, for the DZY it bought
		await until('the payout', async () => (await get('/exchange/' + A.address)).payouts.length === 1);
		payout = (await get('/exchange/' + A.address)).payouts[0];
		const setId = Number(BigInt(await rpc('eth_call', [{ to: vault, data: '0x' + sel('setId()') }, 'latest'])));
		const r = await get(`/exchange/release/${payout.id}?setId=${setId}`);
		assert.equal(r.to.toLowerCase(), payee.toLowerCase()); assert.equal(r.amount, (999_000_000n * 10n ** 9n).toString(), 'not 1 ETH less 0.1%');
		const sig = r.sig.replace(/^0x/, '');
		const call = sel('release(bytes32,address,address,uint256,bytes[])') + r.id32.replace(/^0x/, '') + aw(r.token) + aw(r.to) + w(r.amount) + w(160) + w(1) + w(32) + w(65) + sig.padEnd(192, '0');
		const why = (data) => rpc('eth_call', [{ from: relayer, to: vault, data: '0x' + data }, 'latest']).then(() => 'did not fail', (e) => e.message);
		const forged = call.replace(w(r.amount), w(BigInt(r.amount) + 1n)); // one wei more than the validators signed
		assert.equal((await sendEth(relayer, vault, forged)).ok, false, 'a forged amount was paid');
		assert.match(await why(forged), /not a validator of this set/);
		const before = await ethBalance(payee);
		assert.equal((await sendEth(relayer, vault, call)).ok, true, 'the vault refused the release');
		assert.equal(await ethBalance(payee) - before, BigInt(r.amount), 'the payee was not paid exactly');
		assert.equal(await ethBalance(vault), 10n ** 18n - BigInt(r.amount), 'the vault paid more than the payout');
		// the node sees the vault's Released event and records the payout as paid, with the payment's id
		await until('the payout marked paid', async () => !!(await get('/exchange/' + A.address)).payouts[0].tx);
		assert.equal((await sendEth(relayer, vault, call)).ok, false, 'a replayed release was paid');
		assert.match(await why(call), /already released/);
		assert.equal(await ethBalance(vault), 10n ** 18n - BigInt(r.amount), 'the vault paid out again');
		return `paid ${Number(BigInt(r.amount)) / 1e18} ETH; 0.001 ETH stays in the vault's pot; replaying it and changing the amount both failed`;
	});
	await test('the node signs nothing that is not a real, unpaid payout: an unknown one, or one the vault already paid', async () => {
		assert.match((await get('/exchange/release/p0000000000000000?setId=1')).error, /no such payout/);
		// once the vault paid it, the node has recorded it (x.done) and signs it no more
		assert.match((await get(`/exchange/release/${payout.id}?setId=1`)).error, /already paid/);
	});
	console.log(`\n${pass} tests passed`);
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { anvil.kill(); await node.stop(); testExchangeFrom(CHAIN, null); testExchangeVaults(CHAIN, null); }
