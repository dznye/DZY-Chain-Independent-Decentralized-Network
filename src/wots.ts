/* A key no quantum computer can break: made of nothing but SHA-256 (a Winternitz one-time signature, w = 16, as in the published
   hash-based standards). An account may set one while its ordinary key is still safe; from then on that key can always take the
   account back, or be the only one that moves it (ledger.ts q.set, q.run). Each signs once and names the next. */
import { sha256 } from './btc.ts';

const N = 32, LEN = 67, hexOf = (b: Uint8Array) => { let h = ''; for (const x of b) h += x.toString(16).padStart(2, '0'); return h; };
const bytes = (h: string) => Uint8Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)), utf8 = (t: string) => new TextEncoder().encode(t);
const cat = (...l: Uint8Array[]) => { const o = new Uint8Array(l.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of l) { o.set(x, at); at += x.length; } return o; };
const TAG = utf8('dzy-w'), step = (seed: Uint8Array, i: number, j: number, x: Uint8Array) => sha256(cat(TAG, seed, Uint8Array.of(i, j), x));
const run = (seed: Uint8Array, i: number, from: number, to: number, x: Uint8Array) => { for (let j = from; j < to; j++) x = step(seed, i, j, x); return x; };
/** the message in base 16, and its checksum: raising any digit lowers the checksum, so nothing signed can be turned into anything else */
const digits = (seed: Uint8Array, msg: string): number[] => { const h = hexOf(sha256(cat(utf8('dzy-wm'), seed, utf8(msg)))), d = [...h].map((c) => parseInt(c, 16)), sum = d.reduce((n, x) => n + 15 - x, 0); return [...d, (sum >> 8) & 15, (sum >> 4) & 15, sum & 15]; };
const rootOf = (seed: Uint8Array, ends: Uint8Array[]) => hexOf(sha256(cat(utf8('dzy-wr'), seed, ...ends)));
/** from 32 secret bytes (hex), used for this key only: its public seed and root (what goes on the chain) */
export function wotsKey(secret: string): { seed: string; root: string } { const s = bytes(secret), seed = sha256(cat(utf8('dzy-ws'), s)); return { seed: hexOf(seed), root: rootOf(seed, Array.from({ length: LEN }, (_, i) => run(seed, i, 0, 15, sha256(cat(utf8('dzy-wk'), s, Uint8Array.of(i)))))) }; }
/** sign once. Never sign two different messages with one secret */
export function wotsSign(secret: string, msg: string): { seed: string; sig: string } { const s = bytes(secret), seed = sha256(cat(utf8('dzy-ws'), s)), d = digits(seed, msg); return { seed: hexOf(seed), sig: d.map((n, i) => hexOf(run(seed, i, 0, n, sha256(cat(utf8('dzy-wk'), s, Uint8Array.of(i)))))).join('') }; }
/** the root a signature of `msg` belongs to (or '' when it is not one) */
export function wotsRoot(seed: string, sig: string, msg: string): string { if (!/^[0-9a-f]{64}$/.test(seed) || sig.length !== LEN * N * 2 || !/^[0-9a-f]+$/.test(sig)) return ''; const p = bytes(seed), d = digits(p, msg); return rootOf(p, d.map((n, i) => run(p, i, n, 15, bytes(sig.slice(i * 64, i * 64 + 64))))); }
