// Buying an NFT on another chain with DZY, written as attacks. A buyer locks DZY on Dznye and names one ERC-721 on an
// Ethereum-style chain; anyone (a "filler") holds the order, gets that NFT to the buyer there (bought on any marketplace,
// or their own), and names the transaction; validators check the delivery on that chain; the filler gets the DZY, less
// 0.1% to the Sun (validators and holders). One delivery counts once, an old one never counts, and nothing is created
// or lost. Run: node chain/nftbuy.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import { applyTx, balanceOf, DZY, genesis, holdings, nonceOf, RULES, signTx } from './src/ledger.ts';
import { checkEvmNft, EVM } from './src/evm.ts';

const CHAIN = 'dznye-nft-test', T0 = 1_000_000;
const auth = await newKey(), buyer = await newKey(), filler = await newKey(), eve = await newKey(), v2 = await newKey(), v3 = await newKey(), v4 = await newKey();
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const refuses = async (s, t, why, time = T0) => { const before = canon(s); await assert.rejects(applyTx(s, await t, time), why); assert.equal(canon(s), before, 'a refused transaction must change nothing'); };
const balanced = (s) => { const h = holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `supply of ${id}`); };
async function fresh(validators = [auth.address]) {
	const s = await genesis(CHAIN, auth.address, T0, validators);
	for (const who of [buyer, filler, eve]) await applyTx(s, await tx(s, auth, 'mint', { asset: 'DZY', amount: 1_000 * DZY, to: who.address }), T0);
	return s;
}
const xid = (id) => 'x' + id.slice(0, 16);
const NFT = '0x' + 'ab'.repeat(20), TO = '0x' + '12'.repeat(20), HASH = '0x' + '77'.repeat(32), HASH2 = '0x' + '78'.repeat(32);
const order = (extra = {}) => ({ give: { asset: 'DZY', amount: 500 * DZY }, want: { net: 'base', token: 'NFT', contract: NFT, id: '1234' }, payTo: TO, ...extra });

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };

await test('an NFT order: DZY held; a filler holds it, delivers, names the transaction; once validators confirm, the filler gets the DZY less 0.1% to the Sun', async () => {
	const s = await fresh();
	const x = xid(await applyTx(s, await tx(s, buyer, 'xoffer.create', order()), T0));
	assert.equal(balanceOf(s, buyer.address), 500 * DZY, 'the DZY were not held');
	assert.deepEqual(s.xoffers[x].want, { net: 'base', token: 'NFT', amount: 1, nft: { contract: NFT, id: '1234' } });
	await refuses(s, tx(s, filler, 'xoffer.reserve', { id: x, amount: 100 * DZY }), /delivered whole/);
	await applyTx(s, await tx(s, filler, 'xoffer.reserve', { id: x }), T0 + 10);
	assert.equal(s.xoffers[x].hold.from, T0 + 10, 'the hold does not say when it began');
	await applyTx(s, await tx(s, filler, 'xoffer.paid', { id: x, key: x + '-1', tx: HASH }), T0 + 20);
	const sun0 = s.treasury ?? 0;
	await applyTx(s, await tx(s, auth, 'xoffer.attest', { id: x, key: x + '-1', tx: HASH }), T0 + 30);
	const cut = Math.ceil((500 * DZY * RULES.xServiceBps) / 10_000);
	assert.equal(balanceOf(s, filler.address), 1_000 * DZY + 500 * DZY - cut, 'the filler was not paid the DZY less the cut');
	assert.equal((s.treasury ?? 0) - sun0, cut, 'the cut did not go to the Sun');
	assert.equal(s.xoffers, undefined);
	assert.ok(s.xseen['base:' + HASH], 'the delivery was not recorded');
	balanced(s);
	return `500 DZY to the filler less ${cut / DZY} DZY to the Sun`;
});

await test('one delivery counts once: the same transaction cannot settle a second order for the same NFT', async () => {
	const s = await fresh();
	const a = xid(await applyTx(s, await tx(s, buyer, 'xoffer.create', order()), T0));
	await applyTx(s, await tx(s, filler, 'xoffer.reserve', { id: a }), T0);
	await applyTx(s, await tx(s, auth, 'xoffer.attest', { id: a, key: a + '-1', tx: HASH }), T0);
	const b = xid(await applyTx(s, await tx(s, buyer, 'xoffer.create', order({ give: { asset: 'DZY', amount: 400 * DZY } })), T0));
	await applyTx(s, await tx(s, eve, 'xoffer.reserve', { id: b }), T0);
	await refuses(s, tx(s, auth, 'xoffer.attest', { id: b, key: b + '-1', tx: HASH }), /already counted/);
	balanced(s);
});

await test('bad orders are refused: NFTs only on Ethereum-style chains, a real contract, a whole-number id', async () => {
	const s = await fresh();
	await refuses(s, tx(s, buyer, 'xoffer.create', order({ want: { net: 'sol', token: 'NFT', contract: NFT, id: '1' } })), /Ethereum-style chains/);
	await refuses(s, tx(s, buyer, 'xoffer.create', order({ want: { net: 'base', token: 'NFT', contract: 'opensea', id: '1' } })), /contract of the NFT/);
	await refuses(s, tx(s, buyer, 'xoffer.create', order({ want: { net: 'base', token: 'NFT', contract: NFT, id: '-1' } })), /id of the NFT/);
	await refuses(s, tx(s, buyer, 'xoffer.create', order({ want: { net: 'base', token: 'NFT', contract: NFT, id: 1 } })), /id of the NFT/);
	await refuses(s, tx(s, buyer, 'xoffer.create', order({ want: { net: 'base', token: 'NFT', contract: NFT, id: '2'.repeat(80) } })), /id of the NFT/);
	await refuses(s, tx(s, buyer, 'xoffer.create', order({ give: { asset: 'DZY', amount: 5_000 * DZY } })), /not enough/);
});

await test('with four validators, one cannot release an NFT order alone; three of four can', async () => {
	const s = await fresh([auth.address, v2.address, v3.address, v4.address]);
	const x = xid(await applyTx(s, await tx(s, buyer, 'xoffer.create', order()), T0));
	await applyTx(s, await tx(s, filler, 'xoffer.reserve', { id: x }), T0);
	await applyTx(s, await tx(s, auth, 'xoffer.attest', { id: x, key: x + '-1', tx: HASH }), T0);
	await applyTx(s, await tx(s, v2, 'xoffer.attest', { id: x, key: x + '-1', tx: HASH }), T0);
	assert.ok(s.xoffers?.[x], 'released by two of four');
	await applyTx(s, await tx(s, v3, 'xoffer.attest', { id: x, key: x + '-1', tx: HASH }), T0);
	assert.equal(s.xoffers, undefined);
	balanced(s);
});

await test('the delivery check on the other chain: only a final, successful transfer of exactly that NFT to the buyer, made after the hold began', async () => {
	const AFTER = 1_700_000_000_000, word = (h) => '0x' + h.replace(/^0x/, '').padStart(64, '0');
	const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
	const make = (o = {}) => {
		const log = { address: NFT, topics: [TRANSFER, word('99'.repeat(20)), word(TO), word((1234).toString(16))], data: '0x', ...(o.log ?? {}) };
		const chain = { tx: { chainId: '0x' + EVM.base.id.toString(16) }, receipt: { status: '0x1', blockNumber: '0x64', logs: [log] }, final: '0x64', time: AFTER / 1000 + 60, ...o };
		return async (m, p) => m === 'eth_getTransactionByHash' ? chain.tx : m === 'eth_getTransactionReceipt' ? chain.receipt : m === 'eth_getBlockByNumber' ? (p[0] === 'finalized' ? { number: chain.final } : { number: p[0], timestamp: '0x' + Math.floor(chain.time).toString(16) }) : null;
	};
	const want = { payTo: TO, nft: { contract: NFT, id: '1234' }, after: AFTER };
	assert.equal(await checkEvmNft(make(), 'base', want, HASH), HASH, 'a real delivery was refused');
	assert.equal(await checkEvmNft(make({ final: '0x63' }), 'base', want, HASH), null, 'not final yet');
	assert.equal(await checkEvmNft(make({ receipt: { status: '0x0', blockNumber: '0x64', logs: [] } }), 'base', want, HASH), null, 'a failed transaction');
	assert.equal(await checkEvmNft(make({ time: AFTER / 1000 - 1 }), 'base', want, HASH), null, 'an old delivery, from before the hold');
	assert.equal(await checkEvmNft(make({ log: { topics: [TRANSFER, word('99'.repeat(20)), word(TO), word((1235).toString(16))] } }), 'base', want, HASH), null, 'another NFT of the same collection');
	assert.equal(await checkEvmNft(make({ log: { topics: [TRANSFER, word('99'.repeat(20)), word('34'.repeat(20)), word((1234).toString(16))] } }), 'base', want, HASH), null, 'delivered to someone else');
	assert.equal(await checkEvmNft(make({ log: { address: '0x' + 'cd'.repeat(20) } }), 'base', want, HASH), null, 'a look-alike contract');
	assert.equal(await checkEvmNft(make({ log: { topics: [TRANSFER, word('99'.repeat(20)), word(TO)], data: word((1234).toString(16)) } }), 'base', want, HASH), null, 'an ERC-20 transfer of 1234 units passed off as the NFT');
	assert.equal(await checkEvmNft(make({ tx: { chainId: '0x1' } }), 'base', want, HASH), null, 'a transaction on another chain');
	assert.equal(await checkEvmNft(make(), 'base', want, HASH2.slice(0, 20)), null, 'a bad hash');
});

console.log(`\n${pass} tests passed`);
