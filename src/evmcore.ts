/* The Ethereum virtual machine, in plain code with no library: what runs Solidity contracts on Dznye (evmledger.ts). Every
   operation, gas price and limit follows mainnet Ethereum (Cancun, plus CLZ), so contracts compiled for Ethereum run
   unchanged. It knows nothing of Dznye: a host gives it accounts, code and storage, and takes the changes.

   Everything is whole numbers and bytes: the same input gives the same answer on every machine. A run works on a draft of
   its changes with a list of undo steps, so a call that fails leaves nothing. Checked operation by operation against real
   Ethereum nodes, and against contracts that live there (evm/differential.mjs).

   The pairing (0x08), KZG (0x0a), BLS (0x0b to 0x11) and P-256 (0x100) come with the last rules (curves.ts): before them, calling
   one fails, as a failing precompile does. */
import { blsG1Add, blsG1Msm, blsG2Add, blsG2Msm, blsMapG1, blsMapG2, blsPairing, BN254, bnPairing, kzgPoint, p256 } from './curves.ts';
import { ripemd160, sha256 } from './btc.ts';
import { SECP_P as FP, SECP_N as FN } from './secp.ts';

/* ---------- Keccak-256 on 32-bit halves (the same function as secp.ts, some thirty times faster) ---------- */
const RCH = new Int32Array(24), RCL = new Int32Array(24);
[0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n].forEach((v, i) => { RCH[i] = Number(v >> 32n) | 0; RCL[i] = Number(v & 0xffffffffn) | 0; });
const ROTS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14], DEST = new Uint8Array(25);
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) DEST[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);
const SH = new Int32Array(25), SL = new Int32Array(25), BH = new Int32Array(25), BL = new Int32Array(25), CH = new Int32Array(5), CL = new Int32Array(5);
function f1600() {
	for (let r = 0; r < 24; r++) {
		for (let x = 0; x < 5; x++) { CH[x] = SH[x] ^ SH[x + 5] ^ SH[x + 10] ^ SH[x + 15] ^ SH[x + 20]; CL[x] = SL[x] ^ SL[x + 5] ^ SL[x + 10] ^ SL[x + 15] ^ SL[x + 20]; }
		for (let x = 0; x < 5; x++) { const a = (x + 4) % 5, b = (x + 1) % 5, h = CH[a] ^ ((CH[b] << 1) | (CL[b] >>> 31)), l = CL[a] ^ ((CL[b] << 1) | (CH[b] >>> 31)); for (let y = x; y < 25; y += 5) { SH[y] ^= h; SL[y] ^= l; } }
		for (let i = 0; i < 25; i++) { const n = ROTS[i], d = DEST[i], h = SH[i], l = SL[i]; if (n === 0) { BH[d] = h; BL[d] = l; } else if (n < 32) { BH[d] = (h << n) | (l >>> (32 - n)); BL[d] = (l << n) | (h >>> (32 - n)); } else { const m = n - 32; if (m === 0) { BH[d] = l; BL[d] = h; } else { BH[d] = (l << m) | (h >>> (32 - m)); BL[d] = (h << m) | (l >>> (32 - m)); } } }
		for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) { const p = y + x, q = y + (x + 1) % 5, t = y + (x + 2) % 5; SH[p] = BH[p] ^ (~BH[q] & BH[t]); SL[p] = BL[p] ^ (~BL[q] & BL[t]); }
		SH[0] ^= RCH[r]; SL[0] ^= RCL[r];
	}
}
export function keccak(data: Uint8Array): Uint8Array {
	SH.fill(0); SL.fill(0);
	const n = data.length, last = Math.floor(n / 136) * 136; let off = 0;
	const word = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
	for (; off < last; off += 136) { for (let i = 0; i < 17; i++) { SL[i] ^= word(data, off + i * 8); SH[i] ^= word(data, off + i * 8 + 4); } f1600(); }
	const t = new Uint8Array(136); t.set(data.subarray(off)); t[n - off] ^= 1; t[135] ^= 0x80;
	for (let i = 0; i < 17; i++) { SL[i] ^= word(t, i * 8); SH[i] ^= word(t, i * 8 + 4); } f1600();
	const out = new Uint8Array(32); for (let i = 0; i < 4; i++) { const l = SL[i], h = SH[i], o = i * 8; out[o] = l; out[o + 1] = l >>> 8; out[o + 2] = l >>> 16; out[o + 3] = l >>> 24; out[o + 4] = h; out[o + 5] = h >>> 8; out[o + 6] = h >>> 16; out[o + 7] = h >>> 24; }
	return out;
}

/* ---------- who signed: the same answer as secp.ts `recover` (evmsolidity.test.mjs), several times faster: both numbers in one
   pass (Shamir), four bits at a time, the generator's multiples kept. It only checks signatures; it never holds a key. ---------- */
type J = [bigint, bigint, bigint];
const red = (v: bigint) => { const r = v % FP; return r < 0n ? r + FP : r; };
function dbl(p: J): J { const [x, y, z] = p; if (z === 0n || y === 0n) return [0n, 1n, 0n]; const y2 = (y * y) % FP, s = (4n * x * y2) % FP, m = (3n * x * x) % FP, nx = red(m * m - 2n * s); return [nx, red(m * (s - nx) - 8n * y2 * y2), (2n * y * z) % FP]; }
function sum(a: J, b: J): J {
	if (a[2] === 0n) return b; if (b[2] === 0n) return a;
	const z1 = (a[2] * a[2]) % FP, z2 = (b[2] * b[2]) % FP, u1 = (a[0] * z2) % FP, u2 = (b[0] * z1) % FP, s1 = (((a[1] * z2) % FP) * b[2]) % FP, s2 = (((b[1] * z1) % FP) * a[2]) % FP;
	if (u1 === u2) return s1 === s2 ? dbl(a) : [0n, 1n, 0n];
	const h = red(u2 - u1), r = red(s2 - s1), h2 = (h * h) % FP, h3 = (h2 * h) % FP, v = (u1 * h2) % FP, nx = red(r * r - h3 - 2n * v);
	return [nx, red(r * (v - nx) - s1 * h3), (((h * a[2]) % FP) * b[2]) % FP];
}
const table = (p: J): J[] => { const t: J[] = [[0n, 1n, 0n], p]; for (let i = 2; i < 16; i++) t.push(sum(t[i - 1], p)); return t; };
const GT = table([0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n]);
function egcd(a: bigint, m: bigint): bigint { let [r0, r1, s0, s1] = [m, ((a % m) + m) % m, 0n, 1n]; while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return ((s0 % m) + m) % m; }
function root(a: bigint): bigint { // a^((P+1)/4): the square root, when there is one
	let r = 1n, b = a, e = (FP + 1n) / 4n; while (e > 0n) { if (e & 1n) r = (r * b) % FP; e >>= 1n; if (e) b = (b * b) % FP; } return r;
}
export function recover(hash: Uint8Array, r: bigint, s: bigint, odd: boolean): [bigint, bigint] | null {
	if (hash.length !== 32 || r <= 0n || r >= FN || s <= 0n || s > FN / 2n) return null;
	const y2 = (((r * r) % FP) * r + 7n) % FP; let y = root(y2);
	if ((y * y) % FP !== y2) return null;
	if ((y & 1n) === 1n !== odd) y = FP - y;
	const ri = egcd(r, FN), z = toWord(hash) % FN, u1 = (FN - ((z * ri) % FN)) % FN, u2 = (s * ri) % FN, RT = table([r, y, 1n]), h1 = u1.toString(16).padStart(64, '0'), h2 = u2.toString(16).padStart(64, '0');
	let p: J = [0n, 1n, 0n];
	for (let i = 0; i < 64; i++) { if (p[2] !== 0n) p = dbl(dbl(dbl(dbl(p)))); const a = parseInt(h1[i], 16), b = parseInt(h2[i], 16); if (a) p = sum(p, GT[a]); if (b) p = sum(p, RT[b]); }
	if (p[2] === 0n) return null;
	const zi = egcd(p[2], FP), zi2 = (zi * zi) % FP; return [(p[0] * zi2) % FP, (((p[1] * zi2) % FP) * zi) % FP];
}

/* ---------- bytes and words ---------- */
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const hex = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
export const unhex = (h: string) => { const t = h.startsWith('0x') ? h.slice(2) : h; if (t.length % 2 || /[^0-9a-fA-F]/.test(t)) throw new Error('not hex'); const o = new Uint8Array(t.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16); return o; };
export const toWord = (b: Uint8Array): bigint => (b.length ? BigInt('0x' + hex(b)) : 0n);
export const word32 = (v: bigint): Uint8Array => { const h = v.toString(16).padStart(64, '0'), o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const M256 = (1n << 256n) - 1n, M160 = (1n << 160n) - 1n, TOP = 1n << 255n, T256 = 1n << 256n;
const signed = (v: bigint) => (v & TOP ? v - T256 : v);
const addrOf = (v: bigint) => (v & M160).toString(16).padStart(40, '0');
const EMPTY = new Uint8Array(0);
const EMPTY_HASH = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
export const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
/* RLP */
export type Rlp = Uint8Array | Rlp[];
export function rlp(x: Rlp): Uint8Array {
	const head = (n: number, b: number) => { if (n < 56) return Uint8Array.of(b + n); const l: number[] = []; for (let k = n; k > 0; k = Math.floor(k / 256)) l.unshift(k & 255); return Uint8Array.of(b + 55 + l.length, ...l); };
	if (x instanceof Uint8Array) return x.length === 1 && x[0] < 128 ? x : cat(head(x.length, 128), x);
	const body = cat(...x.map(rlp)); return cat(head(body.length, 192), body);
}
/** one RLP item, strictly: the shortest form only, nothing left over */
export function unrlp(b: Uint8Array): Rlp {
	const bad = () => { throw new Error('bad RLP'); };
	const at = (i: number, end: number, depth: number): [Rlp, number] => {
		if (i >= end || depth > 8) bad();
		const c = b[i];
		if (c < 128) return [b.subarray(i, i + 1), i + 1];
		const list = c >= 192, base = list ? 192 : 128; let n = c - base, s = i + 1;
		if (n > 55) { const k = n - 55; if (s + k > end || k > 4 || b[s] === 0) bad(); n = 0; for (let j = 0; j < k; j++) n = n * 256 + b[s + j]; if (n < 56) bad(); s += k; }
		if (s + n > end) bad();
		if (!list) { if (n === 1 && b[s] < 128) bad(); return [b.subarray(s, s + n), s + n]; }
		const out: Rlp[] = []; let j = s; while (j < s + n) { const [x, k] = at(j, s + n, depth + 1); out.push(x); j = k; }
		return [out, s + n];
	};
	const [x, e] = at(0, b.length, 0); if (e !== b.length) bad(); return x;
}
export const numBytes = (v: bigint): Uint8Array => { if (v === 0n) return EMPTY; let h = v.toString(16); if (h.length % 2) h = '0' + h; return unhex(h); };
export const createAddress = (from: string, nonce: bigint) => hex(keccak(rlp([unhex(from), numBytes(nonce)])).subarray(12));

/* ---------- the host and the draft ---------- */
export interface Host { account(a: string): { nonce: bigint; balance: bigint; code: Uint8Array; hash?: string } | null; slot(a: string, k: bigint): bigint; blockHash(n: bigint): bigint }
export interface Env { origin: string; gasPrice: bigint; number: bigint; time: bigint; gasLimit: bigint; chainId: bigint; random: bigint; baseFee: bigint; coinbase: string; /** the last rules (heart.ts FUTURE): the newer precompiles, and prices by the time things take */ fut?: boolean }
export interface Log { at: string; topics: string[]; data: string }
interface Acct { nonce: bigint; balance: bigint; code: Uint8Array; hash: string; real: boolean }
/** a contract the host runs itself at an address (Dznye's own: coins in and out) */
export type Native = (vm: Vm, msg: { to: string; from: string; value: bigint; data: Uint8Array; gas: number; readonly: boolean }) => { ok: boolean; out: Uint8Array; gas: number } | null;
export interface Result { ok: boolean; out: Uint8Array; gas: number; revert?: boolean; address?: string }
class Halt { why: string; constructor(why: string) { this.why = why; } } // an exceptional halt: all the call's gas is gone. (Not an Error: making its stack trace was most of the time a contract could cost)
const halt = (why: string): never => { throw new Halt(why); };
const JUMPS = new WeakMap<Uint8Array, Uint8Array>();
function jumpsOf(code: Uint8Array): Uint8Array { let j = JUMPS.get(code); if (!j) { j = new Uint8Array(code.length); for (let i = 0; i < code.length; i++) { const c = code[i]; if (c === 0x5b) j[i] = 1; else if (c >= 0x60 && c <= 0x7f) i += c - 0x5f; } JUMPS.set(code, j); } return j; }
const words = (n: number) => Math.ceil(n / 32);
const MAXMEM = 33_554_432; // 32 MB: far past what any block's gas can pay for

export class Vm {
	accts = new Map<string, Acct>(); slots = new Map<string, bigint>(); origSlots = new Map<string, bigint>(); transient = new Map<string, bigint>();
	warm = new Set<string>(); warmSlots = new Set<string>(); made = new Set<string>(); dead = new Set<string>();
	logs: Log[] = []; outs: unknown[] = []; refund = 0; depth = 0; private undo: (() => void)[] = [];
	host: Host; env: Env; native: Native | null;
	constructor(host: Host, env: Env, native: Native | null = null) { this.host = host; this.env = env; this.native = native; }
	mark() { return this.undo.length; }
	back(to: number) { while (this.undo.length > to) this.undo.pop()!(); }
	note(f: () => void) { this.undo.push(f); }
	acct(a: string): Acct { let x = this.accts.get(a); if (!x) { const h = this.host.account(a); x = h ? { nonce: h.nonce, balance: h.balance, code: h.code, hash: h.hash ?? (h.code.length ? '' : EMPTY_HASH), real: true } : { nonce: 0n, balance: 0n, code: EMPTY, hash: EMPTY_HASH, real: false }; this.accts.set(a, x); } return x; }
	codeHash(x: Acct) { if (!x.hash) x.hash = hex(keccak(x.code)); return x.hash; }
	empty(a: string) { const x = this.acct(a); return x.nonce === 0n && x.balance === 0n && x.code.length === 0; }
	setBalance(a: string, v: bigint) { const x = this.acct(a), was = x.balance; x.balance = v; this.note(() => { x.balance = was; }); }
	setNonce(a: string, v: bigint) { const x = this.acct(a), was = x.nonce; x.nonce = v; this.note(() => { x.nonce = was; }); }
	setCode(a: string, c: Uint8Array) { const x = this.acct(a), was = x.code, h = x.hash; x.code = c; x.hash = c.length ? '' : EMPTY_HASH; this.note(() => { x.code = was; x.hash = h; }); }
	move(from: string, to: string, v: bigint) { if (v === 0n || from === to) { this.acct(to); return; } this.setBalance(from, this.acct(from).balance - v); this.setBalance(to, this.acct(to).balance + v); }
	sload(a: string, k: bigint): bigint { const key = a + k.toString(16); let v = this.slots.get(key); if (v === undefined) { v = this.made.has(a) ? 0n : this.host.slot(a, k); this.slots.set(key, v); this.origSlots.set(key, v); } return v; }
	sstore(a: string, k: bigint, v: bigint) { const key = a + k.toString(16), was = this.sload(a, k); this.slots.set(key, v); this.note(() => { this.slots.set(key, was); }); }
	orig(a: string, k: bigint): bigint { this.sload(a, k); return this.origSlots.get(a + k.toString(16))!; }
	touch(a: string): boolean { if (this.warm.has(a)) return true; this.warm.add(a); this.note(() => { this.warm.delete(a); }); return false; }
	touchSlot(a: string, k: bigint): boolean { const key = a + k.toString(16); if (this.warmSlots.has(key)) return true; this.warmSlots.add(key); this.note(() => { this.warmSlots.delete(key); }); return false; }
	addRefund(n: number) { this.refund += n; this.note(() => { this.refund -= n; }); }
	log(l: Log) { this.logs.push(l); this.note(() => { this.logs.pop(); }); }

	/** call `to`: code from `codeAt`, value moved when `move` */
	call(m: { from: string; to: string; codeAt: string; value: bigint; move: boolean; data: Uint8Array; gas: number; readonly: boolean; seen: bigint }): Result {
		const at = this.mark();
		if (m.move && m.value > 0n) this.move(m.from, m.to, m.value);
		const pre = precompile(m.codeAt, m.data, m.gas, !!this.env.fut) ?? this.native?.(this, { to: m.codeAt, from: m.from, value: m.seen, data: m.data, gas: m.gas, readonly: m.readonly || m.codeAt !== m.to }) ?? null;
		if (pre) { if (!pre.ok) this.back(at); return { ok: pre.ok, out: pre.out, gas: pre.gas, revert: !pre.ok && pre.gas > 0 }; }
		const code = this.acct(m.codeAt).code;
		if (!code.length) return { ok: true, out: EMPTY, gas: m.gas };
		const r = this.run({ code, self: m.to, caller: m.from, value: m.seen, data: m.data, gas: m.gas, readonly: m.readonly });
		if (!r.ok) this.back(at);
		return r;
	}
	create(from: string, value: bigint, init: Uint8Array, gas: number, at: string): Result {
		this.warm.has(at) || this.touch(at);
		const there = this.acct(at);
		if (there.nonce !== 0n || there.code.length) return { ok: false, out: EMPTY, gas: 0 };
		const mark = this.mark();
		this.made.add(at); this.note(() => { this.made.delete(at); });
		this.setNonce(at, 1n); this.move(from, at, value);
		const r = this.run({ code: init, self: at, caller: from, value, data: EMPTY, gas, readonly: false });
		if (!r.ok) { this.back(mark); return { ok: false, out: r.revert ? r.out : EMPTY, gas: r.gas, revert: r.revert }; }
		const cost = r.out.length * 200;
		if (r.out.length > 24_576 || r.out[0] === 0xef || r.gas < cost) { this.back(mark); return { ok: false, out: EMPTY, gas: 0 }; }
		this.setCode(at, r.out.slice());
		return { ok: true, out: EMPTY, gas: r.gas - cost, address: at };
	}
	private run(f: { code: Uint8Array; self: string; caller: string; value: bigint; data: Uint8Array; gas: number; readonly: boolean }): Result {
		this.depth++;
		try { return this.exec(f); } catch (e) { if (e instanceof Halt || e instanceof RangeError) return { ok: false, out: EMPTY, gas: 0 }; throw e; } finally { this.depth--; }
	}
	private exec(f: { code: Uint8Array; self: string; caller: string; value: bigint; data: Uint8Array; gas: number; readonly: boolean }): Result {
		const { code, self, data } = f, st: bigint[] = [], jumps = jumpsOf(code);
		let gas = f.gas, pc = 0, mem = new Uint8Array(1024), msize = 0, ret: Uint8Array = EMPTY;
		const use = (n: number) => { gas -= n; if (gas < 0) halt('out of gas'); };
		const pop = (): bigint => { if (!st.length) halt('stack'); return st.pop()!; };
		const push = (v: bigint) => { if (st.length >= 1024) halt('stack'); st.push(v); };
		const small = (v: bigint): number => (v > 0xffffffffn ? halt('out of gas') : Number(v));
		const grow = (off: number, len: number) => {
			if (!len) return;
			const end = off + len; if (end > MAXMEM) halt('out of gas');
			const w = words(end), was = msize / 32;
			if (w > was) { use(3 * (w - was) + Math.floor((w * w) / 512) - Math.floor((was * was) / 512)); msize = w * 32; if (msize > mem.length) { let n = mem.length; while (n < msize) n *= 2; const m = new Uint8Array(n); m.set(mem); mem = m; } }
		};
		const range = (o: bigint, l: bigint): [number, number] => { const len = small(l); if (!len) return [0, 0]; const off = small(o); grow(off, len); return [off, len]; };
		const read = (off: number, len: number) => (len ? mem.slice(off, off + len) : EMPTY);
		const copyIn = (src: Uint8Array, to: number, from: bigint, len: number) => { if (!len) return; mem.fill(0, to, to + len); if (from < BigInt(src.length)) { const s = Number(from); mem.set(src.subarray(s, Math.min(src.length, s + len)), to); } };
		const A = (x: string) => use(this.touch(x) ? 100 : 2600);
		for (;;) {
			const op = pc < code.length ? code[pc] : 0;
			pc++;
			if (op >= 0x60 && op <= 0x7f) { use(3); const n = op - 0x5f; let v = 0n; if (n <= 6) { let k = 0; for (let i = 0; i < n; i++) k = k * 256 + (code[pc + i] ?? 0); v = BigInt(k); } else { let h = ''; for (let i = 0; i < n; i++) h += HEX[code[pc + i] ?? 0]; v = BigInt('0x' + h); } push(v); pc += n; continue; }
			if (op >= 0x80 && op <= 0x8f) { use(3); const n = op - 0x7f; if (st.length < n) halt('stack'); push(st[st.length - n]); continue; }
			if (op >= 0x90 && op <= 0x9f) { use(3); const n = op - 0x8f, t = st.length - 1; if (t < n) halt('stack'); const x = st[t]; st[t] = st[t - n]; st[t - n] = x; continue; }
			switch (op) {
				case 0x00: return { ok: true, out: EMPTY, gas };
				case 0x01: { use(3); const a = pop(), b = pop(); push((a + b) & M256); break; }
				case 0x02: { use(5); const a = pop(), b = pop(); push((a * b) & M256); break; }
				case 0x03: { use(3); const a = pop(), b = pop(); push((a - b) & M256); break; }
				case 0x04: { use(5); const a = pop(), b = pop(); push(b === 0n ? 0n : a / b); break; }
				case 0x05: { use(5); const a = signed(pop()), b = signed(pop()); push(b === 0n ? 0n : (a / b) & M256); break; }
				case 0x06: { use(5); const a = pop(), b = pop(); push(b === 0n ? 0n : a % b); break; }
				case 0x07: { use(5); const a = signed(pop()), b = signed(pop()); push(b === 0n ? 0n : (a % b) & M256); break; }
				case 0x08: { use(8); const a = pop(), b = pop(), n = pop(); push(n === 0n ? 0n : (a + b) % n); break; }
				case 0x09: { use(8); const a = pop(), b = pop(), n = pop(); push(n === 0n ? 0n : (a * b) % n); break; }
				case 0x0a: { const a = pop(); let e = pop(); use(10 + 50 * Math.ceil((e === 0n ? 0 : e.toString(16).length) / 2)); let r = 1n, b = a; while (e > 0n) { if (e & 1n) r = (r * b) & M256; e >>= 1n; if (e) b = (b * b) & M256; } push(r); break; }
				case 0x0b: { use(5); const k = pop(), x = pop(); if (k < 31n) { const bit = k * 8n + 7n, m = (1n << (bit + 1n)) - 1n; push((x >> bit) & 1n ? x | (M256 ^ m) : x & m); } else push(x); break; }
				case 0x10: { use(3); const a = pop(), b = pop(); push(a < b ? 1n : 0n); break; }
				case 0x11: { use(3); const a = pop(), b = pop(); push(a > b ? 1n : 0n); break; }
				case 0x12: { use(3); const a = signed(pop()), b = signed(pop()); push(a < b ? 1n : 0n); break; }
				case 0x13: { use(3); const a = signed(pop()), b = signed(pop()); push(a > b ? 1n : 0n); break; }
				case 0x14: { use(3); const a = pop(), b = pop(); push(a === b ? 1n : 0n); break; }
				case 0x15: { use(3); push(pop() === 0n ? 1n : 0n); break; }
				case 0x16: { use(3); const a = pop(), b = pop(); push(a & b); break; }
				case 0x17: { use(3); const a = pop(), b = pop(); push(a | b); break; }
				case 0x18: { use(3); const a = pop(), b = pop(); push(a ^ b); break; }
				case 0x19: { use(3); push(M256 ^ pop()); break; }
				case 0x1a: { use(3); const i = pop(), x = pop(); push(i > 31n ? 0n : (x >> (248n - i * 8n)) & 255n); break; }
				case 0x1b: { use(3); const n = pop(), x = pop(); push(n > 255n ? 0n : (x << n) & M256); break; }
				case 0x1c: { use(3); const n = pop(), x = pop(); push(n > 255n ? 0n : x >> n); break; }
				case 0x1d: { use(3); const n = pop(), x = signed(pop()); push(n > 255n ? (x < 0n ? M256 : 0n) : (x >> n) & M256); break; }
				case 0x1e: { use(5); const x = pop(); push(x === 0n ? 256n : BigInt(256 - x.toString(2).length)); break; }
				case 0x20: { const o = pop(), l = pop(), [off, len] = range(o, l); use(30 + (this.env.fut ? 12 : 6) * words(len)); push(toWord(keccak(mem.subarray(off, off + len)))); break; }
				case 0x30: use(2); push(BigInt('0x' + self)); break;
				case 0x31: { const a = addrOf(pop()); A(a); push(this.acct(a).balance); break; }
				case 0x32: use(2); push(BigInt('0x' + this.env.origin)); break;
				case 0x33: use(2); push(BigInt('0x' + f.caller)); break;
				case 0x34: use(2); push(f.value); break;
				case 0x35: { use(3); const o = pop(); if (o >= BigInt(data.length)) push(0n); else { const w = new Uint8Array(32), s = Number(o); w.set(data.subarray(s, s + 32)); push(toWord(w)); } break; }
				case 0x36: use(2); push(BigInt(data.length)); break;
				case 0x37: case 0x39: { const to = pop(), from = pop(), l = pop(), [off, len] = range(to, l); use(3 + 3 * words(len)); copyIn(op === 0x37 ? data : code, off, from, len); break; }
				case 0x38: use(2); push(BigInt(code.length)); break;
				case 0x3a: use(2); push(this.env.gasPrice); break;
				case 0x3b: { const a = addrOf(pop()); A(a); push(BigInt(this.acct(a).code.length)); break; }
				case 0x3c: { const a = addrOf(pop()), to = pop(), from = pop(), l = pop(), [off, len] = range(to, l); use(3 * words(len)); A(a); copyIn(this.acct(a).code, off, from, len); break; }
				case 0x3d: use(2); push(BigInt(ret.length)); break;
				case 0x3e: { const to = pop(), from = pop(), l = pop(); if (from + l > BigInt(ret.length)) halt('returndata'); const [off, len] = range(to, l); use(3 + 3 * words(len)); copyIn(ret, off, from, len); break; }
				case 0x3f: { const a = addrOf(pop()); A(a); push(this.empty(a) ? 0n : BigInt('0x' + this.codeHash(this.acct(a)))); break; }
				case 0x40: { use(20); const n = pop(); push(n < this.env.number && n + 256n >= this.env.number ? this.host.blockHash(n) : 0n); break; }
				case 0x41: use(2); push(BigInt('0x' + this.env.coinbase)); break;
				case 0x42: use(2); push(this.env.time); break;
				case 0x43: use(2); push(this.env.number); break;
				case 0x44: use(2); push(this.env.random); break;
				case 0x45: use(2); push(this.env.gasLimit); break;
				case 0x46: use(2); push(this.env.chainId); break;
				case 0x47: use(5); push(this.acct(self).balance); break;
				case 0x48: use(2); push(this.env.baseFee); break;
				case 0x49: use(3); pop(); push(0n); break;
				case 0x4a: use(2); push(1n); break;
				case 0x50: use(2); pop(); break;
				case 0x51: { use(3); const off = small(pop()); grow(off, 32); push(toWord(mem.subarray(off, off + 32))); break; }
				case 0x52: { use(3); const off = small(pop()), v = pop(); grow(off, 32); mem.set(word32(v), off); break; }
				case 0x53: { use(3); const off = small(pop()), v = pop(); grow(off, 1); mem[off] = Number(v & 255n); break; }
				case 0x54: { const k = pop(); use(this.touchSlot(self, k) ? 100 : 2100); push(this.sload(self, k)); break; }
				case 0x55: {
					if (f.readonly) halt('static'); if (gas <= 2300) halt('out of gas');
					const k = pop(), v = pop(), cold = !this.touchSlot(self, k), cur = this.sload(self, k), og = this.orig(self, k);
					let c = cold ? 2100 : 0;
					if (cur === v) c += 100; else if (og === cur) c += og === 0n ? 20_000 : 2_900; else c += 100;
					use(c);
					if (cur !== v) {
						if (og === cur) { if (og !== 0n && v === 0n) this.addRefund(4800); }
						else { if (og !== 0n) { if (cur === 0n) this.addRefund(-4800); else if (v === 0n) this.addRefund(4800); } if (og === v) this.addRefund(og === 0n ? 19_900 : 2_800); }
						this.sstore(self, k, v);
					}
					break;
				}
				case 0x56: { use(8); const d = pop(); if (d >= BigInt(code.length) || !jumps[Number(d)]) halt('jump'); pc = Number(d); break; }
				case 0x57: { use(10); const d = pop(), c = pop(); if (c !== 0n) { if (d >= BigInt(code.length) || !jumps[Number(d)]) halt('jump'); pc = Number(d); } break; }
				case 0x58: use(2); push(BigInt(pc - 1)); break;
				case 0x59: use(2); push(BigInt(msize)); break;
				case 0x5a: use(2); push(BigInt(gas)); break;
				case 0x5b: use(1); break;
				case 0x5c: { use(100); push(this.transient.get(self + pop().toString(16)) ?? 0n); break; }
				case 0x5d: { if (f.readonly) halt('static'); use(100); const key = self + pop().toString(16), v = pop(), was = this.transient.get(key) ?? 0n; this.transient.set(key, v); this.note(() => { this.transient.set(key, was); }); break; }
				case 0x5e: { const to = pop(), from = pop(), l = pop(), len = small(l); if (len) { const a = small(to), b = small(from); grow(Math.max(a, b), len); use(3 + 3 * words(len)); mem.copyWithin(a, b, b + len); } else use(3); break; }
				case 0x5f: use(2); push(0n); break;
				case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {
					if (f.readonly) halt('static');
					const o = pop(), l = pop(), n = op - 0xa0, t: string[] = []; for (let i = 0; i < n; i++) t.push(pop().toString(16).padStart(64, '0'));
					const [off, len] = range(o, l); use(375 + 375 * n + 8 * len); this.log({ at: self, topics: t, data: hex(read(off, len)) }); break;
				}
				case 0xf0: case 0xf5: {
					if (f.readonly) halt('static');
					const value = pop(), o = pop(), l = pop(), salt = op === 0xf5 ? pop() : 0n, [off, len] = range(o, l);
					if (len > 49_152) halt('out of gas');
					use(32_000 + 2 * words(len) + (op === 0xf5 ? 6 * words(len) : 0)); ret = EMPTY;
					const me = this.acct(self);
					if (this.depth >= 1025 || me.balance < value || me.nonce >= 0xffffffffffffffffn) { push(0n); break; }
					const init = read(off, len), give = gas - Math.floor(gas / 64); gas -= give;
					const at = op === 0xf0 ? createAddress(self, me.nonce) : hex(keccak(cat(Uint8Array.of(0xff), unhex(self), word32(salt), keccak(init))).subarray(12));
					this.setNonce(self, me.nonce + 1n);
					const r = this.create(self, value, init, give, at); gas += r.gas; if (!r.ok && r.revert) ret = r.out;
					push(r.ok ? BigInt('0x' + at) : 0n); break;
				}
				case 0xf1: case 0xf2: case 0xf4: case 0xfa: {
					const want = pop(), to = addrOf(pop()), value = op === 0xf1 || op === 0xf2 ? pop() : 0n, ao = pop(), al = pop(), ro = pop(), rl = pop();
					if (op === 0xf1 && f.readonly && value !== 0n) halt('static');
					const [a1, a2] = range(ao, al), [r1, r2] = range(ro, rl);
					A(to);
					if (value !== 0n) use(9000);
					if (op === 0xf1 && value !== 0n && this.empty(to)) use(25_000);
					const most = gas - Math.floor(gas / 64); let give = want > BigInt(most) ? most : Number(want); use(give);
					if (value !== 0n) give += 2300;
					if (this.depth >= 1025 || (value !== 0n && this.acct(self).balance < value)) { gas += give; ret = EMPTY; push(0n); break; }
					const input = read(a1, a2);
					const r = op === 0xf1 ? this.call({ from: self, to, codeAt: to, value, move: true, data: input, gas: give, readonly: f.readonly, seen: value })
						: op === 0xf2 ? this.call({ from: self, to: self, codeAt: to, value, move: false, data: input, gas: give, readonly: f.readonly, seen: value })
						: op === 0xf4 ? this.call({ from: f.caller, to: self, codeAt: to, value: 0n, move: false, data: input, gas: give, readonly: f.readonly, seen: f.value })
						: this.call({ from: self, to, codeAt: to, value: 0n, move: false, data: input, gas: give, readonly: true, seen: 0n });
					gas += r.gas; ret = r.ok || r.revert ? r.out : EMPTY;
					if (r2 && ret.length) mem.set(ret.subarray(0, Math.min(r2, ret.length)), r1);
					push(r.ok ? 1n : 0n); break;
				}
				case 0xf3: case 0xfd: { const o = pop(), l = pop(), [off, len] = range(o, l); return { ok: op === 0xf3, out: read(off, len), gas, revert: op === 0xfd }; }
				case 0xff: {
					if (f.readonly) halt('static');
					const to = addrOf(pop()), bal = this.acct(self).balance;
					use(5000 + (this.touch(to) ? 0 : 2600)); if (bal !== 0n && this.empty(to)) use(25_000);
					const born = this.made.has(self);
					if (to !== self) this.move(self, to, bal); else if (born) this.setBalance(self, 0n);
					if (born && !this.dead.has(self)) { this.dead.add(self); this.note(() => { this.dead.delete(self); }); }
					return { ok: true, out: EMPTY, gas };
				}
				default: halt('invalid');
			}
		}
	}
}

/* ---------- precompiles ---------- */
const power = (b: bigint, e: bigint, m: bigint) => { let r = 1n % m; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; if (e) b = (b * b) % m; } return r; };
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n, BN = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
type Pt = [bigint, bigint] | null;
const inv = (a: bigint) => power(((a % P) + P) % P, P - 2n, P), md = (a: bigint) => ((a % P) + P) % P;
function bnAdd(a: Pt, b: Pt): Pt { if (!a) return b; if (!b) return a; let s: bigint; if (a[0] === b[0]) { if (a[1] !== b[1] || a[1] === 0n) return null; s = md(3n * a[0] * a[0] * inv(2n * a[1])); } else s = md((b[1] - a[1]) * inv(b[0] - a[0])); const x = md(s * s - a[0] - b[0]); return [x, md(s * (a[0] - x) - a[1])]; }
const bnPt = (x: bigint, y: bigint): Pt | undefined => { if (x >= P || y >= P) return undefined; if (x === 0n && y === 0n) return null; return md(y * y) === md(x * x * x + 3n) ? [x, y] : undefined; };
const bnOut = (p: Pt) => cat(word32(p ? p[0] : 0n), word32(p ? p[1] : 0n));
const BIV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIG = ['0123456789abcdef', 'ea489fd61c02b753', 'b8c052fdae367194', '7931dcbe265a40f8', '905724afe1bc683d', '2c6a0b834d75fe19', 'c51fed4a0763928b', 'db7ec13950f4862a', '6fe9b308c2d714a5', 'a2847615fb9e3cd0'].map((r) => [...r].map((c) => parseInt(c, 16)));
function blake2f(d: Uint8Array): Uint8Array {
	const le = (o: number) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; }, M = (1n << 64n) - 1n, rot = (v: bigint, n: bigint) => ((v >> n) | (v << (64n - n))) & M;
	const rounds = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0, h = Array.from({ length: 8 }, (_, i) => le(4 + i * 8)), m = Array.from({ length: 16 }, (_, i) => le(68 + i * 8)), v = [...h, ...BIV];
	v[12] ^= le(196); v[13] ^= le(204); if (d[212]) v[14] ^= M;
	const G = (a: number, b: number, c: number, e: number, x: bigint, y: bigint) => { v[a] = (v[a] + v[b] + x) & M; v[e] = rot(v[e] ^ v[a], 32n); v[c] = (v[c] + v[e]) & M; v[b] = rot(v[b] ^ v[c], 24n); v[a] = (v[a] + v[b] + y) & M; v[e] = rot(v[e] ^ v[a], 16n); v[c] = (v[c] + v[e]) & M; v[b] = rot(v[b] ^ v[c], 63n); };
	for (let r = 0; r < rounds; r++) { const s = SIG[r % 10]; G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]); G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]); G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]); G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]); }
	const o = new Uint8Array(64); h.forEach((x, i) => { let t = x ^ v[i] ^ v[i + 8]; for (let j = 0; j < 8; j++) { o[i * 8 + j] = Number(t & 255n); t >>= 8n; } }); return o;
}
export const isPrecompile = (a: string, fut = false) => /^0{38}(0[1-9]|0a)$/.test(a) || (fut && /^(0{38}(0[b-f]|1[01])|0{37}100)$/.test(a));
function precompile(a: string, d: Uint8Array, gas: number, fut: boolean): { ok: boolean; out: Uint8Array; gas: number } | null {
	if (!isPrecompile(a, fut)) return null;
	const n = parseInt(a.slice(37), 16), fail = { ok: false, out: EMPTY, gas: 0 }, at = (o: number, l = 32) => { const w = new Uint8Array(l); if (o < d.length) w.set(d.subarray(o, o + l)); return w; }, done = (cost: number, f: () => Uint8Array | null) => { if (gas < cost) return fail; const out = f(); return out ? { ok: true, out, gas: gas - cost } : fail; };
	switch (n) {
		case 1: return done(fut ? 12_000 : 3000, () => { const v = toWord(at(32)), r = toWord(at(64)), s = toWord(at(96)); if (v !== 27n && v !== 28n) return EMPTY; const q = recoverAny(at(0), r, s, v === 28n); return q ? cat(new Uint8Array(12), keccak(cat(word32(q[0]), word32(q[1]))).subarray(12)) : EMPTY; });
		case 2: return done(60 + 12 * words(d.length), () => sha256(d));
		case 3: return done(600 + 120 * words(d.length), () => cat(new Uint8Array(12), ripemd160(d)));
		case 4: return done(15 + 3 * words(d.length), () => d.slice());
		case 5: {
			const [bl, el, ml] = [toWord(at(0)), toWord(at(32)), toWord(at(64))];
			if (bl > 1024n || el > 1024n || ml > 1024n) return fail; // EIP-7823
			const [B, E, MM] = [Number(bl), Number(el), Number(ml)], head = toWord(at(96 + B, Math.min(E, 32))), x = Math.max(B, MM), wd = Math.ceil(x / 8), mult = x <= 32 ? 16 : 2 * wd * wd;
			const bits = head === 0n ? 0 : head.toString(2).length - 1, iter = Math.max(1, E <= 32 ? bits : 16 * (E - 32) + bits); // EIP-7883
			return done(Math.max(500, mult * iter), () => { if (!MM) return EMPTY; const m = toWord(at(96 + B + E, MM)), v = m === 0n ? 0n : power(toWord(at(96, B)), toWord(at(96 + B, E)), m), o = new Uint8Array(MM), h = numBytes(v); o.set(h, MM - h.length); return o; });
		}
		case 6: if (fut) return done(300, () => bnFast(at(0, 128), 'add')); return done(150, () => { const p = bnPt(toWord(at(0)), toWord(at(32))), q = bnPt(toWord(at(64)), toWord(at(96))); return p === undefined || q === undefined ? null : bnOut(bnAdd(p, q)); });
		case 7: if (fut) return done(14_000, () => bnFast(at(0, 96), 'mul')); return done(6000, () => { const p = bnPt(toWord(at(0)), toWord(at(32))); if (p === undefined) return null; let k = toWord(at(64)) % BN, r: Pt = null, b: Pt = p; for (; k > 0n; k >>= 1n) { if (k & 1n) r = bnAdd(r, b); b = bnAdd(b, b); } return bnOut(r); });
		case 9: { if (d.length !== 213 || d[212] > 1) return fail; const rounds = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0; return done(rounds, () => blake2f(d)); }
		// the last rules: each costs at least what it does on Ethereum, and at least a unit of gas for a tenth of a microsecond here
		case 8: return fut ? done(100_000 + 70_000 * Math.floor(d.length / 192), () => bnPairing(d)) : fail;
		case 10: return fut ? done(250_000, () => kzgPoint(d)) : fail;
		case 11: return done(2_000, () => blsG1Add(d));
		case 12: return done(28_000 * Math.max(1, Math.floor(d.length / 160)), () => blsG1Msm(d));
		case 13: return done(3_000, () => blsG2Add(d));
		case 14: return done(65_000 * Math.max(1, Math.floor(d.length / 288)), () => blsG2Msm(d));
		case 15: return done(80_000 + 110_000 * Math.floor(d.length / 384), () => blsPairing(d));
		case 16: return done(12_000, () => blsMapG1(d));
		case 17: return done(110_000, () => blsMapG2(d));
		case 256: return done(15_000, () => p256(d));
		default: return fail;
	}
}
function bnFast(d: Uint8Array, what: 'add' | 'mul'): Uint8Array | null {
	const w = (o: number) => toWord(d.slice(o, o + 32)), p = bnPt(w(0), w(32)); if (p === undefined) return null;
	if (what === 'mul') return bnOut(BN254.G1.mul(p, w(64) % BN) as Pt);
	const r = bnPt(w(64), w(96)); return r === undefined ? null : bnOut(BN254.G1.add(p, r) as Pt);
}
const SN = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** ecrecover takes either twin of a signature (a transaction takes only the lower) */
export const recoverAny = (h: Uint8Array, r: bigint, s: bigint, odd: boolean) => (s > SN / 2n && s < SN ? recover(h, r, SN - s, !odd) : recover(h, r, s, odd));

/* ---------- a whole transaction ---------- */
export interface EvmTx { from: string; to: string | null; nonce: bigint; value: bigint; data: Uint8Array; gasLimit: number; price: bigint; access?: [string, bigint[]][] }
export function intrinsic(t: Pick<EvmTx, 'to' | 'data' | 'access'>): { need: number; floor: number } {
	let z = 0; for (const b of t.data) if (b === 0) z++;
	const nz = t.data.length - z, tokens = z + nz * 4;
	let g = 21_000 + tokens * 4 + (t.to === null ? 32_000 + 2 * words(t.data.length) : 0);
	for (const [, k] of t.access ?? []) g += 2400 + 1900 * k.length;
	return { need: g, floor: 21_000 + tokens * 10 };
}
/** run a transaction on this draft. The caller has checked nonce and balance, and takes the fee: `used` gas */
export function transact(vm: Vm, t: EvmTx): { ok: boolean; out: Uint8Array; used: number; address?: string } {
	const { need, floor } = intrinsic(t);
	if (t.gasLimit < Math.max(need, floor)) throw new Error('not enough gas for this transaction');
	if (t.to === null && t.data.length > 49_152) throw new Error('the contract is too big');
	vm.warm.add(t.from); vm.warm.add(vm.env.coinbase); for (let i = 1; i <= (vm.env.fut ? 17 : 10); i++) vm.warm.add(i.toString(16).padStart(40, '0')); if (vm.env.fut) vm.warm.add('100'.padStart(40, '0'));
	for (const [a, ks] of t.access ?? []) { vm.warm.add(a); for (const k of ks) vm.warmSlots.add(a + k.toString(16)); }
	const nonce = vm.acct(t.from).nonce, gas = t.gasLimit - need;
	vm.acct(t.from).nonce = nonce + 1n;
	let r: Result;
	if (t.to === null) { r = vm.create(t.from, t.value, t.data, gas, createAddress(t.from, nonce)); }
	else { vm.warm.add(t.to); r = vm.call({ from: t.from, to: t.to, codeAt: t.to, value: t.value, move: true, data: t.data, gas, readonly: false, seen: t.value }); }
	let used = t.gasLimit - r.gas;
	if (r.ok) used -= Math.min(Math.floor(used / 5), vm.refund);
	used = Math.max(used, floor);
	if (r.ok) for (const a of vm.dead) { const x = vm.acct(a); x.nonce = 0n; x.balance = 0n; x.code = EMPTY; x.hash = EMPTY_HASH; for (const k of vm.slots.keys()) if (k.startsWith(a)) vm.slots.set(k, 0n); }
	return { ok: r.ok, out: r.out, used, ...(r.address ? { address: r.address } : {}) };
}
/** decode a signed transaction (legacy, EIP-2930, EIP-1559): who sent it, what it does, its hash. Throws when it is not one for this chain */
export function decodeTx(raw: Uint8Array, chainId: bigint): EvmTx & { hash: string; max: bigint; tip: bigint; type: number } {
	const bad = (m: string): never => { throw new Error(m); };
	const B = (x: Rlp) => (x instanceof Uint8Array ? x : bad('bad transaction')), I = (x: Rlp, most = 32): bigint => { const b = B(x); if (b.length > most || b[0] === 0) bad('bad number'); return toWord(b); };
	const typed = raw[0] < 0x7f ? raw[0] : 0; if (raw[0] < 0x7f && typed !== 1 && typed !== 2) bad('that kind of transaction is not taken');
	const f = unrlp(typed ? raw.subarray(1) : raw); if (!Array.isArray(f)) return bad('bad transaction');
	const to = (x: Rlp): string | null => { const b = B(x); return b.length === 0 ? null : b.length === 20 ? hex(b) : bad('bad address'); };
	const access = (x: Rlp): [string, bigint[]][] => (Array.isArray(x) ? x : bad('bad list')).map((e) => { if (!Array.isArray(e) || e.length !== 2 || !Array.isArray(e[1])) return bad('bad list'); const a = B(e[0]); if (a.length !== 20) bad('bad list'); return [hex(a), e[1].map((k) => { const b = B(k); if (b.length !== 32) bad('bad list'); return toWord(b); })] as [string, bigint[]]; });
	const gasNum = (v: bigint) => (v > 100_000_000n ? bad('too much gas') : Number(v)), hash = hex(keccak(raw));
	let o: EvmTx & { max: bigint; tip: bigint }, digest: Uint8Array, r: bigint, s: bigint, odd: boolean;
	if (typed) {
		const n = typed === 2 ? 12 : 11; if (f.length !== n) bad('bad transaction'); if (I(f[0], 8) !== chainId) bad('that transaction is for another chain');
		const k = typed === 2 ? 1 : 0, max = I(f[2 + k]), tip = typed === 2 ? I(f[2]) : max; if (tip > max) bad('the tip is above the most');
		const al = access(f[7 + k]); o = { from: '', nonce: I(f[1], 8), max, tip, price: max, gasLimit: gasNum(I(f[3 + k], 8)), to: to(f[4 + k]), value: I(f[5 + k]), data: B(f[6 + k]), access: al };
		const y = I(f[8 + k], 1); if (y > 1n) bad('bad signature'); odd = y === 1n; r = I(f[9 + k]); s = I(f[10 + k]); digest = keccak(cat(Uint8Array.of(typed), rlp(f.slice(0, n - 3))));
	} else {
		if (f.length !== 9) bad('bad transaction'); const v = I(f[6], 8), y = v - chainId * 2n - 35n; if (y !== 0n && y !== 1n) bad('that transaction is not signed for this chain'); // unprotected ones could be replayed from elsewhere
		const price = I(f[1]); o = { from: '', nonce: I(f[0], 8), max: price, tip: price, price, gasLimit: gasNum(I(f[2], 8)), to: to(f[3]), value: I(f[4]), data: B(f[5]) };
		odd = y === 1n; r = I(f[7]); s = I(f[8]); digest = keccak(rlp([...f.slice(0, 6), numBytes(chainId), EMPTY, EMPTY]));
	}
	const q = recover(digest, r, s, odd); if (!q) return bad('bad signature');
	o.from = hex(keccak(cat(word32(q[0]), word32(q[1]))).subarray(12));
	return { ...o, data: o.data.slice(), hash, type: typed };
}
