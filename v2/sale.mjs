/* dznye: the Sun's sale, in exact whole numbers. price(s) = saleStart x 2^(s / saleDouble); a buyer pays the exact
   area under that curve, so one big buy and many small ones cost the same. No floating point: 2^x is worked out with
   a Taylor series whose every step is floored the same way on every machine. Used by the model and by the chain. */
import { UNIT } from './rules.mjs';

/* F(s) is the dollars paid for the first s units, x S */
const S = 10n ** 30n;
const LN2 = 693_147_180_559_945_309_417_232_121_458n; // ln 2 x 10^30
function expS(x) { // e^(x/S) x S, for 0 <= x < S; plain Taylor series, every step floored the same way on every machine
	let sum = S, term = S;
	for (let n = 1n; term > 0n; n++) { term = term * x / (S * n); sum += term; }
	return sum;
}
export function saleF(cfg, s) {
	const k = s / cfg.saleDouble, r = s % cfg.saleDouble;
	const e = expS(r * LN2 / cfg.saleDouble); // 2^(r/D) x S
	return cfg.saleStart * cfg.saleDouble * (1n << k) * e * S / (UNIT * LN2); // µ$ x S (e and LN2 share the scale S)
}
export function saleCost(cfg, a, b) { // µ$ to buy units a..b, rounded up: the buyer never pays less than the curve
	const d = saleF(cfg, b) - saleF(cfg, a);
	return (d + S - 1n) / S;
}
export function salePrice(cfg, s) { // µ$ per DZY at s units sold
	return cfg.saleStart * (1n << (s / cfg.saleDouble)) * expS((s % cfg.saleDouble) * LN2 / cfg.saleDouble) / S;
}
export function saleUnitsFor(cfg, sold, paid) { // the most units whose cost fits in what was paid, never past the cap
	let lo = sold, hi = cfg.saleCap;
	if (saleCost(cfg, sold, hi) <= paid) return hi - sold;
	while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (saleCost(cfg, sold, mid) <= paid) lo = mid; else hi = mid; }
	return lo - sold;
}
