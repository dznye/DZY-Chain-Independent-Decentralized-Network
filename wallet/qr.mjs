// QR codes, written out in full (no libraries): byte mode, error correction level M (about 15% can be damaged),
// versions 1 to 10 (up to 213 bytes: enough for any pay link). qrMatrix(text) → rows of true/false; qrSvg(text) → an
// SVG any page can show. Checked by decoding with OpenCV in chain/site/qr.test.mjs.

/* ---- Reed–Solomon over GF(256), polynomial 0x11D ---- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function generator(n) {
	let g = [1];
	for (let i = 0; i < n; i++) {
		const next = new Array(g.length + 1).fill(0);
		for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
		g = next;
	}
	return g;
}
function ecc(data, n) {
	const g = generator(n), r = [...data, ...new Array(n).fill(0)];
	for (let i = 0; i < data.length; i++) { const c = r[i]; if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c); }
	return r.slice(data.length);
}

/* ---- level M, versions 1–10: [error codewords per block, [blocks, data codewords each], ...] ---- */
const M = [null,
	[10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
	[16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const capacity = (v) => M[v].slice(1).reduce((n, [b, d]) => n + b * d, 0);

function codewords(bytes, v) {
	const bits = [], put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
	put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
	for (const b of bytes) put(b, 8);
	const cap = capacity(v) * 8;
	put(0, Math.min(4, cap - bits.length));
	while (bits.length % 8) bits.push(0);
	const data = [];
	for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
	for (let pad = 0xec; data.length < capacity(v); pad ^= 0xec ^ 0x11) data.push(pad);
	// split into blocks, add error correction, then interleave
	const [n, ...groups] = M[v], blocks = [];
	let at = 0;
	for (const [count, size] of groups) for (let i = 0; i < count; i++) { const d = data.slice(at, at + size); at += size; blocks.push({ d, e: ecc(d, n) }); }
	const out = [], longest = Math.max(...blocks.map((b) => b.d.length));
	for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
	for (let i = 0; i < n; i++) for (const b of blocks) out.push(b.e[i]);
	return out;
}

/* ---- the picture ---- */
function bch(value, poly, len) {
	let v = value << len;
	const top = 31 - Math.clz32(poly);
	while (31 - Math.clz32(v) >= top) v ^= poly << (31 - Math.clz32(v) - top);
	return (value << len) | v;
}
const MASKS = [
	(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
	(r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
	(r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function build(v, words, mask) {
	const size = v * 4 + 17, m = [...Array(size)].map(() => new Array(size).fill(false)), fixed = [...Array(size)].map(() => new Array(size).fill(false));
	const set = (r, c, on) => { if (r >= 0 && c >= 0 && r < size && c < size) { m[r][c] = on; fixed[r][c] = true; } };
	for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]])
		for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++)
			set(r0 + r, c0 + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)));
	for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
	for (const r of ALIGN[v]) for (const c of ALIGN[v]) {
		const last = ALIGN[v].at(-1); // the three corners with a finder pattern get none (the timing line does not count)
		if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
		for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
	}
	// format (level M = 00) and, from version 7, version information
	const fmt = bch(mask, 0x537, 10) ^ 0x5412, fb = (i) => ((fmt >> i) & 1) === 1;
	for (let i = 0; i < 6; i++) set(8, i, fb(14 - i));
	set(8, 7, fb(8)); set(8, 8, fb(7)); set(7, 8, fb(6));
	for (let i = 9; i < 15; i++) set(14 - i, 8, fb(14 - i));
	for (let i = 0; i < 8; i++) set(8, size - 1 - i, fb(i));
	for (let i = 8; i < 15; i++) set(size - 15 + i, 8, fb(i));
	set(size - 8, 8, true); // the dark module
	if (v >= 7) {
		const vi = bch(v, 0x1f25, 12);
		for (let i = 0; i < 18; i++) { const on = ((vi >> i) & 1) === 1, a = Math.floor(i / 3), b = (i % 3) + size - 11; set(a, b, on); set(b, a, on); }
	}
	// data, in the zigzag
	let bit = 0;
	const bits = words.length * 8;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let k = 0; k < size; k++) {
			for (let j = 0; j < 2; j++) {
				const c = right - j, up = ((right + 1) & 2) === 0, r = up ? size - 1 - k : k;
				if (fixed[r][c]) continue;
				let on = bit < bits ? ((words[bit >> 3] >> (7 - (bit & 7))) & 1) === 1 : false;
				bit++;
				if (MASKS[mask](r, c)) on = !on;
				m[r][c] = on;
			}
		}
	}
	return m;
}

function penalty(m) {
	const n = m.length;
	let p = 0;
	for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
		let run = 1;
		for (let j = 1; j <= n; j++) {
			const same = j < n && (pass ? m[j][i] === m[j - 1][i] : m[i][j] === m[i][j - 1]);
			if (same) run++; else { if (run >= 5) p += run - 2; run = 1; }
		}
	}
	for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
	const pat = [true, false, true, true, true, false, true, false, false, false, false], rev = [...pat].reverse();
	for (let r = 0; r < n; r++) for (let c = 0; c <= n - 11; c++) for (const q of [pat, rev]) {
		if (q.every((x, k) => m[r][c + k] === x)) p += 40;
		if (q.every((x, k) => m[c + k][r] === x)) p += 40;
	}
	const dark = m.flat().filter(Boolean).length;
	p += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
	return p;
}

/** text → the QR code as rows of true (dark) / false */
export function qrMatrix(text) {
	const bytes = [...new TextEncoder().encode(String(text))];
	let v = 1;
	while (v <= 10 && capacity(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
	if (v > 10) throw new Error('Too long for a QR code here');
	const words = codewords(bytes, v);
	let best = null, bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) { const m = build(v, words, mask), sc = penalty(m); if (sc < bestScore) { best = m; bestScore = sc; } }
	return best;
}

/** text → an SVG of its QR code (dark on white, with the quiet border scanners need) */
export function qrSvg(text, px = 220) {
	const m = qrMatrix(text), n = m.length + 8;
	let d = '';
	m.forEach((row, r) => row.forEach((on, c) => { if (on) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
