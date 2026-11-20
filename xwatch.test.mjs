// The exchange's watchers (src/xwatch.ts), written as attacks, with no network: a deposit line printed by some other
// program does not count; prices come only from the chains' own pools and are left out when they do not check out (the
// dollar coins not a dollar; ETH's route through BTC and its dollar pool disagreeing); and readings are posted again only
// when they moved or went stale. Run: node chain/xwatch.test.mjs
import assert from 'node:assert/strict';
import { averageTick, PRICE_POOLS, pricesWorthPosting, programLines, readChainPrices, scanEvmVault, depositsInTx, DEPOSIT_TOPIC, feedPrice, FEED_MAX_AGE_S } from './src/xwatch.ts';

const results = [];
async function test(name, fn) {
	try { const note = await fn(); results.push(['PASS', name, note ?? '']); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); }
	const r = results.at(-1); console.log(`${r[0]}  ${r[1]}${r[2] ? '  — ' + r[2] : ''}`);
}
const VAULT = 'Va1t111111111111111111111111111111111111111', OTHER = 'Evi1111111111111111111111111111111111111111';

await test('Only lines printed by the vault program itself count: a lookalike line from another program in the same transaction is ignored', async () => {
	const logs = [
		`Program ${OTHER} invoke [1]`, 'Program log: dznye-deposit SOL ' + 'ab'.repeat(32) + ' 999000000000', `Program ${OTHER} success`,
		`Program ${VAULT} invoke [1]`, `Program 11111111111111111111111111111111 invoke [2]`, `Program 11111111111111111111111111111111 success`,
		'Program log: dznye-deposit SOL ' + 'cd'.repeat(32) + ' 2000000000', `Program ${VAULT} success`,
		`Program ${OTHER} invoke [1]`, `Program ${VAULT} invoke [2]`, 'Program log: dznye-released ' + 'ef'.repeat(32) + ' 5', `Program ${VAULT} success`, 'Program log: dznye-deposit SOL ' + '12'.repeat(32) + ' 7', `Program ${OTHER} success`,
	];
	assert.deepEqual(programLines(logs, VAULT), ['dznye-deposit SOL ' + 'cd'.repeat(32) + ' 2000000000', 'dznye-released ' + 'ef'.repeat(32) + ' 5']);
});

/** a stand-in Ethereum node answering observe() for each pool with a given average tick over 1,800 seconds */
const fakeEth = (ticks) => async (method, params) => {
	if (method !== 'eth_call') throw new Error('no');
	const pool = Object.entries(PRICE_POOLS).find(([, a]) => a.toLowerCase() === params[0].to.toLowerCase())?.[0];
	if (!pool || ticks[pool] === undefined) throw new Error('no pool');
	const w = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
	return '0x' + w(64) + w(64 + 32 * 3) + w(2) + w(0) + w(ticks[pool] * 1800) + w(2) + w(0) + w(0);
};
const tickFor = (price, d0, d1) => Math.round(Math.log(price / Math.pow(10, d0 - d1)) / Math.log(1.0001)); // token1 per token0
const MARKET = { WBTC_USDC: tickFor(64_000, 8, 6), USDC_WETH: tickFor(1 / 1_800, 6, 18), WBTC_WETH: tickFor(64_000 / 1_800, 8, 18), USDC_USDT: 0 };

await test('Prices come from the pools: BTC from WBTC/USDC, ETH through BTC and checked against its dollar pool, USDC a dollar', async () => {
	const p = await readChainPrices(fakeEth(MARKET), null);
	assert.ok(Math.abs(p.BTC / 1e6 - 64_000) < 64_000 * 0.001, `BTC ${p.BTC}`);
	assert.ok(Math.abs(p.ETH / 1e6 - 1_800) < 1_800 * 0.001, `ETH ${p.ETH}`);
	assert.equal(p.USDC, 1_000_000);
	assert.equal(await averageTick(fakeEth({ WBTC_USDC: -5 }), PRICE_POOLS.WBTC_USDC), -5, 'a negative average tick was read wrong');
	return `BTC $${(p.BTC / 1e6).toFixed(0)}, ETH $${(p.ETH / 1e6).toFixed(2)}`;
});

await test('No price at all when the dollar coins are not a dollar; no ETH when its BTC route and dollar pool disagree by over 2%', async () => {
	assert.deepEqual(await readChainPrices(fakeEth({ ...MARKET, USDC_USDT: tickFor(0.95, 6, 6) }), null), {}, 'priced with USDC at 95 cents');
	const p = await readChainPrices(fakeEth({ ...MARKET, WBTC_WETH: tickFor(64_000 / 1_900, 8, 18) }), null); // ETH at $1,900 by BTC, $1,800 by dollars
	assert.equal(p.ETH, undefined, 'ETH priced although its two routes disagree');
	assert.ok(p.BTC > 0, 'BTC lost too');
});

await test('A reading is posted again only when it moved more than 0.5%, went 30 minutes stale, or a coin became readable', async () => {
	const mine = { at: 1_000_000, p: { BTC: 64_000_000_000 } };
	assert.equal(pricesWorthPosting(mine, { BTC: 64_100_000_000 }, 1_060_000), false, '0.16% reposted');
	assert.equal(pricesWorthPosting(mine, { BTC: 64_500_000_000 }, 1_060_000), true, '0.8% not reposted');
	assert.equal(pricesWorthPosting(mine, { BTC: 64_000_000_000 }, 1_000_000 + 31 * 60_000), true, 'a stale reading not refreshed');
	assert.equal(pricesWorthPosting(mine, { BTC: 64_000_000_000, SOL: 150_000_000 }, 1_060_000), true, 'a newly readable coin not posted');
	assert.equal(pricesWorthPosting(mine, {}, 2_000_000_000), false, 'nothing read, yet posted');
});

await test('Each network\'s vault is read with its own coins: BNB on BNB Chain, POL on Polygon, USDT at 18 decimals on BNB Chain and 6 on Arbitrum; a token the exchange does not take is never counted', async () => {
	const V = '0x' + 'ab'.repeat(20), TO = 'cd'.repeat(32), w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0'), t = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
	const log = (token, raw, i) => ({ address: V, topics: [DEPOSIT_TOPIC, t(token), t('0x' + '11'.repeat(20)), '0x' + TO], data: w(raw), transactionHash: '0x' + String(i).padStart(64, '0'), logIndex: '0x0' });
	const rpcWith = (logs) => async (m) => (m === 'eth_getLogs' ? logs : null);
	const ZERO = '0x' + '0'.repeat(40);
	const bsc = await scanEvmVault(rpcWith([log(ZERO, 10n ** 17n, 1), log('0x55d398326f99059fF775485246999027B3197955', 25n * 10n ** 18n, 2), log('0x' + '99'.repeat(20), 10n ** 30n, 3)]), V, 'bsc', 1, 2);
	assert.deepEqual(bsc.deposits.map((d) => [d.coin, d.amount]), [['BNB', 100_000_000], ['USDT', 25_000_000]], 'BNB Chain read wrong, or an unknown token was counted');
	const poly = await scanEvmVault(rpcWith([log(ZERO, 5n * 10n ** 18n, 4)]), V, 'polygon', 1, 2);
	assert.deepEqual(poly.deposits.map((d) => [d.coin, d.amount]), [['POL', 5_000_000_000]]);
	const arb = await scanEvmVault(rpcWith([log(ZERO, 10n ** 16n, 5), log('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 7_000_000n, 6)]), V, 'arb', 1, 2);
	assert.deepEqual(arb.deposits.map((d) => [d.coin, d.amount]), [['ETH', 10_000_000], ['USDT', 7_000_000]]);
});

await test('A price feed counts only while it is fresh and positive: a stuck feed, a negative answer or one dated in the future is no price', async () => {
	const now = 1_800_000_000_000, w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
	const feed = (answer, updated) => async () => '0x' + w(1) + w(answer) + w(updated) + w(updated) + w(1);
	assert.equal(await feedPrice(feed(58_600_000_000n, now / 1000 - 600), '0x', now), 586);
	assert.equal(await feedPrice(feed(58_600_000_000n, now / 1000 - FEED_MAX_AGE_S - 60), '0x', now), 0, 'a stale feed counted');
	assert.equal(await feedPrice(feed(58_600_000_000n, now / 1000 - 8 * 3600), '0x', now), 586, 'an 8-hour-old answer (within the daily heartbeat) was refused');
	assert.equal(await feedPrice(feed(58_600_000_000n, now / 1000 - 26 * 3600), '0x', now), 0, 'a day-and-more-old answer (a stuck feed) counted');
	assert.equal(await feedPrice(feed(-5n, now / 1000 - 60), '0x', now), 0, 'a negative answer counted');
	assert.equal(await feedPrice(feed(58_600_000_000n, now / 1000 + 3600), '0x', now), 0, 'a future-dated answer counted');
});

const failed = results.filter((r) => r[0] === 'FAIL').length;
await test('A payment named by a wallet counts only by its own receipt: a final deposit into this vault counts; one not final yet waits; a failed, foreign, other-vault or made-up one gives nothing', async () => {
	const V = '0x' + 'ab'.repeat(20), TO = 'cd'.repeat(32), H = '0x' + '7'.repeat(64), w = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0'), t = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
	const ZERO = '0x' + '0'.repeat(40);
	const log = (addr, raw) => ({ address: addr, topics: [DEPOSIT_TOPIC, t(ZERO), t('0x' + '11'.repeat(20)), '0x' + TO], data: w(raw), transactionHash: H, logIndex: '0x0' });
	const rpcWith = (receipt) => async (m, p) => (m === 'eth_getTransactionReceipt' ? (p[0] === H ? receipt : null) : null);
	const ok = { transactionHash: H, blockNumber: '0x64', status: '0x1', logs: [log(V, 10n ** 13n)] };
	const got = await depositsInTx(rpcWith(ok), V, 'bsc', H, 100);
	assert.deepEqual(got.deposits.map((d) => [d.coin, d.amount, d.to]), [['BNB', 10_000, TO]], 'a real final deposit was not counted');
	assert.equal(await depositsInTx(rpcWith(ok), V, 'bsc', H, 99), null, 'a payment not yet final was counted');
	assert.equal(await depositsInTx(rpcWith(null), V, 'bsc', H, 100), null, 'an unknown payment was counted');
	assert.deepEqual((await depositsInTx(rpcWith({ ...ok, status: '0x0' }), V, 'bsc', H, 100)).deposits, [], 'a failed payment was counted');
	assert.deepEqual((await depositsInTx(rpcWith({ ...ok, logs: [log('0x' + 'ee'.repeat(20), 10n ** 18n)] }), V, 'bsc', H, 100)).deposits, [], 'a deposit into another contract was counted');
	assert.deepEqual((await depositsInTx(rpcWith({ ...ok, transactionHash: '0x' + '8'.repeat(64) }), V, 'bsc', H, 100)).deposits, [], 'a receipt for another payment was counted');
	assert.deepEqual((await depositsInTx(rpcWith(ok), V, 'bsc', 'not-a-tx', 100)).deposits, [], 'a made-up id was looked up');
});

console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
