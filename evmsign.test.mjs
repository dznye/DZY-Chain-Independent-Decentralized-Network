// Signing on Ethereum-style chains (chain/src/evmsign.ts), checked against published vectors, then against the
// chain's own independent signature check (secp.ts recover). Run: node chain/evmsign.test.mjs
import assert from 'node:assert/strict';
import { evmAddressOf, hmacSha256, rlp, signBtcMessage, signDigest, signEvmTx, signPersonal } from './src/evmsign.ts';
import { btcAddressesOf, btcMessageSigners, pubBytes } from './src/btc.ts';
import { publicPoint } from './src/secp.ts';
import { ethAddress, keccak256, personalSigner, recover, SECP_N } from './src/secp.ts';
import { sha256 } from './src/btc.ts';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));
let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log('ok  ', name); };

test('HMAC-SHA256 matches RFC 4231 test case 2', () => {
	assert.equal(hex(hmacSha256(new TextEncoder().encode('Jefe'), new TextEncoder().encode('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});
test('RLP matches the examples in Ethereum\'s documentation', () => {
	assert.equal(hex(rlp(new TextEncoder().encode('dog'))), '83646f67');
	assert.equal(hex(rlp([new TextEncoder().encode('cat'), new TextEncoder().encode('dog')])), 'c88363617483646f67');
	assert.equal(hex(rlp(new Uint8Array(0))), '80');
	assert.equal(hex(rlp([])), 'c0');
	assert.equal(hex(rlp(Uint8Array.of(0x0f))), '0f');
	assert.equal(hex(rlp(Uint8Array.of(0x04, 0x00))), '820400');
	assert.equal(hex(rlp([[], [[]], [[], [[]]]])), 'c7c0c1c0c3c0c1c0');
	assert.equal(hex(rlp(new TextEncoder().encode('Lorem ipsum dolor sit amet, consectetur adipisicing elit'))).slice(0, 4), 'b838');
});
test('deterministic signing (RFC 6979) matches the well-known vector: key 1, "Satoshi Nakamoto"', () => {
	const s = signDigest(1n, sha256(new TextEncoder().encode('Satoshi Nakamoto')));
	assert.equal(s.r.toString(16), '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8');
	assert.equal(s.s.toString(16), '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5');
});
test('the EIP-155 example transaction is signed byte for byte as published', () => {
	const key = BigInt('0x' + '46'.repeat(32));
	assert.equal(evmAddressOf(key), '0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
	const t = signEvmTx(key, { nonce: 9, gasPrice: 20_000_000_000n, gas: 21000, to: '0x' + '35'.repeat(20), value: 10n ** 18n, data: '0x', chainId: 1 });
	assert.equal(t.raw, '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83');
	assert.equal(t.hash, '0x' + hex(keccak256(unhex(t.raw))));
});
test('every signature is recovered to its signer by the chain\'s own independent check, with low s, on all 7 chain ids', () => {
	for (const chainId of [1, 8453, 42161, 10, 137, 56, 43114]) {
		const key = BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(32)))) % (SECP_N - 1n) + 1n;
		const t = signEvmTx(key, { nonce: 3, gasPrice: 1234567n, gas: 60000, to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: 0n, data: '0xa9059cbb' + '00'.repeat(64), chainId });
		assert.ok(t.s <= SECP_N / 2n);
		assert.equal(ethAddress(recover(t.digest, t.r, t.s, t.odd)), evmAddressOf(key));
		assert.equal(signPersonal(key, 'hello ' + chainId) !== null, true);
		assert.equal(personalSigner('hello ' + chainId, signPersonal(key, 'hello ' + chainId)), evmAddressOf(key));
	}
});
test('bad input is refused: a key out of range, a bad address, a negative amount', () => {
	assert.throws(() => signEvmTx(0n, { nonce: 0, gasPrice: 1n, gas: 21000, to: '0x' + '35'.repeat(20), value: 0n, data: '0x', chainId: 1 }));
	assert.throws(() => signEvmTx(1n, { nonce: 0, gasPrice: 1n, gas: 21000, to: '0x35', value: 0n, data: '0x', chainId: 1 }));
	assert.throws(() => signEvmTx(1n, { nonce: 0, gasPrice: 1n, gas: 21000, to: '0x' + '35'.repeat(20), value: -1n, data: '0x', chainId: 1 }));
});
test('Bitcoin "Sign message" with a wallet key: the chain\'s own checker finds the signer\'s addresses, its native segwit (bc1q) one included', () => {
	for (let i = 1; i <= 5; i++) {
		const key = BigInt('0x' + hex(crypto.getRandomValues(new Uint8Array(32)))) % (SECP_N - 1n) + 1n, text = 'dzy-link:test ' + i;
		const sig = signBtcMessage(key, text), bc1q = btcAddressesOf(pubBytes(publicPoint(key), true))[2];
		assert.match(sig, /^[A-Za-z0-9+/]{87}=$/); assert.ok(bc1q.startsWith('bc1q'));
		assert.ok(btcMessageSigners(text, sig).includes(bc1q), 'the signer was not found');
		assert.ok(!btcMessageSigners(text + '!', sig).includes(bc1q), 'a changed text still matched');
	}
});
console.log(`${pass} tests passed`);
