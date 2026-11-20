/* Bitcoin, as Dznye checks it: everything needed to know, without trusting anyone, that a Bitcoin payment happened
   and is buried under real work. No library: SHA-256 and RIPEMD-160 written out (they must run inside the chain's
   rules, which cannot wait for the browser's async hashing), Bitcoin's address formats, its transaction format, block
   headers and proof of work, and the proof that a transaction is inside a block.

   What a validator accepts as "paid" (checkBtcPayment): the raw transaction, whose id it computes itself; a proof
   that this id is inside a block, checked against that block's header; that header and the next ones after it,
   each linked to the one before and each carrying proof of work at or above a fixed floor (BTC_FLOOR). A node that
   lies cannot make those: it would have to mine that many Bitcoin blocks itself. The node only carries bytes.

   It never holds a key. Payers pay from their own Bitcoin wallet. */
import { fromBase58, toBase58 } from './crypto.ts';
import { recover } from './secp.ts';

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (h: string) => { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return out; };
const isHex = (v: unknown, n?: number): v is string => typeof v === 'string' && v.length % 2 === 0 && /^[0-9a-f]*$/.test(v) && (n === undefined || v.length === n * 2);
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const reversed = (b: Uint8Array) => Uint8Array.from(b).reverse();
const utf8 = (s: string) => new TextEncoder().encode(s);

/* ---- SHA-256 (FIPS 180-4), synchronous ---- */
const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));
export function sha256(data: Uint8Array): Uint8Array {
	const len = data.length, blocks = Math.ceil((len + 9) / 64), m = new Uint8Array(blocks * 64);
	m.set(data); m[len] = 0x80;
	const bits = len * 8, view = new DataView(m.buffer);
	view.setUint32(m.length - 8, Math.floor(bits / 2 ** 32)); view.setUint32(m.length - 4, bits >>> 0);
	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
	for (let b = 0; b < blocks; b++) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(b * 64 + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let [a, bb, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
			const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
			hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
		}
		h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
	}
	const out = new Uint8Array(32), ov = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
	return out;
}
/** Bitcoin's hash: SHA-256 twice */
export const sha256d = (b: Uint8Array) => sha256(sha256(b));

/* ---- RIPEMD-160, for Bitcoin addresses (HASH160 = RIPEMD-160 of SHA-256) ---- */
const RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
const RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
const SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
const SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
const KL = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const fr = (j: number, x: number, y: number, z: number) => (j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z));
export function ripemd160(data: Uint8Array): Uint8Array {
	const len = data.length, blocks = Math.ceil((len + 9) / 64), m = new Uint8Array(blocks * 64);
	m.set(data); m[len] = 0x80;
	const view = new DataView(m.buffer), bits = len * 8;
	view.setUint32(m.length - 8, bits >>> 0, true); view.setUint32(m.length - 4, Math.floor(bits / 2 ** 32), true);
	const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], x = new Array<number>(16);
	for (let b = 0; b < blocks; b++) {
		for (let i = 0; i < 16; i++) x[i] = view.getUint32(b * 64 + i * 4, true);
		let [al, bl, cl, dl, el] = h, [ar, br, cr, dr, er] = h;
		for (let j = 0; j < 80; j++) {
			let t = (rol((al + fr(j, bl, cl, dl) + x[RL[j]] + KL[j >> 4]) | 0, SL[j]) + el) | 0;
			al = el; el = dl; dl = rol(cl, 10); cl = bl; bl = t;
			t = (rol((ar + fr(79 - j, br, cr, dr) + x[RR[j]] + KR[j >> 4]) | 0, SR[j]) + er) | 0;
			ar = er; er = dr; dr = rol(cr, 10); cr = br; br = t;
		}
		const t = (h[1] + cl + dr) | 0;
		h[1] = (h[2] + dl + er) | 0; h[2] = (h[3] + el + ar) | 0; h[3] = (h[4] + al + br) | 0; h[4] = (h[0] + bl + cr) | 0; h[0] = t;
	}
	const out = new Uint8Array(20), ov = new DataView(out.buffer);
	for (let i = 0; i < 5; i++) ov.setUint32(i * 4, h[i] >>> 0, true);
	return out;
}
export const hash160 = (b: Uint8Array) => ripemd160(sha256(b));

/* ---- addresses: base58check (1..., 3...) and bech32 / bech32m (bc1q..., bc1p...), Bitcoin's main network only ---- */
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]): number {
	const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
	let chk = 1;
	for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]; }
	return chk >>> 0;
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
const BECH32 = 1, BECH32M = 0x2bc830a3;
function convert(data: number[], from: number, to: number, pad: boolean): number[] | null {
	let acc = 0, bits = 0; const out: number[] = [], max = (1 << to) - 1;
	for (const v of data) { if (v < 0 || v >> from) return null; acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } }
	if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) return null;
	return out;
}
function segwitDecode(addr: string): { version: number; program: Uint8Array } | null {
	if (addr.length > 90 || (addr !== addr.toLowerCase() && addr !== addr.toUpperCase())) return null;
	const a = addr.toLowerCase(), at = a.lastIndexOf('1');
	if (at !== 2 || a.slice(0, 2) !== 'bc' || a.length - at - 1 < 6) return null;
	const data = [...a.slice(at + 1)].map((c) => B32.indexOf(c));
	if (data.includes(-1)) return null;
	const version = data[0], check = polymod([...hrpExpand('bc'), ...data]);
	if (version > 16 || check !== (version === 0 ? BECH32 : BECH32M)) return null;
	const prog = convert(data.slice(1, -6), 5, 8, false);
	if (!prog || prog.length < 2 || prog.length > 40 || (version === 0 && prog.length !== 20 && prog.length !== 32)) return null;
	return { version, program: Uint8Array.from(prog) };
}
function segwitEncode(version: number, program: Uint8Array): string {
	const data = [version, ...convert([...program], 8, 5, true)!], mod = polymod([...hrpExpand('bc'), ...data, 0, 0, 0, 0, 0, 0]) ^ (version === 0 ? BECH32 : BECH32M);
	return 'bc1' + [...data, ...Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)].map((v) => B32[v]).join('');
}
const base58check = (version: number, payload: Uint8Array) => { const body = cat(Uint8Array.of(version), payload); return toBase58(hexOf(cat(body, sha256d(body).slice(0, 4)))); };

export type BtcKind = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'segwit';
/** A Bitcoin main-network address: its canonical spelling (bech32 in lower case), what kind it is, and the output
    script that pays it. Null when it is not a valid address (wrong checksum, another network, or not an address). */
export function btcAddress(text: unknown): { address: string; kind: BtcKind; script: Uint8Array } | null {
	if (typeof text !== 'string' || text.length < 14 || text.length > 90) return null;
	const sw = segwitDecode(text);
	if (sw) {
		const kind: BtcKind = sw.version === 0 ? (sw.program.length === 20 ? 'p2wpkh' : 'p2wsh') : sw.version === 1 && sw.program.length === 32 ? 'p2tr' : 'segwit';
		return { address: text.toLowerCase(), kind, script: cat(Uint8Array.of(sw.version ? 0x50 + sw.version : 0, sw.program.length), sw.program) };
	}
	if (!/^[13][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(text)) return null;
	const h = fromBase58(text);
	if (!h || h.length !== 50) return null;
	const raw = bytesOf(h), body = raw.slice(0, 21);
	if (hexOf(sha256d(body).slice(0, 4)) !== hexOf(raw.slice(21))) return null;
	const hash = body.slice(1);
	if (body[0] === 0x00) return { address: text, kind: 'p2pkh', script: cat(Uint8Array.of(0x76, 0xa9, 0x14), hash, Uint8Array.of(0x88, 0xac)) };
	if (body[0] === 0x05) return { address: text, kind: 'p2sh', script: cat(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87)) };
	return null;
}
/** the addresses one public key controls with a signature Bitcoin wallets can make for a message (legacy, nested
    segwit and native segwit; taproot keys sign messages another way and are not covered) */
export function btcAddressesOf(pub: Uint8Array): string[] {
	const h = hash160(pub);
	if (pub.length === 65) return [base58check(0x00, h)];
	return [base58check(0x00, h), base58check(0x05, hash160(cat(Uint8Array.of(0x00, 0x14), h))), segwitEncode(0, h)];
}
const big32 = (v: bigint) => bytesOf(v.toString(16).padStart(64, '0'));
/** the public key (compressed or not) of a point */
export const pubBytes = ([x, y]: [bigint, bigint], compressed: boolean) => (compressed ? cat(Uint8Array.of(y & 1n ? 3 : 2), big32(x)) : cat(Uint8Array.of(4), big32(x), big32(y)));

/* ---- signed messages ("Sign message" in Bitcoin Core, Electrum, Sparrow...: BIP-137) ---- */
const varint = (n: number) => (n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? Uint8Array.of(0xfd, n & 255, n >> 8) : Uint8Array.of(0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24));
/** what a Bitcoin wallet really signs for a message: a fixed prefix and the text's length in front, hashed twice */
export function btcMessageHash(text: string): Uint8Array {
	const prefix = utf8('Bitcoin Signed Message:\n'), body = utf8(text);
	return sha256d(cat(varint(prefix.length), prefix, varint(body.length), body));
}
/** Every address that the key behind this message signature controls (the signature as a wallet shows it: 65 bytes,
    base64). Empty when the signature is malformed or invalid. Never throws. */
export function btcMessageSigners(text: string, sig: unknown): string[] {
	if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]{87}=$/.test(sig)) return [];
	let raw: Uint8Array;
	try { raw = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)); } catch { return []; }
	const head = raw[0];
	if (raw.length !== 65 || head < 27 || head > 42) return [];
	const id = (head - 27) & 3, compressed = head >= 31;
	if (id > 1) return []; // R's x would be past the group order: never made by a real wallet
	const q = recover(btcMessageHash(text), BigInt('0x' + hexOf(raw.slice(1, 33))), BigInt('0x' + hexOf(raw.slice(33, 65))), id === 1);
	return q ? btcAddressesOf(pubBytes(q, compressed)) : [];
}

/* ---- transactions ---- */
export interface BtcOutput { value: number; script: Uint8Array }
export interface BtcTx { txid: string; outputs: BtcOutput[]; baseSize: number }
/** Read a raw transaction (with or without witness data) exactly: every byte must be accounted for. Its id is computed
    here from its bytes, never taken from anyone. Null when it is not a well-formed transaction. */
export function parseTx(rawHex: unknown): BtcTx | null {
	if (!isHex(rawHex) || rawHex.length > 2_000_000) return null;
	const b = bytesOf(rawHex);
	let at = 0;
	const need = (n: number) => { if (at + n > b.length) throw new Error('short'); const s = b.subarray(at, at + n); at += n; return s; };
	const vi = () => { const f = need(1)[0]; if (f < 0xfd) return f; const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8; const s = need(n); let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + s[i]; if (!Number.isSafeInteger(v)) throw new Error('big'); return v; };
	try {
		const version = need(4);
		let witness = false;
		if (b[at] === 0x00 && b[at + 1] === 0x01) { witness = true; at += 2; }
		const inStart = at, nIn = vi();
		if (nIn < 1 || nIn > 100_000) return null;
		for (let i = 0; i < nIn; i++) { need(36); need(vi()); need(4); }
		const nOut = vi();
		if (nOut < 1 || nOut > 100_000) return null;
		const outputs: BtcOutput[] = [];
		for (let i = 0; i < nOut; i++) {
			const v = need(8); let value = 0; for (let j = 7; j >= 0; j--) value = value * 256 + v[j];
			if (!Number.isSafeInteger(value) || value > 21e14) return null;
			outputs.push({ value, script: Uint8Array.from(need(vi())) });
		}
		const ioEnd = at;
		if (witness) for (let i = 0; i < nIn; i++) { const items = vi(); for (let j = 0; j < items; j++) need(vi()); }
		const lock = need(4);
		if (at !== b.length) return null;
		const base = cat(version, b.subarray(inStart, ioEnd), lock);
		return { txid: hexOf(reversed(sha256d(base))), outputs, baseSize: base.length };
	} catch { return null; }
}
/** the data an OP_RETURN output carries (one push after OP_RETURN), or null when the script is not one */
export function opReturnData(script: Uint8Array): Uint8Array | null {
	if (script.length < 2 || script[0] !== 0x6a) return null;
	const op = script[1];
	if (op >= 1 && op <= 75 && script.length === 2 + op) return script.slice(2);
	if (op === 0x4c && script.length >= 3 && script.length === 3 + script[2]) return script.slice(3);
	return null;
}
/** does this transaction pay at least `amount` satoshis to `script`, and carry exactly `memo` in an OP_RETURN output? */
export function paysWithMemo(tx: BtcTx, script: Uint8Array, amount: number, memo: string): boolean {
	const want = hexOf(script), m = hexOf(utf8(memo));
	const paid = tx.outputs.filter((o) => hexOf(o.script) === want).reduce((n, o) => n + o.value, 0);
	return paid >= amount && tx.outputs.some((o) => { const d = opReturnData(o.script); return !!d && hexOf(d) === m; });
}

/* ---- block headers and proof of work ---- */
/** The least work a block must carry to count, as a target (a block's hash must be at or below it). Set at difficulty
    40 trillion: real Bitcoin blocks carry about three times that today (checked by chain/btc.test.mjs against the live
    network, which fails loudly if that ever stops being true). Making even one block at this floor costs roughly what
    the whole Bitcoin network earns in several minutes; a payment is accepted only under BTC_CONFIRMATIONS of them. */
export const BTC_FLOOR = (0xffffn << 208n) / 40_000_000_000_000n;
/** how many blocks, the payment's own included, must be on top before it counts (about an hour) */
export const BTC_CONFIRMATIONS = 6;
export const targetOf = (bits: number): bigint | null => {
	const exp = bits >>> 24, mant = bits & 0x007fffff;
	if (bits & 0x00800000 || !mant) return null;
	return exp <= 3 ? BigInt(mant >> (8 * (3 - exp))) : BigInt(mant) << BigInt(8 * (exp - 3));
};
export interface Header { hash: string; prev: string; merkle: string; time: number; bits: number }
/** Read an 80-byte header, and check its proof of work: its hash is at or below the target it claims, and that target
    is at or below `floor`. Null otherwise. `hash`, `prev` and `merkle` are in the usual (reversed) spelling. */
export function checkHeader(hex: unknown, floor: bigint = BTC_FLOOR): Header | null {
	if (!isHex(hex, 80)) return null;
	const b = bytesOf(hex), v = new DataView(b.buffer), hash = reversed(sha256d(b));
	const bits = v.getUint32(72, true), target = targetOf(bits);
	if (target === null || target > floor || BigInt('0x' + hexOf(hash)) > target) return null;
	return { hash: hexOf(hash), prev: hexOf(reversed(b.slice(4, 36))), merkle: hexOf(reversed(b.slice(36, 68))), time: v.getUint32(68, true), bits };
}
/** the merkle root a transaction id and its proof lead to (all in the usual reversed spelling) */
export function merkleRootOf(txid: string, siblings: string[], pos: number): string {
	let cur: Uint8Array = reversed(bytesOf(txid));
	for (let i = 0; i < siblings.length; i++) {
		const sib = reversed(bytesOf(siblings[i]));
		cur = sha256d(Math.floor(pos / 2 ** i) % 2 ? cat(sib, cur) : cat(cur, sib));
	}
	return hexOf(reversed(cur));
}

/* ---- asking a Bitcoin node (the Esplora API: blockstream.info, mempool.space, or anyone's own) ---- */
export type Rpc = (method: string, params: unknown[]) => Promise<any>;
/** Free public nodes (checked 2026-11-15 with the calls below). A validator may set its own: BTC_RPC. */
export const BTC_NODES: readonly string[] = Object.freeze(['https://mempool.space/api', 'https://blockstream.info/api']);
/** one Esplora node as something to ask: tip · hashAt(height) · header(hash) · tx(txid) · proof(txid) · txidAt(hash, i).
    Every argument is checked before it goes into an address. */
export const rpcOf = (base: string): Rpc => async (method, params) => {
	const h = (v: unknown) => (isHex(v, 32) ? v : (() => { throw new Error('bad id'); })());
	const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? v : (() => { throw new Error('bad number'); })());
	const path = method === 'tip' ? '/blocks/tip/height' : method === 'hashAt' ? `/block-height/${n(params[0])}` : method === 'header' ? `/block/${h(params[0])}/header`
		: method === 'tx' ? `/tx/${h(params[0])}/hex` : method === 'proof' ? `/tx/${h(params[0])}/merkle-proof` : method === 'txidAt' ? `/block/${h(params[0])}/txid/${n(params[1])}` : (() => { throw new Error('not passed on'); })();
	const r = await fetch(base + path, { signal: AbortSignal.timeout(12_000) });
	const text = (await r.text()).trim();
	if (!r.ok) throw new Error(`The node answered ${r.status}${text && text.length < 100 ? ': ' + text : ''}`);
	if (method === 'proof') return JSON.parse(text);
	if (method === 'tip') return Number(text);
	return text.toLowerCase();
};

/** Check that the block at `height` and the ones after it, up to BTC_CONFIRMATIONS, are real: each header's hash is
    what the node says is at that height, each carries the work, each links to the one before. Returns the first one. */
async function buriedBlock(rpc: Rpc, height: number, floor: bigint = BTC_FLOOR): Promise<Header | null> {
	let first: Header | null = null, before: Header | null = null;
	for (let i = 0; i < BTC_CONFIRMATIONS; i++) {
		const hash = await rpc('hashAt', [height + i]);
		const hd = checkHeader(await rpc('header', [hash]), floor);
		if (!hd || hd.hash !== hash || (before && hd.prev !== before.hash)) return null;
		first ??= hd; before = hd;
	}
	return first;
}
/** Check ONE Bitcoin transaction (the payer says which): it pays at least `amount` satoshis to `payTo`, carries
    exactly `memo` in an OP_RETURN output, is inside a block, and that block is buried under BTC_CONFIRMATIONS blocks
    of real work. Returns the transaction id when all hold, else null. `floor` is for tests only (a made-up chain with
    easy work); validators always use BTC_FLOOR. */
export async function checkBtcPayment(rpc: Rpc, want: { payTo: string; token: string; amount: number; memo: string }, txid: string, floor: bigint = BTC_FLOOR): Promise<string | null> {
	const to = btcAddress(want.payTo);
	if (want.token !== 'BTC' || !to || !isHex(txid, 32)) return null;
	const proof = await rpc('proof', [txid]);
	const height = proof?.block_height, pos = proof?.pos, siblings = proof?.merkle;
	if (!Number.isSafeInteger(height) || height < 0 || !Array.isArray(siblings) || siblings.length > 32 || !siblings.every((x: unknown) => isHex(x, 32)) || !Number.isSafeInteger(pos) || pos < 0 || pos >= 2 ** siblings.length) return null;
	const tip = await rpc('tip', []);
	if (!Number.isSafeInteger(tip) || tip - height + 1 < BTC_CONFIRMATIONS) return null; // not buried deep enough yet
	const tx = parseTx(await rpc('tx', [txid]));
	// a 64-byte "transaction" could pass for a pair of inner merkle hashes: never accepted
	if (!tx || tx.txid !== txid || tx.baseSize === 64 || !paysWithMemo(tx, to.script, want.amount, want.memo)) return null;
	const block = await buriedBlock(rpc, height, floor);
	return block && merkleRootOf(txid, siblings, pos) === block.merkle ? txid : null;
}
/** Is this node fit for a validator to ask? A buried block's headers check out, and a transaction from it (its first)
    comes back whole with a proof that leads to that block's merkle root. Returns the tip and its age in seconds. */
export async function probeBtc(rpc: Rpc, now = Date.now()): Promise<{ block: number; age: number }> {
	const tip = await rpc('tip', []);
	if (!Number.isSafeInteger(tip) || tip < 900_000) throw new Error('No believable tip height');
	const block = await buriedBlock(rpc, tip - BTC_CONFIRMATIONS + 1);
	if (!block) throw new Error('Its block headers do not check out');
	const txid = await rpc('txidAt', [block.hash, 0]), tx = parseTx(await rpc('tx', [txid])), proof = await rpc('proof', [txid]);
	if (!tx || tx.txid !== txid || merkleRootOf(txid, proof?.merkle ?? [], proof?.pos ?? 0) !== block.merkle) throw new Error('It does not give transactions with proofs');
	const top = checkHeader(await rpc('header', [await rpc('hashAt', [tip])]));
	return { block: tip, age: Math.round(now / 1000 - (top?.time ?? block.time)) };
}
