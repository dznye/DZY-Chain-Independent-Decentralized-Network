// The safe file (src/safe.ts): one PIN-sealed file for every wallet of an account, written as attacks.
// Run: node chain/safe.test.mjs
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { sign, verify } from './src/crypto.ts';
import { deriveDznye, deriveSecp, deriveSeed, isKeysFile, isSafeFile, makePin, newMaster, openKeys, openSafe, PIN_MIN, pinProblem, scrypt, sealKeys, sealSafe, sealSafeV1, SAFE_N } from './src/safe.ts';

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const te = new TextEncoder(), hex = (b) => Buffer.from(b).toString('hex');
const FAST = { N: 1 << 10 }; // the tests seal with a small N; the wallet uses SAFE_N

await test('scrypt matches the standard (RFC 7914) and Node\'s own scrypt, byte for byte', async () => {
	// RFC 7914, test vector 2
	assert.equal(hex(await scrypt(te.encode('password'), te.encode('NaCl'), 1024, 8, 16, 64)),
		'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640');
	for (const [pw, salt, N] of [['k7m2-qx9v-br4t-h8wn', 'salt-1', 1 << 12], ['a much longer pass phrase, with spaces', 'été', 1 << 11]])
		assert.equal(hex(await scrypt(te.encode(pw), te.encode(salt), N, 8, 1, 32)), scryptSync(pw, salt, 32, { N, r: 8, p: 1 }).toString('hex'));
});
await test('the wallet\'s setting costs real memory and time for every guess', async () => {
	const t = Date.now();
	await scrypt(te.encode('k7m2-qx9v-br4t-h8wn'), te.encode('s'), SAFE_N, 8, 1, 32);
	const ms = Date.now() - t;
	assert.ok(ms > 50, 'too fast to slow anyone down');
	return `one guess: ${ms} ms and ${(128 * 8 * SAFE_N / 1024 / 1024).toFixed(0)} MB here (N = 2^17, r = 8)`;
});
await test('a PIN of fewer than 12 characters, or an obvious one, is refused; a made PIN is strong and easy to type', async () => {
	for (const bad of ['123456', '12345678901', 'aaaaaaaaaaaaaaaa', '123456789012', 'abcdefghijklmnop']) assert.notEqual(pinProblem(bad), '', bad);
	assert.equal(pinProblem('my dog likes rain'), '');
	const pins = new Set(Array.from({ length: 200 }, makePin));
	assert.equal(pins.size, 200, 'two made PINs were the same');
	for (const p of pins) { assert.match(p, /^[2-9a-z]{4}-[2-9a-z]{4}-[2-9a-z]{4}-[2-9a-z]{4}$/); assert.doesNotMatch(p, /[01oli]/); assert.equal(pinProblem(p), ''); }
	return `e.g. ${[...pins][0]}: 31^16 = 2^${(16 * Math.log2(31)).toFixed(0)} possibilities; at least ${PIN_MIN} characters for a PIN of one's own`;
});
await test('old files (version 1) still open: the right PIN gives back the master secret; a wrong PIN, a changed file or another address gives nothing', async () => {
	const master = newMaster(), me = (await deriveDznye(master)).address, pin = makePin();
	const f = await sealSafeV1(master, pin, me, FAST);
	assert.ok(isSafeFile(f)); assert.equal(f.address, me);
	assert.ok(!JSON.stringify(f).includes(master), 'the secret is in the file in the clear');
	assert.equal(await openSafe(f, pin), master);
	await assert.rejects(openSafe(f, pin + 'x'), /Wrong PIN/);
	await assert.rejects(openSafe({ ...f, data: f.data.slice(0, -2) + (f.data.endsWith('00') ? '01' : '00') }, pin), /Wrong PIN|changed/);
	await assert.rejects(openSafe({ ...f, address: 'b'.repeat(64) }, pin), /Wrong PIN|changed/);
	await assert.rejects(sealSafeV1(master, 'short', me, FAST), /at least 12/);
	const g = await sealSafeV1(master, pin, me, FAST);
	assert.notEqual(g.data, f.data, 'two seals of the same secret look the same (no fresh salt and nonce)');
});
await test('one master secret, every wallet: the same master always gives the same wallets; each chain and each number is a different, unlinkable key', async () => {
	const m = newMaster();
	const d0 = await deriveDznye(m), d0b = await deriveDznye(m), d1 = await deriveDznye(m, 1);
	assert.deepEqual(d0, d0b); assert.notEqual(d0.address, d1.address);
	assert.ok(await verify(d0.address, 'hello', await sign(d0.secret, 'hello')), 'the derived Dznye key does not sign');
	const e0 = await deriveSecp(m, 'eth', 0), e1 = await deriveSecp(m, 'eth', 1), b0 = await deriveSecp(m, 'btc', 0);
	assert.equal(new Set([e0, e1, b0, await deriveSeed(m, 'dznye', 0)]).size, 4, 'two wallets share a key');
	assert.equal(e0, await deriveSecp(m, 'eth', 0));
	assert.notEqual((await deriveDznye(newMaster())).address, d0.address);
	await assert.rejects(deriveSeed('nope', 'eth'), /bad master/);
});

await test('the new seal (version 2) names no address and holds no check: only the PIN\'s salt and the mixed secret', async () => {
	const master = newMaster(), me = (await deriveDznye(master)).address, pin = makePin();
	const f = await sealSafe(master, pin, me, FAST);
	assert.ok(isSafeFile(f)); assert.equal(f.v, 2);
	assert.deepEqual(Object.keys(f).sort(), ['data', 'kdf', 'kind', 'v'], 'the file carries something that could tell a right PIN from a wrong one');
	assert.ok(!JSON.stringify(f).includes(me), 'the address is in the file');
	assert.ok(!JSON.stringify(f).includes(master), 'the secret is in the file in the clear');
	assert.equal(f.data.length, 64, 'more than the 32 mixed bytes: room for a check value');
	const g = await sealSafe(master, pin, me, FAST);
	assert.notEqual(g.data, f.data, 'two seals of the same secret look the same (no fresh salt)');
	await assert.rejects(sealSafe(master, 'short', me, FAST), /at least 12/);
});
await test('every PIN opens a wallet, like a Rubik\'s cube: the right PIN opens yours; a wrong one opens a valid, different wallet (the same one each time), never an error', async () => {
	const master = newMaster(), pin = makePin(), f = await sealSafe(master, pin, '', FAST);
	assert.equal(await openSafe(f, pin), master, 'the right PIN did not open the wallet');
	const seen = new Set([master]);
	for (const guess of [pin + 'x', pin.slice(1), 'a'.repeat(12), '1234', '', 'correct horse battery staple']) {
		const m = await openSafe(f, guess); // no exception: nothing says "wrong"
		assert.match(m, /^[0-9a-f]{64}$/, 'a wrong PIN gave something that is not a master secret');
		assert.ok(!seen.has(m), 'two PINs opened the same wallet');
		seen.add(m);
		assert.equal(await openSafe(f, guess), m, 'the same wrong PIN opened a different wallet the second time');
		const k = await deriveDznye(m); // a real key: it signs, and the signature checks
		assert.ok(await verify(k.address, 'probe', await sign(k.secret, 'probe')));
	}
});
await test('a decoy PIN is just another PIN: its wallet is stable, so you can put a little in it, and it never reveals the real one', async () => {
	const master = newMaster(), pin = makePin(), decoy = makePin(), f = await sealSafe(master, pin, '', FAST);
	const d1 = await openSafe(f, decoy), d2 = await openSafe(f, decoy);
	assert.equal(d1, d2); assert.notEqual(d1, master);
	assert.notEqual((await deriveDznye(d1)).address, (await deriveDznye(master)).address);
});
await test('an old file opened with its PIN and sealed again the new way gives exactly the same wallets', async () => {
	const master = newMaster(), pin = makePin(), me = (await deriveDznye(master)).address;
	const old = await sealSafeV1(master, pin, me, FAST), again = await sealSafe(await openSafe(old, pin), pin, me, FAST);
	assert.equal((await deriveDznye(await openSafe(again, pin))).address, me);
	assert.equal(await deriveSecp(await openSafe(again, pin), 'eth', 0), await deriveSecp(master, 'eth', 0));
});

/* ---------- the keys file: every chain's keys of a wallet not made from a safe file ---------- */
const KEYS = { eth: 'a1'.repeat(32), btc: '5c'.repeat(32) };
await test('the keys file gives back exactly the 0x and Bitcoin keys with the right PIN', async () => {
	const f = await sealKeys(KEYS, '4829-1650-ka7q', FAST);
	assert.ok(isKeysFile(f) && !isSafeFile(f));
	assert.deepEqual(await openKeys(f, '4829-1650-ka7q'), KEYS);
	assert.deepEqual(await openKeys(JSON.parse(JSON.stringify(f)), '4829-1650-ka7q'), KEYS, 'survives being saved and loaded as JSON');
});
await test('attack: the file names no address and holds no key in the clear', async () => {
	const f = await sealKeys(KEYS, 'my dog likes rain', FAST), text = JSON.stringify(f);
	assert.ok(!text.includes(KEYS.eth) && !text.includes(KEYS.btc), 'a key is readable');
	assert.ok(!/0x[0-9a-f]{40}|bc1/.test(text), 'an address is in the file');
	assert.deepEqual(Object.keys(f).sort(), ['data', 'kdf', 'kind', 'v']);
});
await test('attack: a wrong PIN never says "wrong": it opens other, valid-looking keys, the same ones each time', async () => {
	const f = await sealKeys(KEYS, '4829-1650-ka7q', FAST);
	const a = await openKeys(f, '482917'), b = await openKeys(f, '482917'), c = await openKeys(f, '000000');
	assert.notDeepEqual(a, KEYS); assert.notDeepEqual(c, KEYS); assert.notDeepEqual(a, c);
	assert.deepEqual(a, b, 'the same wrong PIN gives the same wallet');
	for (const k of [a.eth, a.btc, c.eth, c.btc]) assert.match(k, /^[0-9a-f]{64}$/);
});
await test('attack: the same keys sealed twice look unrelated (fresh salt), and a tampered or foreign file is refused', async () => {
	const f1 = await sealKeys(KEYS, '4829-1650-ka7q', FAST), f2 = await sealKeys(KEYS, '4829-1650-ka7q', FAST);
	assert.notEqual(f1.data, f2.data); assert.notEqual(f1.kdf.salt, f2.kdf.salt);
	await assert.rejects(openKeys({ ...f1, data: 'zz' }, '4829-1650-ka7q'));
	await assert.rejects(openKeys({ ...f1, kdf: { ...f1.kdf, N: 1 << 30 } }, '4829-1650-ka7q'), /settings/);
	await assert.rejects(openKeys({ kind: 'dznye-safe', v: 2, kdf: f1.kdf, data: f1.data.slice(0, 64) }, '4829-1650-ka7q'));
	await assert.rejects(sealKeys(KEYS, '123', FAST), /PIN/); await assert.rejects(sealKeys({ eth: 'x', btc: KEYS.btc }, '4829-1650-ka7q', FAST));
});
await test('the wallet keys file costs a full scrypt per guess, like the safe file', async () => {
	const f = await sealKeys(KEYS, '4829-1650-ka7q');
	assert.equal(f.kdf.N, SAFE_N); assert.equal(f.kdf.r, 8);
});
console.log(`\n${pass} tests passed`);
