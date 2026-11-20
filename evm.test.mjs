// Paying on Ethereum and the chains like it (chain/src/evm.ts), checked against the real chains. Needs the internet;
// nothing is spent. Run: node chain/evm.test.mjs
import assert from 'node:assert/strict';
import { anyRpc, checkEvmPayment, EVM, evmScale, memoHex, paymentRequest } from './src/evm.ts';

const TRANSFER_EVENT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (name) => { pass++; console.log('ok  ', name); };

// 1. the payment a wallet sends, byte by byte
{
	const to = '0x' + 'ab'.repeat(20), r = paymentRequest('base', 'USDC', to, 1_500_000, 'dzy:x1-1');
	assert.equal(r.to, EVM.base.usdc); assert.equal(r.value, '0x0'); assert.equal(r.chainId, '0x2105');
	assert.equal(r.data, '0xa9059cbb' + to.slice(2).padStart(64, '0') + (1_500_000).toString(16).padStart(64, '0') + memoHex('dzy:x1-1'));
	const e = paymentRequest('eth', 'ETH', to, 1_000_000_000, 'dzy:x1-1'); // 1 ETH = 10^9 Dznye units
	assert.equal(BigInt(e.value), 10n ** 18n); assert.equal(e.to, to); assert.equal(e.data, '0x' + memoHex('dzy:x1-1'));
	assert.equal(BigInt('0x' + paymentRequest('bsc', 'USDC', to, 1_000_000, 'm').data.slice(74, 138)), 10n ** 18n, 'BNB Chain USDC has 18 decimals there');
	assert.throws(() => paymentRequest('base', 'BNB', to, 1, 'm'), /ETH or USDC/);
	assert.throws(() => paymentRequest('base', 'USDC', '0x12', 1, 'm'), /Bad address/);
	ok('payment requests: USDC with the memo after its arguments, coins with the memo as data, the right scale');
}

// 2. on every chain: a real finalized USDC payment and a real coin payment pass the check (with an empty memo, since
//    real payments carry none), and each change refuses it
for (const [net, c] of Object.entries(EVM)) {
	const rpc = anyRpc(c.rpc);
	const fin = BigInt((await rpc('eth_getBlockByNumber', ['finalized', false])).number), latest = BigInt(await rpc('eth_blockNumber', []));
	// a plain USDC transfer() call (no extra data) from a finalized block
	// (looked for in up to eight windows of 30 final blocks, newest first: a quiet minute on a chain must not fail the test)
	let usdcDone = false;
	for (let w = 0n; w < 8n && !usdcDone; w++) {
	const logs = await rpc('eth_getLogs', [{ address: c.usdc, topics: [TRANSFER_EVENT], fromBlock: '0x' + (fin - 30n * (w + 1n) + 1n).toString(16), toBlock: '0x' + (fin - 30n * w).toString(16) }]);
	for (const l of logs.slice(0, 40)) {
		const tx = await rpc('eth_getTransactionByHash', [l.transactionHash]);
		if (!tx || tx.to?.toLowerCase() !== c.usdc || tx.input.length !== 2 + 8 + 128 || !tx.input.startsWith('0xa9059cbb')) continue;
		const payTo = '0x' + tx.input.slice(34, 74), units = BigInt('0x' + tx.input.slice(74, 138)), scale = 10n ** BigInt(evmScale(net, 'USDC'));
		if (units < scale) continue;
		const amount = Number(units / scale), want = { payTo, token: 'USDC', amount, memo: '' };
		assert.equal(await checkEvmPayment(rpc, net, want, tx.hash), tx.hash, `${net}: a real USDC payment passes`);
		assert.equal(await checkEvmPayment(rpc, net, { ...want, memo: 'dzy:x1-1' }, tx.hash), null, 'without our memo it does not count');
		assert.equal(await checkEvmPayment(rpc, net, { ...want, amount: amount + 1 }, tx.hash), null, 'one unit short');
		assert.equal(await checkEvmPayment(rpc, net, { ...want, payTo: '0x' + '12'.repeat(20) }, tx.hash), null, 'to someone else');
		assert.equal(await checkEvmPayment(rpc, net, { ...want, token: c.coin }, tx.hash), null, 'not a coin payment');
		usdcDone = true; break;
	}
	}
	// a plain coin payment (no data) to a wallet, from a finalized block
	let coinDone = false;
	for (let b = fin; b > fin - 24n && !coinDone; b--) {
		const blk = await rpc('eth_getBlockByNumber', ['0x' + b.toString(16), true]);
		for (const tx of blk.transactions) {
			if (tx.input !== '0x' || !tx.to || BigInt(tx.value) < 10n ** 9n) continue;
			const receipt = await rpc('eth_getTransactionReceipt', [tx.hash]);
			if (receipt.status !== '0x1') continue;
			const amount = Number(BigInt(tx.value) / 10n ** 9n), want = { payTo: tx.to, token: c.coin, amount, memo: '' };
			assert.equal(await checkEvmPayment(rpc, net, want, tx.hash), tx.hash, `${net}: a real ${c.coin} payment passes`);
			assert.equal(await checkEvmPayment(rpc, net, { ...want, memo: 'dzy:x1-1' }, tx.hash), null);
			assert.equal(await checkEvmPayment(rpc, net, { ...want, amount: amount + 1 }, tx.hash), null);
			assert.equal(await checkEvmPayment(rpc, net, { ...want, token: 'USDC' }, tx.hash), null);
			coinDone = true; break;
		}
	}
	// a payment that is not final yet is not counted (on chains where final is far behind)
	let notFinal = 'skipped (final there within seconds)';
	if (latest - fin > 20n) {
		const blk = await rpc('eth_getBlockByNumber', ['latest', true]);
		const tx = blk.transactions.find((t) => t.input === '0x' && t.to && BigInt(t.value) >= 10n ** 9n);
		if (tx) { assert.equal(await checkEvmPayment(rpc, net, { payTo: tx.to, token: c.coin, amount: Number(BigInt(tx.value) / 10n ** 9n), memo: '' }, tx.hash), null, 'not final yet'); notFinal = 'refused'; }
	}
	// a transaction that does not exist: refused, or the node will not say (some free nodes refuse such lookups); never counted
	assert.equal(await checkEvmPayment(rpc, net, { payTo: '0x' + '12'.repeat(20), token: 'USDC', amount: 1, memo: 'x' }, '0x' + '00'.repeat(32)).catch(() => null), null, 'a transaction that does not exist');
	assert.ok(usdcDone || coinDone, `${net}: found real payments to check`);
	ok(`${c.name.padEnd(9)} USDC ${usdcDone ? 'checked' : 'none found'} · ${c.coin} ${coinDone ? 'checked' : 'none found'} · not final: ${notFinal}`);
	await pause(300);
}
console.log(`\n${pass} tests passed`);
