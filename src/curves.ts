/* The mathematics what comes next is built on, in plain whole numbers, so that nothing new ever needs the node changed: contracts
   and layers call it as Ethereum's own precompiles (evmcore.ts), and get Ethereum's answers.

     BN254        0x06 to 0x08: zero-knowledge proofs (Groth16, PLONK...): anything provable, another chain's blocks included
     BLS12-381    0x0b to 0x11: the signatures Ethereum itself is agreed with, and newer proofs
     KZG          0x0a: a point of a committed polynomial (data of layer 2s)
     P-256        0x100: passkeys, phones' secure chips, bank cards

   Checked against real Ethereum nodes (evm/curves.mjs) and by its own laws (curves.test.mjs). Fp2 = Fp[u]/(u^2 + 1),
   Fp6 = Fp2[v]/(v^3 - xi), Fp12 = Fp6[w]/(w^2 - v). The pairing is the ate pairing: a product of pairings is 1 here exactly
   when it is 1 for any other, which is all a contract ever asks. */
import { sha256 } from './btc.ts';

type F2 = readonly [bigint, bigint];
type F6 = readonly [F2, F2, F2];
type F12 = readonly [F6, F6];
export type P1 = readonly [bigint, bigint] | null;
export type P2 = readonly [F2, F2] | null;

/** a^-1 mod p (a not 0): extended Euclid */
function invMod(a: bigint, p: bigint): bigint { let [r0, r1, t0, t1] = [p, ((a % p) + p) % p, 0n, 1n]; while (r1 > 0n) { const q = r0 / r1; [r0, r1, t0, t1] = [r1, r0 - q * r1, t1, t0 - q * t1]; } return t0 < 0n ? t0 + p : t0; }
function powMod(b: bigint, e: bigint, m: bigint): bigint { let r = 1n; b %= m; for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; } return r; }

/* ---------- a pairing-friendly curve ---------- */
interface Spec { p: bigint; r: bigint; b: bigint; xi: F2; /** the Miller loop's number */ s: bigint; /** the twist: D divides b by xi, M multiplies */ twist: 'D' | 'M'; /** BN: its u (the loop is 6u + 2, with two lines more); BLS12: |x| (x is below 0) */ bn?: bigint; bls?: bigint }
export function pairingCurve(spec: Spec) {
	const { p, r, xi, s, twist } = spec, half = (p + 1n) / 2n;
	const m = (x: bigint) => { const v = x % p; return v < 0n ? v + p : v; };
	/* Fp2 */
	const Z2: F2 = [0n, 0n], O2: F2 = [1n, 0n];
	const add2 = (a: F2, b: F2): F2 => { const x = a[0] + b[0], y = a[1] + b[1]; return [x >= p ? x - p : x, y >= p ? y - p : y]; };
	const sub2 = (a: F2, b: F2): F2 => { const x = a[0] - b[0], y = a[1] - b[1]; return [x < 0n ? x + p : x, y < 0n ? y + p : y]; };
	const neg2 = (a: F2): F2 => [a[0] ? p - a[0] : 0n, a[1] ? p - a[1] : 0n];
	const mul2 = (a: F2, b: F2): F2 => { const x = a[0] * b[0], y = a[1] * b[1]; return [m(x - y), ((a[0] + a[1]) * (b[0] + b[1]) - x - y) % p]; };
	const sqr2 = (a: F2): F2 => [m((a[0] + a[1]) * (a[0] - a[1])), (2n * a[0] * a[1]) % p];
	const scl2 = (a: F2, k: bigint): F2 => [(a[0] * k) % p, (a[1] * k) % p];
	const inv2 = (a: F2): F2 => { const d = invMod((a[0] * a[0] + a[1] * a[1]) % p, p); return [(a[0] * d) % p, m(-a[1] * d)]; };
	const eq2 = (a: F2, b: F2) => a[0] === b[0] && a[1] === b[1];
	const isZ2 = (a: F2) => a[0] === 0n && a[1] === 0n;
	const pow2 = (b: F2, e: bigint): F2 => { let x: F2 = O2; for (; e > 0n; e >>= 1n) { if (e & 1n) x = mul2(x, b); b = sqr2(b); } return x; };
	const mxi: (a: F2) => F2 = xi[0] === 1n ? (a) => [a[0] - a[1] < 0n ? a[0] - a[1] + p : a[0] - a[1], a[0] + a[1] >= p ? a[0] + a[1] - p : a[0] + a[1]] : (a) => mul2(a, xi);
	/* Fp6 */
	const Z6: F6 = [Z2, Z2, Z2], O6: F6 = [O2, Z2, Z2];
	const add6 = (a: F6, b: F6): F6 => [add2(a[0], b[0]), add2(a[1], b[1]), add2(a[2], b[2])], sub6 = (a: F6, b: F6): F6 => [sub2(a[0], b[0]), sub2(a[1], b[1]), sub2(a[2], b[2])], neg6 = (a: F6): F6 => [neg2(a[0]), neg2(a[1]), neg2(a[2])];
	const mul6 = (a: F6, b: F6): F6 => { const t0 = mul2(a[0], b[0]), t1 = mul2(a[1], b[1]), t2 = mul2(a[2], b[2]); return [add2(t0, mxi(sub2(sub2(mul2(add2(a[1], a[2]), add2(b[1], b[2])), t1), t2))), add2(sub2(sub2(mul2(add2(a[0], a[1]), add2(b[0], b[1])), t0), t1), mxi(t2)), add2(sub2(sub2(mul2(add2(a[0], a[2]), add2(b[0], b[2])), t0), t2), t1)]; };
	const mv = (a: F6): F6 => [mxi(a[2]), a[0], a[1]];
	const inv6 = (a: F6): F6 => { const t0 = sub2(sqr2(a[0]), mxi(mul2(a[1], a[2]))), t1 = sub2(mxi(sqr2(a[2])), mul2(a[0], a[1])), t2 = sub2(sqr2(a[1]), mul2(a[0], a[2])), d = inv2(add2(mul2(a[0], t0), mxi(add2(mul2(a[2], t1), mul2(a[1], t2))))); return [mul2(t0, d), mul2(t1, d), mul2(t2, d)]; };
	/* Fp12 */
	const O12: F12 = [O6, Z6];
	const mul12 = (a: F12, b: F12): F12 => { const t0 = mul6(a[0], b[0]), t1 = mul6(a[1], b[1]); return [add6(t0, mv(t1)), sub6(sub6(mul6(add6(a[0], a[1]), add6(b[0], b[1])), t0), t1)]; };
	const sqr12 = (a: F12): F12 => { const t = mul6(a[0], a[1]); return [sub6(sub6(mul6(add6(a[0], a[1]), add6(a[0], mv(a[1]))), t), mv(t)), add6(t, t)]; };
	const conj12 = (a: F12): F12 => [a[0], neg6(a[1])];
	const inv12 = (a: F12): F12 => { const d = inv6(sub6(mul6(a[0], a[0]), mv(mul6(a[1], a[1])))); return [mul6(a[0], d), neg6(mul6(a[1], d))]; };
	const eq12 = (a: F12, b: F12) => a.every((x, i) => x.every((y, j) => eq2(y, b[i][j])));
	const g = pow2(xi, (p * p - 1n) / 6n)[0], G = [1n, g, (g * g) % p, powMod(g, 3n, p), powMod(g, 4n, p), powMod(g, 5n, p)]; // xi^((p^2-1)/6): a sixth root of 1, in Fp
	const frob2 = (a: F12): F12 => [[a[0][0], scl2(a[0][1], G[2]), scl2(a[0][2], G[4])], [scl2(a[1][0], G[1]), scl2(a[1][1], G[3]), scl2(a[1][2], G[5])]]; // a -> a^(p^2)
	/** squaring in the part of Fp12 where the exponent's hard half lives (Granger and Scott): a third of the work */
	const sq4 = (a: F2, b: F2): [F2, F2] => { const t0 = sqr2(a), t1 = sqr2(b); return [add2(mxi(t1), t0), sub2(sub2(sqr2(add2(a, b)), t0), t1)]; };
	const dbl2 = (a: F2) => add2(a, a);
	const csqr = (a: F12): F12 => {
		const [z0, z4, z3] = a[0], [z2, z1, z5] = a[1], [t0, t1] = sq4(z0, z1), [t2, t3] = sq4(z2, z3), [t4, t5] = sq4(z4, z5), x = mxi(t5);
		return [[add2(dbl2(sub2(t0, z0)), t0), add2(dbl2(sub2(t2, z4)), t2), add2(dbl2(sub2(t4, z3)), t4)], [add2(dbl2(add2(x, z2)), x), add2(dbl2(add2(t1, z1)), t1), add2(dbl2(add2(t3, z5)), t3)]];
	};
	const HARD = (p ** 4n - p ** 2n + 1n) / r, HARD_BITS = HARD.toString(2);
	/** the plain way (kept to check the fast one against) */
	const finalExpPlain = (f: F12): F12 => { const a = mul12(conj12(f), inv12(f)), b = mul12(frob2(a), a); let x = b; for (let i = 1; i < HARD_BITS.length; i++) { x = csqr(x); if (HARD_BITS[i] === '1') x = mul12(x, b); } return x; };
	/* the fast way: the hard part written with powers of the curve's own small number (u or x), and the Frobenius map, which is free */
	const F1 = [0n, 1n, 2n, 3n, 4n, 5n].map((i) => pow2(xi, (i * (p - 1n)) / 6n)); // xi^(i(p-1)/6)
	const frob1 = (a: F12): F12 => { const c = (z: F2, i: number) => mul2([z[0], z[1] ? p - z[1] : 0n], F1[i]); return [[c(a[0][0], 0), c(a[0][1], 2), c(a[0][2], 4)], [c(a[1][0], 1), c(a[1][1], 3), c(a[1][2], 5)]]; }; // a -> a^p
	const cexp = (a: F12, e: bigint): F12 => { const bits = e.toString(2); let x = a; for (let i = 1; i < bits.length; i++) { x = csqr(x); if (bits[i] === '1') x = mul12(x, a); } return x; };
	const cpow = (a: F12, k: number): F12 => cexp(a, BigInt(k));
	const finalExp = (f: F12): F12 => {
		const a = mul12(conj12(f), inv12(f)), b = mul12(frob2(a), a); // the easy part: (p^6 - 1)(p^2 + 1)
		if (spec.bls) { // 3 x the hard part = (x - 1)^2 (x + p)(x^2 + p^2 - 1) + 3: its result is 1 exactly when the hard part's is (3 does not divide r)
			const ex = (g: F12) => conj12(cexp(g, spec.bls!)), t1 = mul12(ex(b), conj12(b)), A = mul12(ex(t1), conj12(t1)), Bv = mul12(ex(A), frob1(A));
			return mul12(mul12(mul12(ex(ex(Bv)), frob2(Bv)), conj12(Bv)), mul12(csqr(b), b));
		}
		if (spec.bn) { // the hard part = l0 + l1 p + l2 p^2 + p^3, each l a short sum of powers of u (checked to be exactly so by the tests)
			const u = spec.bn, f1 = cexp(b, u), f2 = cexp(f1, u), f3 = cexp(f2, u), [a3, a2, a1] = [cpow(f3, 36), cpow(f2, 30), cpow(f1, 18)];
			const x0 = conj12(mul12(mul12(mul12(a3, a2), a1), csqr(b))), x1 = mul12(conj12(mul12(mul12(a3, cpow(f2, 18)), cpow(f1, 12))), b), x2 = mul12(cpow(f2, 6), b);
			return mul12(mul12(x0, frob1(x1)), mul12(frob2(x2), frob1(frob2(b))));
		}
		return finalExpPlain(f);
	};
	const hardParts = spec.bn ? { u: spec.bn, l0: -(36n * spec.bn ** 3n + 30n * spec.bn ** 2n + 18n * spec.bn + 2n), l1: -(36n * spec.bn ** 3n + 18n * spec.bn ** 2n + 12n * spec.bn) + 1n, l2: 6n * spec.bn ** 2n + 1n } : null;
	/* the line through the twist's points, at a point of the curve */
	const line = (l: F2, x: F2, y: F2, a: bigint, b: bigint): F12 => { const c = sub2(mul2(l, x), y), k = neg2(scl2(l, a)); return twist === 'D' ? [[[b, 0n], Z2, Z2], [k, c, Z2]] : [[c, k, Z2], [Z2, [b, 0n], Z2]]; };
	const S_BITS = s.toString(2);
	/** is the product of the pairings 1? (points already checked; a null is the point at infinity) */
	const pairingsAreOne = (pairs: readonly (readonly [P1, P2])[]): boolean => {
		const list = pairs.filter((x): x is readonly [readonly [bigint, bigint], readonly [F2, F2]] => !!x[0] && !!x[1]); if (!list.length) return true;
		const T = list.map(([, q]) => [q[0], q[1]] as [F2, F2]); let f: F12 = O12;
		const step = (k: number, q: readonly [F2, F2], a: bigint, b: bigint) => { const [x, y] = T[k], l = mul2(sub2(q[1], y), inv2(sub2(q[0], x))); f = mul12(f, line(l, x, y, a, b)); const nx = sub2(sub2(sqr2(l), x), q[0]); T[k] = [nx, sub2(mul2(l, sub2(x, nx)), y)]; };
		for (let i = 1; i < S_BITS.length; i++) {
			f = sqr12(f);
			list.forEach(([[a, b]], k) => { const [x, y] = T[k], l = mul2(scl2(sqr2(x), 3n), inv2(add2(y, y))); f = mul12(f, line(l, x, y, a, b)); const nx = sub2(sqr2(l), add2(x, x)); T[k] = [nx, sub2(mul2(l, sub2(x, nx)), y)]; });
			if (S_BITS[i] === '1') list.forEach(([[a, b], q], k) => step(k, q, a, b));
		}
		// BN's optimal loop ends with two lines more: through pi(Q) and -pi^2(Q), the Frobenius map moved onto the twist
		if (spec.bn) list.forEach(([[a, b], q], k) => { const cj = (z: F2): F2 => [z[0], z[1] ? p - z[1] : 0n], q1: [F2, F2] = [mul2(cj(q[0]), F1[2]), mul2(cj(q[1]), F1[3])], q2: [F2, F2] = [scl2(q[0], G[2]), neg2(scl2(q[1], G[3]))]; step(k, q1, a, b); step(k, q2, a, b); });
		return eq12(finalExp(f), O12);
	};
	/* the two groups, with projective (Jacobian) points */
	const b1 = spec.b, b2 = twist === 'D' ? mul2([b1, 0n], inv2(xi)) : mul2([b1, 0n], xi);
	const group = <F>(F: { add(a: F, b: F): F; sub(a: F, b: F): F; mul(a: F, b: F): F; sqr(a: F): F; inv(a: F): F; eq(a: F, b: F): boolean; zero: F; one: F; isZ(a: F): boolean }, b: F) => {
		type A = readonly [F, F] | null; type J = readonly [F, F, F];
		const ZERO: J = [F.one, F.one, F.zero], two = (x: F) => F.add(x, x);
		const on = (x: F, y: F) => F.eq(F.sqr(y), F.add(F.mul(F.sqr(x), x), b));
		const dbl = ([X, Y, Z]: J): J => { if (F.isZ(Z) || F.isZ(Y)) return ZERO; const a = F.sqr(X), bb = F.sqr(Y), c = F.sqr(bb), d = two(F.sub(F.sub(F.sqr(F.add(X, bb)), a), c)), e = F.add(two(a), a), x = F.sub(F.sqr(e), two(d)); return [x, F.sub(F.mul(e, F.sub(d, x)), two(two(two(c)))), two(F.mul(Y, Z))]; };
		const addJ = (q: J, o: J): J => { if (F.isZ(q[2])) return o; if (F.isZ(o[2])) return q; const z1 = F.sqr(q[2]), z2 = F.sqr(o[2]), u1 = F.mul(q[0], z2), u2 = F.mul(o[0], z1), s1 = F.mul(F.mul(q[1], o[2]), z2), s2 = F.mul(F.mul(o[1], q[2]), z1); if (F.eq(u1, u2)) return F.eq(s1, s2) ? dbl(q) : ZERO; const h = F.sub(u2, u1), hh = F.sqr(h), hhh = F.mul(h, hh), w = F.sub(s2, s1), v = F.mul(u1, hh), x = F.sub(F.sub(F.sqr(w), hhh), two(v)); return [x, F.sub(F.mul(w, F.sub(v, x)), F.mul(s1, hhh)), F.mul(F.mul(q[2], o[2]), h)]; };
		const toJ = (a: A): J => (a ? [a[0], a[1], F.one] : ZERO), toA = (j: J): A => { if (F.isZ(j[2])) return null; const i = F.inv(j[2]), ii = F.sqr(i); return [F.mul(j[0], ii), F.mul(F.mul(j[1], ii), i)]; };
		const mulJ = (j: J, k: bigint): J => { if (k <= 0n) return ZERO; const t: J[] = [ZERO, j]; for (let i = 2; i < 16; i++) t.push(addJ(t[i - 1], j)); const h = k.toString(16); let x: J = ZERO; for (const c of h) { x = dbl(dbl(dbl(dbl(x)))); const d = parseInt(c, 16); if (d) x = addJ(x, t[d]); } return x; };
		/** the sum of each point times its number (Straus: the doublings are shared) */
		const msm = (list: readonly (readonly [A, bigint])[]): A => { const l = list.filter(([a, k]) => a && k > 0n).map(([a, k]) => { const j = toJ(a), t: J[] = [ZERO, j]; for (let i = 2; i < 16; i++) t.push(addJ(t[i - 1], j)); return { t, h: k.toString(16).padStart(64, '0') }; }); const n = Math.max(0, ...l.map((x) => x.h.length)); let x: J = ZERO; for (let i = 0; i < n; i++) { x = dbl(dbl(dbl(dbl(x)))); for (const { t, h } of l) { const d = parseInt(h[i + h.length - n] ?? '0', 16); if (d) x = addJ(x, t[d]); } } return toA(x); };
		return { on, add: (a: A, c: A): A => toA(addJ(toJ(a), toJ(c))), mul: (a: A, k: bigint): A => toA(mulJ(toJ(a), k)), msm, inGroup: (a: A) => F.isZ(mulJ(toJ(a), r)[2]), neg: (a: A): A => (a ? [a[0], F.sub(F.zero, a[1])] : null) };
	};
	const G1 = group<bigint>({ add: (a, c) => { const x = a + c; return x >= p ? x - p : x; }, sub: (a, c) => { const x = a - c; return x < 0n ? x + p : x; }, mul: (a, c) => (a * c) % p, sqr: (a) => (a * a) % p, inv: (a) => invMod(a, p), eq: (a, c) => a === c, zero: 0n, one: 1n, isZ: (a) => a === 0n }, b1);
	const G2 = group<F2>({ add: add2, sub: sub2, mul: mul2, sqr: sqr2, inv: inv2, eq: eq2, zero: Z2, one: O2, isZ: isZ2 }, b2);
	/** a square root in Fp2, or null */
	const sqrt2 = (a: F2): F2 | null => { if (isZ2(a)) return a; const n = powMod((a[0] * a[0] + a[1] * a[1]) % p, (p + 1n) / 4n, p); for (const t of [m(a[0] + n), m(a[0] - n)]) { const d = (t * half) % p, x = powMod(d, (p + 1n) / 4n, p); if (x === 0n) { const y = powMod(m(-a[0]), (p + 1n) / 4n, p), c: F2 = [0n, y]; if (eq2(sqr2(c), a)) return c; continue; } if ((x * x) % p === d) { const c: F2 = [x, (a[1] * half % p * invMod(x, p)) % p]; if (eq2(sqr2(c), a)) return c; } } return null; };
	return { p, r, G1, G2, pairingsAreOne, _fe: { finalExp, finalExpPlain, hard: HARD, hardParts, frob1, frob2, mul12, conj12, eq12, O12 }, f2: { add2, sub2, mul2, sqr2, inv2, neg2, eq2, isZ2, scl2, sqrt2 }, m, b2 };
}

export const BN254 = pairingCurve({ p: 21888242871839275222246405745257275088696311157297823662689037894645226208583n, r: 21888242871839275222246405745257275088548364400416034343698204186575808495617n, b: 3n, xi: [9n, 1n], s: 6n * 4965661367192848881n + 2n, twist: 'D', bn: 4965661367192848881n });
const BLS_X = 0xd201000000010000n;
export const BLS = pairingCurve({ p: 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn, r: 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n, b: 4n, xi: [1n, 1n], s: BLS_X, twist: 'M', bls: BLS_X });
const G1_GEN: P1 = [0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bbn, 0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1n];
const G2_GEN: P2 = [[0x024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8n, 0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7en], [0x0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801n, 0x0606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79ben]];
export const GENERATORS = { G1: G1_GEN, G2: G2_GEN };

/* ---------- P-256 ---------- */
const PP = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, PN = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n, PB = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn, PG: [bigint, bigint] = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
type J3 = [bigint, bigint, bigint];
const pm = (x: bigint) => { const v = x % PP; return v < 0n ? v + PP : v; };
function pDbl([X, Y, Z]: J3): J3 { if (!Z || !Y) return [1n, 1n, 0n]; const d = pm(Z * Z), g = pm(Y * Y), b = pm(X * g), a = pm(3n * (X - d) * (X + d)), x = pm(a * a - 8n * b); return [x, pm(a * (4n * b - x) - 8n * g * g), pm((Y + Z) * (Y + Z) - g - d)]; }
function pAdd(q: J3, o: J3): J3 { if (!q[2]) return o; if (!o[2]) return q; const z1 = pm(q[2] * q[2]), z2 = pm(o[2] * o[2]), u1 = pm(q[0] * z2), u2 = pm(o[0] * z1), s1 = pm(q[1] * o[2] * z2), s2 = pm(o[1] * q[2] * z1); if (u1 === u2) return s1 === s2 ? pDbl(q) : [1n, 1n, 0n]; const h = pm(u2 - u1), hh = pm(h * h), hhh = pm(h * hh), w = pm(s2 - s1), v = pm(u1 * hh), x = pm(w * w - hhh - 2n * v); return [x, pm(w * (v - x) - s1 * hhh), pm(q[2] * o[2] * h)]; }
/** an ECDSA signature by a P-256 key (a passkey's, a phone's, a card's) of a 32-byte hash */
export function p256Verify(h: bigint, r: bigint, s: bigint, x: bigint, y: bigint): boolean {
	if (r <= 0n || r >= PN || s <= 0n || s >= PN || x >= PP || y >= PP || (x === 0n && y === 0n)) return false;
	if (pm(y * y) !== pm(x * x * x - 3n * x + PB)) return false;
	const w = invMod(s, PN), u = ((h % PN) * w) % PN, v = (r * w) % PN, Q: J3 = [x, y, 1n], GJ: J3 = [PG[0], PG[1], 1n], both = pAdd(GJ, Q); let t: J3 = [1n, 1n, 0n];
	for (let i = 255n; i >= 0n; i--) { t = pDbl(t); const a = (u >> i) & 1n, b = (v >> i) & 1n; if (a && b) t = pAdd(t, both); else if (a) t = pAdd(t, GJ); else if (b) t = pAdd(t, Q); }
	if (!t[2]) return false;
	const zi = invMod(t[2], PP); return pm(t[0] * zi * zi) % PN === r;
}

/* ---------- bytes ---------- */
const big = (d: Uint8Array, at: number, n: number): bigint => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(d[at + i] ?? 0); return v; };
const out = (n: number, ...vs: bigint[]): Uint8Array => { const o = new Uint8Array(n * vs.length); vs.forEach((v, k) => { for (let i = n - 1; i >= 0; i--) { o[k * n + i] = Number(v & 255n); v >>= 8n; } }); return o; };
const BAD = Symbol('not a point'); type Bad = typeof BAD;
/* BN254, as Ethereum writes it: 32 bytes a number, a point of G2 with the u part first */
const bnP1 = (d: Uint8Array, at: number): P1 | Bad => { const x = big(d, at, 32), y = big(d, at + 32, 32); if (x >= BN254.p || y >= BN254.p) return BAD; if (!x && !y) return null; return BN254.G1.on(x, y) ? [x, y] : BAD; };
const bnP2 = (d: Uint8Array, at: number): P2 | Bad => { const [a, b, c, e] = [0, 32, 64, 96].map((o) => big(d, at + o, 32)); if ([a, b, c, e].some((v) => v >= BN254.p)) return BAD; if (!a && !b && !c && !e) return null; const x: F2 = [b, a], y: F2 = [e, c]; return BN254.G2.on(x, y) && BN254.G2.inGroup([x, y]) ? [x, y] : BAD; };
/** 0x08: is the product of these pairings 1? null: the call fails */
export function bnPairing(d: Uint8Array): Uint8Array | null {
	if (d.length % 192) return null; const list: [P1, P2][] = [];
	for (let at = 0; at < d.length; at += 192) { const a = bnP1(d, at); if (a === BAD) return null; const b = bnP2(d, at + 64); if (b === BAD) return null; list.push([a as P1, b as P2]); }
	return out(32, BN254.pairingsAreOne(list) ? 1n : 0n);
}
/* BLS12-381 (EIP-2537): 64 bytes a number, the first 16 zero; a number of Fp2 with the real part first */
const bf = (d: Uint8Array, at: number): bigint | Bad => { for (let i = 0; i < 16; i++) if (d[at + i]) return BAD; const v = big(d, at + 16, 48); return v < BLS.p ? v : BAD; };
const g1In = (d: Uint8Array, at: number, group: boolean): P1 | Bad => { const x = bf(d, at), y = bf(d, at + 64); if (x === BAD || y === BAD) return BAD; if (!x && !y) return null; const q: P1 = [x as bigint, y as bigint]; return BLS.G1.on(q[0], q[1]) && (!group || BLS.G1.inGroup(q)) ? q : BAD; };
const g2In = (d: Uint8Array, at: number, group: boolean): P2 | Bad => { const v = [0, 64, 128, 192].map((o) => bf(d, at + o)); if (v.includes(BAD)) return BAD; const [a, b, c, e] = v as bigint[]; if (!a && !b && !c && !e) return null; const x: F2 = [a, b], y: F2 = [c, e]; return BLS.G2.on(x, y) && (!group || BLS.G2.inGroup([x, y])) ? [x, y] : BAD; };
const g1Out = (q: P1) => out(64, q ? q[0] : 0n, q ? q[1] : 0n), g2Out = (q: P2) => (q ? out(64, q[0][0], q[0][1], q[1][0], q[1][1]) : new Uint8Array(256));
export function blsG1Add(d: Uint8Array): Uint8Array | null { if (d.length !== 256) return null; const a = g1In(d, 0, false), b = g1In(d, 128, false); return a === BAD || b === BAD ? null : g1Out(BLS.G1.add(a as P1, b as P1)); }
export function blsG2Add(d: Uint8Array): Uint8Array | null { if (d.length !== 512) return null; const a = g2In(d, 0, false), b = g2In(d, 256, false); return a === BAD || b === BAD ? null : g2Out(BLS.G2.add(a as P2, b as P2)); }
export function blsG1Msm(d: Uint8Array): Uint8Array | null { if (!d.length || d.length % 160) return null; const l: [P1, bigint][] = []; for (let at = 0; at < d.length; at += 160) { const a = g1In(d, at, true); if (a === BAD) return null; l.push([a as P1, big(d, at + 128, 32) % BLS.r]); } return g1Out(BLS.G1.msm(l)); }
export function blsG2Msm(d: Uint8Array): Uint8Array | null { if (!d.length || d.length % 288) return null; const l: [P2, bigint][] = []; for (let at = 0; at < d.length; at += 288) { const a = g2In(d, at, true); if (a === BAD) return null; l.push([a as P2, big(d, at + 256, 32) % BLS.r]); } return g2Out(BLS.G2.msm(l)); }
export function blsPairing(d: Uint8Array): Uint8Array | null { if (!d.length || d.length % 384) return null; const l: [P1, P2][] = []; for (let at = 0; at < d.length; at += 384) { const a = g1In(d, at, true); if (a === BAD) return null; const b = g2In(d, at + 128, true); if (b === BAD) return null; l.push([a as P1, b as P2]); } return out(32, BLS.pairingsAreOne(l) ? 1n : 0n); }
/* a number onto the curve (RFC 9380: the simplified SWU map, its isogeny, and the cofactor) */
const { add2, mul2, sqr2, inv2, neg2, eq2, isZ2, sqrt2, sub2 } = BLS.f2, Q = BLS.p;
const hx = (s: string): bigint[] => s.split(' ').map((x) => BigInt('0x' + x));
const A1 = 0x144698a3b8e9433d693a02c96d4982b0ea985383ee66a8d8e8981aefd881ac98936f8da0e0f97f5cf428082d584c1dn, B1 = 0x12e2908d11688030018b12e8753eee3b2016c1f0f24f4070a0b9c14fcef35ef55a23215a316ceaa5d1cc48e98e172be0n;
const ISO1: bigint[][] = [
	hx('11a05f2b1e833340b809101dd99815856b303e88a2d7005ff2627b56cdb4e2c85610c2d5f2e62d6eaeac1662734649b7 17294ed3e943ab2f0588bab22147a81c7c17e75b2f6a8417f565e33c70d1e86b4838f2a6f318c356e834eef1b3cb83bb d54005db97678ec1d1048c5d10a9a1bce032473295983e56878e501ec68e25c958c3e3d2a09729fe0179f9dac9edcb0 1778e7166fcc6db74e0609d307e55412d7f5e4656a8dbf25f1b33289f1b330835336e25ce3107193c5b388641d9b6861 e99726a3199f4436642b4b3e4118e5499db995a1257fb3f086eeb65982fac18985a286f301e77c451154ce9ac8895d9 1630c3250d7313ff01d1201bf7a74ab5db3cb17dd952799b9ed3ab9097e68f90a0870d2dcae73d19cd13c1c66f652983 d6ed6553fe44d296a3726c38ae652bfb11586264f0f8ce19008e218f9c86b2a8da25128c1052ecaddd7f225a139ed84 17b81e7701abdbe2e8743884d1117e53356de5ab275b4db1a682c62ef0f2753339b7c8f8c8f475af9ccb5618e3f0c88e 80d3cf1f9a78fc47b90b33563be990dc43b756ce79f5574a2c596c928c5d1de4fa295f296b74e956d71986a8497e317 169b1f8e1bcfa7c42e0c37515d138f22dd2ecb803a0c5c99676314baf4bb1b7fa3190b2edc0327797f241067be390c9e 10321da079ce07e272d8ec09d2565b0dfa7dccdde6787f96d50af36003b14866f69b771f8c285decca67df3f1605fb7b 6e08c248e260e70bd1e962381edee3d31d79d7e22c837bc23c0bf1bc24c6b68c24b1b80b64d391fa9c8ba2e8ba2d229'),
	hx('8ca8d548cff19ae18b2e62f4bd3fa6f01d5ef4ba35b48ba9c9588617fc8ac62b558d681be343df8993cf9fa40d21b1c 12561a5deb559c4348b4711298e536367041e8ca0cf0800c0126c2588c48bf5713daa8846cb026e9e5c8276ec82b3bff b2962fe57a3225e8137e629bff2991f6f89416f5a718cd1fca64e00b11aceacd6a3d0967c94fedcfcc239ba5cb83e19 3425581a58ae2fec83aafef7c40eb545b08243f16b1655154cca8abc28d6fd04976d5243eecf5c4130de8938dc62cd8 13a8e162022914a80a6f1d5f43e7a07dffdfc759a12062bb8d6b44e833b306da9bd29ba81f35781d539d395b3532a21e e7355f8e4e667b955390f7f0506c6e9395735e9ce9cad4d0a43bcef24b8982f7400d24bc4228f11c02df9a29f6304a5 772caacf16936190f3e0c63e0596721570f5799af53a1894e2e073062aede9cea73b3538f0de06cec2574496ee84a3a 14a7ac2a9d64a8b230b3f5b074cf01996e7f63c21bca68a81996e1cdf9822c580fa5b9489d11e2d311f7d99bbdcc5a5e a10ecf6ada54f825e920b3dafc7a3cce07f8d1d7161366b74100da67f39883503826692abba43704776ec3a79a1d641 95fc13ab9e92ad4476d6e3eb3a56680f682b4ee96f7d03776df533978f31c1593174e4b4b7865002d6384d168ecdd0a 1'),
	hx('90d97c81ba24ee0259d1f094980dcfa11ad138e48a869522b52af6c956543d3cd0c7aee9b3ba3c2be9845719707bb33 134996a104ee5811d51036d776fb46831223e96c254f383d0f906343eb67ad34d6c56711962fa8bfe097e75a2e41c696 cc786baa966e66f4a384c86a3b49942552e2d658a31ce2c344be4b91400da7d26d521628b00523b8dfe240c72de1f6 1f86376e8981c217898751ad8746757d42aa7b90eeb791c09e4a3ec03251cf9de405aba9ec61deca6355c77b0e5f4cb 8cc03fdefe0ff135caf4fe2a21529c4195536fbe3ce50b879833fd221351adc2ee7f8dc099040a841b6daecf2e8fedb 16603fca40634b6a2211e11db8f0a6a074a7d0d4afadb7bd76505c3d3ad5544e203f6326c95a807299b23ab13633a5f0 4ab0b9bcfac1bbcb2c977d027796b3ce75bb8ca2be184cb5231413c4d634f3747a87ac2460f415ec961f8855fe9d6f2 987c8d5333ab86fde9926bd2ca6c674170a05bfe3bdd81ffd038da6c26c842642f64550fedfe935a15e4ca31870fb29 9fc4018bd96684be88c9e221e4da1bb8f3abd16679dc26c1e8b6e6a1f20cabe69d65201c78607a360370e577bdba587 e1bba7a1186bdb5223abde7ada14a23c42a0ca7915af6fe06985e7ed1e4d43b9b3f7055dd4eba6f2bafaaebca731c30 19713e47937cd1be0dfd0b8f1d43fb93cd2fcbcb6caf493fd1183e416389e61031bf3a5cce3fbafce813711ad011c132 18b46a908f36f6deb918c143fed2edcc523559b8aaf0c2462e6bfe7f911f643249d9cdf41b44d606ce07c8a4d0074d8e b182cac101b9399d155096004f53f447aa7b12a3426b08ec02710e807b4633f06c851c1919211f20d4c04f00b971ef8 245a394ad1eca9b72fc00ae7be315dc757b3b080d4c158013e6632d3c40659cc6cf90ad1c232a6442d9d3f5db980133 5c129645e44cf1102a159f748c4a3fc5e673d81d7e86568d9ab0f5d396a7ce46ba1049b6579afb7866b1e715475224b 15e6be4e990f03ce4ea50b3b42df2eb5cb181d8f84965a3957add4fa95af01b2b665027efec01c7704b456be69c8b604'),
	hx('16112c4c3a9c98b252181140fad0eae9601a6de578980be6eec3232b5be72e7a07f3688ef60c206d01479253b03663c1 1962d75c2381201e1a0cbd6c43c348b885c84ff731c4d59ca4a10356f453e01f78a4260763529e3532f6102c2e49a03d 58df3306640da276faaae7d6e8eb15778c4855551ae7f310c35a5dd279cd2eca6757cd636f96f891e2538b53dbf67f2 16b7d288798e5395f20d23bf89edb4d1d115c5dbddbcd30e123da489e726af41727364f2c28297ada8d26d98445f5416 be0e079545f43e4b00cc912f8228ddcc6d19c9f0f69bbb0542eda0fc9dec916a20b15dc0fd2ededda39142311a5001d 8d9e5297186db2d9fb266eaac783182b70152c65550d881c5ecd87b6f0f5a6449f38db9dfa9cce202c6477faaf9b7ac 166007c08a99db2fc3ba8734ace9824b5eecfdfa8d0cf8ef5dd365bc400a0051d5fa9c01a58b1fb93d1a1399126a775c 16a3ef08be3ea7ea03bcddfabba6ff6ee5a4375efa1f4fd7feb34fd206357132b920f5b00801dee460ee415a15812ed9 1866c8ed336c61231a1be54fd1d74cc4f9fb0ce4c6af5920abc5750c4bf39b4852cfe2f7bb9248836b233d9d55535d4a 167a55cda70a6e1cea820597d94a84903216f763e13d87bb5308592e7ea7d4fbc7385ea3d529b35e346ef48bb8913f55 4d2f259eea405bd48f010a01ad2911d9c6dd039bb61a6290e591b36e636a5c871a5c29f4f83060400f8b49cba8f6aa8 accbb67481d033ff5852c1e48c50c477f94ff8aefce42d28c0f9a88cea7913516f968986f7ebbea9684b529e2561092 ad6b9514c767fe3c3613144b45f1496543346d98adf02267d5ceef9a00d9b8693000763e3b90ac11e99b138573345cc 2660400eb2e4f3b628bdd0d53cd76f2bf565b94e72927c1cb748df27942480e420517bd8714cc80d1fadc1326ed06f7 e0fa1d816ddc03e6b24255e0d7819c171c40f65e273b853324efcd6356caa205ca2f570f13497804415473a1d634b8f 1'),
];
const H2 = 0xbc69f08f2ee75b3584c6a0ea91b352888e2a8e9145ad7689986ff031508ffe1329c2f178731db956d82bf015d1212b02ec0ec69d7477c1ae954cbc06689f6a359894c0adebbf6b4e8020005aaa95551n, H1 = 0xd201000000010001n;
const A2: F2 = [0n, 240n], B2: F2 = [1012n, 1012n], Z_2: F2 = [Q - 2n, Q - 1n];
const ISO2: F2[][] = [
	[[0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97d6n, 0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97d6n], [0x0n, 0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71an], [0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71en, 0x8ab05f8bdd54cde190937e76bc3e447cc27c3d6fbd7063fcd104635a790520c0a395554e5c6aaaa9354ffffffffe38dn], [0x171d6541fa38ccfaed6dea691f5fb614cb14b4e7f4e810aa22d6108f142b85757098e38d0f671c7188e2aaaaaaaa5ed1n, 0x0n]],
	[[0x0n, 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa63n], [0xcn, 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa9fn], [0x1n, 0x0n]],
	[[0x1530477c7ab4113b59a4c18b076d11930f7da5d4a07f649bf54439d87d27e500fc8c25ebf8c92f6812cfc71c71c6d706n, 0x1530477c7ab4113b59a4c18b076d11930f7da5d4a07f649bf54439d87d27e500fc8c25ebf8c92f6812cfc71c71c6d706n], [0x0n, 0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97ben], [0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71cn, 0x8ab05f8bdd54cde190937e76bc3e447cc27c3d6fbd7063fcd104635a790520c0a395554e5c6aaaa9354ffffffffe38fn], [0x124c9ad43b6cf79bfbf7043de3811ad0761b0f37a1e26286b0e977c69aa274524e79097a56dc4bd9e1b371c71c718b10n, 0x0n]],
	[[0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa8fbn, 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa8fbn], [0x0n, 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa9d3n], [0x12n, 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa99n], [0x1n, 0x0n]],
];
const sgn2 = (a: F2) => (a[0] % 2n === 1n || (a[0] === 0n && a[1] % 2n === 1n));
const poly2 = (k: F2[], x: F2) => k.reduceRight((acc, c) => add2(mul2(acc, x), c), [0n, 0n] as F2), poly1 = (k: bigint[], x: bigint) => k.reduceRight((acc, c) => (acc * x + c) % Q, 0n);
function swu2(u: F2): P2 {
	const t = mul2(Z_2, sqr2(u)), tv = add2(sqr2(t), t); let x1 = isZ2(tv) ? mul2(B2, inv2(mul2(Z_2, A2))) : mul2(mul2(neg2(B2), inv2(A2)), add2([1n, 0n], inv2(tv)));
	const gx = (x: F2) => add2(mul2(add2(sqr2(x), A2), x), B2); let y = sqrt2(gx(x1)); if (!y) { x1 = mul2(t, x1); y = sqrt2(gx(x1)); if (!y) return null; }
	if (sgn2(u) !== sgn2(y)) y = neg2(y);
	const xd = poly2(ISO2[1], x1), yd = poly2(ISO2[3], x1); if (isZ2(xd) || isZ2(yd)) return null;
	return [mul2(poly2(ISO2[0], x1), inv2(xd)), mul2(y, mul2(poly2(ISO2[2], x1), inv2(yd)))];
}
function swu1(u: bigint): P1 {
	const Z = 11n, t = (Z * u % Q) * u % Q, tv = (t * t + t) % Q; let x1 = tv === 0n ? B1 * invMod(Z * A1 % Q, Q) % Q : (Q - B1) * invMod(A1, Q) % Q * ((1n + invMod(tv, Q)) % Q) % Q;
	const gx = (x: bigint) => ((x * x + A1) % Q * x + B1) % Q, root = (a: bigint) => { const y = powMod(a, (Q + 1n) / 4n, Q); return y * y % Q === a ? y : null; }; let y = root(gx(x1)); if (y === null) { x1 = t * x1 % Q; y = root(gx(x1)); if (y === null) return null; }
	if (u % 2n !== y % 2n) y = (Q - y) % Q;
	const xd = poly1(ISO1[1], x1), yd = poly1(ISO1[3], x1); if (!xd || !yd) return null;
	return [poly1(ISO1[0], x1) * invMod(xd, Q) % Q, y * poly1(ISO1[2], x1) % Q * invMod(yd, Q) % Q];
}
export function blsMapG1(d: Uint8Array): Uint8Array | null { if (d.length !== 64) return null; const u = bf(d, 0); return u === BAD ? null : g1Out(BLS.G1.mul(swu1(u as bigint), H1)); }
export function blsMapG2(d: Uint8Array): Uint8Array | null { if (d.length !== 128) return null; const a = bf(d, 0), b = bf(d, 64); return a === BAD || b === BAD ? null : g2Out(BLS.G2.mul(swu2([a as bigint, b as bigint]), H2)); }

/* ---------- KZG (EIP-4844) ---------- */
/** a point of G1 in its 48 bytes (checked: on the curve, in the group) */
export function g1From48(d: Uint8Array): P1 | Bad { const c = d[0]; if (d.length !== 48 || !(c & 0x80)) return BAD; const x = big(d, 0, 48) & ((1n << 381n) - 1n); if (c & 0x40) return x === 0n && !(c & 0x20) ? null : BAD; if (x >= Q) return BAD; const t = (x * x % Q * x + 4n) % Q; let y = powMod(t, (Q + 1n) / 4n, Q); if (y * y % Q !== t) return BAD; if ((y > (Q - 1n) / 2n) !== !!(c & 0x20)) y = Q - y; return BLS.G1.inGroup([x, y]) ? [x, y] : BAD; }
const TAU: P2 = (() => { const h = 'b5bfd7dd8cdeb128843bc287230af38926187075cbfbefa81009a2ce615ac53d2914e5870cb452d2afaaab24f3499f72185cbfee53492714734429b7b38608e23926c911cceceac9a36851477ba4c60b087041de621000edc98edada20c1def2', x: F2 = [BigInt('0x' + h.slice(96)), BigInt('0x' + h.slice(0, 96)) & ((1n << 381n) - 1n)], y = sqrt2(add2(mul2(sqr2(x), x), BLS.b2))!; const bigY = y[1] > 0n ? y[1] > (Q - 1n) / 2n : y[0] > (Q - 1n) / 2n; return [x, bigY === !!(parseInt(h[0], 16) & 2) ? y : neg2(y)]; })(); // the ceremony's point (2023, 141,416 people): one of the group's, times a number nobody knows
/** 0x0a: the polynomial behind `commitment` is y at z. null: the call fails */
export function kzgPoint(d: Uint8Array): Uint8Array | null {
	if (d.length !== 192) return null; const h = sha256(d.slice(96, 144)); if (d[0] !== 1) return null; for (let i = 1; i < 32; i++) if (d[i] !== h[i]) return null;
	const z = big(d, 32, 32), y = big(d, 64, 32); if (z >= BLS.r || y >= BLS.r) return null; const C = g1From48(d.slice(96, 144)), W = g1From48(d.slice(144, 192)); if (C === BAD || W === BAD) return null;
	const X: P2 = BLS.G2.add(TAU, BLS.G2.neg(BLS.G2.mul(G2_GEN, z))), Y: P1 = BLS.G1.add(C as P1, BLS.G1.neg(BLS.G1.mul(G1_GEN, y)));
	return BLS.pairingsAreOne([[Y, BLS.G2.neg(G2_GEN)], [W as P1, X]]) ? out(32, 4096n, BLS.r) : null;
}
/** 0x100: a P-256 signature: 1, or nothing */
export function p256(d: Uint8Array): Uint8Array { return d.length === 160 && p256Verify(big(d, 0, 32), big(d, 32, 32), big(d, 64, 32), big(d, 96, 32), big(d, 128, 32)) ? out(32, 1n) : new Uint8Array(0); }
/* (eq2 and sub2 are used by the tests) */
export const _laws = { eq2, sub2 };
