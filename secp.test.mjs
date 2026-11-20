// Ethereum's hash (Keccak-256) and signature check (secp256k1), written by hand in src/secp.ts: checked against
// published vectors, against Node's own independent secp256k1, and as attacks (altered, twinned and malformed
// signatures). Run: node chain/secp.test.mjs
import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { ethAddress, keccak256, personalHash, personalSigner, publicPoint, recover, SECP_N } from './src/secp.ts';
import { canon, newKey } from './src/crypto.ts';
import { applyTx, balanceOf, genesis, linkMessage, nonceOf, signTx, stateRoot } from './src/ledger.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };
const hex = (b) => Buffer.from(b).toString('hex'), utf = (s) => new TextEncoder().encode(s);
const big = (b) => BigInt('0x' + hex(b));
const b32 = (v) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex');

/* a signer, for tests only (the chain never signs): the textbook ECDSA formula with a nonce derived from the key and the hash */
const inv = (v, m) => { let r = 1n, b = ((v % m) + m) % m, e = m - 2n; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
function signHash(secret, hash) {
	for (let n = 0; ; n++) {
		const k = big(createHash('sha256').update(b32(secret)).update(hash).update(String(n)).digest()) % SECP_N;
		const R = k ? publicPoint(k) : null;
		if (!R) continue;
		const r = R[0] % SECP_N;
		let s = (inv(k, SECP_N) * (big(hash) + r * secret)) % SECP_N, odd = (R[1] & 1n) === 1n;
		if (!r || !s) continue;
		if (s > SECP_N / 2n) { s = SECP_N - s; odd = !odd; } // the lower twin, as every Ethereum wallet gives
		return { r, s, odd };
	}
}
const personalSign = (secret, text) => { const { r, s, odd } = signHash(secret, personalHash(text)); return '0x' + hex(b32(r)) + hex(b32(s)) + (odd ? '1c' : '1b'); };

await test('Keccak-256 matches the published values (empty, "abc", a long input, every block-edge length)', async () => {
	assert.equal(hex(keccak256(utf(''))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
	assert.equal(hex(keccak256(utf('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
	// the well-known function selectors: the first 4 bytes of Keccak-256 of the signature text
	assert.equal(hex(keccak256(utf('transfer(address,uint256)'))).slice(0, 8), 'a9059cbb');
	assert.equal(hex(keccak256(utf('Transfer(address,address,uint256)'))), 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
	assert.equal(hex(keccak256(utf('The quick brown fox jumps over the lazy dog'))), '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15');
	// lengths around the 136-byte block edge all give different, stable 32-byte results
	const seen = new Set();
	for (const n of [0, 1, 135, 136, 137, 271, 272, 273, 1000]) { const h = hex(keccak256(new Uint8Array(n).fill(7))); assert.equal(h.length, 64); seen.add(h); }
	assert.equal(seen.size, 9);
});

await test('public keys match Node\'s own secp256k1 for 40 random keys; key 1 gives the published address', async () => {
	assert.equal(ethAddress(publicPoint(1n)), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
	assert.equal(ethAddress(publicPoint(2n)), '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf');
	for (let i = 0; i < 40; i++) {
		const secret = randomBytes(32), ecdh = createECDH('secp256k1');
		ecdh.setPrivateKey(secret);
		const theirs = ecdh.getPublicKey(), [x, y] = publicPoint(big(secret));
		assert.equal('04' + hex(b32(x)) + hex(b32(y)), hex(theirs), 'the same point as Node computes');
	}
	assert.equal(publicPoint(0n), null); assert.equal(publicPoint(SECP_N), null);
});

await test('the published personal_sign vector recovers its signer (web3 documentation); a published key gives its address (ethers)', async () => {
	assert.equal(ethAddress(publicPoint(0x0123456789012345678901234567890123456789012345678901234567890123n)), '0x14791697260e4c9a71f18484c9f997b308e59325');
	// web3: key 0x4c08...2318 signs "Some data"
	assert.equal(hex(personalHash('Some data')), '1da44b586eb0729ff70a73c326926f6ed5a25f5b056e7f47fbc6e58d86871655');
	assert.equal(personalSigner('Some data', '0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c'), '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
	assert.equal(ethAddress(publicPoint(0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318n)), '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
});

await test('60 random keys and messages: the signer is recovered, and only for exactly that message', async () => {
	for (let i = 0; i < 60; i++) {
		const secret = (big(randomBytes(32)) % (SECP_N - 1n)) + 1n, me = ethAddress(publicPoint(secret)), text = 'dzy-link:' + hex(randomBytes(i));
		const sig = personalSign(secret, text);
		assert.equal(personalSigner(text, sig), me);
		assert.notEqual(personalSigner(text + '!', sig), me, 'another message');
		assert.equal(personalSigner(text, sig.slice(0, 130) + (sig.endsWith('1b') ? '00' : '01')), me, 'v as 0 or 1 is the same signature');
	}
});

await test('attacks: an altered, twinned, out-of-range or malformed signature never names the signer, and never throws', async () => {
	const secret = 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789n, me = ethAddress(publicPoint(secret)), text = 'dzy-link:test';
	const sig = personalSign(secret, text), r = BigInt('0x' + sig.slice(2, 66)), s = BigInt('0x' + sig.slice(66, 130)), v = sig.slice(130);
	const make = (rr, ss, vv) => '0x' + hex(b32(rr)) + hex(b32(ss)) + vv;
	assert.equal(personalSigner(text, make(r, s, v)), me);
	// the twin: (r, N - s) with the other recovery bit is the same signature in the upper half. Ethereum refuses it; so do we.
	assert.equal(personalSigner(text, make(r, SECP_N - s, v === '1b' ? '1c' : '1b')), null, 'the upper-half twin');
	assert.notEqual(personalSigner(text, make(r, s, v === '1b' ? '1c' : '1b')), me, 'the other recovery bit is someone else');
	assert.notEqual(personalSigner(text, make(r + 1n, s, v)), me);
	assert.notEqual(personalSigner(text, make(r, s + 1n, v)), me);
	for (const bad of [make(0n, s, v), make(r, 0n, v), make(SECP_N, s, v), make(r, SECP_N, v), make(r, s, '1d'), make(r, s, '02'), make(r, s, 'ff')]) assert.equal(personalSigner(text, bad), null);
	for (const bad of [null, undefined, 5, {}, '', '0x', sig.slice(2), sig.toUpperCase(), sig + '00', sig.slice(0, -2), '0x' + 'zz'.repeat(65)]) assert.equal(personalSigner(text, bad), null);
	// an r that is not the x of any point on the curve
	let off = 5n; while (recover(personalHash(text), off, s, false) !== null) off++;
	assert.equal(personalSigner(text, make(off, s, '1b')), null);
	assert.equal(recover(new Uint8Array(31), r, s, false), null, 'a hash of the wrong length');
});

/* ---- on the chain: one @name, and one address for Ethereum and every chain that shares its addresses ---- */
const CHAIN = 'dznye-test-1', T0 = 1_000_000;
const auth = await newKey(), alice = await newKey(), bob = await newKey();
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const refuses = async (s, t, why) => { const before = canon(s); await assert.rejects(applyTx(s, await t, T0), why); assert.equal(canon(s), before, 'a refused transaction must change nothing'); };
async function fresh() {
	const s = await genesis(CHAIN, auth.address, T0);
	s.assets.TOK = { symbol: 'TOK', name: 'Test token', issuer: auth.address, supply: 0, minted: 0, mintable: true, decimals: 0 };
	for (const who of [alice, bob]) await applyTx(s, await tx(s, auth, 'mint', { asset: 'TOK', amount: 1000, to: who.address }), T0);
	return s;
}
const WALLET = 0x1111111111111111111111111111111111111111111111111111111111111111n, EVE = 0x2222222222222222222222222222222222222222222222222222222222222222n;
const walletAddr = ethAddress(publicPoint(WALLET));
const xo = (s, id) => s.xoffers['x' + id.slice(0, 16)];

await test('linking an Ethereum address: only its own wallet\'s signature, for this account, on this chain, links it', async () => {
	const s = await fresh();
	const text = linkMessage(CHAIN, alice.address, 'eth', walletAddr), sig = personalSign(WALLET, text);
	const link = (who, data) => tx(s, who, 'name.link', { net: 'eth', address: walletAddr, sig, ...data });
	await refuses(s, link(bob, {}), /must sign/); // alice's proof, taken by bob: the message names alice's account
	await refuses(s, link(alice, { sig: personalSign(EVE, text) }), /must sign/); // someone else's wallet claiming this address
	await refuses(s, link(alice, { sig: personalSign(WALLET, linkMessage('dznye-1', alice.address, 'eth', walletAddr)) }), /must sign/); // a proof made for another chain
	await refuses(s, link(alice, { sig: personalSign(WALLET, linkMessage(CHAIN, alice.address, 'sol', walletAddr)) }), /must sign/); // a proof made for another network
	await refuses(s, link(alice, { address: ethAddress(publicPoint(EVE)) }), /must sign/); // the proof is for another address
	await refuses(s, link(alice, { address: '0x' + walletAddr.slice(2).toUpperCase() }), /bad address/);
	await refuses(s, link(alice, { address: walletAddr.slice(0, 40) }), /bad address/);
	for (const bad of ['', 'nope', sig.slice(0, -2), sig + '00', sig.slice(0, 130) + '1d']) await refuses(s, link(alice, { sig: bad }), /must sign/);
	// the upper-half twin of the real signature: the same proof in another spelling, refused
	const r = BigInt('0x' + sig.slice(2, 66)), sv = BigInt('0x' + sig.slice(66, 130));
	await refuses(s, link(alice, { sig: '0x' + hex(b32(r)) + hex(b32(SECP_N - sv)) + (sig.endsWith('1b') ? '1c' : '1b') }), /must sign/);
	const root = await stateRoot(s);
	await applyTx(s, await link(alice, {}), T0);
	assert.deepEqual(s.accounts[alice.address].links, { eth: walletAddr });
	assert.notEqual(await stateRoot(s), root, 'links are part of the chain\'s fingerprint');
	// an offer paid on any EVM chain now needs no address typed: it is paid at the linked one
	const want = (net) => ({ give: { asset: 'TOK', amount: 1 }, want: { net, token: 'USDC', amount: 5 } });
	for (const net of ['base', 'polygon', 'bsc']) assert.equal(xo(s, await applyTx(s, await tx(s, alice, 'xoffer.create', want(net)), T0)).payTo, walletAddr);
	const other = '0x' + 'ab'.repeat(20);
	const id = await applyTx(s, await tx(s, alice, 'xoffer.create', { ...want('base'), payTo: other }), T0);
	assert.equal(xo(s, id).payTo, other, 'an address given by hand still wins');
	await refuses(s, tx(s, bob, 'xoffer.create', want('base')), /0x address/); // bob linked nothing
	// a Solana offer is untouched by an Ethereum link
	assert.notEqual(xo(s, await applyTx(s, await tx(s, alice, 'xoffer.create', want('sol')), T0)).payTo, walletAddr);
	// unlink: offers already made keep the address they were made with; new ones need one again
	await applyTx(s, await tx(s, alice, 'name.link', { net: 'eth', address: null }), T0);
	assert.equal(s.accounts[alice.address].links, undefined);
	assert.equal(xo(s, id).payTo, other);
	await refuses(s, tx(s, alice, 'xoffer.create', want('base')), /0x address/);
	assert.equal(balanceOf(s, alice.address, 'TOK'), 1000 - 5);
});

console.log(`\n${pass} tests passed`);
