// The market (part fills, end times, trade records), hash locks (swaps with other chains, pay-on-proof) and
// addresses linked on other chains. Written as attacks: each cheat must fail and leave no trace.
// Run: node chain/market.test.mjs
import assert from 'node:assert/strict';
import { canon, fromSolana, hex, newKey, sha256Bytes, sign, solanaAddress, toBase58 } from './src/crypto.ts';
import { applyTx, balanceOf, genesis, holdings, linkMessage, nonceOf, RULES, signTx, stateRoot } from './src/ledger.ts';

const CHAIN = 'dznye-test-1', T0 = 1_000_000;
const auth = await newKey(), alice = await newKey(), bob = await newKey(), eve = await newKey();
async function fresh() {
	const s = await genesis(CHAIN, auth.address, T0);
	s.assets.TOK = { symbol: 'TOK', name: 'Test token', issuer: auth.address, supply: 0, minted: 0, mintable: true, decimals: 0 };
	s.assets.USD = { symbol: 'USD', name: 'Test dollar', issuer: auth.address, supply: 0, minted: 0, mintable: true, decimals: 2 };
	await applyTx(s, await tx(s, auth, 'mint', { asset: 'TOK', amount: 1000, to: alice.address }), T0);
	await applyTx(s, await tx(s, auth, 'mint', { asset: 'USD', amount: 100_000, to: bob.address }), T0);
	await applyTx(s, await tx(s, auth, 'mint', { asset: 'USD', amount: 100_000, to: eve.address }), T0);
	return s;
}
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const refuses = async (s, t, why, time = T0) => {
	const before = canon(s);
	await assert.rejects(applyTx(s, await t, time), why);
	assert.equal(canon(s), before, 'a refused transaction must change nothing');
};
const balanced = (s) => { const h = holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `supply of ${id}`); };
const offerId = (id) => 'o' + id.slice(0, 16), lockId = (id) => 'sw' + id.slice(0, 16);

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };

await test('market: take part of an offer at its price; the rest stays open; trades are recorded', async () => {
	const s = await fresh();
	// alice sells 100 TOK for 30.00 USD (3000 parts): 0.30 each
	const o = offerId(await applyTx(s, await tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 100 }, want: { asset: 'USD', amount: 3000 } }), T0));
	await applyTx(s, await tx(s, bob, 'offer.take', { id: o, amount: 40 }), T0 + 1);
	assert.equal(balanceOf(s, bob.address, 'TOK'), 40);
	assert.equal(balanceOf(s, alice.address, 'USD'), 1200);
	assert.deepEqual(s.offers[o].give, { asset: 'TOK', amount: 60 });
	assert.deepEqual(s.offers[o].want, { asset: 'USD', amount: 1800 });
	await applyTx(s, await tx(s, eve, 'offer.take', { id: o }), T0 + 2); // the rest, all of it
	assert.equal(s.offers[o], undefined);
	assert.equal(balanceOf(s, alice.address, 'USD'), 3000, 'the maker gets exactly what was asked, in total');
	assert.equal(s.trades.length, 2);
	assert.deepEqual(s.trades.map((t) => [t.taker, t.sold.amount, t.paid.amount, t.t]), [[bob.address, 40, 1200, T0 + 1], [eve.address, 60, 1800, T0 + 2]]);
	balanced(s);
});

await test('market: rounding always favours the maker, and never gives anything away', async () => {
	const s = await fresh();
	// 3 TOK for 10 USD parts: one TOK costs 3.33… parts
	const o = offerId(await applyTx(s, await tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 3 }, want: { asset: 'USD', amount: 10 } }), T0));
	await applyTx(s, await tx(s, bob, 'offer.take', { id: o, amount: 1 }), T0);
	assert.equal(balanceOf(s, alice.address, 'USD'), 4, 'rounded up: 4, not 3');
	await applyTx(s, await tx(s, bob, 'offer.take', { id: o, amount: 1 }), T0);
	await applyTx(s, await tx(s, bob, 'offer.take', { id: o, amount: 1 }), T0);
	assert.equal(balanceOf(s, alice.address, 'USD'), 10, 'in total the maker gets exactly the asking price');
	assert.equal(balanceOf(s, bob.address, 'TOK'), 3);
	// a part so small its price would be the whole asking price is refused (it would leave coins for nothing)
	const p = offerId(await applyTx(s, await tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 100 }, want: { asset: 'USD', amount: 1 } }), T0));
	await refuses(s, tx(s, bob, 'offer.take', { id: p, amount: 1 }), /too small/);
	balanced(s);
});

await test('market: bad amounts, too much, and taking your own are refused', async () => {
	const s = await fresh();
	const o = offerId(await applyTx(s, await tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 10 }, want: { asset: 'USD', amount: 100 } }), T0));
	for (const amount of [0, -1, 11, '5', null]) await refuses(s, tx(s, bob, 'offer.take', { id: o, amount }), /amount|whole/);
	await refuses(s, tx(s, alice, 'offer.take', { id: o, amount: 1 }), /your own/);
	const poor = await newKey();
	await refuses(s, tx(s, poor, 'offer.take', { id: o, amount: 1 }), /not enough/);
});

await test('market: an offer with an end cannot be taken after it; then anyone can close it for the maker', async () => {
	const s = await fresh();
	await refuses(s, tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 1 }, want: { asset: 'USD', amount: 1 }, until: T0 }), /future/);
	await refuses(s, tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 1 }, want: { asset: 'USD', amount: 1 }, until: T0 + RULES.maxOfferTime + 1 }), /within a year/);
	const o = offerId(await applyTx(s, await tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: 10 }, want: { asset: 'USD', amount: 100 }, until: T0 + 1000 }), T0));
	await refuses(s, tx(s, eve, 'offer.cancel', { id: o }), /only the maker/, T0 + 1000); // not ended yet
	await refuses(s, tx(s, bob, 'offer.take', { id: o }), /ended/, T0 + 1001);
	await applyTx(s, await tx(s, eve, 'offer.cancel', { id: o }), T0 + 1001);
	assert.equal(balanceOf(s, alice.address, 'TOK'), 1000, 'the maker got everything back');
	assert.equal(balanceOf(s, eve.address, 'TOK'), 0, 'whoever closed it got nothing');
	balanced(s);
});

await test('market: only the newest trades are kept on the chain, and they are part of its fingerprint', async () => {
	const s = await fresh();
	const root0 = await stateRoot(s);
	const o = offerId(await applyTx(s, await tx(s, alice, 'offer.create', { give: { asset: 'TOK', amount: RULES.maxTrades + 5 }, want: { asset: 'USD', amount: RULES.maxTrades + 5 } }), T0));
	const rootOffer = await stateRoot(s);
	assert.notEqual(root0, rootOffer);
	for (let i = 0; i < RULES.maxTrades + 2; i++) await applyTx(s, await tx(s, bob, 'offer.take', { id: o, amount: 1 }), T0 + i);
	assert.equal(s.trades.length, RULES.maxTrades);
	assert.equal(s.trades.at(-1).t, T0 + RULES.maxTrades + 1);
	const before = await stateRoot(s);
	s.trades[0].paid.amount++; // a node lying about a past price
	assert.notEqual(await stateRoot(s), before);
});

await test('swaps: the receiver gets the coins with the right secret, before the end; the secret is published', async () => {
	const s = await fresh();
	const secret = hex(crypto.getRandomValues(new Uint8Array(32))), hash = await sha256Bytes(secret);
	const w = lockId(await applyTx(s, await tx(s, alice, 'swap.lock', { to: bob.address, asset: 'TOK', amount: 50, hash, until: T0 + 5000, note: 'for 5 USDC on Solana' }), T0));
	assert.equal(balanceOf(s, alice.address, 'TOK'), 950);
	balanced(s);
	const wrong = hex(crypto.getRandomValues(new Uint8Array(32)));
	await refuses(s, tx(s, bob, 'swap.claim', { id: w, secret: wrong }), /not the secret/, T0 + 1);
	await refuses(s, tx(s, bob, 'swap.claim', { id: w, secret: hash }), /not the secret/, T0 + 1); // the hash itself is not the secret
	await refuses(s, tx(s, bob, 'swap.claim', { id: w, secret: 'zz' }), /64 hex/, T0 + 1);
	await refuses(s, tx(s, alice, 'swap.refund', { id: w }), /not ended/, T0 + 4999);
	await applyTx(s, await tx(s, eve, 'swap.claim', { id: w, secret }), T0 + 2); // anyone may carry the claim: the coins still go to bob
	assert.equal(balanceOf(s, bob.address, 'TOK'), 50);
	assert.equal(balanceOf(s, eve.address, 'TOK'), 0);
	assert.equal(s.swaps, undefined);
	assert.deepEqual(s.swapLog.at(-1), { id: w, h: 1, hash, secret });
	await refuses(s, tx(s, bob, 'swap.claim', { id: w, secret }), /no such lock/, T0 + 3); // never twice
	balanced(s);
});

await test('swaps: after the end the coins can only go back to whoever locked them', async () => {
	const s = await fresh();
	const secret = hex(crypto.getRandomValues(new Uint8Array(32))), hash = await sha256Bytes(secret);
	const w = lockId(await applyTx(s, await tx(s, alice, 'swap.lock', { to: bob.address, asset: 'TOK', amount: 50, hash, until: T0 + 5000 }), T0));
	await refuses(s, tx(s, bob, 'swap.claim', { id: w, secret }), /ended/, T0 + 5000);
	await applyTx(s, await tx(s, eve, 'swap.refund', { id: w }), T0 + 5000);
	assert.equal(balanceOf(s, alice.address, 'TOK'), 1000);
	assert.equal(s.swapLog.at(-1).refunded, true);
	await refuses(s, tx(s, alice, 'swap.refund', { id: w }), /no such lock/, T0 + 6000);
	balanced(s);
});

await test('swaps: bad locks are refused', async () => {
	const s = await fresh();
	const hash = await sha256Bytes('00'.repeat(32)), ok = { to: bob.address, asset: 'TOK', amount: 5, hash, until: T0 + 10 };
	for (const [bad, why] of [[{ to: alice.address }, /receiver/], [{ to: 'x' }, /receiver/], [{ hash: 'AB'.repeat(32) }, /hash/], [{ until: T0 }, /future/], [{ until: T0 + RULES.maxSwapTime + 1 }, /30 days/], [{ amount: 5000 }, /not enough/], [{ asset: 'NOPE' }, /no such asset/], [{ note: 'x'.repeat(121) }, /note/]])
		await refuses(s, tx(s, alice, 'swap.lock', { ...ok, ...bad }), why);
	await refuses(s, tx(s, alice, 'swap.claim', { id: '__proto__', secret: '00'.repeat(32) }), /no such lock/);
});

await test('swaps: one secret matches what Bitcoin, Ethereum and Solana compute (SHA-256 of the raw bytes)', async () => {
	// NIST test vector: SHA-256("abc") as raw bytes
	assert.equal(await sha256Bytes('616263'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

await test('links: a Dznye address is a Solana address; a link needs that address to sign, for this account only', async () => {
	// known value: Solana's token program id
	assert.equal(fromSolana('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), '06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9');
	assert.equal(toBase58('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
	assert.equal(fromSolana(solanaAddress(alice.address)), alice.address);
	assert.equal(fromSolana('0OIl'), null);
	const s = await fresh();
	const phantom = await newKey(), sol = solanaAddress(phantom.address);
	const sig = await sign(phantom.secret, linkMessage(CHAIN, alice.address, 'sol', sol));
	await refuses(s, tx(s, bob, 'name.link', { net: 'sol', address: sol, sig }), /must sign/); // alice's proof, used by bob
	await refuses(s, tx(s, alice, 'name.link', { net: 'sol', address: sol, sig: await sign(eve.secret, linkMessage(CHAIN, alice.address, 'sol', sol)) }), /must sign/);
	await refuses(s, tx(s, alice, 'name.link', { net: 'doge', address: sol, sig }), /you can link/);
	await refuses(s, tx(s, alice, 'name.link', { net: 'eth', address: sol, sig }), /bad address/); // a Solana address and proof, passed off as Ethereum
	await refuses(s, tx(s, alice, 'name.link', { net: 'sol', address: 'not-base58!', sig }), /bad address/);
	await applyTx(s, await tx(s, alice, 'name.link', { net: 'sol', address: sol, sig }), T0);
	assert.deepEqual(s.accounts[alice.address].links, { sol });
	await applyTx(s, await tx(s, alice, 'name.link', { net: 'sol', address: null }), T0);
	assert.equal(s.accounts[alice.address].links, undefined);
	await refuses(s, tx(s, alice, 'name.link', { net: 'sol', address: null }), /nothing linked/);
});

await test('random: thousands of mixed trades, part fills, locks, claims and refunds keep every supply exact', async () => {
	const s = await fresh(), who = [alice, bob, eve], secrets = new Map();
	await applyTx(s, await tx(s, auth, 'mint', { asset: 'TOK', amount: 5000, to: bob.address }), T0);
	await applyTx(s, await tx(s, auth, 'mint', { asset: 'USD', amount: 5000, to: alice.address }), T0);
	let seed = 7; const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
	let t = T0, ok = 0;
	for (let i = 0; i < 1500; i++) {
		t += rnd(400);
		const p = who[rnd(3)], q = who[rnd(3)], asset = rnd(2) ? 'TOK' : 'USD', offers = Object.keys(s.offers), locks = Object.keys(s.swaps ?? {});
		const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
		const [type, data] = [
			['offer.create', { give: { asset, amount: rnd(200) + 1 }, want: { asset: asset === 'TOK' ? 'USD' : 'TOK', amount: rnd(200) + 1 }, ...(rnd(2) ? { until: t + rnd(5000) + 1 } : {}) }],
			['offer.take', { id: offers[rnd(offers.length || 1)] ?? 'none', ...(rnd(2) ? { amount: rnd(60) + 1 } : {}) }],
			['offer.cancel', { id: offers[rnd(offers.length || 1)] ?? 'none' }],
			['swap.lock', { to: q.address, asset, amount: rnd(100) + 1, hash: await sha256Bytes(secret), until: t + rnd(3000) + 1 }],
			['swap.claim', { id: locks[rnd(locks.length || 1)] ?? 'none', secret: secrets.get(locks[0]) ?? secret }],
			['swap.refund', { id: locks[rnd(locks.length || 1)] ?? 'none' }]
		][rnd(6)];
		const before = canon(s);
		try { const id = await applyTx(s, await tx(s, p, type, data), t); ok++; if (type === 'swap.lock') secrets.set(lockId(id), secret); }
		catch { assert.equal(canon(s), before); }
		balanced(s);
	}
	assert.ok(ok > 300, `enough of them went through (${ok})`);
});

console.log(`\n${pass} tests passed`);
