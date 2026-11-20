/* The two pieces of Ethereum's cryptography Dznye needs, in plain code with no library: Keccak-256 (Ethereum's hash)
   and public-key recovery on the secp256k1 curve (how Ethereum, and Bitcoin, prove who signed). With them the chain
   can check, by itself, that the owner of an Ethereum address agreed to something: an address on Ethereum, Base,
   Arbitrum, Optimism, Polygon, BNB Chain and Avalanche is the same 20 bytes, so one proof covers all of them.

   This file only CHECKS signatures. It never holds or makes a key, so it has no secret to leak through timing.
   Everything is whole-number arithmetic: the same input gives the same answer on every machine, as the chain's
   rules need. Tested against published vectors and an independent implementation (chain/secp.test.mjs). */

/* ---- Keccak-256 (the original Keccak padding, as Ethereum uses; not the later SHA3-256) ---- */
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
	0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // by x + 5y
const rotl = (v: bigint, n: number) => (n ? ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64 : v);
function permute(a: bigint[]) {
	const c = new Array<bigint>(5), b = new Array<bigint>(25);
	for (let round = 0; round < 24; round++) {
		for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
		for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) a[x + y] ^= d; }
		for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
		for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & M64 & b[((x + 2) % 5) + y]);
		a[0] ^= RC[round];
	}
}
/** Keccak-256 of bytes: 32 bytes */
export function keccak256(data: Uint8Array): Uint8Array {
	const RATE = 136, padded = new Uint8Array((Math.floor(data.length / RATE) + 1) * RATE);
	padded.set(data); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
	const a = new Array<bigint>(25).fill(0n);
	for (let off = 0; off < padded.length; off += RATE) {
		for (let i = 0; i < RATE / 8; i++) { let lane = 0n; for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]); a[i] ^= lane; }
		permute(a);
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((a[i] >> BigInt(8 * j)) & 0xffn);
	return out;
}

/* ---- secp256k1: y² = x³ + 7 over the prime P; the group has N points ---- */
export const SECP_P = 2n ** 256n - 2n ** 32n - 977n;
export const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (v: bigint, m: bigint) => ((v % m) + m) % m;
const power = (b: bigint, e: bigint, m: bigint) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const inverse = (v: bigint, m: bigint) => power(v, m - 2n, m); // m is prime
/* points in Jacobian form (X, Y, Z) stand for (X/Z², Y/Z³); Z = 0 is the point at infinity */
type Point = [bigint, bigint, bigint];
const INF: Point = [0n, 1n, 0n];
function double([x, y, z]: Point): Point {
	if (!z || !y) return INF;
	const P = SECP_P, y2 = (y * y) % P, s = (4n * x * y2) % P, m = (3n * x * x) % P;
	const nx = mod(m * m - 2n * s, P);
	return [nx, mod(m * (s - nx) - 8n * y2 * y2, P), (2n * y * z) % P];
}
function add(a: Point, b: Point): Point {
	if (!a[2]) return b;
	if (!b[2]) return a;
	const P = SECP_P, z1 = (a[2] * a[2]) % P, z2 = (b[2] * b[2]) % P;
	const u1 = (a[0] * z2) % P, u2 = (b[0] * z1) % P, s1 = (a[1] * z2 * b[2]) % P, s2 = (b[1] * z1 * a[2]) % P;
	if (u1 === u2) return s1 === s2 ? double(a) : INF;
	const h = mod(u2 - u1, P), r = mod(s2 - s1, P), h2 = (h * h) % P, h3 = (h2 * h) % P, v = (u1 * h2) % P;
	const nx = mod(r * r - h3 - 2n * v, P);
	return [nx, mod(r * (v - nx) - s1 * h3, P), (h * a[2] * b[2]) % P];
}
function times(k: bigint, p: Point): Point {
	let out = INF;
	for (; k > 0n; k >>= 1n) { if (k & 1n) out = add(out, p); p = double(p); }
	return out;
}
const plain = ([x, y, z]: Point): [bigint, bigint] | null => { if (!z) return null; const i = inverse(z, SECP_P), i2 = (i * i) % SECP_P; return [(x * i2) % SECP_P, (y * i2 * i) % SECP_P]; };
const bytes32 = (v: bigint) => { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; };
const big = (b: Uint8Array) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** the public key (x, y) of a private key: only for tests and tools; the chain itself never handles a private key */
export const publicPoint = (secret: bigint): [bigint, bigint] | null => (secret > 0n && secret < SECP_N ? plain(times(secret, [GX, GY, 1n])) : null);
/** the Ethereum address of a public key: the last 20 bytes of Keccak-256(x ‖ y), as 0x + 40 lower-case hex digits */
export function ethAddress([x, y]: [bigint, bigint]): string {
	const xy = new Uint8Array(64); xy.set(bytes32(x)); xy.set(bytes32(y), 32);
	return '0x' + hexOf(keccak256(xy).slice(12));
}
/** Who signed this 32-byte hash? The public key that made signature (r, s) with recovery bit `odd`, or null when the
    signature is not a valid one. Refused on purpose: s in the upper half (each signature has a twin there, and
    accepting both would let anyone alter a signature without the key), and r, s outside 1..N-1. */
export function recover(hash: Uint8Array, r: bigint, s: bigint, odd: boolean): [bigint, bigint] | null {
	if (hash.length !== 32 || r <= 0n || r >= SECP_N || s <= 0n || s > SECP_N / 2n) return null;
	const P = SECP_P, y2 = mod(r * r * r + 7n, P);
	let y = power(y2, (P + 1n) / 4n, P);
	if ((y * y) % P !== y2) return null; // r is not the x of any point on the curve
	if ((y & 1n) === 1n !== odd) y = P - y;
	const ri = inverse(r, SECP_N), z = mod(big(hash), SECP_N);
	// Q = r⁻¹ · (s·R − z·G)
	return plain(add(times(mod(s * ri, SECP_N), [r, y, 1n]), times(mod(-z * ri, SECP_N), [GX, GY, 1n])));
}

/** what an Ethereum wallet really signs when asked to sign a text ("personal_sign", EIP-191): a fixed prefix and the
    text's length are put in front, so a signed text can never be mistaken for a transaction */
export function personalHash(text: string): Uint8Array {
	const body = new TextEncoder().encode(text), head = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
	const all = new Uint8Array(head.length + body.length); all.set(head); all.set(body, head.length);
	return keccak256(all);
}
/** The Ethereum address that signed `text` with personal_sign, from the 65-byte signature a wallet returns
    (0x + r ‖ s ‖ v, v = 27 or 28, or 0 or 1). Null when the signature is malformed or invalid. Never throws. */
export function personalSigner(text: string, sig: unknown): string | null {
	if (typeof sig !== 'string' || !/^0x[0-9a-f]{130}$/.test(sig)) return null;
	const v = parseInt(sig.slice(130), 16), bit = v === 27 || v === 0 ? 0 : v === 28 || v === 1 ? 1 : -1;
	if (bit < 0) return null;
	const q = recover(personalHash(text), BigInt('0x' + sig.slice(2, 66)), BigInt('0x' + sig.slice(66, 130)), bit === 1);
	return q ? ethAddress(q) : null;
}
