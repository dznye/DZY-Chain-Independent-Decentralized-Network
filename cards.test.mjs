// Cards that are real NFTs (ledger.ts nftItemsOn), written as attacks: an item names its creator's own Heart NFT; buying it,
// paying from another chain, or buying it from an owner hands over the copy in the same step; a creator with no copy left
// cannot sell one, and a checkout already paid then gives the buyer their money back. Nothing is made or lost.
// Run: node cards.test.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';
import * as F from './src/blobs.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { const n = await fn(); pass++; console.log('ok  ', name, n ? '— ' + n : ''); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, [V, A, B, C] = await Promise.all([0, 0, 0, 0].map(() => newKey())), VAULT = '0x' + '11'.repeat(20); let chains = 0;
async function fresh({ cards = 2 } = {}) {
	const n = 'dznye-cards-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); L.testExchangeVaults(n, { base: VAULT }); L.testCheckoutV2From(n, 1); if (cards !== null) L.testNftItemsFrom(n, cards);
	const s = await L.sunGenesis({ chain: n, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [V, A, B, C].map((k) => ({ to: k.address, units: 5_000 * DZY, paid: 50 * DZY, proof: 't' })) });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1; return s;
}
const send = async (s, k, type, data = {}, side) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, side ? { ...t, side } : t, s.time, V.address); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s), t = s.time; await assert.rejects(() => send(s, k, type, data), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused action changed something'); };
const bal = (s, k, a = 'DZY') => L.balanceOf(s, k.address, a);
const whole = (s) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) if (!id.startsWith('x')) assert.equal(h[id] ?? 0, a.supply, id); };
/** the creator's card: a picture in the blocks, and `copies` NFTs of it */
async function card(s, k = A, copies = 3) {
	const p = F.parts(randomBytes(20_000), 'image/webp'); await send(s, k, 'blob.in', { ...p.open, years: 1 }); for (const x of p.parts) await send(s, k, 'blob.part', x.data, x.side);
	await send(s, k, 'nft.make', { blob: p.id, symbol: 'ART', name: 'Card', copies, royalty: 140 });
	return Object.keys(s.assets).filter((x) => s.assets[x].nft?.by === k.address).at(-1);
}
const item = (nft, more = {}) => ({ title: 'Card', kind: 'nft', usd: 2_000_000, editions: 3, ...(nft ? { nft } : {}), ...more });
const put = async (s, k, value, key = 'card') => { if (!s.creators?.[k.address]) await send(s, k, 'creator.join', {}); return send(s, k, 'record.put', { space: 'items', key, value }); };
const buy = (s, k, key = 'card', seller = A) => send(s, k, 'item.buy', { seller: seller.address, item: key, asset: 'DZY', max: 1_000 * DZY });

await test('an item may name only its creator\'s own NFT, with as many editions as copies, and never as a membership', async () => {
	const s = await fresh(), mine = await card(s), theirs = await card(s, B, 3);
	await refused(s, A, 'record.put', { space: 'items', key: 'card', value: item(theirs) }, /only one you made/);
	await refused(s, A, 'record.put', { space: 'items', key: 'card', value: item(mine, { editions: 4 }) }, /as many editions/);
	await refused(s, A, 'record.put', { space: 'items', key: 'card', value: item(mine, { editions: undefined }) }, /as many editions/);
	await refused(s, A, 'record.put', { space: 'items', key: 'card', value: item(mine, { every: 'month' }) }, /as many editions/);
	await refused(s, A, 'record.put', { space: 'items', key: 'card', value: item('nffffffffffffffff') }, /an NFT on this chain/);
	await put(s, A, item(mine)); whole(s);
});
await test('buying hands the buyer a copy in the same step; when the creator holds none, it is sold out and nothing moves', async () => {
	const s = await fresh(), n = await card(s); await put(s, A, item(n));
	await buy(s, B); assert.equal(bal(s, B, n), 1); assert.equal(bal(s, A, n), 2); assert.equal(s.owned[`${B.address}/${A.address}/card`].ed, 1);
	await send(s, A, 'transfer', { asset: n, to: C.address, amount: 2 }); // the creator lets the rest go elsewhere
	await refused(s, C, 'item.buy', { seller: A.address, item: 'card', asset: 'DZY', max: 1_000 * DZY }, /holds no copy/); whole(s);
});
await test('resale moves the card: only who holds it offers it; one given away cannot be bought from them', async () => {
	const s = await fresh(), n = await card(s); await put(s, A, item(n)); await buy(s, B);
	await send(s, B, 'resale.list', { seller: A.address, item: 'card', usd: 5_000_000, bps: 200 });
	await send(s, C, 'resale.buy', { owner: B.address, seller: A.address, item: 'card', asset: 'DZY', usd: 5_000_000, max: 1_000 * DZY });
	assert.equal(bal(s, C, n), 1); assert.equal(bal(s, B, n), 0); assert.equal(s.owned[`${C.address}/${A.address}/card`].ed, 1);
	await send(s, C, 'transfer', { asset: n, to: B.address, amount: 1 }); // C gives the card away, but still has the shop's record
	await refused(s, C, 'resale.list', { seller: A.address, item: 'card', usd: 6_000_000, bps: 200 }, /do not hold the card/);
	const t = await fresh(), m = await card(t); await put(t, A, item(m)); await buy(t, B); await send(t, B, 'resale.list', { seller: A.address, item: 'card', usd: 5_000_000, bps: 200 }); await send(t, B, 'transfer', { asset: m, to: C.address, amount: 1 });
	await refused(t, C, 'resale.buy', { owner: B.address, seller: A.address, item: 'card', asset: 'DZY', usd: 5_000_000, max: 1_000 * DZY }, /not for sale any more/); whole(s); whole(t);
});
/* a checkout paid from another chain into the vault: order.open, order.paid, then the validators */
const TX = (n) => '0x' + n.toString(16).padStart(64, '0');
async function checkout(s, k, i) { await send(s, k, 'order.open', { seller: A.address, item: 'card', net: 'base', coin: 'USDC' }); const [id, o] = Object.entries(s.orders).find(([, x]) => x.buyer === k.address); await send(s, k, 'order.paid', { id, tx: TX(i) }); return [id, o]; }
await test('paid from another chain: the card is handed over when the payment counts; only through a vault', async () => {
	const s = await fresh(), n = await card(s); await put(s, A, item(n, { usd: 20_000_000 })); // $20: more than the $5 a new shop owes from its first sales
	await refused(s, B, 'order.open', { seller: A.address, item: 'card', net: 'sol', coin: 'USDC' }, /paid into a vault/);
	const [id, o] = await checkout(s, B, 1); await send(s, V, 'order.attest', { id, tx: TX(1), amount: o.due });
	assert.equal(bal(s, B, n), 1); assert.equal(bal(s, A, n), 2); assert.ok(bal(s, A, 'xUSDC') > 10_000_000, 'the creator is paid'); whole(s);
});
await test('a creator who let every copy go before the payment counted: the buyer gets the money back on Dznye, the creator nothing', async () => {
	const s = await fresh(), n = await card(s, A, 1); await put(s, A, item(n, { editions: 1 }));
	const [id, o] = await checkout(s, B, 2); await send(s, A, 'transfer', { asset: n, to: C.address, amount: 1 });
	const a0 = bal(s, A, 'xUSDC'); await send(s, V, 'order.attest', { id, tx: TX(2), amount: o.due });
	assert.equal(bal(s, B, 'xUSDC'), o.due, 'all of it back'); assert.equal(bal(s, A, 'xUSDC'), a0); assert.equal(bal(s, B, n), 0); assert.equal(s.orders, undefined); assert.equal(s.owned?.[`${B.address}/${A.address}/card`], undefined); whole(s);
	await refused(s, C, 'order.open', { seller: A.address, item: 'card', net: 'base', coin: 'USDC' }, /holds no copy/);
});
await test('before its block (and on the live chain until the owner sets one) an item\'s nft is only words: nothing moves', async () => {
	const s = await fresh({ cards: 1_000 }), n = await card(s); await put(s, A, item(n, { editions: 9 })); await buy(s, B);
	assert.equal(bal(s, B, n), 0); assert.ok(s.owned[`${B.address}/${A.address}/card`]); assert.equal(L.nftItemsFrom('dznye-mainnet'), 11_100); assert.equal(L.exchangeView(s).nftItems.open, false); whole(s);
});
console.log(`\n${pass} card tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
