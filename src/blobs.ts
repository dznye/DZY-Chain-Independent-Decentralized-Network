/* Files that last (the Heart upgrade): pictures, videos, music, PDFs, kept two ways, each paid for what it takes.

   IN THE BLOCKS ("in"): the bytes travel beside their transactions in blocks (Tx.side: outside what is signed and
   fingerprinted, matched by the file's own fingerprints), so every node keeps them while they are paid for, and anyone
   rebuilds the file from the blocks alone. For small things (inMax): art, thumbnails, covers. It costs more, because every
   node keeps it: inUsd a megabyte a year. The state holds only the file's facts; its parts are found by the heights of their
   blocks. Parts go in the cargo lane: never more than half of a block (block.ts).

   IN PIECES ("out"): for big files. The file is cut into 8 pieces and 8 more are made from them (Reed-Solomon), so ANY 8 of
   the 16 rebuild it. The chain holds only the pieces' fingerprints. The owner pays outUsd a megabyte a year: 90% becomes the
   file's fund, 10% is a fee. Staked keys keep pieces, at most `slots` keys a piece, and are paid from the fund once a chain
   day for PROVING it: the day's draw (seeded by Bitcoin) names one spot of the piece, and the holder shows those 1,024
   bytes with their place in the fingerprint. A fund is paid out evenly over the days that are left. Not proving for staleDays gives the place to whoever proves next.

   A file's id is the fingerprint of its facts and of its parts, so nobody can swap a byte. Files are never changed: a new
   version is a new file the old one points to (blob.next). The owner of a file nobody's NFT shows any more may close it and
   gets the rest of its fund back (blob.close).

   RENT, SLEEP AND WAKING: what keeps the chain small. A file is paid for by the year (anyone may renew it: blob.renew).
   `graceMs` after its time is over, anyone may put it to sleep (blob.sleep, for its 0.01 DZY deposit): the chain then keeps
   only who, how big, what kind, and its id (a few hundred bytes), and nodes drop its bytes and pieces. Its id IS the
   fingerprint of everything, so anyone who still has the file may wake it, years later, exactly as it was, by paying again
   (blob.wake) and handing the bytes over again. Its NFTs stay NFTs, asleep or awake. Blocks check the same without the bytes.
   Nodes may refuse to SERVE a file (node/blobs.mjs).

   LOOKS: a small picture of a file (4 KB at most: a thumbnail, a video's poster, a page's first lines), paid for ONCE and kept
   by the chain itself for as long as the chain is. It is what an NFT shows while its file sleeps: no rent, ever. Whoever has
   the full file may keep it themselves, and wake it here whenever they like.

   COLLECTIONS, ROYALTIES, DROPS: an NFT may belong to a collection and carry traits. Its royalty (at most 10%) is taken by the
   chain itself from every sale on Dznye's own market, in whatever coin it is sold for, and paid to its maker: nobody can
   leave it out there (a plain transfer, or a sale somewhere else, pays none). A drop (drop.*) makes up to a million NFTs
   with ONE action: their list's fingerprint; each is made only when its owner claims it.

   NFTS (nft.*): a token that shows a file. Its maker, or anyone, may put DZY inside (the same for every copy); whoever holds a
   copy may burn it and gets the DZY in it. Whole numbers only. */
import { canon } from './crypto.ts';
import { emptyOf } from './layer.ts';
import { sha256 as sha256Sync } from './btc.ts';

const B = BigInt, N = Number, own = (o: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(o, k);
const fail = (m: string): never => { throw new Error(m); };
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hexOf = (b: Uint8Array) => { let s = ''; for (const x of b) s += HEX[x]; return s; };
const enc = new TextEncoder();
export const shaHex = (b: Uint8Array) => hexOf(sha256Sync(b));
const shaText = (t: string) => shaHex(enc.encode(t));

export const BLOB = Object.freeze({
	partBytes: 45_000, inMax: 270_000,      // in the blocks: 6 parts of 45,000 bytes, at most
	data: 8, total: 16, outMax: 512_000_000, // in pieces: any 8 of 16; up to 512 MB
	leaf: 1_024,                             // the bytes one proof shows
	inUsd: 250_000, outUsd: 5_000, outMin: 5_000, inMin: 2_500, // µ$ a megabyte (1,000,000 bytes) a YEAR: 25 cents in the blocks, half a cent in pieces (and the least a file pays a year)
	yearMs: 365.25 * 24 * 60 * 60 * 1000, maxYears: 100, graceMs: 30 * 24 * 60 * 60 * 1000,
	freshMs: 2 * 24 * 60 * 60 * 1000,        // a block younger than this must come with its files' bytes; an older one may come without
	bond: 1_000_000,                         // 0.01 DZY held with every file: for whoever puts it to sleep, or back when its owner closes it
	feeBp: 1_000,                            // a tenth of a piece file's price is a fee; the rest its fund
	slots: 3, staleDays: 3,                  // holders of one piece; silent this long: the place is free
	lookMax: 4_096, lookUsd: 5,              // a look: 4 KB at most, 5 µ$ a byte, once (about 2 cents for the biggest)
	maxNfts: 50, maxTraits: 16, royaltyMax: 1_000, colFee: 100_000_000, claimFee: 1_000_000, dropMax: 1_000_000, descMax: 500, maxCopies: 1_000_000, maxInside: 1_000_000 * 100_000_000,
});
/** the kinds of file taken: pictures, film, sound, documents, books, sheets, slides, 3D and print, fonts, archives. Never programs,
    scripts or web pages: nothing a browser or a computer would run. (What is inside is not looked at: nodes serve everything
    as not-to-be-run, and what they cannot show safely as a download.) */
export const TYPES: readonly string[] = [
	'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'image/heic', 'image/heif', 'image/tiff', 'image/bmp', 'image/vnd.adobe.photoshop',
	'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg', 'video/mpeg', 'video/3gpp',
	'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/webm', 'audio/midi',
	'application/pdf', 'application/epub+zip', 'text/plain', 'text/csv', 'text/markdown', 'application/rtf', 'application/json',
	'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
	'model/gltf-binary', 'model/gltf+json', 'model/stl', 'model/obj', 'model/3mf', 'model/vnd.usdz+zip', 'image/vnd.dxf', 'application/step',
	'font/woff2', 'font/woff', 'font/ttf', 'font/otf', 'application/zip', 'application/gzip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-tar',
];
/** shown in a page as they are; everything else is handed over as a download */
export const SHOWN: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'image/bmp', 'video/mp4', 'video/webm', 'video/ogg', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/webm', 'application/pdf', 'application/json', 'text/plain', 'model/gltf-binary']);
const LOOK_TYPES = ['image/webp', 'image/avif', 'image/jpeg', 'image/png', 'image/gif'];
/** does a picture begin the way its kind begins? (a look is shown straight from the chain) */
const looksLike = (t: string, b: Uint8Array): boolean => { const s = (i: number, x: string) => [...x].every((c, j) => b[i + j] === c.charCodeAt(0)); return t === 'image/webp' ? s(0, 'RIFF') && s(8, 'WEBP') : t === 'image/avif' ? s(4, 'ftypavif') : t === 'image/jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff : t === 'image/png' ? b[0] === 0x89 && s(1, 'PNG') : s(0, 'GIF8'); };
export const lookUsd = (bytes: number) => Math.max(1_000, bytes * BLOB.lookUsd);
export interface Look { t: string; b: string }
export interface Blob { by: string; kind: 'in' | 'out'; size: number; type: string; at: number; until: number; bond: number; asleep?: 1; hashes: string[]; heights?: number[]; fund?: number; holders?: Record<string, number>; nfts?: string[]; many?: number; next?: string; name?: string } // many: shown by more NFTs than are listed: its owner cannot close it any more (it may still sleep)
export interface Nft { by: string; blob: string; desc: string; cover?: string; col?: string; traits?: [string, string][]; royalty?: number }
export interface Col { by: string; symbol: string; name: string; desc: string; royalty: number; items: number; cover?: string }
export interface Drop { by: string; col: string; root: string; count: number; price: number; until: number; claimed: number }

/* ---------- fingerprints ---------- */
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const blobId = (kind: string, size: number, type: string, hashes: string[]) => shaText('dzy-blob:' + canon([kind, size, type, hashes]));
const join2 = (l: string, r: string) => shaText('blob-node:' + l + r);
const leafHash = (b: Uint8Array) => { const t = new Uint8Array(b.length + 1); t.set(b, 1); return shaHex(t); }; // a 0 byte in front: a leaf can never be a node
export const pieceLen = (size: number) => Math.ceil(size / BLOB.data);
export const leavesOf = (len: number) => Math.max(1, Math.ceil(len / BLOB.leaf));
const depthOf = (leaves: number) => { let d = 0; while (2 ** d < leaves) d++; return d; };
const EMPTY = ['0'.repeat(64)]; for (let i = 0; i < 32; i++) EMPTY.push(join2(EMPTY[i], EMPTY[i]));
/** the fingerprint of one piece, and the path of one of its spots */
export function pieceTree(piece: Uint8Array) {
	const n = leavesOf(piece.length), depth = depthOf(n), rows = [Array.from({ length: n }, (_, i) => leafHash(piece.subarray(i * BLOB.leaf, (i + 1) * BLOB.leaf)))];
	for (let d = 0; d < depth; d++) { const r = rows[d], up: string[] = []; for (let i = 0; i < r.length; i += 2) up.push(join2(r[i], r[i + 1] ?? EMPTY[d])); rows.push(up); }
	return { root: rows[depth][0], path: (i: number) => { const out: string[] = []; for (let d = 0, k = i; d < depth; d++, k >>= 1) out.push(rows[d][k ^ 1] ?? EMPTY[d]); return out; } };
}
function rootFrom(leaf: string, index: number, path: string[]) { let h = leaf, i = index; for (const s of path) { h = i & 1 ? join2(s, h) : join2(h, s); i = Math.floor(i / 2); } return h; }
/** which spot of piece `p` a holder shows on a day */
export const spotFor = (seed: string, id: string, p: number, who: string, leaves: number) => N(B('0x' + shaText(`dzy-spot:${seed}:${id}:${p}:${who}`)) % B(leaves));
const unb64 = (s: string): Uint8Array => { const t = atob(s), o = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) o[i] = t.charCodeAt(i); return o; };
const b64 = (b: Uint8Array) => { let t = ''; for (let i = 0; i < b.length; i += 8192) t += String.fromCharCode(...b.subarray(i, i + 8192)); return btoa(t); };

/* ---------- cutting and rebuilding (Reed-Solomon over GF(256), systematic Cauchy) ---------- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (x: number, y: number) => (x && y ? EXP[LOG[x] + LOG[y]] : 0), inv = (x: number) => EXP[255 - LOG[x]];
const rowOf = (i: number) => (i < BLOB.data ? Array.from({ length: BLOB.data }, (_, j) => (i === j ? 1 : 0)) : Array.from({ length: BLOB.data }, (_, j) => inv((i + 16) ^ j)));
function mix(row: number[], from: Uint8Array[], len: number): Uint8Array {
	const o = new Uint8Array(len);
	row.forEach((c, j) => { if (!c) return; const src = from[j], lc = LOG[c]; if (c === 1) { for (let i = 0; i < src.length; i++) o[i] ^= src[i]; return; } for (let i = 0; i < src.length; i++) { const v = src[i]; if (v) o[i] ^= EXP[lc + LOG[v]]; } });
	return o;
}
function invert(m: number[][]): number[][] {
	const n = m.length, A = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
	for (let c = 0; c < n; c++) { let q = c; while (q < n && !A[q][c]) q++; if (q === n) fail('those pieces cannot rebuild it'); [A[c], A[q]] = [A[q], A[c]]; const k = inv(A[c][c]); A[c] = A[c].map((v) => mul(v, k)); for (let r = 0; r < n; r++) if (r !== c && A[r][c]) { const f = A[r][c]; A[r] = A[r].map((v, j) => v ^ mul(f, A[c][j])); } }
	return A.map((r) => r.slice(n));
}
/** cut a file into its 16 pieces; and what blob.out sends */
export function cut(file: Uint8Array, type: string) {
	const len = pieceLen(file.length), data = Array.from({ length: BLOB.data }, (_, i) => { const p = new Uint8Array(len); p.set(file.subarray(i * len, Math.min(file.length, (i + 1) * len))); return p; });
	const pieces = Array.from({ length: BLOB.total }, (_, i) => (i < BLOB.data ? data[i] : mix(rowOf(i), data, len))), hashes = pieces.map((p) => pieceTree(p).root);
	return { id: blobId('out', file.length, type, hashes), pieces, data: { size: file.length, type, hashes } };
}
/** any 8 pieces (by number) give the file back; a piece that is not the one the chain names is refused */
export function rebuild(blob: Pick<Blob, 'size' | 'hashes'>, have: Map<number, Uint8Array>): Uint8Array {
	const len = pieceLen(blob.size), good: number[] = [];
	for (const [i, p] of have) { if (good.length === BLOB.data) break; if (p.length === len && pieceTree(p).root === blob.hashes[i]) good.push(i); }
	if (good.length < BLOB.data) fail(`it takes ${BLOB.data} good pieces: there are ${good.length}`);
	good.sort((a, b) => a - b);
	const m = invert(good.map(rowOf)), from = good.map((i) => have.get(i)!), out = new Uint8Array(len * BLOB.data);
	for (let i = 0; i < BLOB.data; i++) out.set(good.includes(i) ? have.get(i)! : mix(m[i], from, len), i * len);
	return out.subarray(0, blob.size);
}
/** a small file's parts; and what blob.in and each blob.part send */
export function parts(file: Uint8Array, type: string) {
	const list = Array.from({ length: Math.max(1, Math.ceil(file.length / BLOB.partBytes)) }, (_, i) => file.subarray(i * BLOB.partBytes, (i + 1) * BLOB.partBytes)), hashes = list.map(shaHex);
	const id = blobId('in', file.length, type, hashes);
	return { id, open: { size: file.length, type, hashes }, parts: list.map((p, n) => { const side = b64(p); return { data: { id, n, len: side.length }, side }; }) };
}
/** rebuild a small file from the blocks (what any other program does): blocks by height */
export function fromBlocks(id: string, blob: Blob, block: (h: number) => { txs: { type: string; data: Record<string, unknown>; side?: string }[] } | null): Uint8Array {
	if (blob.asleep) fail('that file is asleep: wake it (blob.wake)');
	const out = new Uint8Array(blob.size); let at = 0;
	for (const [n, h] of (blob.heights ?? []).entries()) {
		const tx = block(h)?.txs.find((t) => t.type === 'blob.part' && t.data.id === id && t.data.n === n) ?? fail(`part ${n} is not in block ${h}`), p = unb64(tx!.side ?? fail('this node no longer keeps those bytes'));
		if (shaHex(p) !== blob.hashes[n]) fail('a part is not the one the chain names');
		out.set(p, at); at += p.length;
	}
	if (at !== blob.size) fail('not all of it has been written yet');
	return out;
}
/** what a holder sends today for a piece it keeps */
export function proofOf(id: string, p: number, piece: Uint8Array, seed: string, who: string) { const i = spotFor(seed, id, p, who, leavesOf(piece.length)); return { id, p, b: b64(piece.subarray(i * BLOB.leaf, (i + 1) * BLOB.leaf)), path: pieceTree(piece).path(i) }; }

/* ---------- prices ---------- */
/** what keeping `bytes` costs, in µ$ */
export const usdFor = (kind: 'in' | 'out', bytes: number, years = 1) => years * (kind === 'in' ? Math.max(BLOB.inMin, Math.ceil((bytes * BLOB.inUsd) / 1_000_000)) : Math.max(BLOB.outMin, Math.ceil((bytes * BLOB.outUsd) / 1_000_000)));
const yearsOf = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= BLOB.maxYears ? v : fail(`years: 1 to ${BLOB.maxYears}`));
const DAY_MS = 24 * 60 * 60 * 1000;
export const daysLeft = (x: Blob, time: number) => Math.max(0, Math.ceil((x.until - time) / DAY_MS));
/** does the chain still keep this file's bytes? */
export const isAwake = (x: Blob | undefined | null, time: number) => !!x && !x.asleep && time <= x.until + BLOB.graceMs;

/* ---------- the rules ---------- */
interface AssetLike { symbol: string; name: string; issuer: string; supply: number; minted: number; mintable: boolean; decimals: number; content?: string; nft?: Nft; backed?: { per: number; reserve: number } }
interface S { chain: string; heart?: { day: [number, string] }; blobs?: Record<string, Blob>; looks?: Record<string, Look>; cols?: Record<string, Col>; drops?: Record<string, Drop>; dropped?: Record<string, 1>; assets: Record<string, AssetLike>; sun?: { minute: number } }
export interface BlobBank { keptTimes(): number; keptAdd(bytes: number): void; add(who: string, asset: string, n: number): void; sub(who: string, asset: string, n: number): void; balance(who: string, asset: string): number; toSun(n: number): void; toFees(n: number): void; amount(v: unknown): number; addr(v: unknown): string; /** what `usd` µ$ is in DZY shards now */ dzyFor(usd: number): number; staked(who: string): boolean; assetFee: number }
interface C { height: number; side?: string }
type BH = (s: S, from: string, d: Record<string, unknown>, id: string, time: number, ctx: C, bank: BlobBank) => () => void;
const only = (d: Record<string, unknown>, ...k: string[]) => { for (const x of Object.keys(d)) if (!k.includes(x)) fail(`"${x}" is not expected here`); };
const need = (s: S) => { if (!s.heart) fail('files start with the Heart upgrade'); };
const blobOf = (s: S, id: unknown): [string, Blob] => (s.blobs && own(s.blobs, id) ? [id, s.blobs[id]] : fail('no such file'));
const facts = (d: Record<string, unknown>, kind: 'in' | 'out') => {
	const most = kind === 'in' ? BLOB.inMax : BLOB.outMax, size = typeof d.size === 'number' && Number.isSafeInteger(d.size) && d.size > 0 && d.size <= most ? d.size : fail(`size: 1 to ${most} bytes`);
	const type = typeof d.type === 'string' && TYPES.includes(d.type) ? d.type : fail('that kind of file is not taken');
	const count = kind === 'in' ? Math.max(1, Math.ceil(size / BLOB.partBytes)) : BLOB.total;
	const hashes = Array.isArray(d.hashes) && d.hashes.length === count && d.hashes.every(isHash) ? (d.hashes as string[]) : fail(`hashes: ${count} fingerprints`);
	const name = d.name === undefined ? undefined : typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= 80 ? d.name : fail('name: up to 80 characters');
	return { size, type, hashes, ...(name === undefined ? {} : { name }) };
};
/* collections and drops */
const colOf = (s: S, id: unknown, by: string): string => (s.cols && own(s.cols, id) && s.cols[id].by === by ? id : fail('no such collection of yours'));
const royaltyOf = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= BLOB.royaltyMax ? v : fail(`royalty: 0 to ${BLOB.royaltyMax} (hundredths of a percent)`));
const traitsOf = (v: unknown): [string, string][] | undefined => { if (v === undefined) return undefined; if (!Array.isArray(v) || !v.length || v.length > BLOB.maxTraits || !v.every((t) => Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 40))) return fail(`traits: up to ${BLOB.maxTraits} [name, value]`); return v as [string, string][]; };
export interface DropItem { i: number; to: string; blob: string; name: string; traits?: [string, string][] }
export const dropLeaf = (x: DropItem) => shaText('dzy-drop:' + canon([x.i, x.to, x.blob, x.name, x.traits ?? null]));
/** a drop's fingerprint, and each item's path (what a creator's program makes) */
export function dropTree(items: Omit<DropItem, 'i'>[]) {
	const depth = depthOf(items.length), rows = [items.map((x, i) => dropLeaf({ ...x, i }))];
	for (let d = 0; d < depth; d++) { const r = rows[d], up: string[] = []; for (let i = 0; i < r.length; i += 2) up.push(join2(r[i], r[i + 1] ?? EMPTY[d])); rows.push(up); }
	return { root: rows[depth][0], path: (i: number) => { const out: string[] = []; for (let d = 0, k = i; d < depth; d++, k >>= 1) out.push(rows[d][k ^ 1] ?? EMPTY[d]); return out; } };
}
/** the royalty in a sale of this asset for `paid`, and whose it is */
export const royaltyIn = (a: { nft?: Nft } | undefined, paid: number): { to: string; n: number } | null => { const r = a?.nft?.royalty; if (!r || paid <= 0) return null; const n = N((B(paid) * B(r) + 9_999n) / 10_000n); return n > 0 ? { to: a!.nft!.by, n } : null; };
/** today's share of a fund for one holder of one piece: even over the days that are left */
export const payOf = (fund: number, days: number) => (days > 0 ? Math.floor(fund / (days * BLOB.total * BLOB.slots)) : 0);
const inUse = (s: S, b: Blob) => !!b.many || (b.nfts ?? []).some((a) => own(s.assets, a) && s.assets[a].supply > 0);

export const BLOB_HANDLERS: Record<string, BH> = {
	/** say which small file will be written in the blocks */
	'blob.in'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'size', 'type', 'hashes', 'name', 'years');
		const f = facts(d, 'in'), id = blobId('in', f.size, f.type, f.hashes), years = yearsOf(d.years), cost = bank.dzyFor(usdFor('in', f.size, years));
		if (s.blobs && own(s.blobs, id)) fail('that file is already on the chain');
		if (bank.balance(from, 'DZY') < cost + BLOB.bond) fail(`keeping this file costs ${cost / 1e8} DZY, and ${BLOB.bond / 1e8} DZY are held with it`);
		return () => { bank.sub(from, 'DZY', cost + BLOB.bond); bank.toFees(cost); (s.blobs ??= {})[id] = { by: from, kind: 'in', at: time, until: time + years * BLOB.yearMs, bond: BLOB.bond, heights: [], ...f }; };
	},
	/** its next part, in order: the bytes come beside the transaction (anyone may hand them over: they are the ones the file names) */
	'blob.part'(s, _from, d, _id, _time, ctx) {
		need(s); only(d, 'id', 'n', 'len');
		const [, x] = blobOf(s, d.id);
		if (x.kind !== 'in' || x.asleep) fail('that file takes no parts now');
		const n = d.n === x.heights!.length && x.heights!.length < x.hashes.length ? (d.n as number) : fail(`the next part is ${x.heights!.length} of ${x.hashes.length}`);
		const want = n < x.hashes.length - 1 ? BLOB.partBytes : x.size - BLOB.partBytes * (x.hashes.length - 1);
		if (d.len !== Math.ceil(want / 3) * 4) fail(`len: ${Math.ceil(want / 3) * 4}, the part's length as text`);
		if (ctx.side !== undefined) { // (an old block may come without: it was checked with them when it was new)
			if (ctx.side.length !== d.len || !/^[A-Za-z0-9+/]*={0,2}$/.test(ctx.side)) fail('the part, in base64');
			const bytes = unb64(ctx.side);
			if (bytes.length !== want || b64(bytes) !== ctx.side || shaHex(bytes) !== x.hashes[n]) fail('that is not the part the file names');
		}
		return () => { x.heights!.push(ctx.height); };
	},
	/** a file in pieces: only its fingerprints are written; its fund pays whoever keeps the pieces */
	'blob.out'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'size', 'type', 'hashes', 'name', 'years');
		const f = facts(d, 'out'), id = blobId('out', f.size, f.type, f.hashes), years = yearsOf(d.years);
		if (s.blobs && own(s.blobs, id)) fail('that file is already on the chain');
		const cost = bank.dzyFor(usdFor('out', f.size, years)), fee = Math.ceil((cost * BLOB.feeBp) / 10_000);
		if (bank.balance(from, 'DZY') < cost + BLOB.bond) fail(`keeping this file costs ${cost / 1e8} DZY, and ${BLOB.bond / 1e8} DZY are held with it`);
		return () => { bank.sub(from, 'DZY', cost + BLOB.bond); bank.toFees(fee); (s.blobs ??= {})[id] = { by: from, kind: 'out', at: time, until: time + years * BLOB.yearMs, bond: BLOB.bond, fund: cost - fee, holders: {}, ...f }; };
	},
	/** more years, from anyone */
	'blob.renew'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'years');
		const [, x] = blobOf(s, d.id), years = yearsOf(d.years);
		if (x.asleep) fail('that file is asleep: wake it (blob.wake)');
		const until = Math.max(x.until, time) + years * BLOB.yearMs;
		if (until > time + (BLOB.maxYears + 1) * BLOB.yearMs) fail(`at most ${BLOB.maxYears} years ahead`);
		const cost = bank.dzyFor(usdFor(x.kind, x.size, years)), fee = x.kind === 'in' ? cost : Math.ceil((cost * BLOB.feeBp) / 10_000);
		if (bank.balance(from, 'DZY') < cost) fail(`that costs ${cost / 1e8} DZY`);
		return () => { bank.sub(from, 'DZY', cost); bank.toFees(fee); if (x.kind === 'out') x.fund! += cost - fee; x.until = until; };
	},
	/** a file nobody renewed: anyone puts it to sleep, for its deposit. The chain keeps its id and a few facts; its bytes go */
	'blob.sleep'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id');
		const [, x] = blobOf(s, d.id);
		if (x.asleep) fail('it sleeps already');
		if (time <= x.until + BLOB.graceMs) fail('it is paid for (and has 30 days to be renewed after that)');
		return () => { bank.add(from, 'DZY', x.bond); if (x.fund) bank.toFees(x.fund); x.bond = 0; delete x.fund; delete x.heights; delete x.holders; delete x.name; x.hashes = []; x.asleep = 1; };
	},
	/** wake a sleeping file, exactly as it was: its fingerprints again (they must give its id), and its time paid */
	'blob.wake'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'hashes', 'years');
		const [id, x] = blobOf(s, d.id), years = yearsOf(d.years);
		if (!x.asleep) fail('it is not asleep');
		if (!Array.isArray(d.hashes) || d.hashes.length > 64 || !d.hashes.every(isHash) || blobId(x.kind, x.size, x.type, d.hashes as string[]) !== id) fail('those are not its fingerprints');
		const cost = bank.dzyFor(usdFor(x.kind, x.size, years)), fee = x.kind === 'in' ? cost : Math.ceil((cost * BLOB.feeBp) / 10_000);
		if (bank.balance(from, 'DZY') < cost + BLOB.bond) fail(`that costs ${(cost + BLOB.bond) / 1e8} DZY`);
		return () => { bank.sub(from, 'DZY', cost + BLOB.bond); bank.toFees(fee); delete x.asleep; x.bond = BLOB.bond; x.hashes = d.hashes as string[]; x.until = time + years * BLOB.yearMs; if (x.kind === 'in') x.heights = []; else { x.fund = cost - fee; x.holders = {}; } };
	},
	/** anyone may add to a file's fund */
	'blob.fund'(s, from, d, _id, _t, _c, bank) {
		need(s); only(d, 'id', 'amount');
		const [, x] = blobOf(s, d.id), amount = bank.amount(d.amount);
		if (x.kind !== 'out' || x.asleep) fail('only a file in pieces, awake, has a fund');
		if (bank.balance(from, 'DZY') < amount) fail('not enough DZY');
		return () => { bank.sub(from, 'DZY', amount); x.fund! += amount; };
	},
	/** a staked key shows it keeps a piece: the spot the day's draw names. The first time it takes a place; from the next day it is paid */
	'blob.prove'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'p', 'b', 'path');
		const [id, x] = blobOf(s, d.id);
		if (x.kind !== 'out') fail('that file is in the blocks');
		if (x.asleep || time > x.until) fail('that file\'s time is over');
		if (!bank.staked(from)) fail('only a staked key keeps pieces');
		const p = typeof d.p === 'number' && Number.isSafeInteger(d.p) && d.p >= 0 && d.p < BLOB.total ? d.p : fail('which piece');
		const [day, seed] = s.heart!.day, key = p + ':' + from, was = own(x.holders!, key) ? x.holders![key] : undefined;
		if (was !== undefined && was >= day) fail('already shown today');
		const len = pieceLen(x.size), leaves = leavesOf(len), i = spotFor(seed, id, p, from, leaves), want = Math.min(BLOB.leaf, len - i * BLOB.leaf);
		if (typeof d.b !== 'string' || d.b.length !== Math.ceil(want / 3) * 4) fail('b: the bytes of today\'s spot, in base64');
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(d.b as string)) fail('b: the bytes of today\'s spot, in base64');
		const bytes = unb64(d.b as string);
		if (bytes.length !== want || !Array.isArray(d.path) || d.path.length !== depthOf(leaves) || !d.path.every(isHash) || rootFrom(leafHash(bytes), i, d.path as string[]) !== x.hashes[p]) fail('that is not today\'s spot of that piece');
		const others = Object.keys(x.holders!).filter((k) => k.startsWith(p + ':') && k !== key), stale = others.filter((k) => x.holders![k] < day - BLOB.staleDays);
		if (was === undefined && others.length - stale.length >= BLOB.slots) fail('that piece is kept by enough: take another');
		const pay = was !== undefined && was >= day - BLOB.staleDays ? payOf(x.fund!, daysLeft(x, time)) : 0;
		return () => { for (const k of stale) delete x.holders![k]; x.holders![key] = day; if (pay) { x.fund! -= pay; bank.add(from, 'DZY', pay); } };
	},
	/** a small picture of the file, for ever: what it shows while it sleeps. Once, and never changed (NFTs show it) */
	'blob.look'(s, from, d, _id, _t, _c, bank) {
		need(s); only(d, 'id', 't', 'b');
		const [id, x] = blobOf(s, d.id); if (x.by !== from) fail('only its owner'); if (s.looks && own(s.looks, id)) fail('it has one already');
		const t = typeof d.t === 'string' && LOOK_TYPES.includes(d.t) ? d.t : fail('t: a WebP, AVIF, JPEG, PNG or GIF picture');
		if (typeof d.b !== 'string' || d.b.length > Math.ceil(BLOB.lookMax / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.b)) fail(`b: the picture, in base64, at most ${BLOB.lookMax} bytes`);
		const bytes = unb64(d.b as string); if (bytes.length < 20 || bytes.length > BLOB.lookMax || b64(bytes) !== d.b || !looksLike(t, bytes)) fail('that is not such a picture');
		const cost = bank.dzyFor(lookUsd(bytes.length)) * bank.keptTimes(); if (bank.balance(from, 'DZY') < cost) fail(`it costs ${cost / 1e8} DZY, once`);
		return () => { bank.sub(from, 'DZY', cost); bank.toFees(cost); bank.keptAdd((d.b as string).length); (s.looks ??= {})[id] = { t, b: d.b as string }; };
	},
	/** a newer version: the old one stays, and points to it */
	'blob.next'(s, from, d) {
		need(s); only(d, 'id', 'next');
		const [id, x] = blobOf(s, d.id), [next] = blobOf(s, d.next);
		if (x.by !== from) fail('only its owner');
		if (next === id) fail('a file cannot follow itself');
		return () => { x.next = next; };
	},
	'blob.give'(s, from, d, _id, _t, _c, bank) { need(s); only(d, 'id', 'to'); const [, x] = blobOf(s, d.id), to = bank.addr(d.to); if (x.by !== from) fail('only its owner'); return () => { x.by = to; }; },
	/** its owner closes a file no NFT shows any more: the rest of its fund comes back (what is in blocks stays in them) */
	'blob.close'(s, from, d, _id, _t, _c, bank) {
		need(s); only(d, 'id');
		const [id, x] = blobOf(s, d.id);
		if (x.by !== from) fail('only its owner');
		if (inUse(s, x)) fail('an NFT still shows this file: its holders keep it');
		return () => { if (x.fund || x.bond) bank.add(from, 'DZY', (x.fund ?? 0) + x.bond); delete s.blobs![id]; if (emptyOf(s.blobs!)) delete s.blobs; if (s.looks && own(s.looks, id)) { delete s.looks[id]; if (emptyOf(s.looks)) delete s.looks; } };
	},
	/** an NFT that shows a file you own: `copies` of it, each with `inside` DZY in it (0 for none), which burning a copy gives back */
	'nft.make'(s, from, d, txid, _t, _c, bank) {
		need(s); only(d, 'blob', 'symbol', 'name', 'desc', 'copies', 'inside', 'cover', 'col', 'traits', 'royalty');
		const col = d.col === undefined ? undefined : colOf(s, d.col, from), traits = traitsOf(d.traits), royalty = d.royalty === undefined ? col ? s.cols![col].royalty : 0 : royaltyOf(d.royalty);
		const [bid, x] = blobOf(s, d.blob);
		if (x.by !== from) fail('only the file\'s owner makes NFTs of it');
		if (x.asleep || (x.kind === 'in' && x.heights!.length < x.hashes.length)) fail('the file is asleep, or not all written yet');
		if ((x.nfts ?? []).length >= BLOB.maxNfts) fail('that file has enough NFTs');
		const symbol = typeof d.symbol === 'string' && /^[A-Z0-9]{2,10}$/.test(d.symbol) && d.symbol !== 'DZY' ? d.symbol : fail('symbol: 2 to 10 capital letters or digits');
		const name = typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= 40 ? d.name : fail('name: up to 40 characters');
		const desc = d.desc === undefined ? '' : typeof d.desc === 'string' && d.desc.length <= BLOB.descMax ? d.desc : fail(`desc: up to ${BLOB.descMax} characters`);
		const copies = typeof d.copies === 'number' && Number.isSafeInteger(d.copies) && d.copies >= 1 && d.copies <= BLOB.maxCopies ? d.copies : fail(`copies: 1 to ${BLOB.maxCopies}`);
		const inside = d.inside === undefined ? 0 : typeof d.inside === 'number' && Number.isSafeInteger(d.inside) && d.inside >= 0 && d.inside <= BLOB.maxInside ? d.inside : fail('inside: DZY (in shards) in every copy');
		const cover = d.cover === undefined ? undefined : blobOf(s, d.cover)[0], put = inside * copies;
		if (!Number.isSafeInteger(put) || bank.balance(from, 'DZY') < put + bank.assetFee) fail(`it takes ${(put + bank.assetFee) / 1e8} DZY`);
		const key = 'n' + txid.slice(0, 16);
		if (own(s.assets, key)) fail('that NFT already exists');
		return () => {
			bank.sub(from, 'DZY', put + bank.assetFee); bank.toSun(bank.assetFee);
			s.assets[key] = { symbol, name, issuer: from, supply: copies, minted: copies, mintable: false, decimals: 0, content: bid, nft: { by: from, blob: bid, desc, ...(cover ? { cover } : {}), ...(col ? { col } : {}), ...(traits ? { traits } : {}), ...(royalty ? { royalty } : {}) }, backed: { per: inside, reserve: put } };
			if (col) s.cols![col].items += 1;
			bank.add(from, key, copies); (x.nfts ??= []).push(key);
		};
	},
	/** a collection: its name, its royalty, its picture */
	'col.make'(s, from, d, txid, _t, _c, bank) {
		need(s); only(d, 'symbol', 'name', 'desc', 'royalty', 'cover');
		const symbol = typeof d.symbol === 'string' && /^[A-Z0-9]{2,10}$/.test(d.symbol) && d.symbol !== 'DZY' ? d.symbol : fail('symbol: 2 to 10 capital letters or digits'), name = typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= 40 ? d.name : fail('name: up to 40 characters');
		const desc = d.desc === undefined ? '' : typeof d.desc === 'string' && d.desc.length <= BLOB.descMax ? d.desc : fail(`desc: up to ${BLOB.descMax} characters`), royalty = d.royalty === undefined ? 0 : royaltyOf(d.royalty), cover = d.cover === undefined ? undefined : blobOf(s, d.cover)[0];
		if (bank.balance(from, 'DZY') < BLOB.colFee) fail(`a collection costs ${BLOB.colFee / 1e8} DZY`);
		const key = 'c' + txid.slice(0, 16); if (s.cols && own(s.cols, key)) fail('that collection already exists');
		return () => { bank.sub(from, 'DZY', BLOB.colFee); bank.toSun(BLOB.colFee); (s.cols ??= {})[key] = { by: from, symbol, name, desc, royalty, items: 0, ...(cover ? { cover } : {}) }; };
	},
	/** up to a million NFTs with one action: the fingerprint of their list (dropTree). Each is made when it is claimed */
	'drop.make'(s, from, d, txid, time) {
		need(s); only(d, 'col', 'root', 'count', 'price', 'until');
		const col = colOf(s, d.col, from), root = isHash(d.root) ? d.root : fail('root'), count = typeof d.count === 'number' && Number.isSafeInteger(d.count) && d.count >= 1 && d.count <= BLOB.dropMax ? d.count : fail(`count: 1 to ${BLOB.dropMax}`), price = d.price === undefined ? 0 : typeof d.price === 'number' && Number.isSafeInteger(d.price) && d.price >= 0 && d.price <= BLOB.maxInside ? d.price : fail('price: DZY, in shards'), until = typeof d.until === 'number' && Number.isSafeInteger(d.until) && d.until > time && d.until <= time + 10 * BLOB.yearMs ? d.until : fail('until: up to 10 years ahead');
		const key = 'd' + txid.slice(0, 16); if (s.drops && own(s.drops, key)) fail('that drop already exists');
		return () => { (s.drops ??= {})[key] = { by: from, col, root, count, price, until, claimed: 0 }; };
	},
	/** claim item `i` of a drop: what it is, and its place in the list. Only whom the list names (or anyone, where it names nobody) */
	'drop.claim'(s, from, d, _id, time, _c, bank) {
		need(s); only(d, 'id', 'i', 'to', 'blob', 'name', 'traits', 'path');
		const id = s.drops && own(s.drops, d.id) ? (d.id as string) : fail('no such drop'), x = s.drops![id], i = typeof d.i === 'number' && Number.isSafeInteger(d.i) && d.i >= 0 && d.i < x.count ? d.i : fail('which item');
		if (time > x.until) fail('that drop is over');
		const key = id + '/' + i; if (s.dropped && own(s.dropped, key)) fail('already claimed');
		const to = d.to === '' ? '' : bank.addr(d.to); if (to !== '' && to !== from) fail('that item is for someone else');
		const name = typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= 40 ? d.name : fail('name'), traits = traitsOf(d.traits), [bid, b] = blobOf(s, d.blob), col = s.cols![x.col];
		if (!Array.isArray(d.path) || d.path.length !== depthOf(x.count) || !d.path.every(isHash) || rootFrom(dropLeaf({ i, to, blob: bid, name, ...(traits ? { traits } : {}) }), i, d.path as string[]) !== x.root) fail('that is not item ' + i + ' of the drop');
		if (b.by !== x.by || b.asleep) fail('its file is not there');
		if (bank.balance(from, 'DZY') < x.price + BLOB.claimFee) fail(`it costs ${(x.price + BLOB.claimFee) / 1e8} DZY`);
		const asset = 'n' + shaText(key).slice(0, 16); if (own(s.assets, asset)) fail('that NFT already exists');
		return () => {
			bank.sub(from, 'DZY', x.price + BLOB.claimFee); bank.toSun(BLOB.claimFee); if (x.price) bank.add(x.by, 'DZY', x.price);
			s.assets[asset] = { symbol: col.symbol, name, issuer: x.by, supply: 1, minted: 1, mintable: false, decimals: 0, content: bid, nft: { by: x.by, blob: bid, desc: '', col: x.col, ...(traits ? { traits } : {}), ...(col.royalty ? { royalty: col.royalty } : {}) }, backed: { per: 0, reserve: 0 } };
			bank.add(from, asset, 1); x.claimed += 1; col.items += 1; (s.dropped ??= {})[key] = 1; if ((b.nfts ??= []).length < BLOB.maxNfts) b.nfts.push(asset); else b.many = (b.many ?? 0) + 1;
		};
	},
	/** put more DZY into every copy (anyone may): `each` shards a copy */
	'nft.fill'(s, from, d, _id, _t, _c, bank) {
		need(s); only(d, 'asset', 'each');
		const a = own(s.assets, d.asset) && s.assets[d.asset].nft ? s.assets[d.asset] : fail('no such NFT'), each = bank.amount(d.each), put = each * a!.supply;
		if (!a!.supply) fail('every copy has been burned');
		if (!Number.isSafeInteger(put) || a!.backed!.per + each > BLOB.maxInside || bank.balance(from, 'DZY') < put) fail('not enough DZY');
		return () => { bank.sub(from, 'DZY', put); a!.backed!.per += each; a!.backed!.reserve += put; };
	},
	/** burn copies you hold: they are gone, and the DZY in them is yours */
	'nft.burn'(s, from, d, _id, _t, _c, bank) {
		need(s); only(d, 'asset', 'copies');
		const key = own(s.assets, d.asset) && s.assets[d.asset].nft ? (d.asset as string) : fail('no such NFT'), a = s.assets[key], n = d.copies === undefined ? 1 : bank.amount(d.copies), pay = n * a.backed!.per;
		if (bank.balance(from, key) < n) fail('you do not hold that many');
		if (pay > a.backed!.reserve) fail('cannot happen: it holds less than it says');
		return () => { bank.sub(from, key, n); a.supply -= n; a.backed!.reserve -= pay; if (pay) bank.add(from, 'DZY', pay); };
	},
};
/** DZY in files' funds */
export const blobHeld = (s: S) => Object.values(s.blobs ?? {}).reduce((n, b) => n + (b.fund ?? 0) + b.bond, 0);

/* ---------- for marketplaces: the form OpenSea and the others read (ERC-721 metadata) ---------- */
export function metadata(s: S, key: string, base: string): Record<string, unknown> | null {
	const a = own(s.assets, key) ? s.assets[key] : null;
	if (!a?.nft) return null;
	const col = a.nft.col && s.cols && own(s.cols, a.nft.col) ? s.cols[a.nft.col] : null;
	const b = s.blobs && own(s.blobs, a.nft.blob) ? s.blobs[a.nft.blob] : null, file = `${base}/blob/${a.nft.blob}`, lookOf = (id: string) => (s.looks && own(s.looks, id) ? `data:${s.looks[id].t};base64,${s.looks[id].b}` : undefined), look = lookOf(a.nft.blob) ?? (a.nft.cover ? lookOf(a.nft.cover) : undefined), awake = !!b && !b.asleep, cb = a.nft.cover && s.blobs && own(s.blobs, a.nft.cover) ? s.blobs[a.nft.cover] : null, cover = cb && !cb.asleep ? `${base}/blob/${a.nft.cover}` : undefined, picture = !!b?.type.startsWith('image/');
	return {
		name: a.name, description: a.nft.desc, image: awake && picture ? file : cover ?? look ?? file, ...(picture || !awake ? {} : { animation_url: file }), ...(look ? { image_preview: look } : {}), external_url: `${base}/nft/${key}`, ...(a.nft.royalty ? { seller_fee_basis_points: a.nft.royalty, fee_recipient: a.nft.by } : {}), ...(col ? { collection: { name: col.name, family: col.symbol } } : {}),
		attributes: [{ trait_type: 'Copies', value: a.supply, max_value: a.minted, display_type: 'number' }, ...(a.nft.traits ?? []).map(([trait_type, value]) => ({ trait_type, value })), { trait_type: 'DZY inside', value: (a.backed?.per ?? 0) / 1e8, display_type: 'number' }, { trait_type: 'Kept', value: !b ? 'gone' : b.asleep ? 'asleep' : b.kind === 'in' ? 'in the blocks' : 'in 16 pieces' }, ...(b && !b.asleep ? [{ trait_type: 'Paid until', value: Math.floor(b.until / 1000), display_type: 'date' }] : [])],
		properties: { chain: s.chain, asset: key, creator: a.nft.by, file: a.nft.blob, type: b?.type ?? null, size: b?.size ?? null, fingerprints: b?.hashes ?? [], ...(b?.kind === 'in' ? { blocks: b.heights } : {}), ...(b?.next ? { newer: b.next } : {}) },
	};
}
