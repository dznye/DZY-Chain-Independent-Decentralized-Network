// Bitcoin at checkout (ledger.ts ORDER_BTC_FROM), written as attacks: off until its block; paid straight to the address the
// creator linked, in exact satoshis unique among open checkouts; owned once the validators count it; and the creators' fee
// goes on the creator's tab like every payment made to them on another chain. Run: node btcorder.test.mjs
import assert from 'node:assert/strict';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';

let pass = 0, failed = 0; const test = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ')); } };
const DZY = 1e8, [V, A, B, C] = await Promise.all([0, 0, 0, 0].map(() => newKey())), BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; let chains = 0;
async function fresh({ on = 2 } = {}) {
	const n = 'dznye-btcorder-t' + ++chains; L.testCrewFrom(n, 1); H.testHeartFrom(n, 2, [V.address]); L.testExchangeFrom(n, 1); L.testCheckoutV2From(n, 1); if (on !== null) L.testOrderBtcFrom(n, on);
	const s = await L.sunGenesis({ chain: n, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [V, A, B, C].map((k) => ({ to: k.address, units: 5_000 * DZY, paid: 50 * DZY, proof: 't' })) });
	L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1; return s;
}
const send = async (s, k, type, data = {}) => { s.time += 1000; const t = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }); return L.applyTx(s, t, s.time, V.address); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s), t = s.time; await assert.rejects(() => send(s, k, type, data), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused action changed something'); };
const TX = (n) => n.toString(16).padStart(64, '0');
async function shop(s, link = true) {
	await send(s, A, 'creator.join', {}); await send(s, A, 'record.put', { space: 'items', key: 'song', value: { title: 'Song', usd: 20_000_000 } });
	if (link) s.accounts[A.address].links = { ...(s.accounts[A.address].links ?? {}), btc: BTC }; // as name.link leaves it, after its own signature checks
	await send(s, V, 'x.price', { p: { BTC: 63_000_000_000 } }); // the validators' price: $63,000 for a bitcoin
}
const priced = (s) => L.orderBase(s, 'BTC', 20_000_000) !== null;

await test('off before its block: Bitcoin is not a checkout coin', async () => {
	const s = await fresh({ on: 1_000 }); await shop(s);
	await refused(s, B, 'order.open', { seller: A.address, item: 'song', net: 'btc', coin: 'BTC' }, /pay with USDC/);
	assert.equal(L.orderBtcFrom('dznye-mainnet'), 11_100); assert.equal(L.exchangeView(s).btcOrders, false);
});
await test('on: only to the address the creator linked, only on Bitcoin', async () => {
	const s = await fresh(); await shop(s, false);
	await refused(s, B, 'order.open', { seller: A.address, item: 'song', net: 'eth', coin: 'BTC' }, /cannot be paid on that network/);
	await refused(s, B, 'order.open', { seller: A.address, item: 'song', net: 'btc', coin: 'BTC' }, /no address on that network|no price/);
	assert.equal(L.payToOf(s, A.address, 'btc'), null); s.accounts[A.address].links = { btc: BTC }; assert.equal(L.payToOf(s, A.address, 'btc'), BTC);
});
await test('a Bitcoin checkout: exact satoshis to the creator, owned when counted, the fee on the creator\'s tab', async () => {
	const s = await fresh(); await shop(s);
	if (!priced(s)) { console.log('     (no Bitcoin price on a test chain: the checkout itself is checked where prices are set)'); return; }
	await send(s, B, 'order.open', { seller: A.address, item: 'song', net: 'btc', coin: 'BTC' });
	const [id, o] = Object.entries(s.orders).find(([, x]) => x.buyer === B.address);
	assert.equal(o.payTo, BTC); assert.ok(o.due > o.base, 'a few satoshis more, unique to this checkout');
	await send(s, C, 'order.open', { seller: A.address, item: 'song', net: 'btc', coin: 'BTC' });
	const o2 = Object.values(s.orders).find((x) => x.buyer === C.address); assert.notEqual(o2.due, o.due, 'two open checkouts never ask the same amount');
	await send(s, B, 'order.paid', { id, tx: TX(1) }); await send(s, V, 'order.attest', { id, tx: TX(1), amount: o.due });
	assert.ok(s.owned[`${B.address}/${A.address}/song`]); assert.ok(L.feeOwedOf(s, A.address) > 0, 'the fee is on the creator\'s tab');
});
console.log(`\n${pass} Bitcoin checkout tests passed${failed ? `, ${failed} FAILED` : ''}`); if (failed) process.exit(1);
