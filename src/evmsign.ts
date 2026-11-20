/* Signing on Ethereum and the chains that work like it (Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche), in
   plain code with no library: what lets the Dznye wallet use its OWN Ethereum-style key (the one in its PIN locker)
   the way MetaMask does, instead of sending people to another wallet.

   - signDigest: secp256k1 signatures with the nonce made from the key and the message (RFC 6979), never from chance, so
     a weak random source can never leak the key; s is always the lower of its two twins (as Ethereum requires).
   - signEvmTx: a transaction in the form every one of the 7 chains accepts (EIP-155, which names the chain inside the
     signature, so a payment signed for one chain can never be replayed on another).
   - signPersonal: "personal_sign" (EIP-191), what sites ask a wallet to sign as text.

   Checked against published vectors (the EIP-155 example, RFC 6979, RFC 4231) and against the chain's own independent
   signature check in secp.ts (chain/evmsign.test.mjs). Runs only where the key is: the wallet's page or a person's
   own computer. The chain itself never signs with, or sees, such a key. Plain whole-number arithmetic, not hardened
   against timing measurements: fine for a person's own device, not for a shared server. */
import { btcMessageHash, sha256 } from './btc.ts';
import { ethAddress, keccak256, personalHash, publicPoint, SECP_N } from './secp.ts';

const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const bytes32 = (v: bigint) => { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; };
const big = (b: Uint8Array) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => { const t = h.replace(/^0x/, ''); if (t.length % 2 || /[^0-9a-fA-F]/.test(t)) throw new Error('Not hex'); return Uint8Array.from(t.match(/../g) ?? [], (x) => parseInt(x, 16)); };
const mod = (v: bigint, m: bigint) => ((v % m) + m) % m;
const power = (b: bigint, e: bigint, m: bigint) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };

/** HMAC-SHA256 (RFC 2104), synchronous */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
	const k = new Uint8Array(64); k.set(key.length > 64 ? sha256(key) : key);
	return sha256(cat(k.map((b) => b ^ 0x5c), sha256(cat(k.map((b) => b ^ 0x36), msg))));
}

/** RLP, Ethereum's way of writing bytes and lists of them */
export type RlpItem = Uint8Array | RlpItem[];
export function rlp(item: RlpItem): Uint8Array {
	const head = (len: number, short: number) => {
		if (len < 56) return Uint8Array.of(short + len);
		const l: number[] = []; for (let n = len; n > 0; n = Math.floor(n / 256)) l.unshift(n % 256);
		return Uint8Array.of(short + 55 + l.length, ...l);
	};
	if (item instanceof Uint8Array) return item.length === 1 && item[0] < 0x80 ? item : cat(head(item.length, 0x80), item);
	const body = cat(...item.map(rlp));
	return cat(head(body.length, 0xc0), body);
}
/** a whole number as RLP wants it: big-endian, no leading zero bytes, and zero as no bytes at all */
const num = (v: bigint | number) => { let b = BigInt(v); if (b < 0n) throw new Error('A negative number'); const out: number[] = []; for (; b > 0n; b >>= 8n) out.unshift(Number(b & 0xffn)); return Uint8Array.from(out); };

const checkKey = (key: bigint) => { if (typeof key !== 'bigint' || key <= 0n || key >= SECP_N) throw new Error('Not a secp256k1 key'); };
/** the Ethereum-style address (0x + 40 lower-case hex) of a key: the same on all 7 chains */
export function evmAddressOf(key: bigint): string { checkKey(key); return ethAddress(publicPoint(key)!); }

/** Sign a 32-byte digest: { r, s, odd } with s in the lower half; `odd` is the recovery bit (y of the nonce point) */
export function signDigest(key: bigint, digest: Uint8Array): { r: bigint; s: bigint; odd: boolean } {
	checkKey(key);
	if (digest.length !== 32) throw new Error('A digest is 32 bytes');
	const x = bytes32(key), z = mod(big(digest), SECP_N), h1 = bytes32(z);
	let V = new Uint8Array(32).fill(1), K = new Uint8Array(32);
	K = hmacSha256(K, cat(V, Uint8Array.of(0), x, h1)); V = hmacSha256(K, V);
	K = hmacSha256(K, cat(V, Uint8Array.of(1), x, h1)); V = hmacSha256(K, V);
	for (;;) {
		V = hmacSha256(K, V);
		const k = big(V);
		if (k > 0n && k < SECP_N) {
			const R = publicPoint(k)!, r = mod(R[0], SECP_N);
			let s = mod(power(k, SECP_N - 2n, SECP_N) * (z + r * key), SECP_N), odd = (R[1] & 1n) === 1n;
			if (r !== 0n && s !== 0n && R[0] < SECP_N) {
				if (s > SECP_N / 2n) { s = SECP_N - s; odd = !odd; }
				return { r, s, odd };
			}
		}
		K = hmacSha256(K, cat(V, Uint8Array.of(0))); V = hmacSha256(K, V);
	}
}

/** one transaction: amounts in the chain's smallest unit (wei), `data` as 0x-hex, `to` a 0x address */
export interface EvmTx { nonce: number | bigint; gasPrice: bigint; gas: number | bigint; /** a 0x address, or '' to create a contract */ to: string; value: bigint; data: string; chainId: number }
/** Sign a transaction (EIP-155). Returns the raw transaction to send (eth_sendRawTransaction), its hash, and the signature. */
export function signEvmTx(key: bigint, t: EvmTx) {
	if (t.to !== '' && !/^0x[0-9a-fA-F]{40}$/.test(t.to)) throw new Error('Not an address: ' + t.to); // '' creates a contract
	if (!Number.isSafeInteger(t.chainId) || t.chainId <= 0) throw new Error('Not a chain id');
	const fields = [num(t.nonce), num(t.gasPrice), num(t.gas), unhex(t.to), num(t.value), unhex(t.data || '0x')];
	const digest = keccak256(rlp([...fields, num(t.chainId), new Uint8Array(0), new Uint8Array(0)]));
	const { r, s, odd } = signDigest(key, digest);
	const raw = rlp([...fields, num(BigInt(t.chainId) * 2n + 35n + (odd ? 1n : 0n)), num(r), num(s)]);
	return { raw: '0x' + hexOf(raw), hash: '0x' + hexOf(keccak256(raw)), digest, r, s, odd };
}

/** personal_sign (EIP-191): 0x + r ‖ s ‖ v (27 or 28), as MetaMask returns it */
export function signPersonal(key: bigint, text: string): string {
	const { r, s, odd } = signDigest(key, personalHash(text));
	return '0x' + hexOf(bytes32(r)) + hexOf(bytes32(s)) + (odd ? '1c' : '1b');
}

/** Bitcoin's "Sign message" (BIP-137, compressed key): base64 of a header byte and r ‖ s, as Bitcoin wallets give it.
    Checked by the chain's own btcMessageSigners, which finds every address of the signing key (1…, 3…, bc1q…). */
export function signBtcMessage(key: bigint, text: string): string {
	const { r, s, odd } = signDigest(key, btcMessageHash(text)), raw = new Uint8Array(65);
	raw[0] = 31 + (odd ? 1 : 0); raw.set(bytes32(r), 1); raw.set(bytes32(s), 33);
	let bin = ''; for (const b of raw) bin += String.fromCharCode(b);
	return btoa(bin);
}
