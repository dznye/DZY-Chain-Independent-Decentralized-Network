/* dznye: every constant of the chain, in this one file. The tested model (econ.mjs) and the chain itself
   (src/ledger.ts) both read them from here, so they can never drift apart. Once the chain starts, these are fixed
   for ever: changing any of them makes a different chain.

   Whole numbers only (BigInt). Amounts are in shards: 1 DZY = 10^8 shards (8 decimals, like bitcoin's satoshis; the most
   the chain's code can hold, since it keeps amounts as ordinary whole numbers, exact up to 9 x 10^15, and all 12,000,000 DZY
   are 1.2 x 10^15 shards). The rules call a shard a unit. Dollars are in µ$ (USDC and USDT have
   6 decimals). Time is in chain minutes: a chain minute passes only when a block is made in a new clock minute, so a
   stopped chain costs nobody anything. */

export const DECIMALS = 8;
export const UNIT = 10n ** 8n;              // one DZY, in shards
export const SUPPLY = 12_000_000n * UNIT; // all the DZY there will ever be; none is ever created or destroyed
export const DAY = 1_440n;
export const YEAR = 525_960n;              // minutes in 365.25 days
export const SUB = 10n ** 12n;             // sub-units per unit, so per-minute shares never round away (they are carried)
export const IDX = 10n ** 36n;             // precision of the running totals (indexes)
export const BP = 10_000n;                 // basis points
export const TICK = 10n ** 9n;             // deposit clocks are kept in billionths of a minute

export const RULES = {
	/* the split of every minute's profit (the rest, 50%, stays in the Sun) */
	validatorBp: 4_000n,          // 40% to validators, by raffle
	holderBp: 1_000n,             // 10% to holders, by deposit weight
	dripBp: 500n,                 // the Sun adds 5% of what it holds a year to profit, times the share of all DZY in people's hands, never more than the fees released that minute
	potMinutes: DAY,              // fees reach profit spread over about a day (each minute, 1/1,440 of what waits)
	/* the raffle */
	ticketBp: 3_000n,             // tickets a minute = 30% of active lockers, rounded up ...
	maxTickets: 60n,              // ... but never more than 60, so the chain's work is the same at any size
	answerMinutes: 10n,           // a winner has this long, once the winners are known, to answer its history question
	seedWait: 60n,                // with no new Bitcoin block for this long, a round is drawn from the chain's own last block
	minYears: 1n, maxYears: 100n, // lock weight = DZY locked x whole years: as long as someone wants, up to 100 (2026-11-16, the owner's choice)
	/* the fixed deposit: weight = the parts of the balance that have waited 30 days, a year, 3 years (0 to 3 x balance) */
	tiers: [30n * DAY, YEAR, 3n * YEAR],
	renewMinutes: YEAR,           // an account that signs nothing for this long stops earning (lost keys)
	/* the Sun's uses, each limited by a share of what it holds */
	welcomeBp: 50n, welcomeBank: DAY,      // fees for new and tiny accounts: 0.5% of the Sun a year, at most a day's worth saved up
	welcomeTinyFees: 100n,                 // "tiny" = holds less than 100 fees at the current fee
	lendBp: 1_000n,                        // lent into the margin vaults: at most 10% of the Sun's holdings (cash + loans)
	backstopBp: 100n, backstopBank: 30n * DAY, // bad debt covered: 1% of the Sun a year, at most 30 days' worth saved up
	/* the sale */
	saleStart: 116_900n,          // µ$ per DZY at the start ($0.1169: the genesis purchase, 8,500 DZY for $1,000, fits under the curve)
	saleDouble: 500_000n * UNIT,  // DZY sold that doubles the price
	saleCap: 3_000_000n * UNIT,   // the sale ends for ever when this much has been sold
	/* fees and blocks */
	feeFloor: 1n,                 // smallest base fee: one shard (0.00000001 DZY)
	feeCap: 1_000n * UNIT,        // largest base fee (1,000 DZY): spam already costs a fortune long before it, and the fee stays an exact whole number for ever
	maxTxPerBlock: 500n,          // the fee's target is half of this
	/* the council: validators paid like a fair job (2026-11-17). A share of every fee goes to the council fund; the fund
	   pays the validators' wage, equal shares to every validator that made its turns that day, plus a daily bonus drawn by shards */
	councilBp: 2_000n,            // 20% of the fees released each minute go to the council fund (the other 80% are the profit)
	wageBp: 100n,                 // the validators' wage, all together: 1% of the DZY in people's hands a year
	bonusBp: 2_000n,              // 20% of each wage payment builds the bonus, paid once a chain day to a worker drawn by its staked shards (sun.ts bonusWinner)
	workMinutes: DAY,             // a validator "worked" if it made a block within the last chain day
	/* the commission: the fee floor follows the council fund, once a chain day */
	bufferDays: 30n,              // the fund should hold 30 days of wages, plus two standard deviations of its daily income over them
	feeStepDiv: 8n,               // the floor moves by (shortfall / buffer) / 8 a day: at most 12.5%, at least one unit
	floorMax: UNIT / 1_000n,      // the floor never above 0.001 DZY: a quiet chain stays cheap (its validators earn less) instead of
	                              // chasing the full wage from a few users (found by simulating 10 quiet years: 16.8 DZY a fee); busy blocks can still raise the fee
	historyDays: 30n,             // days of history kept for the buffer and the policy rate
	/* the policy rate (the chain's own central bank: the Taylor rule), once a chain day; it is the base rate of every loan */
	rateStartBp: 500n,            // where it starts: 5% a year
	rateNeutralBp: 100n,          // the neutral real rate: 1%
	moneyGoalBp: 200n,            // the goal for the growth of DZY in people's hands: 2% a year
	rateMaxBp: 2_000n,            // never above 20% a year (never below 0)
	rateStepBp: 25n,              // moves at most 0.25% a day, as central banks do
	/* starter credit: a new account may try everything before owning DZY: a name, a test token, a test contract and
	   everyday fees, on credit. Repaid from the first DZY it receives, with the policy rate as interest, or after about
	   6 months taken back: the name released, the account never given credit again. It can never be sent as DZY */
	creditAmount: 22n * UNIT / 10n, // 2.2 DZY: a name (0.1), a token (1), a contract (1) and fees
	creditMinutes: YEAR / 2n,     // repay within half a year (about 6 months, the owner's choice), or it is taken back
	creditBp: 50n,                // the fees paid on credit: at most 0.5% of the Sun a year, at most a day of it saved up
	creditPerDay: 1_000n,         // new starter credits a chain day, at most
	/* free transactions for lockers (like staking for bandwidth on Tron): every chain day, freePerDay simple transactions
	   are free, shared among all lockers by the DZY each has locked; splitting a lock over many accounts gains nothing */
	freePerDay: 1_440_000n,       // 1,000 a chain minute, network-wide
	creditNameMin: 6n,            // a name taken on credit has at least 6 characters (short names need DZY of one's own)
};

/* tickets a minute for n active lockers: 30% of them, rounded up, at most 60 */
export function ticketsFor(cfg, n) {
	if (n <= 0n) return 0n;
	const k = (n * cfg.ticketBp + BP - 1n) / BP;
	return k < cfg.maxTickets ? k : cfg.maxTickets;
}

/* The price of a seat. Locked DZY counts as burned: the more of it is locked away, the less each newly locked DZY
   counts, so every new validator pays a little more than the last for the same weight, by itself, from locked against
   circulating (no buyer or seller). Each unit counts by the share of DZY still circulating at the moment it is locked:
     weight = years x (area under the line from C0/O down to (C0 - amt)/O) = years x (2 amt C0 - amt^2) / (2 O)
   where O = DZY out of the Sun and the sale, and C0 = O minus what is already locked. Because it is an area, one lock
   and the same lock in a thousand pieces weigh the same. 0 when it is too small to count. */
export function seatWeight(amt, years, out, locked) {
	const c0 = out - locked;
	if (amt <= 0n || years <= 0n || c0 <= 0n || amt > c0) return 0n;
	return years * (2n * amt * c0 - amt * amt) / (2n * out);
}

/* the fee after a block that used `use` of its space, against a target of `target` (both in transactions) */
export function feeNext(cfg, fee, use, target) {
	let d = fee * (use - target) / (8n * target);
	// whole numbers round small changes to zero, which would freeze a small fee: always move by at least one unit
	if (d === 0n && use !== target) d = use > target ? 1n : -1n;
	const next = fee + d;
	return next < cfg.feeFloor ? cfg.feeFloor : next > cfg.feeCap ? cfg.feeCap : next;
}

/* ---------- the council, the commission and the policy rate (2026-11-17): whole numbers, the same in the chain and the model ---------- */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** the largest whole number whose square is at most n */
export function isqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
/** the validators' wage for m minutes, in sub-units: wageBp of the DZY in people's hands (M) a year */
export const wageSub = (cfg, M, m) => M * cfg.wageBp * m * SUB / (BP * YEAR);
/** the insurance buffer: bufferDays of wages, plus two standard deviations of the fund's daily income over that many days
    (sd x sqrt(days)): more cushion when income is jumpy, as an insurer holds */
export function bufferFor(cfg, M, incomes) {
	const day = M * cfg.wageBp * DAY / (BP * YEAR), n = BigInt(incomes.length);
	let sd = 0n;
	if (n > 1n) { const mean = incomes.reduce((a, x) => a + x, 0n) / n; sd = isqrt(incomes.reduce((a, x) => a + (x - mean) * (x - mean), 0n) / n); }
	return cfg.bufferDays * day + 2n * sd * isqrt(cfg.bufferDays * 1_000_000n) / 1_000n;
}
/** the commission: tomorrow's fee floor. It rises when the council fund is short of its buffer and falls when it is full,
    by (shortfall / buffer) / feeStepDiv (at most 12.5% a day, at least one unit), within [feeFloor, floorMax] */
export function nextFloor(cfg, floor, fund, buffer) {
	const gap = buffer > 0n ? clamp((buffer - fund) * BP / buffer, -BP, BP) : fund > 0n ? -BP : 0n;
	let step = floor * gap / (cfg.feeStepDiv * BP);
	if (step === 0n && gap !== 0n) step = gap > 0n ? 1n : -1n;
	return clamp(floor + step, cfg.feeFloor, cfg.floorMax);
}
/** how fast the DZY in people's hands grew over `days`, at a year's pace, in bp (within ±100%) */
export const moneyGrowthBp = (now, then, days) => (then > 0n && days > 0n ? clamp((now - then) * BP * 365n / (then * days), -BP, BP) : 0n);
/** how busy blocks were against the fee's target (half full): txs / (blocks x target) - 1, in bp (within ±100%) */
export const useGapBp = (cfg, txs, blocks) => (blocks > 0n ? clamp(txs * BP * 2n / (blocks * cfg.maxTxPerBlock) - BP, -BP, BP) : -BP);
/** the Taylor rule: neutral + growth + (growth - goal) / 2 + use / 2, within [0, rateMax] */
export const policyTarget = (cfg, growthBp, useBp) => clamp(cfg.rateNeutralBp + growthBp + (growthBp - cfg.moneyGoalBp) / 2n + useBp / 2n, 0n, cfg.rateMaxBp);
/** the rate moves toward its target by at most rateStep a day */
export const nextRate = (cfg, rate, target) => rate + clamp(target - rate, -cfg.rateStepBp, cfg.rateStepBp);

/* every formula and constant, as the chain's GET /rules gives them (whole numbers as text, so nothing is rounded) */
export function rulesJson(cfg = RULES) {
	const v = (x) => (typeof x === 'bigint' ? x.toString() : Array.isArray(x) ? x.map(v) : x);
	return {
		decimals: DECIMALS, supply: SUPPLY.toString(), minutesPerYear: YEAR.toString(),
		constants: Object.fromEntries(Object.entries(cfg).filter(([, x]) => typeof x === 'bigint' || Array.isArray(x)).map(([k, x]) => [k, v(x)])),
		formulas: {
			chainMinute: 'one passes when a block is made in a new clock minute; nothing counts while the chain is stopped',
			profit: 'fees released this minute (1/potMinutes of the fee pot) + drip, where drip = sun x dripBp/10000 / minutesPerYear x (supply - sun - unsold) / supply, never more than the fees released this minute',
			split: 'validators validatorBp, holders holderBp, the rest stays in the Sun',
			tickets: 'min(maxTickets, ceil(activeLockers x ticketBp / 10000)) a minute, drawn by weight with replacement from the lockers as they stood that minute; prize = validator pot / tickets; a winner answers within answerMinutes; unanswered: to the Sun, and the winner sits out until it signs lock.ready',
			lockWeight: 'years x (2 amt C0 - amt^2) / (2 O): O = supply - sun - unsold, C0 = O - locked; each unit counts by the share still circulating as it is locked',
			depositWeight: 'for each step in tiers, the part of the balance that has waited that long; summed (0 to 3 x balance); 0 if the account signed nothing for renewMinutes; received DZY waits on its own clock, blended only with other waiting DZY; spending restarts every step; fees and rewards restart nothing',
			fee: 'next = fee + fee x (use - target) / (8 x target), moving at least 1 unit when use != target, never below feeFloor nor above feeCap; target = maxTxPerBlock / 2',
			salePrice: 'saleStart x 2^(sold / saleDouble) µ$ per DZY, until saleCap is sold',
			council: 'councilBp/10000 of the fees released each minute go to the council fund; it pays the wage, wageBp/10000 of the DZY in people\'s hands a year: (10000 - bonusBp)/10000 in equal shares among the validators that made a block within workMinutes, bonusBp/10000 to a bonus paid once a chain day to one such validator, drawn with one ticket per shard of its own stake plus backing, seeded by the newest Bitcoin block hash (else the last block of this chain) and the day',
			commission: 'once a chain day: buffer = bufferDays x a day\'s wage + 2 x sd(daily council income over historyDays) x sqrt(bufferDays); fee floor += floor x clamp((buffer - fund) / buffer, -1, 1) / feeStepDiv (at least one unit), within [feeFloor, floorMax]; the fee is never below the floor',
			policyRate: 'once a chain day: target = rateNeutral + g + (g - moneyGoal) / 2 + u / 2 within [0, rateMax], g = growth of the DZY in people\'s hands over historyDays a year, u = txs / (blocks x maxTxPerBlock / 2) - 1; the rate moves toward the target by at most rateStep; it is the base yearly rate of every loan',
			starterCredit: 'an account with no DZY may take creditAmount (at most creditPerDay a chain day): it pays only fees, a name of creditNameMin+ characters, a token and a contract, never a transfer; owed = used + used x policy rate at the time x elapsed / year (to the due minute); the first DZY the account receives repays it; after creditMinutes an unpaid credit closes, its name is released and the account never takes credit again (what it still owes is repaid from DZY it receives later); fees paid on credit come from a budget of creditBp/10000 of the Sun a year',
			welcome: 'budget += sun x welcomeBp/10000 / minutesPerYear a minute, at most welcomeBank minutes saved; pays the fee of an account holding < welcomeTinyFees fees',
			lending: 'the Sun lends at most lendBp/10000 of (sun + lent); any excess is recalled as the vault has cash',
			backstop: 'budget += sun x backstopBp/10000 / minutesPerYear a minute, at most backstopBank minutes saved; covers bad debt up to the budget',
			circulating: 'supply - sun - unsold - locked: the Sun, unsold and locked DZY are out of circulation, but never destroyed',
		},
	};
}
