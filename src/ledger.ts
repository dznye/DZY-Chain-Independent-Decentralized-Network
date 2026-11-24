import { rootCacheFor, stateRootOf } from './root.ts';
import { wotsRoot } from './wots.ts';
import { emptyOf, keysOf, peek } from './layer.ts';
import { canon, fromSolana, merkleRoot, sha256, sha256Bytes, sign, toBase58, verify } from './crypto.ts';
import { personalSigner } from './secp.ts';
import { btcAddress, btcMessageSigners, BTC_FLOOR, checkHeader, merkleRootOf, opReturnData, parseTx, sha256 as btcSha256 } from './btc.ts';
import { checkCall, checkProgram, ContractFailure, LIMITS, run, type Program, type Value, type World } from './contracts.ts';
import { backAdded, backGone, benchable, bondAdded, clockAfter, coinFee, curveOf, drawHeartCrew, grantOf, HEART, KEPT, keptAdd, keptTimes, newEntries, payPrice, seatFor, setIndexPrice, sizeFees, spotPrice, takeBacking, unitsFor, heartCoin, instantLeft, instantUse, mayVouch, missed as missedTurn, ownHours, FUTURE, PROOF, roomOf, startFuture, workAdd, startHeart, startProof, startTime, vouched, vouchers, turnFor, type HeartState } from './heart.ts';
import { EVM_HANDLERS, EVM_RULES, evmHeld, type EvmAcct, type EvmState } from './evmledger.ts';
import { BLOB_HANDLERS, blobHeld, royaltyIn, type Blob, type BlobBank, type Col, type Drop, type Look, type Nft } from './blobs.ts';
import { checkOp, isOwner, layerRoot, opMessage, ZONE_HANDLERS, zoneHeld, type Bank, type Batch, type Dep, type Layer } from './zones.ts';
import { RULES as V2 } from '../v2/rules.mjs';
import { saleBackFor, saleCost, salePrice, saleUnitsFor } from '../v2/sale.mjs';
import { lockOf, lockOut, SUN_SUPPLY } from './sun.ts';
import { charge as sunCharge, creditCovers, creditUse, lockFreeLeft, lockFreeUse, policyRate, openTickets, receive as sunReceive, refund as sunRefund, spend as sunSpend, SUN_HANDLERS, sunBlock, sunGenesis, sunHeld, sunPayment, sunPays, sunSupply, sunView, toSun, MAX_SUN_LOCKS, type SunState } from './sun.ts';
export { openTickets, sunBlock, sunGenesis, sunPayment, sunSupply, sunView };
export { creditView, economyView, lockFreeLeft } from './sun.ts';
export { MIN_BUY, SUN_BURN, SUN_DOLLARS, sunBuyProblem, sunMemo } from './sun.ts';

/* The rules of the Dznye chain (coin: DZY): what a transaction is and what it may change.
   Everything is a whole number. Nothing is created except by `mint` (the asset's issuer) and nothing is destroyed
   except by `burn` of a token, so for every asset: balances + open offers (+ stakes and the treasury, for DZY) = supply, always.
   A transaction that breaks a rule changes nothing at all. */

/* DZY is the chain's own coin, and the only thing the chain itself knows about:
     at most 12,000,000 can ever be issued, and no DZY is ever destroyed: fees, the charge for making a token, penalties
     for cheating and DZY that someone "burns" all go back to the chain's TREASURY, which pays them out again (by
     `treasury.spend`, in public). So DZY goes round like a currency and the total stays as issued; 6 decimals.
   Everything else is a TOKEN that somebody created on the chain with `asset.create`: an app's credits, a game's
   gold, a reward point, a ticket, a meme coin, a stable token, an item. The chain treats them all the same and
   favours none; what a token is for is up to whoever issues it.
   Amounts on the chain are always whole numbers of the smallest part: 1 DZY = 100,000,000 shards. */
export const NATIVE = 'DZY';
export const DZY_DECIMALS = 8; // a DZY is 100,000,000 shards (like bitcoin's satoshis): the most ordinary numbers hold exactly for 12,000,000 DZY
export const DZY = 10 ** DZY_DECIMALS; // one whole DZY, in parts
export const MONTH = 30 * 24 * 60 * 60 * 1000;

/* Who the 12,000,000 DZY are for. Every DZY is issued from one of these pools and the chain itself holds each pool
   to its limit and its timetable: a part may be free from the first block, the rest unlocks evenly, month by month,
   after an optional wait. Nobody can issue ahead of the timetable. Time counts from block 1. */
export interface Pool { cap: number; atStart: number; cliff: number; months: number; what: string }
export const POOLS: Readonly<Record<string, Pool>> = Object.freeze({
	community: { cap: 6_000_000 * DZY, atStart: 300_000 * DZY, cliff: 0, months: 96, what: 'Earned by people who use and build on the chain: rewards, contests, grants for real use' },
	creators: { cap: 2_400_000 * DZY, atStart: 120_000 * DZY, cliff: 0, months: 60, what: 'Grants for people who build apps, tokens and tools on the chain' },
	treasury: { cap: 1_200_000 * DZY, atStart: 120_000 * DZY, cliff: 0, months: 24, what: 'Running the network: nodes, security reviews, partners' },
	founder: { cap: 1_200_000 * DZY, atStart: 0, cliff: 6, months: 36, what: 'The founder: nothing for 6 months, then evenly over 3 years' },
	reserve: { cap: 1_200_000 * DZY, atStart: 0, cliff: 12, months: 24, what: 'Kept for later needs, such as future block makers; locked for a year' }
});
/** how much of a pool may have been issued once `elapsed` milliseconds have passed since block 1 */
export function unlocked(p: Pool, elapsed: number): number {
	const t = elapsed - p.cliff * MONTH, span = p.months * MONTH;
	if (t < 0) return p.cliff ? 0 : p.atStart;
	if (t >= span) return p.cap;
	return p.atStart + Number((BigInt(p.cap - p.atStart) * BigInt(Math.floor(t))) / BigInt(span));
}

export const RULES = {
	maxSupply: Number.MAX_SAFE_INTEGER,
	maxSunLocks: MAX_SUN_LOCKS, // locks one account may hold at once, on a chain with the Sun
	dzyCap: 12_000_000 * DZY,
	maxValidators: 64,
	maxKeys: 8, // device keys on one account
	recoverDelay: 3 * 24 * 60 * 60 * 1000, // a guardian's recovery waits this long, so the owner can cancel it
	assetFee: 1 * DZY, // DZY paid to the treasury to create an asset (stops spam)
	maxFee: 1 * DZY, // the most a chain may charge per transaction (its own fee is fixed at genesis)
	maxDecimals: 8,
	reasonMax: 60,
	memoMax: 120,
	recordMax: 1_000,    // the largest value a record holds, in characters
	recordByte: DZY / 100_000, // what keeping one character costs, once (0.00001 DZY): 1,000 characters for 0.01 DZY
	maxRecords: 10_000,  // records one account may keep
	maxStreams: 100, // open streams one account may pay into at once
	nameMax: 40,
	/* ---- creators: tips and items for sale (tip, item.buy) ---- */
	saleFeeBps: 50, // 0.5% of every tip and sale goes to saleFeeTo; the creator gets the rest
	saleFeeTo: '6653763632eb15f0e36df4f6710722e95ac555939df956aac01f1cf8f9341ac4', // the network's fee account
	tipMsgMax: 140, tipsKept: 20, // a tip's public message, and how many of the latest a creator's tip box shows
	/* checkout from any wallet or exchange (order.*): the buyer pays the creator's own address on another chain */
	orderLife: 60 * 60 * 1000, // an order waits this long for its payment
	orderGrace: 30 * 60 * 1000, // ... and the buyer may still name a payment this much later (exchanges can be slow)
	orderPaidWait: 6 * 60 * 60 * 1000, // once a payment is named, validators have this long to see it final
	orderTags: 99, // open orders at once for one creator, coin and network: each pays a slightly different amount
	maxOpenOrders: 5, // open orders one buyer may have
	feeOwedMax: 20_000_000, // a creator owing more than $20 of fees cannot take outside payments until they pay it
	maxEditions: 1_000_000,
	maxTxChars: 2000, maxBtcChars: 9_000,
	batchMax: 100, maxBatchChars: 10_000, // transfer.many: up to 100 payments in one transaction (a longer one), one fee per 20
	maxPartChars: 61_000, // a file's part: 45,000 bytes, as text, beside its transaction
	maxProofChars: 10_000, // layer.prove carries a step and the accounts it touched
	maxTxPerBlock: 500,
	clockSlack: 30_000, // a live node refuses a block dated more than this far past its own clock (time unlocks pools, stakes, recoveries)
	maxWaiting: 5000, // transactions a validator holds waiting for a block, from everyone together
	maxWaitingPerSender: 64, // ... and from one account
	/* ---- staking: who makes the blocks ---- */
	minStake: 1000 * DZY, // the least a validator must lock up to be in the set
	unbondDelay: 14 * 24 * 60 * 60 * 1000, // unlocked stake waits this long, still answerable for cheating, before it can be taken out
	maxUnbonding: 8, // unlocks waiting at once, per validator
	handover: 4, // staking takes over once every starting validator has staked, or once this many keys have
	slashPct: 5, // share of its stake a validator loses for signing two different votes in one place
	/* the crew upgrade (see crewOn): anyone with crewMinStake staked whose node checked in lately is in the draw; each
	   crewEveryMs a crew is drawn by shards: everyone while there are crewMin or fewer, else crewShareBp of them, between
	   crewMin and crewMax seats. Cheating costs the operator crewSlashPct of its stake (its backers still slashPct) */
	crewMinStake: 1 * DZY, crewEveryMs: 10 * 60_000, crewShareBp: 2000, crewMin: 64, crewMax: 128, crewSlashPct: 100,
	checkinWindowMs: 60 * 60_000, // a node that checked in within this long is online
	checkinGapMs: 5 * 60_000, // and may check in again after this long
	/* checkers: every check-in quotes one of the last recentBlocks blocks by its hash (so a node shows it follows this very
	   chain). A staked key whose node checked in during at least checkerMinHours different hours of a chain day is a
	   checker that day, and checkers share checkerShareBp of the day's work pay (the wage less its bonus), by stake. A node without a public address
	   checks only; it is never drawn to make blocks */
	recentBlocks: 64, checkerMinHours: 12, checkerShareBp: 2000,
	commissionDefaultBp: 1000, // an operator keeps 10% of its pay before its backers' share, unless it sets its own
	reporterPct: 10, // share of that penalty paid to whoever sent the proof; the rest goes to the treasury
	/* delegation: holders back a validator with their DZY (it counts toward its seat and its say, and shares its penalty) */
	maxDelegations: 16, // validators one account may back at once
	/* partners: a shop keeping at least this much DZY in its cashback reserve gets this many fee-free transactions every 30 days */
	partnerMinReserve: 100 * DZY, partnerFree: 10_000,
	/* treasury by vote: anyone with stake proposes a payout; it is paid once more than two thirds of all stake says yes */
	voteDays: 7 * 24 * 60 * 60 * 1000, maxProposals: 50,
	missLimit: 12, // turns to propose missed in a row before a validator is benched
	jailTime: 24 * 60 * 60 * 1000, // a benched validator waits at least this long before it can ask to come back
	feeShare: 50, // share of each fee paid to the staked validator that made the block; the rest goes to the treasury
	/* ---- contracts ---- */
	deployFee: 1 * DZY, // DZY paid to the treasury to put a contract on the chain (like making a token)
	maxDeployChars: 14_000, // a deploy carries a program, so it may be bigger than other transactions
	defaultGas: 10_000, // a call's gas limit when it names none
	/* ---- the second layer: payment channels ---- */
	channelWait: 24 * 60 * 60 * 1000, // after one side starts closing a channel, the other has this long to show a newer state
	reasonMin: 3, // a treasury payment must say what it is for
	nameFee: DZY / 10, // a name costs 0.1 DZY, to the treasury: enough to stop anyone taking thousands
	maxCosigs: 16,
	/* ---- the market, swaps with other chains, linked addresses ---- */
	maxTrades: 500, // completed trades the chain keeps (older ones stay in the blocks)
	maxFills: 50, // the most offers one swap or one matching offer fills in a step
	maxOfferTime: 365 * 24 * 60 * 60 * 1000, // the furthest ahead an offer's end may be
	maxSwapTime: 30 * 24 * 60 * 60 * 1000, // the longest a hash lock may run
	maxSwapLog: 300, // finished hash locks the chain keeps, with their secrets
	maxLinks: 8, // addresses on other chains one account may link to its name
	xHold: 10 * 60 * 1000, // a taker holds a cross-chain offer this long while they pay
	xGrace: 5 * 60 * 1000, // ... and validators have this much longer to see the payment before anyone else may hold it
	xPaidWait: 2 * 60 * 60 * 1000, // once the taker says which transaction paid, the hold lasts this long, for slow chains to make it final
	xPaidWaitBtc: 6 * 60 * 60 * 1000, // ... on Bitcoin, which needs 6 blocks on top (about an hour, sometimes much longer)
	/* liquidity pools (see LiquidityPool): every pool pairs one token with DZY */
	poolFee: 1 * DZY, // DZY paid to the treasury to open a pool (stops spam)
	poolMinDzy: 1 * DZY, // the least DZY a pool can be opened with
	poolLock: 1000, // shares of every pool that belong to nobody, for ever: a pool can never be emptied or its share price bent by its first backer
	poolBps: 16, // of every swap, in hundredths of a percent: stays in the pool, for the people who back it
	poolObsEvery: 5 * 60 * 1000, poolObsKept: 16, poolAvgWindow: 30 * 60 * 1000, // price readings: one per 5 minutes, 16 kept; averages are over 30 minutes
	/* leveraged trading (see Position and chain/MARGIN.md): the same limits for everyone, set by each pool's size */
	marginMaxLev: 30, // in tenths: at most 3x (lev 11..30 = 1.1x..3x)
	marginOpenPct: 125, // a position opens only if it holds at least 125% of what it owes, at the average AND the current price
	marginLiqPct: 110, // anyone may close it once it holds under 110% of what it owes at the average AND the current price
	marginRewardPct: 5, // the closer's reward: at most this % of the position's own margin, from what is left after repaying
	marginPoolShare: 5, // all borrowing on one pool is at most a fifth of that pool's side it borrows from
	marginMinAge: 24 * 60 * 60 * 1000, // no positions on a pool younger than a day
	marginBaseBps: 500, marginSlopeBps: 2000, // yearly interest: 5%, plus up to 20% more as the vault is lent out
	marginHubBps: 1000, // a tenth of the DZY interest paid goes to the treasury; the rest to the vault's lenders
	year: 365 * 24 * 60 * 60 * 1000,
	launchVirtual: 30 * DZY, // a launch's curve starts as if 30 DZY were in it (none is: buyers bring the real DZY)
	launchCreatorBps: 50, // a launch's creator gets 0.5% of the DZY side of every trade of its coin
	pointsMaxValue: 1_000 * DZY, // reward points: what one point can be backed by, at most
	loanMinBps: 15_000, // the Dznye dollar (DUSD): a loan borrows at most 1/1.5 of its coin's value
	loanLiqBps: 12_000, // ... and anyone may close one worth less than 120% of what it owes
	loanRateBps: 500, // 5% a year of what is borrowed, taken from the coin when the loan closes, to the pot
	loanOpenBps: 10, // 0.1% of what is borrowed, on borrowing, likewise
	loanBonusBps: 500, // whoever closes a loan below the line gets its coin worth the debt plus 5%
	marketFee: 100_000_000, // asking a prediction-market question: 1 DZY, to the Sun
	marketSunBps: 100, // 1% of every prediction-market win, to the Sun (validators and holders)
	marketMakerBps: 50, // 0.5% of every win, to whoever asked the question
	roundFeeBps: 200, // Up or Down: 2% of what a winner collects, to the Sun
	roundMin: 10_000_000, // the smallest bet: 0.1 DZY
	roundWindow: 10 * 60 * 1000, // a round's start or end price is marked within 10 minutes of that moment
	xServiceBps: 10, // cross-chain orders paid in DZY (payments, NFTs bought on other chains): 0.1% of the DZY to the Sun, for validators and holders
	xFeeBps: 10, // the exchange: 0.1% of every coin paid out (or a lock closed) goes to the pot, the floor behind DZY
	xTradeBps: 5, // 0.05% of the vault coin in every order-book fill goes to the pot
	hubBps: 4 // ... and this much of the DZY side goes to the treasury: the chain's own income from being in the middle.
	// Together 0.20%: a third less than the 0.30% most pools elsewhere charge (2026-11-15)
} as const;
/** other chains an account may link an address on, and how the chain checks that the address agreed. `sol`: Solana
    uses the same kind of key as Dznye, so the chain checks that key's signature itself. */
/* `eth` is one address for Ethereum and every chain that shares its addresses (Base, Arbitrum, Optimism, Polygon, BNB
   Chain, Avalanche): proven once by a signature from that address's own wallet (personal_sign of linkMessage). */
export const LINKABLE: Readonly<Record<string, string>> = Object.freeze({ sol: 'Solana', eth: 'Ethereum and the chains that share its addresses', btc: 'Bitcoin' });
/** a Bitcoin address that can be linked: written the canonical way, and of a kind whose owner can sign a message for it */
const isLinkableBtc = (v: unknown): v is string => { const a = btcAddress(v); return !!a && a.address === v && (a.kind === 'p2pkh' || a.kind === 'p2sh' || a.kind === 'p2wpkh'); };
/** an Ethereum-style address as the chain keeps it: 0x and 40 lower-case hex digits */
const isEthAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v);
/** the exact text the other chain's key signs to agree to be linked to a Dznye account */
export const linkMessage = (chain: string, account: string, net: string, address: string) => 'dzy-link:' + canon({ chain, account, net, address });
/** what a gift's claim key signs to send the gift to `to`: the receiver is inside the signature, so a claim seen on its
    way to the chain cannot be copied with another receiver */
/** what a staked account signs to vouch for a volunteer node at `url` (node.ts addPeer): its stake stands behind it */
export const volunteerMessage = (chain: string, url: string) => 'dznye-volunteer:' + canon({ chain, url });
export const giftMessage = (chain: string, id: string, to: string) => 'dzy-gift:' + canon({ chain, id, to });
/** what a task's checker signs to say `to` completed task `id` (the receiver is inside, so it cannot be redirected) */
export const taskMessage = (chain: string, id: string, to: string) => 'dzy-task:' + canon({ chain, id, to });
/** A task a site pays for (sign up, buy, review, invite...): `reward` of `asset` for each account its `checker`
    signs as done, at most `left` more, until `until`. The rewards are locked from the site's own coins when it is
    posted. Each account claims once. `note` says what to do (public). */
export interface Task { by: string; asset: string; reward: number; left: number; checker: string; until: number; done: Record<string, 1>; note?: string }
/** A gift: coins held by the chain for whoever holds the claim key (a one-time key that travels in a link: by email,
    chat, a QR code on a card). The sender takes it back after `until` if nobody claimed it. `note` is public. */
/** A shop's cashback: for each asset it is paid in, the reward asset and rate (reward = paid × num / den, rounded down),
    paid automatically from the shop's own reserve, which the shop funds itself. Nothing is created: a shop can only
    give what it put in, so buying from yourself through another account gains nothing. */
export interface Shop {
	rules: Record<string, { reward: string; num: number; den: number }>; reserve: Record<string, number>; name?: string;
	/** its last 100 orders: every shop.pay to it, newest last (the payments themselves stay in the blocks for ever) */
	orders?: { order?: string; from: string; asset: string; amount: number; at: number }[];
	/** free transactions used in the current 30-day period: [period, count] (see RULES.partnerFree) */
	free?: [number, number];
}
const PERIOD = 30 * 24 * 60 * 60 * 1000;
/** Is this account a partner whose transaction fees the chain waives right now? Automatic, no vote: a shop that keeps
    at least RULES.partnerMinReserve DZY in its cashback reserve gets RULES.partnerFree fee-free transactions in each
    30-day period, for transactions it sends or pays the fee of (so its users' actions are free too). */
export function partnerFreeLeft(s: State, addr: string, time: number): number {
	const sh = s.shops && own(s.shops, addr) ? s.shops[addr] : null;
	if (!sh || (own(sh.reserve, NATIVE) ? sh.reserve[NATIVE] : 0) < RULES.partnerMinReserve) return 0;
	const period = Math.floor(time / PERIOD), used = sh.free && sh.free[0] === period ? sh.free[1] : 0;
	return Math.max(0, RULES.partnerFree - used);
}
export interface Gift { from: string; asset: string; amount: number; key: string; until: number; note?: string }
/** A record: an app's data on the chain (a sign-up, a profile, an order, an entry), kept at "<writer>/<space>/<key>".
    Only its writer can change or delete it. A small value, or a file's SHA-256 and where to find the file. */
export interface ChainRecord { value?: unknown; hash?: string; link?: string; at: number }
const SPACE = /^[a-z0-9][a-z0-9-]{0,31}$/, RKEY = /^[A-Za-z0-9._:-]{1,64}$/;
/** what keeping a record costs, by its size (paid once, to the Sun): space, key and what it holds, in characters */
export function recordFee(space: string, key: string, r: { value?: unknown; hash?: string; link?: string }) {
	return (space.length + key.length + (r.value !== undefined ? canon(r.value).length : 64 + (r.link?.length ?? 0))) * RULES.recordByte;
}
export function recordOf(s: State, writer: string, space: string, key: string) {
	const k = `${writer}/${space}/${key}`, r = s.records && Object.hasOwn(s.records, k) ? s.records[k] : null;
	return r ? { writer, space, key, ...r } : null;
}
/** one writer's records in a space, by key (at most `limit`, after `after`) */
export function recordsOf(s: State, writer: string, space: string, limit = 100, after = '', keys: string[] = Object.keys(s.records ?? {})) {
	const pre = `${writer}/${space}/`;
	return keys.filter((k) => k.startsWith(pre) && k.slice(pre.length) > after).sort().slice(0, limit).map((k) => ({ writer, space, key: k.slice(pre.length), ...s.records![k] }));
}
/** a space across every writer, newest first (at most `limit`, written before `before`) */
export function spaceRecords(s: State, space: string, limit = 100, before = Infinity, keys: string[] = Object.keys(s.records ?? {})) {
	const out: { writer: string; space: string; key: string; value?: unknown; hash?: string; link?: string; at: number }[] = [];
	for (const k of keys) { const r = s.records![k], [writer, sp, ...rest] = k.split('/'); if (sp === space && r.at < before) out.push({ writer, space, key: rest.join('/'), ...r }); }
	return out.sort((a, b) => b.at - a.at || (a.writer + a.key < b.writer + b.key ? -1 : 1)).slice(0, limit);
}
/** A stream: `perMinute` of `asset` flowing from `from` to `to`. `held`: still to flow, counted from `start`;
    `owed`: flowed and not yet withdrawn. What flows is worked out from the clock, so nothing is sent while it runs. */
export interface Stream { from: string; to: string; asset: string; perMinute: number; held: number; owed: number; start: number; note?: string }
const streamMinutes = (st: Stream, time: number) => Math.max(0, Math.floor((time - st.start) / 60_000));
/** what has flowed since `start`, never more than `held` (written so that no product can grow past an exact number) */
function streamFlow(st: Stream, time: number) { const m = streamMinutes(st, time); return { m, flowed: m >= st.held / st.perMinute ? st.held : m * st.perMinute }; }
/** move what has flowed into `owed`, and the clock forward by whole minutes (a part minute keeps counting) */
function streamRebase(st: Stream, time: number) { const { m, flowed } = streamFlow(st, time); st.held -= flowed; st.owed += flowed; st.start += m * 60_000; }
/** a stream as it stands at `time`: what is owed to the receiver now, and what is left to flow */
export function streamView(s: State, id: string, time: number = s.time) {
	const st = s.streams && Object.hasOwn(s.streams, id) ? s.streams[id] : null;
	if (!st) return null;
	const { flowed } = streamFlow(st, time);
	return { id, from: st.from, to: st.to, asset: st.asset, perMinute: st.perMinute, owed: st.owed + flowed, left: st.held - flowed, ...(st.note ? { note: st.note } : {}), now: time };
}

/* An account is named by its first key (its address) and may add more keys, one per device. Any of its keys can sign;
   `signer` says which one did, when it was not the first.
   `payer` (optional) is another account that pays this transaction's fee: an app covering its users, so they never
   need to hold DZY. The sender names the payer inside what it signs, and the payer signs too (`payerSig`). */
export interface Tx { chain: string; from: string; nonce: number; type: string; data: Record<string, unknown>; sig: string; /** the last rules: more than the fee, to go first when blocks are full; and the most fee it may cost (above it, it waits) */ tip?: number; max?: number; signer?: string; payer?: string; payerSig?: string; cosigs?: { key: string; sig: string }[]; side?: string } // side: a file part's bytes, beside the transaction (blobs.ts): not signed, not in the block's fingerprint; matched by the file's own
export interface Account {
	nonce: number;
	bal: Record<string, number>;
	keys?: string[]; // extra device keys
	off?: true; // the first key has been switched off (a lost first device)
	guardian?: string; // who may start a recovery, if the owner chose one
	/** a hash-based key (wots.ts), the next one to sign, and how many have; `only`: nothing else moves this account */
	q?: { root: string; n: number; only?: true };
	recover?: { key: string; at: number }; // a recovery waiting out its delay: this key joins at this time unless cancelled
	/** limited keys for software acting for the owner (an AI agent, a game, a subscription): each may only SEND one
	    asset, up to what is left of its allowance, until its end time. It can never add keys or touch anything else. */
	agents?: Record<string, Agent>;
	/** the account's name, if it chose one (people send to @name instead of the address) */
	name?: string;
	/** its addresses on other chains, each proven by that address's own signature: network → address */
	links?: Record<string, string>;
	/** several keys must agree: every transaction from this account needs `need` signatures from `keys` (its own
	    signature counts if its key is in the list; the others come as `cosigs`). Agent keys keep their own limits. */
	multi?: { keys: string[]; need: number };
}
/** `fees`: how much DZY this key may spend on transaction fees from the account (0 when not given), so a key
    allowed to send a token can never drain the account's DZY through fees */
export interface Agent { asset: string; left: number; until: number; fees?: number }
export interface Asset {
	symbol: string; name: string; issuer: string;
	supply: number; // exists now
	minted: number; // ever issued (supply + everything burned); never goes down
	mintable: boolean;
	decimals: number; // how many decimal places apps should show
	cap?: number; // the most that can ever be issued, when there is a limit
	/** what the token stands for, when it stands for a file (a picture, a ticket, a deed): the file's SHA-256, and
	    where to find it. Fixed for ever. A token with a supply of 1 and these is what people call an NFT. */
	content?: string; link?: string;
	/** reward points with real value (points.create): every point in existence has `per` DZY shards behind it, held by
	    the chain in `reserve` (always exactly supply × per), which any holder can cash in at that rate at any time */
	backed?: { per: number; reserve: number };
	nft?: Nft; // a token that shows a file (blobs.ts): `backed` is the DZY in every copy
}
/** DZY a validator has locked up. `bond` counts towards a seat; `unbonding` is on its way out (still answerable for
    cheating until it is withdrawn); `missed` counts turns to propose missed in a row; `jailed` = benched until this
    time and until it asks to come back; `tomb` = caught signing two different votes: never a validator again. */
/** DZY a holder has stopped backing a validator with: it waits RULES.unbondDelay (still answerable if that validator
    is caught cheating) before `stake.claim` gives it back */
export interface Undelegation { v: string; amount: number; at: number }
/** a proposed treasury payout, open for votes until `until`. Votes are counted at their voters' stake when counted. */
export interface Proposal { by: string; to: string; amount: number; reason: string; until: number; votes: Record<string, boolean> }
export interface Stake { bond: number; since?: number; /** DZY moved here from locks: each part held until that chain minute */ kept?: { n: number; m: number }[]; unbonding?: { amount: number; at: number }[]; missed?: number; jailed?: number; tomb?: true; commission?: number } // commission: basis points of its pay it keeps before its backers' share (the crew upgrade)
/** one signed consensus vote, as carried in a proof of cheating */
export interface SignedVote { type: 'prevote' | 'precommit'; height: number; round: number; block: string | null; validator: string; sig: string }
/** a program on the chain: its code, who put it there, and what it has stored. Its coins are in its account. */
export interface Contract {
	creator: string; code: Program; storage: Record<string, Value>; entries: number;
	/** the newest events (what its code emitted, and calls that failed while running), at most LIMITS.events */
	events?: ContractEvent[];
	/** how many tokens it has made (their ids come from this) */
	made?: number;
}
export interface ContractEvent { h: number; v?: Value; failed?: string; by?: string }
/** A payment channel between `a` and `b` in one asset: `total` is locked here. They pay each other off the chain by
    both signing newer states { nonce, a, b }, and settle here once. `closing` is a close one side has started. */
export interface Channel { a: string; b: string; asset: string; total: number; fundedA: number; fundedB: number; closing?: { nonce: number; a: number; b: number; at: number; by: string } }
export interface Side { asset: string; amount: number }
/** `until`: the offer can no longer be taken after this time (then anyone may close it, and the maker gets it back) */
export interface Offer { maker: string; give: Side; want: Side; until?: number }
/** one completed trade: the maker sold `sold` and was paid `paid`, by `taker`, in block `h` at time `t` */
export interface Trade { h: number; t: number; offer: string; maker: string; taker: string; sold: Side; paid: Side; via?: string }
/* ---- offers paid on another chain ----
   "I give 1,000 DZY for 5 USDC, paid to me on Solana." What is given is held by the chain. A taker first holds the
   offer (so nobody else can take it while they pay), then pays on Solana with the hold's key as the payment's memo.
   The validators each look at Solana themselves; once validators with more than two thirds of the say have reported
   the payment, the held coins go to the taker. Nothing is wrapped and nobody keeps the Solana coins but the maker.
   What a taker trusts: the same validators that already keep every balance on this chain. */
export interface XWant { net: string; token: string; amount: number; /** token 'NFT': this exact NFT (ERC-721), delivered to payTo */ nft?: { contract: string; id: string } }
/** `key` is what the payment's memo must be; `votes` are the validators that have reported seeing it */
/** `tx`: the payment the taker says they made on the other chain (validators check exactly that one) */
export interface XHold { by: string; take: number; pay: number; until: number; key: string; votes?: string[]; tx?: string; /** when the hold began (an NFT delivery must be made after it) */ from?: number }
export interface XOffer { maker: string; give: Side; want: XWant; payTo: string; until?: number; n: number; hold?: XHold }
/** what may be asked for on another chain: network → token → decimals (the same list as SOL_TOKENS in solana.ts) */
export const XTOKENS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
	sol: Object.freeze({ SOL: 9, USDC: 6, USDT: 6 }),
	// EVM chains (evm.ts): 18-decimal coins are counted here in billionths (gwei), USDC in millionths, so amounts stay exact
	eth: Object.freeze({ ETH: 9, USDC: 6 }), base: Object.freeze({ ETH: 9, USDC: 6 }), arb: Object.freeze({ ETH: 9, USDC: 6 }), op: Object.freeze({ ETH: 9, USDC: 6 }),
	polygon: Object.freeze({ POL: 9, USDC: 6 }), bsc: Object.freeze({ BNB: 9, USDC: 6 }), avax: Object.freeze({ AVAX: 9, USDC: 6 }),
	// Bitcoin (btc.ts): counted in satoshis, exactly as Bitcoin counts it
	btc: Object.freeze({ BTC: 8 })
});
/** A liquidity pool: `token` units of one token and `dzy` parts of DZY, held by the chain, that anyone can swap
    against at once. The price is the ratio of the two (the product of the two amounts never goes down in a swap).
    Every pool has DZY on one side, so any token reaches any other through DZY in two steps (`pool.route`): DZY is
    what holds the market together. `shares`: all shares, of which RULES.poolLock belong to nobody; `lp`: who backs
    the pool, and with how many shares. A backer's shares are a claim on that part of both amounts, swap fees included. */
export interface LiquidityPool {
	dzy: number; token: number; shares: number; lp: Record<string, number>;
	/** The pool's price, added up over time, so an average over a stretch of time can be worked out that nobody can
	    bend with one big swap: `cum` is the sum of (price × milliseconds it lasted), as text (it outgrows a number),
	    counted up to time `at`; `obs` are a few past readings [time, cum], at most one per RULES.poolObsEvery. */
	cum: string; at: number; obs: [number, string][];
	/** when the pool was opened (positions need a pool at least RULES.marginMinAge old) */
	born?: number;
	/** a launch (token.launch): DZY that is priced in but not there (the curve's starting point), and who launched it
	    (it gets launchCreatorBps of every trade). Nobody holds a share of a launch's market: its DZY never leaves */
	virt?: number; launch?: { creator: string };
}
/** the price of one token unit in DZY parts, times 2^64, rounded down: exact enough for any pair of amounts */
const priceX = (p: { dzy: number; token: number; virt?: number }) => (BigInt(p.dzy + (p.virt ?? 0)) << 64n) / BigInt(p.token);
/** bring a pool's running sum up to `time`, at the price it has had since it was last touched. Called before
    anything changes its amounts, so a price only counts for the time it really lasted: a swap and its opposite inside
    one block count for nothing. */
function poolTick(p: LiquidityPool, time: number) {
	if (time <= p.at) return;
	p.cum = (BigInt(p.cum) + priceX(p) * BigInt(time - p.at)).toString();
	p.at = time;
	if (time - p.obs[p.obs.length - 1][0] >= RULES.poolObsEvery) { p.obs.push([time, p.cum]); if (p.obs.length > RULES.poolObsKept) p.obs.shift(); }
}
/** A pool's average price over about the last `window` milliseconds, as DZY parts per 1,000,000,000 token units, or
    null while the pool is too young to have one (younger than half the window). One big swap moves the price now but
    hardly moves this: to bend it, a price must be HELD, against everyone free to trade it back. */
export function poolAverage(p: LiquidityPool, now: number, window: number = RULES.poolAvgWindow): number | null {
	const cumNow = BigInt(p.cum) + priceX(p) * BigInt(Math.max(0, now - p.at));
	// the newest reading at least `window` old; failing that the oldest we have, if it is at least half as old
	let from = p.obs[0];
	for (const o of p.obs) if (now - o[0] >= window) from = o;
	const span = now - from[0];
	if (span < window / 2) return null;
	const avg = ((cumNow - BigInt(from[1])) / BigInt(span)) * 1_000_000_000n >> 64n;
	return avg <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(avg) : null;
}
const big = BigInt;
/** the whole-number square root, rounded down */
function isqrt(n: bigint): bigint {
	if (n < 2n) return n;
	let x = big(Math.floor(Math.sqrt(Number(n)))) + 1n;
	for (;;) { const y = (x + n / x) >> 1n; if (y >= x) break; x = y; }
	while (x * x > n) x -= 1n;
	return x;
}
/** what a swap of `amount` in gives out of a pool with these two amounts, after the backers' fee; always rounded down */
const poolOut = (rIn: number, rOut: number, amount: number): number => {
	const eff = big(amount) * big(10_000 - RULES.poolBps);
	return Number((big(rOut) * eff) / (big(rIn) * 10_000n + eff));
};
/** amount x num / den, exact (amounts reach 1.2 x 10^15 shards: a product of ordinary numbers would round), floored */
const mulDiv = (amount: number, num: number, den: number) => Number((BigInt(amount) * BigInt(num)) / BigInt(den));
const hubCut = (dzy: number) => mulDiv(dzy, RULES.hubBps, 10_000);
/** One swap against one pool, worked out without changing anything. `giveDzy`: the taker gives DZY and gets the
    token; otherwise the other way. Returns what the taker gets, the treasury's cut (always DZY), and the pool's two
    amounts afterwards; null when the swap is too small to give anything. */
export function poolSwap(p: LiquidityPool, giveDzy: boolean, amount: number): { out: number; hub: number; creator: number; dzy: number; token: number } | null {
	if (!isAmount(amount)) return null;
	// a launch is priced from its real DZY plus its virtual starting DZY; its creator gets its share of the DZY side
	const v = p.virt ?? 0, cut = (n: number) => (p.launch ? mulDiv(n, RULES.launchCreatorBps, 10_000) : 0);
	if (giveDzy) {
		const hub = hubCut(amount), creator = cut(amount), put = amount - hub - creator, out = poolOut(p.dzy + v, p.token, put);
		return out > 0 && out < p.token && Number.isSafeInteger(p.dzy + put) ? { out, hub, creator, dzy: p.dzy + put, token: p.token - out } : null;
	}
	const gross = poolOut(p.token, p.dzy + v, amount), hub = hubCut(gross), creator = cut(gross), out = gross - hub - creator;
	return out > 0 && gross < p.dzy && Number.isSafeInteger(p.token + amount) ? { out, hub, creator, dzy: p.dzy - gross, token: p.token + amount } : null; // never more DZY than is really there
}
/** What giving `amount` of `from` gets in `to` right now, through the pools (straight when one side is DZY, through
    DZY otherwise). Null when there is no way, or the amount is too small. `hub`: DZY the treasury would receive. */
export function poolQuote(s: State, from: string, to: string, amount: number): { out: number; hub: number; via: string[] } | null {
	const pools = s.liquidity ?? {};
	if (from === to || !isAmount(amount)) return null;
	if (from === NATIVE || to === NATIVE) {
		const token = from === NATIVE ? to : from, r = own(pools, token) ? poolSwap(pools[token], from === NATIVE, amount) : null;
		return r ? { out: r.out, hub: r.hub, via: [token] } : null;
	}
	const a = own(pools, from) ? poolSwap(pools[from], false, amount) : null, b = a && own(pools, to) ? poolSwap(pools[to], true, a.out) : null;
	return a && b ? { out: b.out, hub: a.hub + b.hub, via: [from, to] } : null;
}
/** A lending vault for one pool and one side. `L` vaults lend DZY to people going long on that pool's token; `S`
    vaults lend the token to people going short. Lenders own shares; `cash` is what is in the vault now, `lent` the
    principal out on loan. A share is worth (cash + lent) / shares. Interest arrives when a loan is repaid; a loan that
    cannot be repaid in full is a loss for that vault's lenders only (never for anyone else, never covered by new DZY). */
export interface Vault { cash: number; lent: number; shares: number; lp: Record<string, number> }
/** A leveraged position, held by the chain. Long (`L`): `held` tokens bought with the owner's `margin` DZY and `debt`
    DZY borrowed. Short (`S`): `held` DZY (the margin plus what `debt` borrowed tokens sold for). Interest at `rate`
    (hundredths of a percent a year, fixed when opened) runs from `at`. */
export interface Position { owner: string; pool: string; side: 'L' | 'S'; margin: number; held: number; debt: number; rate: number; at: number }
/** what a position owes now: its debt plus interest, rounded up */
export const owedOf = (p: Position, time: number) => p.debt + Number((BigInt(p.debt) * BigInt(p.rate) * BigInt(Math.max(0, time - p.at)) + BigInt(10_000 * RULES.year) - 1n) / BigInt(10_000 * RULES.year));
/** How much a position holds against what it owes, in percent, at a price of `num` DZY parts per `den` token units.
    Long: the tokens' worth over the DZY owed. Short: the DZY held over the tokens' worth. */
export function healthOf(p: Position, owed: number, num: bigint, den: bigint): number {
	if (owed <= 0) return Number.MAX_SAFE_INTEGER;
	const v = p.side === 'L' ? (BigInt(p.held) * num * 100n) / (BigInt(owed) * den) : (BigInt(p.held) * den * 100n) / (BigInt(owed) * num);
	return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}
/** a position's health now at the pool's average price and at its current price (both must agree before anyone can close it) */
export function positionHealth(s: State, p: Position, time: number): { owed: number; average: number | null; now: number } {
	const pool = s.liquidity?.[p.pool], owed = owedOf(p, time), avg = pool ? poolAverage(pool, time) : null;
	return { owed, average: avg === null || !pool ? null : healthOf(p, owed, BigInt(avg), 1_000_000_000n), now: pool ? healthOf(p, owed, BigInt(pool.dzy), BigInt(pool.token)) : 0 };
}
/** the least DZY to give a pool so that it gives at least `want` tokens (after both fees), or null when it cannot */
export function dzyFor(p: LiquidityPool, want: number): number | null {
	if (!isAmount(want) || want >= p.token) return null;
	const put = (BigInt(p.dzy) * BigInt(want) * 10_000n + BigInt(p.token - want) * BigInt(10_000 - RULES.poolBps) - 1n) / (BigInt(p.token - want) * BigInt(10_000 - RULES.poolBps));
	let amount = Number((put * 10_000n + BigInt(10_000 - RULES.hubBps) - 1n) / BigInt(10_000 - RULES.hubBps));
	for (let i = 0; i < 8; i++, amount++) { const r = poolSwap(p, true, amount); if (r && r.out >= want) return amount; }
	return null;
}
const vaultKey = (pool: string, side: unknown) => (side === 'L' || side === 'S' ? `${pool}:${side}` : fail('side is L (long: lend or borrow DZY) or S (short: lend or borrow the token)'));
/** the yearly rate (hundredths of a percent) a new loan of `more` from this vault pays */
/** a loan's yearly rate: the base (on a chain with the Sun, the policy rate, set by the chain's own Taylor rule), plus up to marginSlopeBps as the vault is lent out */
const rateFor = (s: State, v: Vault, more: number) => (s.sun ? policyRate(s) : RULES.marginBaseBps) + mulDiv(v.lent + more, RULES.marginSlopeBps, Math.max(1, v.cash + v.lent));

/** a payment's id on its chain: a Solana signature (base58), or an EVM transaction hash */
const isXTx = (net: string, v: unknown): v is string => typeof v === 'string' && (net === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(v) : net === 'btc' ? /^[0-9a-f]{64}$/.test(v) : /^0x[0-9a-f]{64}$/.test(v));
/** how a token on another chain is named in trade records: "USDC@sol" */
export const xAsset = (w: { net: string; token: string }) => `${w.token}@${w.net}`;
/** the memo a payment for this hold must carry */
export const xMemo = (key: string) => 'dzy:' + key;
/** A hash lock: `amount` of `asset` from `from`, held by the chain. `to` gets it by showing the secret whose SHA-256 is
    `hash`, before `until`; after that, it goes back to `from`. With the same hash on another chain this is a swap
    with Bitcoin, Ethereum, Solana or anything else that can check SHA-256: no bridge, nobody holding the coins. */
export interface Swap { from: string; to: string; asset: string; amount: number; hash: string; until: number; note?: string }
/** a finished hash lock: the secret it was claimed with (so the other side can use it on its chain), or a refund */
export interface SwapDone { id: string; h: number; hash: string; secret?: string; refunded?: true }
export interface State {
	chain: string;
	authority: string; // issues DZY, within the pools' limits and timetables. It does NOT decide blocks: the validators do.
	validators: string[]; // the keys that agree on each block; a block counts once more than two thirds have signed it
	/** DZY (in parts) every accepted transaction pays, fixed at genesis; missing or 0 = no fee */
	fee?: number;
	height: number;
	time: number;
	started: number; // time of block 1: the pools' timetables count from here (0 until then)
	pools: Record<string, number>; // DZY issued so far from each pool
	last: string; // hash of the newest block
	accounts: Record<string, Account>;
	assets: Record<string, Asset>;
	offers: Record<string, Offer>;
	/** locked-up DZY of everyone who stakes (absent until someone does) */
	stakes?: Record<string, Stake>;
	/** true once staking has taken over choosing the validators from the starting set */
	staked?: true;
	/** programs on the chain, by their address (absent until one is deployed) */
	contracts?: Record<string, Contract>;
	/** two-party payment channels, by id (absent until one is opened) */
	channels?: Record<string, Channel>;
	/** names chosen by accounts: name → address (absent until someone chooses one) */
	names?: Record<string, string>;
	/** how many premium names (1, 2, 3 characters) have been taken: each one raises the next one's price */
	premiumSold?: Record<string, number>;
	/** DZY held by the chain itself: everything paid in fees, charges and penalties that is not paid to a validator.
	    Never destroyed; only `treasury.spend` pays it out again. (Absent while empty.) */
	treasury?: number;
	/** the newest completed trades, oldest first, at most RULES.maxTrades (absent until the first trade). Prices come
	    only from these: never from offers nobody took. */
	trades?: Trade[];
	/** open hash locks, by id (absent until one is made) */
	swaps?: Record<string, Swap>;
	/** the newest finished hash locks, with their secrets, at most RULES.maxSwapLog */
	swapLog?: SwapDone[];
	/** open offers that are paid on another chain, by id (absent until one is made) */
	xoffers?: Record<string, XOffer>;
	/** liquidity pools, by their token's id (absent until one is opened). Not the DZY issuing pools above. */
	liquidity?: Record<string, LiquidityPool>;
	/** lending vaults, by "<token>:L" or "<token>:S" (absent until one is opened) */
	vaults?: Record<string, Vault>;
	/** open leveraged positions, by id (absent until one is opened) */
	positions?: Record<string, Position>;
	/** delegations: validator → holder → DZY backing it (absent until someone delegates) */
	delegations?: Record<string, Record<string, number>>;
	/** delegated DZY on its way back to its holder, by holder */
	undelegating?: Record<string, Undelegation[]>;
	/** proposed treasury payouts, by id */
	proposals?: Record<string, Proposal>;
	/** gifts waiting to be claimed by link, by id (absent until one is made) */
	gifts?: Record<string, Gift>;
	records?: Record<string, ChainRecord>;
	streams?: Record<string, Stream>;
	/** shops with a cashback rule, by the shop's address (absent until one is set) */
	shops?: Record<string, Shop>;
	/** creators: what each buyer owns (buyer/seller/item -> when, what was paid), each item's sales (seller/item), each
	    creator's tip box (by address). Absent until the first sale or tip. */
	owned?: Record<string, { at: number; asset: string; paid: number; usd?: number; until?: number; ed?: number }>; // ed: which edition (#3 of 50), for limited items
	sales?: Record<string, { n: number; total: number; usd?: number }>;
	tipboxes?: Record<string, { total: Record<string, number>; n: number; usd?: number; last: { from: string; asset: string; amount: number; usd?: number; msg?: string; at: number }[] }>;
	/** checkouts paid on another chain straight to the creator, by id; and the 0.5% each creator owes for them (µ$) */
	orders?: Record<string, Order>;
	feeOwed?: Record<string, number>;
	/** limited editions their owners offer (resale.list): owner/seller/item -> the dollar price and the fee it was listed
	    with; and what each item's resales came to (kept apart from sales, which count editions sold) */
	listings?: Record<string, { usd: number; bps: number; at: number }>;
	resales?: Record<string, { n: number; usd: number; last: number; at: number }>;
	/** creators who joined (creator.join): address -> when */
	creators?: Record<string, number>;
	/** the creators' fee now, in basis points (fee.set, from the checkout upgrade); absent: RULES.saleFeeBps */
	saleFeeBps?: number;
	/** tasks sites pay for, by id (absent until one is posted) */
	tasks?: Record<string, Task>;
	/** the crew upgrade: each staked key's node, as it last checked in (its public address, and when) */
	nodes?: Record<string, { url?: string; at: number; hr?: number; hrs?: number; on?: number; ch?: number; seat?: number; big?: number }>; // seat: the stake its place asks; big: the biggest block it takes; on, ch: the Heart upgrade's time online (heart.ts)
	/** the Heart upgrade: where a validator's clock stood when a holder backed it ("validator:holder") */
	backed?: Record<string, number>;
	heart?: HeartState;
	/** layers on top of this chain (zones.ts): each one, its batches ("layer/n"), and the deposits into it ("layer/q") */
	xwaits?: Record<string, XWait>; xlocks?: Record<string, number>; xloans?: Record<string, Loan>; xparks?: Record<string, 1>; books?: Record<string, string[]>; orderOf?: Record<string, string[]>; blobs?: Record<string, Blob>; looks?: Record<string, Look>; cols?: Record<string, Col>; drops?: Record<string, Drop>; dropped?: Record<string, 1>; // files that last, collections and drops (blobs.ts)
	/** Ethereum contracts (evmledger.ts): what was brought in, by asset; accounts; code by its hash; storage */
	evm?: EvmState; evmAccts?: Record<string, EvmAcct>; evmCodes?: Record<string, string>; evmSlots?: Record<string, string>;
	layers?: Record<string, Layer>; lbatches?: Record<string, Batch>; ldeps?: Record<string, Dep>;
	// nodes: hr: the clock hour of its last check-in; hrs: hours seen in since the last pay day
	/** checkers: the hashes of the last RULES.recentBlocks blocks before the newest, oldest first (`h`: the first one's
	    height). Kept from the crew upgrade on. The newest block's hash is `last`. */
	recent?: { h: number; hashes: string[] };
	/** the exchange (EXCHANGE.md): coin held in each vault ("net:COIN" -> units), each validator's latest price reading,
	    and coin held for an address that it may take straight back with no DZY ("address:COIN" -> units) */
	x?: XState;
	/** the exchange's payouts, by id: what a vault must pay, to whom, on which network (tx: the payment, once made) */
	xpays?: Record<string, XPayout>;
	/** business offers: each business's orders and bookings (newest last), and how many are booked in each slot ("seller/item/at") */
	biz?: Record<string, BizEntry[]>; slots?: Record<string, number>;
	/** shops in their 40 free days: when each one's $5 falls due */
	joinDue?: Record<string, number>;
	/** DZY on Solana: what the chain holds for the wDZY people have there */
	wdzy?: { held: number };
	/** deposits counted, by "net:payment id" (each counted once), and deposits waiting for enough validators */
	/** Up or Down rounds (round.*): "COIN:period:start" -> the round */
	rounds?: Record<string, Round>;
	/** prediction markets (market.*) */
	markets?: Record<string, Market>;
	xseen?: Record<string, { at: number; to: string; coin: string; amount: number; dzy: number }>;
	xclaims?: Record<string, { at: number; votes: string[] }>;
	/** the crew upgrade: who makes blocks this period, and each one's seats (its say) */
	crew?: { epoch: number; validators: string[]; powers: Record<string, number>; seed?: string };
	/** the Sun: this chain's own economy, chosen at genesis (sunGenesis). All 12,000,000 DZY exist from block 1, the
	    treasury above IS the Sun, nobody can issue DZY or pay the Sun out, and every minute's profit is shared by the
	    formulas in sun.ts. Absent on chains made by genesis(), which replay exactly as before. */
	sun?: SunState;
}

const fail = (m: string): never => { throw new Error(m); };
const own = (o: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(o, k);
export const isAddr = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export async function genesis(chain: string, authority: string, time = 0, validators: string[] = [authority], fee = 0): Promise<State> {
	if (!/^[a-z0-9-]{3,32}$/.test(chain)) fail('bad chain name');
	if (!isAddr(authority)) fail('bad authority');
	if (!Array.isArray(validators) || !validators.length || validators.length > RULES.maxValidators || !validators.every(isAddr) || new Set(validators).size !== validators.length) fail('bad validators');
	if (!Number.isSafeInteger(fee) || fee < 0 || fee > RULES.maxFee) fail('bad fee');
	validators = validators.slice().sort(); // one agreed order: it decides whose turn it is to propose
	return {
		chain, authority, validators, ...(fee ? { fee } : {}), height: 0, time, started: 0,
		pools: Object.fromEntries(Object.keys(POOLS).map((k) => [k, 0])),
		// the fee is part of the chain's identity; a chain without one hashes exactly as before fees existed
		last: await sha256('dzy-genesis:' + canon({ chain, authority, validators, time, fee: fee || undefined, pools: Object.fromEntries(Object.entries(POOLS).map(([k, p]) => [k, [p.cap, p.atStart, p.cliff, p.months]])) })),
		accounts: {},
		assets: {
			[NATIVE]: { symbol: NATIVE, name: 'Dznye', issuer: authority, supply: 0, minted: 0, mintable: true, decimals: DZY_DECIMALS, cap: RULES.dzyCap }
		},
		offers: {}
	};
}

/** the exact text a validator signs when it votes; `block` is a block hash, or null for "no block this round" */
export const voteMessage = (chain: string, type: 'prevote' | 'precommit', height: number, round: number, block: string | null) =>
	'dzy-vote:' + canon({ chain, type, height, round, block });

/** the exact text a sender signs; the chain name inside stops a transaction being replayed on another chain */
export const txMessage = (t: Omit<Tx, 'sig' | 'payerSig'>) => 'dzy-tx:' + canon({ chain: t.chain, from: t.from, nonce: t.nonce, type: t.type, data: t.data, signer: t.signer, payer: t.payer, tip: t.tip, max: t.max });
export const txId = (t: Omit<Tx, 'sig' | 'payerSig'>) => sha256(txMessage(t));
/** what a fee payer signs: exactly the sender's transaction, under its own label so neither signature can stand in for the other */
export const payerMessage = (t: Omit<Tx, 'sig' | 'payerSig'>) => 'dzy-pay:' + txMessage(t);
export async function signTx(secret: string, t: Omit<Tx, 'sig' | 'payerSig'>): Promise<Tx> {
	return { ...t, sig: await sign(secret, txMessage(t)) };
}
/** the payer agrees to pay a transaction's fee. The transaction must already name this payer (the sender signed that). */
export async function signPayer(secret: string, tx: Tx): Promise<Tx> {
	if (!tx.payer) throw new Error('this transaction names no payer');
	return { ...tx, payerSig: await sign(secret, payerMessage(tx)) };
}
/** what one transaction costs in fees on this state. Issuing DZY from the pools is free: otherwise nobody could get the first DZY. */
export function feeFor(s: State, tx: Pick<Tx, 'from' | 'type' | 'data'>): number {
	const base = plainFee(s, tx);
	return s.heart && base ? Math.max(base, (tx.type === 'transfer.many' ? s.fee ?? 0 : base) + sizeExtra(s, tx)) + entryExtra(s, tx) : base;
}
/** the Heart upgrade: what an action's size adds to its fee (baggage: one fee for every 1,000 characters past the first) */
export const sizeExtra = (s: State, tx: Pick<Tx, 'data'> & { type?: string }) => (s.heart ? (s.fee ?? 0) * (sizeFees(canon(tx.data).length) - 1) : 0);
/** the Heart upgrade: what the lasting entries an action adds cost (heart.ts KEPT) */
const entryExtra = (s: State, tx: Pick<Tx, 'type' | 'data'>) => (s.fee ?? 0) * KEPT.entryFees * newEntries(s, tx) * keptTimes(s);
function plainFee(s: State, tx: Pick<Tx, 'from' | 'type' | 'data'>): number {
	if (tx.type === 'mint' && tx.from === s.authority && tx.data?.asset === NATIVE) return 0;
	if ((tx.type === 'xoffer.attest' || tx.type === 'order.attest') && s.validators.includes(tx.from)) return 0; // validators reporting a payment: part of running the chain
	if (tx.type === 'contract.call' || tx.type === 'contract.deploy') return gasFee(s, gasLimitOf(tx.data));
	if (s.heart && tx.type === 'node.checkin' && isCandidate(s, tx.from) && canon(tx.data).length <= 1_000) return 0; // a validator saying it is there (at most one every few minutes): part of running the chain, and a small one must not be eaten by it
	if (tx.type === 'ticket.answer') return 0; // collecting a raffle prize is free (and each ticket can be collected once)
	if (tx.type === 'credit.take' && s.sun) return 0; // taking starter credit: an account with no DZY could not pay (limited to creditPerDay a day)
	if ((tx.type === 'sun.attest' || tx.type === 'sun.btc') && s.validators.includes(tx.from)) return 0;
	if (tx.type === 'transfer.many' && Array.isArray(tx.data?.to)) return (s.fee ?? 0) * Math.max(1, Math.ceil(tx.data.to.length / 20)); // one fee per 20 payments: by size, like gas // validators confirming a purchase: part of running the chain
	return s.fee ?? 0;
}
/** a contract transaction pays the chain's fee once, plus once more for every 1,000 gas (or part) it may use */
export const gasFee = (s: State, gas: number) => (s.fee ?? 0) * (1 + Math.ceil(gas / 1000));
export function gasLimitOf(d: Record<string, unknown> | undefined): number {
	const g = d?.gas === undefined ? RULES.defaultGas : d.gas;
	return typeof g === 'number' && Number.isSafeInteger(g) && g > 0 && g <= LIMITS.maxGas ? g : fail(`gas must be a whole number from 1 to ${LIMITS.maxGas}`);
}
/** the exact text both sides of a payment channel sign for one state of it */
export const channelMessage = (chain: string, id: string, nonce: number, a: number, b: number) => 'dzy-channel:' + canon({ chain, id, nonce, a, b });

export const balanceOf = (s: State, addr: string, asset: string = NATIVE) =>
	own(s.accounts, addr) && own(s.accounts[addr].bal, asset) ? s.accounts[addr].bal[asset] : 0;
export const nonceOf = (s: State, addr: string) => (own(s.accounts, addr) ? s.accounts[addr].nonce : 0);

function account(s: State, addr: string): Account {
	if (!own(s.accounts, addr)) s.accounts[addr] = { nonce: 0, bal: {} };
	return s.accounts[addr];
}
function add(s: State, addr: string, asset: string, n: number) {
	if (s.sun && asset === NATIVE) { sunReceive(s, addr, n); return; } // a person's DZY carries its deposit clocks with it
	const a = account(s, addr);
	a.bal[asset] = (own(a.bal, asset) ? a.bal[asset] : 0) + n;
}
function sub(s: State, addr: string, asset: string, n: number) {
	if (s.sun && asset === NATIVE) { sunSpend(s, addr, n); return; }
	const a = account(s, addr);
	a.bal[asset] -= n;
	if (a.bal[asset] === 0) delete a.bal[asset];
}
const assetOf = (s: State, id: unknown): string => (own(s.assets, id) ? id : fail('no such asset'));
const amountOf = (v: unknown): number => (isAmount(v) ? v : fail('the amount must be a whole number above zero'));
/* ---- the order book: shared by offer.take, swap and matching offers ---- */
interface Fill { key: string; take: number; pay: number }
/** the height of the block being made (an offer made with fill records its trades there) */
const height_ = (s: State) => s.height + 1;
/** The open offers that sell `want` for `give`, best price first (fewest `give` per `want`; the older key first on a tie),
    leaving out `who`'s own and those that have ended. */
function bookFor(s: State, give: string, want: string, who: string, time: number): string[] {
	const ks: string[] = [];
	if (s.heart) { // each pair's own list (kept by bookAdd): not looked for in all the offers of the chain
		const b = s.books && own(s.books, want + '|' + give) ? s.books[want + '|' + give] : [];
		return byPrice(s, b.filter((k) => { const o = own(s.offers, k) ? s.offers[k] : null; return !!o && o.maker !== who && !(o.until !== undefined && time > o.until); }));
	}
	for (const [k, o] of Object.entries(s.offers)) if (o.give.asset === want && o.want.asset === give && o.maker !== who && !(o.until !== undefined && time > o.until)) ks.push(k);
	return byPrice(s, ks);
}
function byPrice(s: State, ks: string[]): string[] {
	return ks.sort((a, b) => { const x = s.offers[a], y = s.offers[b], l = BigInt(x.want.amount) * BigInt(y.give.amount), r = BigInt(y.want.amount) * BigInt(x.give.amount); return l < r ? -1 : l > r ? 1 : a < b ? -1 : 1; });
}
/** The Heart upgrade: each pair's open offers, the best KEPT.bookMax of them (the rest stay open, to be taken by name). */
function bookAdd(s: State, key: string, time: number) {
	if (!s.heart) return;
	const o = s.offers[key], p = o.give.asset + '|' + o.want.asset, was = s.books && own(s.books, p) ? s.books[p] : [];
	const live = was.filter((k) => own(s.offers, k) && !(s.offers[k].until !== undefined && time > s.offers[k].until!));
	(s.books ??= {})[p] = byPrice(s, [...live, key]).slice(0, KEPT.bookMax);
}
function bookDrop(s: State, o: Offer, key: string) {
	if (!s.heart || !s.books) return;
	const p = o.give.asset + '|' + o.want.asset; if (!own(s.books, p) || !s.books[p].includes(key)) return;
	const rest = s.books[p].filter((k) => k !== key); if (rest.length) s.books[p] = rest; else { delete s.books[p]; if (emptyOf(s.books)) delete s.books; }
}
/** The Heart upgrade: the open checkouts of a buyer ("b" + address) and of a creator ("s" + address) */
function ordersOf(s: State, who: string): string[] { return s.orderOf && own(s.orderOf, who) ? s.orderOf[who].filter((k) => !!s.orders && own(s.orders, k)) : []; }
function orderAdd(s: State, key: string) { if (!s.heart) return; const o = s.orders![key]; for (const w of ['b' + o.buyer, 's' + o.seller]) (s.orderOf ??= {})[w] = [...ordersOf(s, w), key]; }
function orderDrop(s: State, key: string) {
	const o = s.orders![key]; delete s.orders![key]; if (emptyOf(s.orders!)) delete s.orders;
	if (!s.heart || !s.orderOf) return;
	for (const w of ['b' + o.buyer, 's' + o.seller]) { if (!s.orderOf || !own(s.orderOf, w)) continue; const rest = s.orderOf[w].filter((k) => k !== key); if (rest.length) s.orderOf[w] = rest; else { delete s.orderOf[w]; if (emptyOf(s.orderOf)) delete s.orderOf; } }
}
/** locks, loans and parked accounts: inside `x` before the Heart upgrade, collections of their own from it on */
/** a payment into a vault counts: the coin is held, and whoever it is for gets what it buys (or the coin, as free coin) */
export interface XWait { net: string; coin: string; amount: number; to: string; at: number; until: number; votes?: string[]; by?: string; block?: [number, string] }
/** TEST ONLY: easier Bitcoin work for a test chain */
const TEST_FLOOR = new Map<string, bigint>();
export function testBtcFloor(chain: string, floor: bigint | null) { if (floor === null) TEST_FLOOR.delete(chain); else TEST_FLOOR.set(chain, floor); }
const dropClaims = (s: State, seen: string) => { if (s.xclaims) for (const k of keysOf(s.xclaims)) if (k.startsWith(seen + ':')) delete s.xclaims[k]; };
function depositCounts(s: State, height: number, pay: { net: string; coin: string; amount: number; to: string; seen: string }, time: number, orderTime: number) {
	const { net, coin, amount, seen } = pay;
	const ok = checkoutV2(s, height) ? taggedOrder(s, pay.to, coin, net, orderTime) : null, o = ok ? s.orders![ok] : null;
	if (ok && o && (amount >= o.due || amount >= Math.floor((o.base * 99) / 100))) { completeOrder(s, ok, amount, time, seen); dropClaims(s, seen); return; }
	const to = o ? o.buyer : pay.to; // short of the price: the buyer's own, as free coin
	const x = xOf(s), held = `${net}:${coin}`, lim = X_LIMITS[coin], u = s.sun!;
	const vaultTotal = Object.entries(x.vaults).filter(([k]) => k.endsWith(':' + coin)).reduce((n, [, v]) => n + v, 0);
	x.vaults[held] = (x.vaults[held] ?? 0) + amount;
	const price = xPrice(s, coin, time), usd = price === null ? 0n : (B(amount) * B(price)) / 10n ** B(X_COINS[coin].decimals);
	const parked = !!o || isParked(s, to) || !!retiredOf(s, coin); // (a retired coin buys no DZY: it stays the payer's own)
	const capped = !xUnlimited(s, height), units = parked || price === null || (capped && (amount > lim.deposit || vaultTotal + amount > lim.vault)) || u.salePot <= 0 ? 0 : indexOn(s) ? indexBuyUnits(s, usd, time) : N(unitsFor(s, usd, s.heart ? xFloor(s, time) : null));
	const given = units > 0 && units <= u.salePot ? units : 0;
	if (given && indexOn(s)) indexBought(s, usd, time); // its fee washes (at the price it bought at, before the coin counts)
	if (given) { u.salePot -= given; u.sold += given; add(s, to, NATIVE, given); if (indexOn(s) || reserveOn(s, height)) { claimAsset(s, coin); potAdd(s, coin, amount); } else lockAdd(s, `${to}:${coin}`, amount); } // into the shared reserve (before it: locked in the buyer's own name)
	else { claimAsset(s, coin).supply += amount; claimAsset(s, coin).minted += amount; add(s, to, 'x' + coin, amount); } // free coin, theirs: to trade or take straight back
	(s.xseen ??= {})[seen] = { at: time, to, coin, amount, dzy: given };
	dropClaims(s, seen);
}
/* The shared reserve (24 Nov 2026; from the block below). DZY has one price, the chain's, like gold:
   bought with any coin, sold back for any coin, at that price, with nothing added or taken but the chain's fee.
   - Buying from the sale (a deposit into a vault, or a coin on Dznye through Convert): the coin goes into ONE reserve the
     chain holds (x.pot), not a lock in the buyer's own name.
   - Selling DZY to the chain (Convert, DZY to a coin): it pays what those DZY cost on the curve right now (saleCost of the
     stretch they return), in the coin asked, from the reserve, as free coin on Dznye (D.USDC, D.BNB…) that anyone takes
     out to its own chain. The DZY go back to the sale, so the price comes down the same curve it went up.
   - No cap: a free market. A sale is limited only by what the reserve holds of that coin; the chain's fees, paid on
     every move, are what lift DZY over time.
   Locks made before stay as they were (their owners close them as before). */
const RESERVE_FROM: Record<string, number> = { 'dznye-mainnet': 11_400 };
const TEST_RESERVE = new Map<string, number>();
/** TEST ONLY: the block a test chain's sale fills the shared reserve from (null: back to the rule) */
export function testReserveFrom(chain: string, height: number | null) { if (height === null) TEST_RESERVE.delete(chain); else TEST_RESERVE.set(chain, height); }
export const reserveFrom = (chain: string) => TEST_RESERVE.get(chain) ?? (Object.hasOwn(RESERVE_FROM, chain) ? RESERVE_FROM[chain] : Infinity);
export const reserveOn = (s: State, height: number = s.height + 1) => !!s.heart && height >= reserveFrom(s.chain);
/** what selling `dzy` to the chain pays in `coin` now (its units), at the chain's own price, or null (no price, too much) */
export function reserveSale(s: State, coin: string, dzy: number, time: number = s.time): { pay: number; usd: number } | null {
	const u = s.sun!, price = xPrice(s, coin, time);
	if (!price || dzy <= 0 || dzy > u.sold) return null;
	const usd = saleCost(curveOf(s), B(u.sold - dzy), B(u.sold)); // what these DZY cost on the curve now
	const pay = N((usd * 10n ** B(X_COINS[coin].decimals)) / B(price));
	return pay > 0 ? { pay, usd: N(usd) } : null;
}
/* The index (24 Nov 2026): DZY's price stops being a curve and becomes what stands behind it, like a
   share of an index fund. Nobody holds the reserve: the chain does.
   - Price = the reserve's value in dollars (every coin in it at its agreed price) ÷ the BACKED DZY in people's hands.
   - It turns on at INDEX_FROM. At that block the DZY in hands that the reserve does not cover at today's curve price are
     counted once as unbacked (x.unbacked: early DZY, from before the index). They are left out of the price, so the
     price starts exactly at today's and every other DZY is fully backed.
   - Washing: half of every fee (WASH_BP) backs unbacked DZY until none are left; the other half stays in the reserve and
     lifts the price for everyone who holds. A gift to the reserve (reserve.give) washes first, then lifts the price.
   - Buying: a coin (a vault deposit, or free coin through Convert) buys DZY at the index price, less RULES.xFeeBps; the
     coin goes into the reserve. Selling: DZY pay the index price in any coin the reserve holds, less the same fee. The
     DZY go back to the unsold. No daily limit: only what the reserve holds of that coin.
   - Nothing new enters people's hands without coin behind it: from the switch the Sun's drip and its free fees for small
     accounts stop (sun.ts); validators and holders are paid from the fees people pay, DZY already in hands.
   - The price moves with the coins themselves (Bitcoin up, DZY up by its share) and with every fee left in the reserve. */
const INDEX_FROM: Record<string, number> = { 'dznye-mainnet': 13_500 };
/* Gold in the reserve (24 Nov 2026): tokenized gold, PAXG and XAUT (an ounce each, in the Ethereum
   vault, priced by Chainlink's XAU / USD feed), from the same block as the index. With the dollars and the crypto it
   makes the reserve a mix: steady, with a kick. */
const GOLD = new Set(['PAXG', 'XAUT']);
const GOLD_FROM: Record<string, number> = { 'dznye-mainnet': 13_500 };
const TEST_GOLD = new Map<string, number>();
/** TEST ONLY: the block gold counts from on a test chain (null: back to the rule) */
export function testGoldFrom(chain: string, height: number | null) { if (height === null) TEST_GOLD.delete(chain); else TEST_GOLD.set(chain, height); }
export const goldFrom = (chain: string) => TEST_GOLD.get(chain) ?? (Object.hasOwn(GOLD_FROM, chain) ? GOLD_FROM[chain] : Infinity);
const WASH_BP = 5_000n; // of every fee: washes unbacked DZY first (the rest lifts the price)
const TEST_INDEX = new Map<string, number>();
/** TEST ONLY: the block a test chain's index turns on at (null: back to the rule) */
export function testIndexFrom(chain: string, height: number | null) { if (height === null) TEST_INDEX.delete(chain); else TEST_INDEX.set(chain, height); }
export const indexFrom = (chain: string) => TEST_INDEX.get(chain) ?? (Object.hasOwn(INDEX_FROM, chain) ? INDEX_FROM[chain] : Infinity);
/** is DZY priced by the index (it turned on at a block, kept in the state) */
export const indexOn = (s: State) => !!s.x?.index;
/** past the index's block but not turned on yet (a coin had no agreed price at its block): nobody sells into the reserve */
const indexWaiting = (s: State, height: number = s.height + 1) => !!s.heart && !indexOn(s) && height >= indexFrom(s.chain);
/** the price as a fraction: the reserve's value (µ$) over the backed DZY in hands; with nothing backed yet, the last price.
    Null: a coin in the reserve has no agreed price right now */
function indexNav(s: State, time: number): { usd: bigint; hands: bigint } | null {
	const f = xFloor(s, time);
	if (!f) return null;
	const backed = f.hands - B(s.x?.unbacked ?? 0);
	if (backed > 0n && f.usd > 0n) return { usd: f.usd, hands: backed };
	return s.x?.nav ? { usd: B(s.x.nav), hands: B(DZY) } : null;
}
/** DZY's index price now (µ$), or null */
export function indexPrice(s: State, time: number = s.time): number | null { const n = indexNav(s, time); return n ? N((n.usd * B(DZY)) / n.hands) : null; }
/** `usd` µ$ of a fee (or a gift) left in the reserve: `part` (basis points) of it backs unbacked DZY at the price before it */
function wash(s: State, n: { usd: bigint; hands: bigint }, usd: bigint, part: bigint) {
	const x = s.x!, left = B(x.unbacked ?? 0);
	if (!left || usd <= 0n) return;
	const w = (usd * part * n.hands) / (10_000n * n.usd), take = w < left ? w : left;
	if (take > 0n) { x.unbacked = N(left - take); if (!x.unbacked) delete x.unbacked; }
}
/** DZY that `usd` µ$ of coin buys at the index price, after the fee that stays in the reserve (0: no price) */
export function indexBuyUnits(s: State, usd: bigint, time: number = s.time): number {
	const n = indexNav(s, time);
	return n && usd > 0n ? N((usd * B(10_000 - RULES.xFeeBps) * n.hands) / (10_000n * n.usd)) : 0;
}
/** a buy at the index went through: its fee washes */
function indexBought(s: State, usd: bigint, time: number) { const n = indexNav(s, time); if (n) wash(s, n, (usd * B(RULES.xFeeBps)) / 10_000n, WASH_BP); }
/** what selling `dzy` pays in `coin` (its units) at the index price, after the fee that stays in the reserve, or null */
export function indexSale(s: State, coin: string, dzy: number, time: number = s.time): { pay: number; usd: number; fee: number } | null {
	const n = indexNav(s, time), price = xPrice(s, coin, time);
	if (!n || !price || dzy <= 0 || dzy > s.sun!.sold) return null;
	const gross = (B(dzy) * n.usd) / n.hands, usd = (gross * B(10_000 - RULES.xFeeBps)) / 10_000n;
	const pay = N((usd * 10n ** B(X_COINS[coin].decimals)) / B(price));
	return pay > 0 ? { pay, usd: N(usd), fee: N(gross - usd) } : null;
}
/** at a block's end: the index turns on at its block (the unbacked counted once); while on, its last price is kept, for
    when a coin's price is missing for a while */
function indexBlock(s: State, height: number, time: number) {
	if (!s.heart || !s.sun || height < indexFrom(s.chain)) return;
	if (indexOn(s)) { const p = indexPrice(s, time); if (p !== null) s.x!.nav = p; return; }
	const f = xFloor(s, time), p0 = spotPrice(s);
	if (!f || p0 <= 0) return; // a coin with no agreed price: try at the next block
	const covered = (f.usd * B(DZY)) / B(p0), un = f.hands > covered ? f.hands - covered : 0n;
	const x = xOf(s); x.index = height; x.nav = p0; if (un > 0n) x.unbacked = N(un);
}
setIndexPrice((s) => indexPrice(s));
/* If a coin in the reserve is hacked or shut down (24 Nov 2026), the chain can act without a new node:
   validators vote (more than two thirds of the say, as for prices and deposits) with reserve.retire:
   - 'out': the coin is leaving. Nobody buys DZY with it any more, and anyone may swap good coins INTO the reserve for it
     (reserve.swap): what comes in is worth what goes out at the agreed prices, plus a fixed 0.5% for the trouble, so it
     actually happens. The reserve trades a bad coin for good ones; no one is ever paid for nothing.
   - 'zero': the coin counts for nothing in the price (a hack whose price feed still says otherwise); nobody buys with it.
   - 'back': undoes either.
   And on its own: a coin with no agreed price for a day counts for nothing, so DZY never freezes waiting for a dead feed.
   A vote changes only which coins the reserve holds and how it counts them: it can never send a coin to anyone. */
const RETIRE_BONUS_BP = 50n, GONE_MS = 86_400_000;
export const retiredOf = (s: State, coin: string): 'out' | 'zero' | null => (s.x?.retired && own(s.x.retired, coin) ? s.x.retired[coin] : null);
/** no agreed price for this coin for a day (or ever): it counts for nothing (only once the index is on) */
function priceGone(s: State, coin: string, time: number) {
	let last = 0;
	for (const r of Object.values(s.x?.prices ?? {})) if (own(r.p, coin) && r.at > last) last = r.at;
	return time - last > GONE_MS;
}
/* The fee from the trade itself (24 Nov 2026): once the index is on, buying, selling or taking a coin
   out never needs DZY on the side for the chain's fee. The fee is still DZY, but it comes out of what is traded:
   - selling DZY (a swap giving DZY) that would leave nothing for the fee: the fee comes out of the DZY sold;
   - with less DZY than the fee, a trade in a coin (a swap giving a vault coin, x.sell, reserve.give) buys the missing
     fee at the index price from that coin: the coin joins the reserve, the DZY come from the unsold, so the fee is backed
     like any DZY bought. The amount traded shrinks by that much when it would not fit (a minimum shrinks with it).
   Returns the data the transaction runs with, and how to undo what it did if the transaction is refused. */
function feeFromTrade(s: State, tx: Tx, payer: string, fee: number): { data: Record<string, unknown>; undo: () => void } | null {
	const d = tx.data, bal = balanceOf(s, payer, NATIVE);
	const shrink = (amount: number, to: number) => ({ ...d, amount: to, ...(tx.type === 'swap' && isAmount(d.min) ? { min: Math.max(1, Math.floor((Number(d.min) * to) / amount)) } : {}) });
	if (tx.type === 'swap' && d.give === NATIVE && isAmount(d.amount)) {
		const amount = Number(d.amount);
		return bal >= fee && bal - fee < amount && bal >= amount ? { data: shrink(amount, bal - fee), undo: () => {} } : null;
	}
	if (bal >= fee) return null;
	const coin = tx.type === 'swap' ? (typeof d.give === 'string' && isXClaim(s, d.give) ? d.give.slice(1) : null) : (tx.type === 'x.sell' || tx.type === 'reserve.give') && typeof d.coin === 'string' && own(X_COINS, d.coin) ? d.coin : null;
	if (!coin || !own(s.assets, 'x' + coin) || !isAmount(d.amount)) return null;
	const need = fee - bal, p = indexPrice(s), price = xPrice(s, coin);
	if (!p || !price || need > s.sun!.salePot) return null;
	const units = N((B(need) * B(p) * 10n ** B(X_COINS[coin].decimals) + B(DZY) * B(price) - 1n) / (B(DZY) * B(price))); // rounded up: never less than the fee
	const has = balanceOf(s, payer, 'x' + coin), amount = Number(d.amount);
	if (units <= 0 || has < units || amount <= 0) return null;
	sub(s, payer, 'x' + coin, units); s.assets['x' + coin].supply -= units; potAdd(s, coin, units);
	s.sun!.salePot -= need; s.sun!.sold += need; add(s, payer, NATIVE, need);
	const undo = () => { sub(s, payer, NATIVE, need); s.sun!.salePot += need; s.sun!.sold -= need; xOf(s).pot![coin] -= units; s.assets['x' + coin].supply += units; add(s, payer, 'x' + coin, units); };
	return { data: amount + units > has ? shrink(amount, has - units) : d, undo };
}
/** what a hash key signs: for this chain, this account and this turn only */
export const qMessage = (chain: string, account: string, n: number, d: { root: string; key?: string; only?: boolean; act?: unknown }) => 'dzy-q:' + canon({ chain, account, n, root: d.root, ...(d.key === undefined ? {} : { key: d.key }), ...(d.only === undefined ? {} : { only: d.only }), ...(d.act === undefined ? {} : { act: d.act }) });
/** what a hash key may do as its account, in one step */
const Q_ACTS: ReadonlySet<string> = new Set(['transfer', 'transfer.many', 'stake.unbond', 'stake.withdraw', 'stake.undelegate', 'stake.claim', 'offer.create', 'offer.cancel', 'swap', 'x.sell', 'x.close', 'key.add', 'key.remove', 'name.set', 'lock.stake']);
/** stake that came from locks and is still held */
export const keptNow = (s: State, st: Stake) => (st.kept ?? []).filter((k) => k.m > (s.sun?.minute ?? 0)).reduce((n, k) => n + k.n, 0);
export const locksOfX = (s: State) => (s.heart ? s.xlocks : s.x?.locks);
export const loansOfX = (s: State) => (s.heart ? s.xloans : s.x?.loans);
export const lockAt = (s: State, k: string): number => { const m = locksOfX(s); return m && own(m, k) ? m[k] : 0; };
function lockAdd(s: State, k: string, n: number) { const m = s.heart ? (s.xlocks ??= {}) : (xOf(s).locks ??= {}); m[k] = (m[k] ?? 0) + n; }
export const isParked = (s: State, who: string): boolean => { const m = s.heart ? s.xparks : s.x?.park; return !!m && own(m, who); };
/** as the upgrade starts: the lists of what is open already */
function startLists(s: State) {
	if (s.x) {
		if (s.x.locks) { const m = s.x.locks; delete s.x.locks; for (const k of Object.keys(m)) (s.xlocks ??= {})[k] = m[k]; }
		if (s.x.loans) { const m = s.x.loans; delete s.x.loans; for (const k of Object.keys(m)) (s.xloans ??= {})[k] = m[k]; }
		if (s.x.park) { const m = s.x.park; delete s.x.park; for (const k of Object.keys(m)) (s.xparks ??= {})[k] = m[k]; }
	}
	for (const k of keysOf(s.offers)) bookAdd(s, k, s.time);
	for (const k of keysOf(s.orders ?? {})) orderAdd(s, k);
}
/** how much of an offer `budget` (in what it wants) takes, at the maker's price rounded in the maker's favour; null if too small */
function partFill(o: Offer, budget: number): { take: number; pay: number } | null {
	if (budget >= o.want.amount) return { take: o.give.amount, pay: o.want.amount };
	const take = Number((BigInt(budget) * BigInt(o.give.amount)) / BigInt(o.want.amount));
	if (take <= 0) return null;
	const pay = Number((BigInt(take) * BigInt(o.want.amount) + BigInt(o.give.amount) - 1n) / BigInt(o.give.amount));
	return pay > budget || pay >= o.want.amount ? null : { take, pay };
}
/** what the taker of a fill receives: what the offer gives, less 0.05% to the pot if that is vault coin */
const fillGets = (s: State, o: Offer, take: number) => { const net = take - (isXClaim(s, o.give.asset) ? xFee(take, RULES.xTradeBps) : 0); return net - (royaltyIn(s.assets[o.want.asset], net)?.n ?? 0); }; // (less the royalty, when what is sold to the offer is an NFT)
/** one fill of one offer: both sides move. A fill that moves vault coin pays 0.05% of that coin to the pot, once (on what
    the offer gives if it is coin). Checked before: the offer is open, the taker holds `pay`. */
function fillOffer(s: State, key: string, taker: string, take: number, pay: number, height: number, time: number) {
	const o = s.offers[key];
	const feeOn = isXClaim(s, o.give.asset) ? 'give' : isXClaim(s, o.want.asset) ? 'want' : null;
	const fee = feeOn === 'give' ? xFee(take, RULES.xTradeBps) : feeOn === 'want' ? xFee(pay, RULES.xTradeBps) : 0;
	sub(s, taker, o.want.asset, pay);
	const toMaker = pay - (feeOn === 'want' ? fee : 0), toTaker = take - (feeOn === 'give' ? fee : 0);
	const r1 = royaltyIn(s.assets[o.give.asset], toMaker), r2 = royaltyIn(s.assets[o.want.asset], toTaker); // an NFT sold, to a buyer or to an offer for it: its maker's royalty comes out of what the seller gets
	if (toMaker - (r1?.n ?? 0) > 0) add(s, o.maker, o.want.asset, toMaker - (r1?.n ?? 0));
	if (r1) add(s, r1.to, o.want.asset, r1.n);
	if (toTaker - (r2?.n ?? 0) > 0) add(s, taker, o.give.asset, toTaker - (r2?.n ?? 0));
	if (r2) add(s, r2.to, o.give.asset, r2.n);
	if (fee) { const c = (feeOn === 'give' ? o.give.asset : o.want.asset).slice(1); s.assets['x' + c].supply -= fee; potAdd(s, c, coinFee(s, c, fee)); }
	const sold = o.give.asset, paid = o.want.asset;
	if (take === o.give.amount) { bookDrop(s, o, key); delete s.offers[key]; }
	else { o.give = { asset: sold, amount: o.give.amount - take }; o.want = { asset: paid, amount: o.want.amount - pay }; }
	const t: Trade = { h: height, t: time, offer: key, maker: o.maker, taker, sold: { asset: sold, amount: take }, paid: { asset: paid, amount: pay } };
	s.trades = [...(s.trades ?? []), t].slice(-RULES.maxTrades);
}
/** a pool leg: `amount` of `give` through the pools to `want` (straight against DZY, or token → DZY → token), or null */
function poolPlan(s: State, give: string, want: string, amount: number): { out: number; run: (who: string, height: number, time: number) => void } | null {
	const pools = s.liquidity ?? {};
	if (give === NATIVE || want === NATIVE) {
		const asset = give === NATIVE ? want : give;
		if (!own(pools, asset)) return null;
		const p = pools[asset], r = poolSwap(p, give === NATIVE, amount);
		if (!r) return null;
		return { out: r.out, run: (who, height, time) => {
			poolTick(p, time);
			sub(s, who, give, amount); add(s, who, want, r.out); toTreasury(s, r.hub); p.dzy = r.dzy; p.token = r.token;
			if (r.creator) add(s, p.launch!.creator, NATIVE, r.creator);
			s.trades = [...(s.trades ?? []), { h: height, t: time, offer: 'pool:' + asset, maker: 'pool:' + asset, taker: who, sold: { asset: want, amount: r.out }, paid: { asset: give, amount } } as Trade].slice(-RULES.maxTrades);
		} };
	}
	if (!own(pools, give) || !own(pools, want)) return null;
	const a = pools[give], b = pools[want], one = poolSwap(a, false, amount), two = one ? poolSwap(b, true, one.out) : null;
	if (!one || !two) return null;
	return { out: two.out, run: (who, height, time) => {
		poolTick(a, time); poolTick(b, time);
		sub(s, who, give, amount); add(s, who, want, two.out); toTreasury(s, one.hub + two.hub);
		if (one.creator) add(s, a.launch!.creator, NATIVE, one.creator);
		if (two.creator) add(s, b.launch!.creator, NATIVE, two.creator);
		a.dzy = one.dzy; a.token = one.token; b.dzy = two.dzy; b.token = two.token;
		s.trades = [...(s.trades ?? []), { h: height, t: time, offer: 'pool:' + give, maker: 'pool:' + give, taker: who, sold: { asset: NATIVE, amount: one.out }, paid: { asset: give, amount } } as Trade, { h: height, t: time, offer: 'pool:' + want, maker: 'pool:' + want, taker: who, sold: { asset: want, amount: two.out }, paid: { asset: NATIVE, amount: one.out } } as Trade].slice(-RULES.maxTrades);
	} };
}
/** The exchange's own two sides, so DZY against a vault coin always has a price, with no pool and nobody's money put up:
    - vault coin → DZY: the sale sells DZY at its price now, and the coin becomes a lock in the buyer's own name (as a
      deposit would);
    - DZY → vault coin: the pot buys DZY at the floor, never above it (as x.floor), and the DZY go back to the sale.
    People's offers between those two prices are always better, so a swap uses them first. */
function xLeg(s: State, give: string, want: string, amount: number, time: number): { out: number; run: (who: string, height: number, time: number) => void } | null {
	if (!exchangeOn(s, s.height + 1)) return null;
	const u = s.sun!;
	if (isXClaim(s, give) && want === NATIVE) {
		const coin = give.slice(1), price = xPrice(s, coin, time);
		if (price === null || u.salePot <= 0 || retiredOf(s, coin)) return null; // (a retired coin buys no DZY)
		const usd = (B(amount) * B(price)) / 10n ** B(X_COINS[coin].decimals), units = indexOn(s) ? indexBuyUnits(s, usd, time) : N(unitsFor(s, usd, xFloor(s, time)));
		if (units <= 0 || units > u.salePot) return null;
		return { out: units, run: (who) => {
			sub(s, who, give, amount); s.assets[give].supply -= amount;
			if (indexOn(s)) indexBought(s, usd, time);
			if (indexOn(s) || reserveOn(s)) potAdd(s, coin, amount); else lockAdd(s, `${who}:${coin}`, amount); // the shared reserve (before it: a lock in their name)
			u.salePot -= units; u.sold += units; add(s, who, NATIVE, units);
		} };
	}
	if (give === NATIVE && isXClaim(s, want) && indexOn(s)) { // the index: what stands behind each DZY, less the fee that stays
		const coin = want.slice(1), pot = s.x?.pot?.[coin] ?? 0, q = indexSale(s, coin, amount, time);
		if (!q || q.pay > pot) return null; // only what the reserve holds of that coin
		return { out: q.pay, run: (who) => {
			const n = indexNav(s, time); if (n) wash(s, n, B(q.fee), WASH_BP);
			sub(s, who, NATIVE, amount); u.salePot += amount; u.sold -= amount;
			xOf(s).pot![coin] -= q.pay; claimAsset(s, coin).supply += q.pay; claimAsset(s, coin).minted += q.pay; add(s, who, want, q.pay);
		} };
	}
	if (give === NATIVE && isXClaim(s, want) && indexWaiting(s)) return null; // the reserve is short of today's price: no selling into it yet
	if (give === NATIVE && isXClaim(s, want) && reserveOn(s)) { // the shared reserve: the chain's price, nothing added or taken
		const coin = want.slice(1), pot = s.x?.pot?.[coin] ?? 0, q = reserveSale(s, coin, amount, time);
		if (!q || q.pay > pot) return null; // only what the reserve holds of that coin
		return { out: q.pay, run: (who) => {
			sub(s, who, NATIVE, amount); u.salePot += amount; u.sold -= amount;
			xOf(s).pot![coin] -= q.pay; claimAsset(s, coin).supply += q.pay; claimAsset(s, coin).minted += q.pay; add(s, who, want, q.pay);
		} };
	}
	if (give === NATIVE && isXClaim(s, want)) {
		const coin = want.slice(1), pot = s.x?.pot?.[coin] ?? 0, f = pot ? xFloor(s, time) : null, price = f ? xPrice(s, coin, time) : null;
		if (!f || price === null || amount > u.sold) return null;
		const gross = N((B(amount) * f.usd * 10n ** B(X_COINS[coin].decimals)) / (f.hands * B(price)));
		if (gross <= 0 || gross > pot) return null;
		let t: ReturnType<typeof takeBacking>; try { t = takeBacking(s, coin, pot, gross); } catch { return null; } // the day's part is used up
		const pay = t.pay;
		return { out: pay, run: (who) => {
			t.done(); sub(s, who, NATIVE, amount); u.salePot += amount; u.sold -= amount;
			xOf(s).pot![coin] -= pay; claimAsset(s, coin).supply += pay; claimAsset(s, coin).minted += pay; add(s, who, want, pay);
		} };
	}
	return null;
}
/** the better of the pool and the exchange's own side for `amount`, or null */
function bestLeg(s: State, give: string, want: string, amount: number, time: number) {
	const p = poolPlan(s, give, want, amount), x = xLeg(s, give, want, amount, time);
	return p && x ? (x.out > p.out ? x : p) : p ?? x;
}
/** The best way to swap `amount` of `give` for `want` now: offers cheapest first, each while it beats the pool (and, for
    DZY against a vault coin, the sale or the floor) for that part, then the better of those for the rest. (Offers move
    neither, so they are priced as they stand.) */
export function swapPlan(s: State, who: string, give: string, want: string, amount: number, time: number = s.time): { fills: Fill[]; pool: ReturnType<typeof bestLeg>; out: number; spent: number } {
	const fills: Fill[] = [];
	let left = amount, out = 0;
	for (const k of bookFor(s, give, want, who, time)) {
		if (!left || fills.length >= RULES.maxFills) break;
		const o = s.offers[k], f = partFill(o, left);
		if (!f) break;
		const gets = fillGets(s, o, f.take);
		if ((bestLeg(s, give, want, f.pay, time)?.out ?? 0) > gets) break; // the pool (or the sale, or the floor) gives more for this part: it takes the rest
		fills.push({ key: k, ...f }); left -= f.pay; out += gets;
	}
	const pool = left > 0 ? bestLeg(s, give, want, left, time) : null;
	if (pool) out += pool.out;
	return { fills, pool, out, spent: pool ? amount : amount - left };
}
function sideOf(s: State, v: unknown): Side {
	if (!v || typeof v !== 'object') fail('bad offer');
	const o = v as Record<string, unknown>;
	return { asset: assetOf(s, o.asset), amount: amountOf(o.amount) };
}

/* Each handler checks everything first and returns the change to make. It must not touch the state before returning,
   so a refused transaction leaves no trace. */
/** what a handler may know beyond the transaction (worked out before, while waiting is still allowed), and what it
    reports back (the gas a contract used, so the unused part of the fee is given back) */
interface Ctx { height: number; payer: string; contract?: string; sigsOk?: boolean; gasUsed?: number; failed?: string; secretHash?: string; linkOk?: boolean; giftOk?: boolean; taskOk?: boolean; stepSig?: boolean; side?: string; fee?: number }
/** what applyTx can report back: the fee paid, the gas a contract used, and why a contract call failed while running */
export interface TxReport { fee?: number; gasUsed?: number; failed?: string }
type Handler = (s: State, from: string, d: Record<string, unknown>, id: string, time: number, ctx: Ctx) => () => void;

/** what layers may do with balances: the ledger's own moves and checks, nothing more */
const bankOf = (s: State): Bank => ({
	add: (who, asset, n) => add(s, who, asset, n), sub: (who, asset, n) => sub(s, who, asset, n), balance: (who, asset) => balanceOf(s, who, asset), toSun: (n) => toTreasury(s, n),
	asset: (id) => (typeof id === 'string' && own(s.assets, id) ? id : fail('no such asset')), amount: amountOf, addr: (v) => (isAddr(v) ? v : fail('bad address')),
});
const blobBank = (s: State): BlobBank => ({
	...bankOf(s), assetFee: RULES.assetFee, toFees: (n) => { s.sun!.feePot += n; }, // into the fee pot: 40% validators, 30% backing, ... like any fee
	keptTimes: () => keptTimes(s), keptAdd: (n) => keptAdd(s, n), dzyFor: (usd) => usdCost(s, NATIVE, usd) ?? fail('DZY has no price'), staked: (who) => isCandidate(s, who),
});
/** milliseconds since block 1 (0 before the chain has started) */
const elapsed = (s: State, time: number) => (s.started ? Math.max(0, time - s.started) : 0);
/** an account that already exists; key and recovery changes need one, so they cannot be used to fill the chain with empty accounts */
const existing = (s: State, addr: string): Account => (own(s.accounts, addr) ? s.accounts[addr] : fail('this account has nothing on the chain yet'));

/** the 0.5% (saleFeeBps) taken from a tip or a sale, rounded down */
const saleFee = (amount: number, bps: number = RULES.saleFeeBps) => Number((BigInt(amount) * BigInt(bps)) / 10_000n);
/** the most the creators' fee can ever be set to: 20% (fee.set) */
export const SALE_FEE_MAX_BPS = 2_000;
/** the creators' fee now: what the network's fee account set (fee.set), from the checkout upgrade; else the rule */
export const feeBpsOf = (s: State) => (checkoutV2(s) && Number.isSafeInteger(s.saleFeeBps) ? s.saleFeeBps! : RULES.saleFeeBps);
/* ---- dollar prices: a creator prices in dollars (µ$), a buyer pays in any coin the chain prices ----
   DZY at the chain's own sale price; xUSDC and xUSDT (claims on dollars in the vaults) one for one; the other claims
   (xETH, xBTC, xSOL, ...) at the price the validators agreed (xPrice). Nothing else: a coin with no price is refused. */
export const DOLLAR_CLAIMS: readonly string[] = ['xUSDC', 'xUSDT'];
/** µ$ per whole unit of `asset` now, and its decimals; null when the chain has no price for it */
export function usdRate(s: State, asset: string, time: number = s.time): { per: number; decimals: number } | null {
	if (asset === NATIVE) return s.sun ? { per: payPrice(s), decimals: 8 } : null;
	if (!own(s.assets, asset)) return null;
	if (DOLLAR_CLAIMS.includes(asset)) return { per: 1_000_000, decimals: 6 };
	const coin = asset.startsWith('x') ? asset.slice(1) : '';
	if (!own(X_COINS, coin) || s.assets[asset].issuer !== '0'.repeat(64)) return null; // only the chain's own claims
	const p = xPrice(s, coin, time);
	return p ? { per: p, decimals: X_COINS[coin].decimals } : null;
}
/** how much of `asset` pays `usd` µ$ (rounded up, so the seller never gets less), or null */
export function usdCost(s: State, asset: string, usd: number, time: number = s.time): number | null {
	const r = usdRate(s, asset, time); if (!r || r.per <= 0) return null;
	const n = (B(usd) * 10n ** B(r.decimals) + B(r.per) - 1n) / B(r.per);
	return n > 0n && n <= B(Number.MAX_SAFE_INTEGER) ? N(n) : null;
}
/** what `amount` of `asset` is worth in µ$ now (rounded down), or null */
export function usdWorth(s: State, asset: string, amount: number, time: number = s.time): number | null {
	const r = usdRate(s, asset, time); return r ? N((B(amount) * B(r.per)) / 10n ** B(r.decimals)) : null;
}
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** an item for sale as its record holds it, checked: priced in dollars (usd: µ$ above 0), or in one coin (price: whole
    units of asset, default DZY); editions? (how many can be sold), every? ("month": a membership, 30 days a payment),
    off? (not for sale now). The rest (title, kind, cover, sealed, ...) is the seller's */
export function itemOf(v: unknown): { price: number; asset: string; usd: number; editions: number; month: boolean; off: boolean } | null {
	if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>, asset = o.asset === undefined ? NATIVE : o.asset;
	const usd = Number.isSafeInteger(o.usd) && (o.usd as number) > 0 ? (o.usd as number) : 0;
	if (!usd && (typeof asset !== 'string' || !Number.isSafeInteger(o.price) || (o.price as number) <= 0)) return null;
	if (o.every !== undefined && o.every !== 'month') return null;
	const editions = o.editions === undefined ? 0 : Number.isSafeInteger(o.editions) && (o.editions as number) >= 1 && (o.editions as number) <= RULES.maxEditions ? (o.editions as number) : -1;
	return editions < 0 ? null : { price: usd ? 0 : (o.price as number), asset: usd ? '' : (asset as string), usd, editions, month: o.every === 'month', off: o.off === true };
}

/* ---- checkout from any wallet or exchange ----
   The buyer opens an order: the chain names the creator's own address on the chosen network and an exact amount (the
   price in that coin plus a few smallest units unique among the creator's open orders), and a memo for wallets that
   can carry one. The buyer pays from anywhere (an exchange, MetaMask, Phantom) and names the payment (order.paid);
   validators read it on that chain and report it (order.attest). When more than two thirds of the say agree, the buyer
   owns the item, exactly as with item.buy. The money never touches Dznye: the creator has it at once. The 0.5% is owed
   by the creator (feeOwed) and taken from their next earnings on Dznye; past feeOwedMax, no new orders. */
export interface Order { buyer: string; seller: string; item: string; net: string; coin: string; payTo: string; base: number; due: number; usd: number; memo: string; at: number; until: number; tx?: string; votes?: string[]; /** paid into Dznye's vault: the chain pays the creator */ vault?: true; /** a network's own coin: paid by the vault's deposit naming this tag */ tag?: string }
/** which coin on which network a buyer may pay with (all counted on Dznye in its units: 6 decimals, 9 for SOL/ETH/BNB) */
export const ORDER_COINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	USDC: ['base', 'sol', 'bsc', 'eth', 'arb', 'op', 'polygon', 'avax'], USDT: ['bsc', 'sol', 'eth', 'arb', 'op', 'polygon', 'avax'],
	SOL: ['sol'], ETH: ['base', 'eth', 'arb', 'op'], BNB: ['bsc'], POL: ['polygon'], AVAX: ['avax'],
});
const ORDER_DECIMALS: Readonly<Record<string, number>> = Object.freeze({ USDC: 6, USDT: 6, SOL: 9, ETH: 9, BNB: 9, POL: 9, AVAX: 9, BTC: 8 });
/* Bitcoin at checkout (24 Nov 2026; off until a block is set). A buyer pays the creator's own Bitcoin
   address (the one their account linked) an exact amount in satoshis, unique among the creator's open checkouts; the
   validators count it only with its proof: its merkle path to a block whose headers carry the work and are buried deep
   enough (btc.ts checkBtcPayment). As with every payment made straight to a creator on another chain, the creators' fee
   goes on their tab (feeOwed) and is taken from their next earnings on Dznye. */
const ORDER_BTC_FROM: Record<string, number> = { 'dznye-mainnet': 11_100 }; // switched on 24 Nov 2026
const TEST_ORDER_BTC = new Map<string, number>();
/** TEST ONLY: the block a test chain takes Bitcoin at checkout from (null: back to the rule) */
export function testOrderBtcFrom(chain: string, height: number | null) { if (height === null) TEST_ORDER_BTC.delete(chain); else TEST_ORDER_BTC.set(chain, height); }
export const orderBtcFrom = (chain: string) => TEST_ORDER_BTC.get(chain) ?? (Object.hasOwn(ORDER_BTC_FROM, chain) ? ORDER_BTC_FROM[chain] : Infinity);
export const orderBtcOn = (s: State, height: number = s.height + 1) => height >= orderBtcFrom(s.chain);
/** a network's own coin: the vault takes it only through its deposit, which names a 32-byte tag (an order's) */
const NATIVE_PAY = new Set(['ETH', 'BNB', 'POL', 'AVAX']);
/** where the creator is paid on `net`: their Solana address (their own key) or a linked one; on the 0x networks, the 0x
    address they linked to their name. null: they cannot be paid there yet */
/* Checkout through the vaults, and creators who join (2026-11-21). From this block on mainnet:
   - an outside checkout is paid into Dznye's own vault on that chain (USDC or USDT, on every network with a vault), not to
     the creator. When the validators agree it arrived, the creator gets 99.5% of it as that coin on Dznye (theirs to keep,
     spend or take out to any chain) and the network's fee account the 0.5%, in the same coin, at once: no fee is owed.
     ETH and BNB sent as a plain payment (the vault takes those only through its deposit) are not offered; Solana, with
     no vault yet, keeps the old checkout (paid to the creator, the fee on their tab);
   - selling (item.buy, a checkout) needs the seller to have joined (creator.join, free to do): joining puts $5 on what
     they owe, taken from their first sales and tips, like any fee owed.
   Blocks before it replay under the rules as they were. Other chains keep the old checkout. */
const CHECKOUT_V2_FROM: Record<string, number> = { 'dznye-mainnet': 7400 };
const TEST_CHECKOUT_V2 = new Map<string, number>();
/** TEST ONLY: the block a test chain starts the vault checkout from (null: back to the rule) */
export function testCheckoutV2From(chain: string, height: number | null) { if (height === null) TEST_CHECKOUT_V2.delete(chain); else TEST_CHECKOUT_V2.set(chain, height); }
export const checkoutV2 = (s: State, height: number = s.height + 1) => height >= (TEST_CHECKOUT_V2.get(s.chain) ?? (Object.hasOwn(CHECKOUT_V2_FROM, s.chain) ? CHECKOUT_V2_FROM[s.chain] : Infinity));
/** the one-time price of joining as a creator, in µ$ */
export const CREATOR_JOIN_USD = 5_000_000;
/* A shop's 40 free days (24 Nov 2026; from the block below). A shop opened from then on owes its $5
   only once 40 days have passed: until then every sale is the creator's in full (less the creators' fee). From day 40
   the $5 is taken from the next sales, in whatever coin they are paid in, as before; or the creator pays it any time,
   in any coin the chain prices (fee.pay). It goes to the network's fee account, like the creators' fee. */
export const JOIN_TRIAL_MS = 40 * 86_400_000;
const JOIN_TRIAL_FROM: Record<string, number> = { 'dznye-mainnet': 11_100 };
const TEST_JOIN_TRIAL = new Map<string, number>();
/** TEST ONLY: the block a test chain gives shops their free days from (null: back to the rule) */
export function testJoinTrialFrom(chain: string, height: number | null) { if (height === null) TEST_JOIN_TRIAL.delete(chain); else TEST_JOIN_TRIAL.set(chain, height); }
export const joinTrialOn = (s: State, height: number = s.height + 1) => height >= (TEST_JOIN_TRIAL.get(s.chain) ?? (Object.hasOwn(JOIN_TRIAL_FROM, s.chain) ? JOIN_TRIAL_FROM[s.chain] : Infinity));
/** the $5 a shop owes from `time` on (its free days over, not yet paid), in µ$ */
export const joinDueAt = (s: State, who: string, time: number = s.time) => (s.joinDue && own(s.joinDue, who) && time >= s.joinDue[who] ? CREATOR_JOIN_USD : 0);
/** whether `a` may sell: always before the upgrade; after it, once they have joined */
export const creatorJoined = (s: State, a: string, height: number = s.height + 1) => !checkoutV2(s, height) || !!(s.creators && own(s.creators, a));
/* Resale (22 Nov 2026). Whoever owns a numbered edition may offer it for dollars. The price is all a
   buyer pays: the resale fee comes out of it. The fee is the creator's to set on the item (`resale`, 1% to 10%; 2% when
   they set none): 70% of it goes to the creator, 30% to the network's fee account (@dzy). Only numbered editions: a file sold
   without limit is copied, not owned. Older blocks replay as they were; other chains: from the start, unless set. */
const RESALE_FROM: Record<string, number> = { 'dznye-mainnet': 10_000 }; // live height 7,977 when written, 22 Nov 2026
const TEST_RESALE = new Map<string, number>();
/** TEST ONLY: the block a test chain takes resales from (null: back to the rule) */
export function testResaleFrom(chain: string, height: number | null) { if (height === null) TEST_RESALE.delete(chain); else TEST_RESALE.set(chain, height); }
export const resaleFrom = (chain: string) => TEST_RESALE.get(chain) ?? (Object.hasOwn(RESALE_FROM, chain) ? RESALE_FROM[chain] : 0);
export const resaleOn = (s: State, height: number = s.height + 1) => height >= resaleFrom(s.chain);
export const RESALE = Object.freeze({ defaultBps: 200, minBps: 100, maxBps: 1_000, creatorPct: 70, minUsd: 100_000, maxUsd: 1_000_000_000_000 });
/** Sold means locked (from the same block): once an item has sold, its maker may change only what it costs, its words
    (about), its resale fee and whether it is on sale, and may make fewer of them (never fewer than sold); never what it
    is: its title, picture, kind, locked content, or any other field. It cannot be deleted. A membership may change what
    it gives (a private link, an invite): that is paid for month by month; it cannot be deleted either. The reason it is refused, or ''. */
const ITEM_FREE: ReadonlySet<string> = new Set(['usd', 'price', 'asset', 'about', 'resale', 'off', 'editions']);
/** A file an item opens into costs by its size, once, to the Sun with the record's own fee: the same for a kilobyte as for a
    character of a record (0.00001 DZY; 10 MB is 0.1 DZY). Nothing else is charged for posting. A price change pays it again
    never: only a new file does. */
export const FILE_FEE = Object.freeze({ perKb: 1_000, max: 60_000_000 });
export const fileFee = (bytes: number) => Math.ceil(bytes / 1_000) * FILE_FEE.perKb;
export function itemFileFee(s: State, writer: string, item: string, value: unknown): number {
	const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	if (v.file === undefined && v.fs === undefined) return 0;
	if (typeof v.file !== 'string' || !/^[0-9a-f]{64}$/.test(v.file) || !Number.isSafeInteger(v.fs) || (v.fs as number) < 1 || (v.fs as number) > FILE_FEE.max) fail('file: its fingerprint, and fs: its size, at most 60 MB');
	const rec = s.records && own(s.records, `${writer}/items/${item}`) ? s.records[`${writer}/items/${item}`].value : null, o = rec && typeof rec === 'object' ? (rec as Record<string, unknown>) : {};
	return o.file === v.file && o.fs === v.fs ? 0 : fileFee(v.fs as number);
}
const soldCount = (s: State, seller: string, item: string) => (s.sales && own(s.sales, `${seller}/${item}`) ? s.sales[`${seller}/${item}`].n : 0);
export function soldLock(s: State, seller: string, item: string, next: unknown): string {
	const sold = soldCount(s, seller, item);
	const rec = s.records && own(s.records, `${seller}/items/${item}`) ? s.records[`${seller}/items/${item}`] : null;
	if (!sold || !rec || rec.value === undefined) return '';
	if (next === null || typeof next !== 'object' || Array.isArray(next)) return 'someone owns this: it cannot be removed (hide it instead)';
	const a = rec.value as Record<string, unknown>, b = next as Record<string, unknown>, month = a.every === 'month';
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (ITEM_FREE.has(k) || (month && k !== 'every')) continue;
		if (own(a, k) !== own(b, k) || canon(a[k] ?? null) !== canon(b[k] ?? null)) return `someone owns this: its ${k === 'sealed' ? 'content' : k === 'cover' ? 'picture' : k} cannot change any more`;
	}
	if (own(a, 'editions') !== own(b, 'editions') || (own(a, 'editions') && !(Number.isSafeInteger(b.editions) && (b.editions as number) <= (a.editions as number) && (b.editions as number) >= sold))) return 'someone owns this: you may make fewer of them (never fewer than sold), not more';
	return '';
}
/* Cards that are real NFTs (23 Nov 2026; off until a block is set). An item may name the Heart NFT
   (`nft`) its creator made of it: the copies must be theirs and as many as its editions. From the block below, buying it
   through the shop (item.buy, or a checkout paid from any chain) hands the buyer one copy in the same step; a resale moves
   the owner's copy; and whoever holds a copy, however they got it, owns the item (GET /owned). A creator who no longer holds a
   copy cannot sell one: a checkout already paid then gives the buyer their money back, on Dznye. */
const NFT_ITEMS_FROM: Record<string, number> = { 'dznye-mainnet': 11_100 }; // switched on 24 Nov 2026
const TEST_NFT_ITEMS = new Map<string, number>();
/** TEST ONLY: the block a test chain links items to NFTs from (null: back to the rule) */
export function testNftItemsFrom(chain: string, height: number | null) { if (height === null) TEST_NFT_ITEMS.delete(chain); else TEST_NFT_ITEMS.set(chain, height); }
export const nftItemsFrom = (chain: string) => TEST_NFT_ITEMS.get(chain) ?? (Object.hasOwn(NFT_ITEMS_FROM, chain) ? NFT_ITEMS_FROM[chain] : Infinity);
export const nftItemsOn = (s: State, height: number = s.height + 1) => !!s.heart && height >= nftItemsFrom(s.chain);
/** the NFT an item is, when the rule is on and it names one, or null */
export function itemNft(s: State, value: unknown, height: number = s.height + 1): string | null {
	if (!nftItemsOn(s, height) || !value || typeof value !== 'object') return null;
	const n = (value as Record<string, unknown>).nft;
	return typeof n === 'string' && own(s.assets, n) && s.assets[n].nft ? n : null;
}
/** an item record naming an NFT must name its writer's own, with as many copies as editions: the reason it is refused, or '' */
function nftItemProblem(s: State, writer: string, value: unknown): string {
	const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	if (!v || v.nft === undefined) return '';
	const a = typeof v.nft === 'string' && own(s.assets, v.nft) ? s.assets[v.nft] : null;
	if (!a?.nft) return 'nft: an NFT on this chain';
	if (a.nft.by !== writer) return 'nft: only one you made yourself';
	if (v.every !== undefined || a.minted !== v.editions) return 'nft: as many editions as it has copies, and not a membership';
	return '';
}
/* DZY on Solana (23 Nov 2026; off until a block and the token are set). Anyone may move DZY they own to
   Solana and back. Going out, their DZY is held by the chain (State.wdzy.held: never destroyed, never the Sun's or the
   sale's) and the Solana vault pays them the same amount of wDZY, released only with the validators' signatures, exactly as
   it pays SOL or USDC. Coming back, they pay wDZY into the vault; once validators with more than two thirds of the power
   have seen it, the same DZY is theirs again. The wDZY token has a fixed supply of 12,000,000 that all starts in the vault
   and can never be made again (its mint authority is closed), so wDZY in people's hands is exactly the DZY held here. At
   most `cap` DZY are out at once, so a fault costs little while it is new. */
export const WDZY = Object.freeze({ cap: 100_000 * DZY, least: DZY / 100 });
const WDZY_FROM: Record<string, number> = {}; // the owner writes the mainnet block here: 'dznye-mainnet': N
const WDZY_MINT: Record<string, string> = {}; // and the wDZY token's mint address on Solana
const TEST_WDZY = new Map<string, { from: number; mint: string; cap?: number }>();
/** TEST ONLY: switch DZY on Solana on for a test chain (null: back to the rule) */
export function testWdzy(chain: string, v: { from: number; mint: string; cap?: number } | null) { if (v === null) TEST_WDZY.delete(chain); else TEST_WDZY.set(chain, v); }
const wdzyConf = (chain: string) => TEST_WDZY.get(chain) ?? (Object.hasOwn(WDZY_FROM, chain) && Object.hasOwn(WDZY_MINT, chain) ? { from: WDZY_FROM[chain], mint: WDZY_MINT[chain] } : null);
/** the wDZY token's mint on Solana, or null while DZY on Solana is off */
export const wdzyMint = (chain: string): string | null => wdzyConf(chain)?.mint ?? null;
const wdzyCap = (chain: string) => TEST_WDZY.get(chain)?.cap ?? WDZY.cap;
export const wdzyOn = (s: State, height: number = s.height + 1) => { const c = wdzyConf(s.chain); return !!c && height >= c.from && exchangeOn(s, height); };
/** a validator's word that wDZY came back into the Solana vault: counted like any deposit (more than two thirds of the
    power), then the same DZY is its owner's again, from what the chain holds */
function wdzyIn(s: State, from: string, d: Record<string, unknown>, time: number) {
	if (!wdzyOn(s)) fail('DZY on Solana is not open on this chain');
	if (d.net !== 'sol') fail('wDZY comes back through the Solana vault');
	const amount = amountOf(d.amount), to = isAddr(d.to) ? d.to : fail('bad Dznye address');
	const tx = typeof d.tx === 'string' && d.tx.length >= 32 && d.tx.length <= 100 && /^[0-9A-Za-z]+$/.test(d.tx) ? d.tx : fail('bad payment id');
	const seen = `sol:${tx}`;
	if (s.xseen && own(s.xseen, seen)) fail('that payment was already counted');
	const key = `${seen}:wDZY:${amount}:${to}`, c = s.xclaims && own(s.xclaims, key) ? s.xclaims[key] : null;
	if (c?.votes.includes(from)) fail('this validator already confirmed it');
	const votes = [...(c?.votes ?? []), from], w = powers(s);
	const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
	if (said * 3 <= all * 2 || !vouched(s, votes)) return () => { (s.xclaims ??= {})[key] = { at: time, votes }; };
	const held = s.wdzy?.held ?? 0;
	if (amount > held) fail('more wDZY came back than was ever sent out'); // cannot happen while the supply is the vault's
	return () => { s.wdzy!.held -= amount; add(s, to, NATIVE, amount); (s.xseen ??= {})[seen] = { at: time, to, coin: 'wDZY', amount, dzy: amount }; dropClaims(s, seen); };
}
/* Business (23 Nov 2026; off until a block is set). An item may be a business offer (`biz`: 'order' a
   product or a meal, 'book' an appointment or a session, 'table' a reservation, 'pass' a pass or a membership of a place).
   It can be bought again and again, and a purchase may carry a short note (an address, a size, what to bring). An
   appointment or a reservation names its hours (`book`: the days of the week, from and to in minutes of the day, the
   length of a slot, the seats in a slot, and the business's time zone in minutes); buying it names the slot (`at`), and
   the chain refuses a slot that is not open, is past or too far ahead, or is full. The business sees every order and
   booking (GET /biz/<address>); anyone sees how full each slot is (GET /slots/<seller>/<item>). */
export const BIZ = Object.freeze({ kinds: ['order', 'book', 'table', 'pass'] as readonly string[], noteMax: 140, aheadMs: 180 * 86_400_000, keep: 400, seatsMax: 500 });
const BIZ_FROM: Record<string, number> = { 'dznye-mainnet': 11_100 }; // switched on 24 Nov 2026
const TEST_BIZ = new Map<string, number>();
/** TEST ONLY: the block a test chain opens business offers from (null: back to the rule) */
export function testBizFrom(chain: string, height: number | null) { if (height === null) TEST_BIZ.delete(chain); else TEST_BIZ.set(chain, height); }
export const bizFrom = (chain: string) => TEST_BIZ.get(chain) ?? (Object.hasOwn(BIZ_FROM, chain) ? BIZ_FROM[chain] : Infinity);
export const bizOn = (s: State, height: number = s.height + 1) => height >= bizFrom(s.chain);
export interface Book { days: number[]; from: number; to: number; step: number; seats: number; tz: number }
export interface BizEntry { i: string; by: string; t: number; asset: string; paid: number; at?: number; note?: string }
/** a booking offer's hours, or null when they are not well made */
export function bookOf(v: unknown): Book | null {
	const b = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	if (!b) return null;
	const int = (x: unknown, lo: number, hi: number) => Number.isSafeInteger(x) && (x as number) >= lo && (x as number) <= hi;
	const days = Array.isArray(b.days) && b.days.length >= 1 && b.days.length <= 7 && b.days.every((d) => int(d, 0, 6)) && new Set(b.days).size === b.days.length ? (b.days as number[]) : null;
	if (!days || !int(b.from, 0, 1439) || !int(b.to, 1, 1440) || (b.to as number) <= (b.from as number) || !int(b.step, 5, 720) || !int(b.seats, 1, BIZ.seatsMax) || !int(b.tz, -840, 840)) return null;
	return { days, from: b.from as number, to: b.to as number, step: b.step as number, seats: b.seats as number, tz: b.tz as number };
}
/** why `at` (ms) is not an open slot of `b` at `now`, or '' */
export function slotProblem(b: Book, at: unknown, now: number): string {
	if (!Number.isSafeInteger(at) || (at as number) % 60_000) return 'at: the slot, in whole minutes';
	const t = at as number;
	if (t <= now) return 'that time has passed';
	if (t > now + BIZ.aheadMs) return 'too far ahead';
	const local = t + b.tz * 60_000, day = new Date(local).getUTCDay(), m = Math.floor((local % 86_400_000 + 86_400_000) % 86_400_000 / 60_000);
	if (!b.days.includes(day)) return 'closed that day';
	if (m < b.from || m + b.step > b.to || (m - b.from) % b.step) return 'not one of the open times';
	return '';
}
/** an item record's business part: the reason it is refused, or '' */
function bizProblem(value: unknown): string {
	const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	if (!v || v.biz === undefined) return '';
	if (typeof v.biz !== 'string' || !BIZ.kinds.includes(v.biz)) return `biz: one of ${BIZ.kinds.join(', ')}`;
	if ((v.biz === 'book' || v.biz === 'table') !== (v.book !== undefined)) return 'book: the hours of an appointment or a reservation (and only of those)';
	if (v.book !== undefined && !bookOf(v.book)) return 'book: days 0 to 6, from and to in minutes of the day, step, seats and tz';
	if (v.every !== undefined && v.biz !== 'pass') return 'only a pass may be monthly';
	return '';
}
/** an item's resale fee in basis points: what its creator set, within the limits; else the default */
export function resaleBps(v: unknown): number {
	const n = v && typeof v === 'object' ? (v as Record<string, unknown>).resale : undefined;
	return Number.isSafeInteger(n) && (n as number) >= RESALE.minBps && (n as number) <= RESALE.maxBps ? (n as number) : RESALE.defaultBps;
}
/** a resale's price split, in whole units: every unit goes to someone */
export function resaleSplit(pay: number, bps: number): { owner: number; creator: number; founder: number } {
	const fee = saleFee(pay, bps), creator = N((B(fee) * B(RESALE.creatorPct)) / 100n);
	return { owner: pay - fee, creator, founder: fee - creator };
}
/** the vault an outside checkout in `coin` on `net` is paid into, or null when none takes it */
export const checkoutVault = (s: State, coin: string, net: string): string | null => ((coin === 'USDC' || coin === 'USDT' || NATIVE_PAY.has(coin)) && exchangeOn(s) && xLive(s, coin, net) ? exchangeVaults(s)[net] ?? null : null);
export function payToOf(s: State, seller: string, net: string): string | null {
	const links = own(s.accounts, seller) ? s.accounts[seller].links ?? {} : {};
	if (net === 'sol') return links.sol ?? toBase58(seller);
	if (net === 'btc') return links.btc ?? null; // Bitcoin at checkout: the address the creator linked
	return links.eth ?? null;
}
/** what `usd` µ$ is in `coin` (its Dznye units) now: dollar coins one for one, the others at the validators' price */
export function orderBase(s: State, coin: string, usd: number, time: number = s.time): number | null {
	if (coin === 'USDC' || coin === 'USDT') return usd;
	const p = xPrice(s, coin, time); if (!p) return null;
	return N((B(usd) * 10n ** B(ORDER_DECIMALS[coin]) + B(p) - 1n) / B(p));
}
/** a checkout paid: the buyer owns the item; paid into a vault, the creator gets the coin on Dznye less the fee (and
    anything owed), the fee account the fee, at once; paid to the creator, the fee goes on their tab */
function completeOrder(s: State, key: string, amount: number, time: number, seen: string) {
	const o = s.orders![key];
	const rec = s.records && own(s.records, `${o.seller}/items/${o.item}`) ? s.records[`${o.seller}/items/${o.item}`] : null, v = itemOf(rec?.value);
	const k = `${o.buyer}/${o.seller}/${o.item}`, had = s.owned && own(s.owned, k) ? s.owned[k] : null;
	(s.xseen ??= {})[seen] = { at: time, to: o.seller, coin: o.coin, amount, dzy: 0 };
	const card = o.vault ? itemNft(s, rec?.value) : null;
	if (card && balanceOf(s, o.seller, card) < 1) { // the creator let every copy go before this was paid: the buyer gets the money back, on Dznye
		const asset = 'x' + o.coin, x = xOf(s); x.vaults[`${o.net}:${o.coin}`] = (x.vaults[`${o.net}:${o.coin}`] ?? 0) + amount;
		claimAsset(s, o.coin).supply += amount; claimAsset(s, o.coin).minted += amount; add(s, o.buyer, asset, amount);
		orderDrop(s, key); return;
	}
	if (card) { sub(s, o.seller, card, 1); add(s, o.buyer, card, 1); }
	const sold = s.sales && own(s.sales, `${o.seller}/${o.item}`) ? s.sales[`${o.seller}/${o.item}`].n : 0;
	(s.owned ??= {})[k] = { at: time, asset: `${o.coin}@${o.net}`, paid: amount, usd: o.usd, ...(v?.month ? { until: Math.max(time, had?.until ?? 0) + MONTH_MS } : {}), ...(edOn(s) ? (v?.editions && !had ? { ed: sold + 1 } : had?.ed ? { ed: had.ed } : {}) : {}) };
	const x0 = ((s.sales ??= {})[`${o.seller}/${o.item}`] ??= { n: 0, total: 0 }); x0.n += 1; x0.usd = (x0.usd ?? 0) + o.usd;
	if (o.vault) {
		const asset = 'x' + o.coin, x = xOf(s); x.vaults[`${o.net}:${o.coin}`] = (x.vaults[`${o.net}:${o.coin}`] ?? 0) + amount;
		claimAsset(s, o.coin).supply += amount; claimAsset(s, o.coin).minted += amount;
		const fee = saleFee(amount, feeBpsOf(s)), back = collectOwed(s, o.seller, asset, amount - fee)();
		add(s, o.seller, asset, amount - fee - back); if (fee + back) add(s, RULES.saleFeeTo, asset, fee + back);
	} else (s.feeOwed ??= {})[o.seller] = feeOwedOf(s, o.seller) + saleFee(o.usd, feeBpsOf(s));
	orderDrop(s, key);
}
/** the open, tagged checkout a vault deposit names (its `to`), or null */
function taggedOrder(s: State, to: string, coin: string, net: string, time: number): string | null {
	if (s.heart) { const k = 'o' + to.slice(0, 16), o = s.orders && own(s.orders, k) ? s.orders[k] : null; return o && o.tag === to && o.coin === coin && o.net === net && orderOpen(o, time) ? k : null; } // a checkout's key is the start of its tag
	for (const [k, o] of Object.entries(s.orders ?? {})) if (o.tag === to && o.coin === coin && o.net === net && orderOpen(o, time)) return k;
	return null;
}
const orderOpen = (o: Order, time: number) => time <= o.until + RULES.orderGrace || o.tx !== undefined;
export const feeOwedOf = (s: State, a: string) => (s.feeOwed && own(s.feeOwed, a) ? s.feeOwed[a] : 0);
/** take what `seller` owes in fees from `pay` of `asset` they are about to receive; returns how much goes to the owner */
function collectOwed(s: State, seller: string, asset: string, room: number): () => number {
	const join = joinDueAt(s, seller), owed = feeOwedOf(s, seller) + join; if (!owed || room <= 0) return () => 0; // a shop's $5 counts once its free days are over
	const cost = usdCost(s, asset, owed); if (cost === null) return () => 0;
	const take = Math.min(room, cost), cut = usdWorth(s, asset, take) ?? 0;
	return () => {
		if (join) { delete s.joinDue![seller]; if (emptyOf(s.joinDue!)) delete s.joinDue; }
		const left = take >= cost ? 0 : Math.max(0, owed - cut); if (left) (s.feeOwed ??= {})[seller] = left; else if (s.feeOwed) delete s.feeOwed[seller]; return take;
	};
}

const HANDLERS: Record<string, Handler> = {
	...Object.fromEntries(Object.entries(BLOB_HANDLERS).map(([k, f]): [string, Handler] => [k, (s, from, d, id, time, ctx) => f(s as unknown as Parameters<typeof f>[0], from, d, id, time, ctx, blobBank(s))])), // files and NFTs (blobs.ts)
	...Object.fromEntries(Object.entries(EVM_HANDLERS).map(([k, f]): [string, Handler] => [k, (s, from, d, id, time, ctx) => f(s as unknown as Parameters<typeof f>[0], from, d, id, time, ctx, { ...bankOf(s), toFees: (n) => { s.sun!.feePot += n; }, carried: ctx.fee ?? 0, carrier: ctx.payer })])), // Solidity (evmledger.ts)
	...Object.fromEntries(Object.entries(ZONE_HANDLERS).map(([k, f]): [string, Handler] => [k, (s, from, d, id, time, ctx) => f(s, from, d, id, time, ctx, bankOf(s))])), // layers (zones.ts)
	...(SUN_HANDLERS as Record<string, Handler>), // lock, lock.ready, renew, ticket.answer (only on a chain with the Sun)
	/** send any asset to another account */
	transfer(s, from, d) {
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		const to = isAddr(d.to) ? d.to : fail('bad receiver');
		if (to === from) fail('you cannot send to yourself');
		if (d.memo !== undefined && (typeof d.memo !== 'string' || d.memo.length > RULES.memoMax)) fail('bad memo');
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		return () => { sub(s, from, asset, amount); add(s, to, asset, amount); };
	},
	/** pay up to batchMax people in one transaction, one fee for every 20 payments: cheap mass payments (payroll, rewards, refunds) */
	'transfer.many'(s, from, d) {
		const asset = assetOf(s, d.asset);
		const list = Array.isArray(d.to) && d.to.length >= 1 && d.to.length <= RULES.batchMax ? d.to : fail(`to is a list of 1 to ${RULES.batchMax} payments, each [address, amount]`);
		if (d.memo !== undefined && (typeof d.memo !== 'string' || d.memo.length > RULES.memoMax)) fail('bad memo');
		let total = 0;
		const pays: [string, number][] = list.map((p: unknown) => {
			if (!Array.isArray(p) || p.length !== 2) fail('each payment is [address, amount]');
			const [to, amt] = p as unknown[];
			if (!isAddr(to)) fail('bad receiver');
			if (to === from) fail('you cannot send to yourself');
			const amount = amountOf(amt);
			total += amount;
			if (!Number.isSafeInteger(total)) fail('that is more than the chain can count');
			return [to as string, amount];
		});
		if (balanceOf(s, from, asset) < total) fail('not enough balance');
		return () => { for (const [to, amount] of pays) { sub(s, from, asset, amount); add(s, to, asset, amount); } };
	},
	/** create new units: only the asset's issuer, and only when the asset allows it */
	mint(s, from, d, _id, time) {
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		const to = isAddr(d.to) ? d.to : fail('bad receiver');
		const a = s.assets[asset];
		if (a.issuer !== from) fail('only the issuer can mint');
		if (!a.mintable) fail('this asset has a fixed supply');
		if (a.minted + amount > (a.cap ?? RULES.maxSupply)) fail('supply limit reached');
		if (d.reason !== undefined && (typeof d.reason !== 'string' || d.reason.length > RULES.reasonMax)) fail('bad reason');
		if (asset !== NATIVE) {
			if (d.pool !== undefined) fail('only DZY comes from pools');
			return () => { a.supply += amount; a.minted += amount; add(s, to, asset, amount); };
		}
		// every DZY comes out of a named pool, within that pool's limit and timetable
		const pool = d.pool === undefined ? 'community' : own(POOLS, d.pool) ? d.pool : fail('no such pool');
		if (s.pools[pool] + amount > unlocked(POOLS[pool], elapsed(s, time))) fail(`the ${pool} pool has not unlocked that much yet`);
		return () => { a.supply += amount; a.minted += amount; s.pools[pool] += amount; add(s, to, asset, amount); };
	},
	/** destroy your own units */
	/** destroy your own units of a token. DZY is never destroyed: "burning" DZY gives it to the treasury. */
	burn(s, from, d) {
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		if (asset === NATIVE) return () => { sub(s, from, NATIVE, amount); toTreasury(s, amount); };
		if (s.assets[asset].nft) fail('burn an NFT with nft.burn: it gives back the DZY in it');
		if (s.assets[asset].backed) fail('points are cashed in, not burned: points.redeem gives their DZY back');
		return () => { sub(s, from, asset, amount); s.assets[asset].supply -= amount; };
	},
	/** make your own asset (a game currency, an item, a ticket). Costs a DZY charge, paid to the treasury. */
	'asset.create'(s, from, d, id) {
		const symbol = typeof d.symbol === 'string' && /^[A-Z0-9]{2,10}$/.test(d.symbol) ? d.symbol : fail('bad symbol');
		if (symbol === NATIVE) fail('that symbol is taken');
		const decimals = d.decimals === undefined ? 0 : typeof d.decimals === 'number' && Number.isSafeInteger(d.decimals) && d.decimals >= 0 && d.decimals <= RULES.maxDecimals ? d.decimals : fail('bad decimals');
		const name = typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= RULES.nameMax ? d.name : fail('bad name');
		const supply = typeof d.supply === 'number' && Number.isSafeInteger(d.supply) && d.supply >= 0 ? d.supply : fail('bad supply');
		const mintable = typeof d.mintable === 'boolean' ? d.mintable : fail('say whether more can be minted');
		if (!mintable && supply === 0) fail('a fixed asset needs a supply');
		// a creator may promise a limit: the most that can ever exist, enforced by the chain from then on
		const cap = d.cap === undefined ? undefined : typeof d.cap === 'number' && Number.isSafeInteger(d.cap) && d.cap > 0 && d.cap >= supply && mintable ? d.cap : fail('bad cap');
		const content = d.content === undefined ? undefined : typeof d.content === 'string' && /^[0-9a-f]{64}$/.test(d.content) ? d.content : fail('content must be the SHA-256 of the file: 64 hex digits');
		const link = d.link === undefined ? undefined : typeof d.link === 'string' && d.link.length <= 200 && /^(https|ipfs|ar):\/\/[\x21-\x7e]+$/.test(d.link) ? d.link : fail('bad link: https://, ipfs:// or ar://, at most 200 characters');
		const onCredit = !!s.sun && balanceOf(s, from, NATIVE) < RULES.assetFee && creditCovers(s, from, RULES.assetFee);
		if (!onCredit && balanceOf(s, from, NATIVE) < RULES.assetFee) fail(`creating an asset costs ${RULES.assetFee / DZY} DZY`);
		const key = 'a' + id.slice(0, 16);
		if (own(s.assets, key)) fail('asset already exists');
		return () => {
			if (onCredit) creditUse(s, from, RULES.assetFee); else { sub(s, from, NATIVE, RULES.assetFee); toTreasury(s, RULES.assetFee); }
			s.assets[key] = { symbol, name, issuer: from, supply, minted: supply, mintable, decimals, ...(cap === undefined ? {} : { cap }), ...(content === undefined ? {} : { content }), ...(link === undefined ? {} : { link }) };
			if (supply > 0) add(s, from, key, supply);
		};
	},
	/** Launch a coin in one step, as on pump.fun: a fixed supply (a billion, 6 decimals, unless given), all of it in its
	    own market from the first second, priced by a curve that starts from a virtual launchVirtual DZY. Each buy moves the
	    price up and each sell moves it down. Nobody holds a share of that market, so the DZY in it can never be pulled out
	    (no rug pull); its creator gets launchCreatorBps of every trade. Costs what making a token costs (starter credit too). */
	'token.launch'(s, from, d, id, time) {
		const symbol = typeof d.symbol === 'string' && /^[A-Z0-9]{2,10}$/.test(d.symbol) ? d.symbol : fail('bad symbol: 2 to 10 capital letters or digits');
		if (symbol === NATIVE) fail('that symbol is taken');
		const name = typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= RULES.nameMax ? d.name : fail('bad name');
		const decimals = d.decimals === undefined ? 6 : typeof d.decimals === 'number' && Number.isSafeInteger(d.decimals) && d.decimals >= 0 && d.decimals <= RULES.maxDecimals ? d.decimals : fail('bad decimals');
		const supply = d.supply === undefined ? 1_000_000_000 * 10 ** decimals : typeof d.supply === 'number' && Number.isSafeInteger(d.supply) && d.supply >= 1_000 ? d.supply : fail('bad supply (at least 1,000 units)');
		const link = d.link === undefined ? undefined : typeof d.link === 'string' && d.link.length <= 200 && /^(https|ipfs|ar):\/\/[\x21-\x7e]+$/.test(d.link) ? d.link : fail('bad link: https://, ipfs:// or ar://, at most 200 characters');
		const onCredit = !!s.sun && balanceOf(s, from, NATIVE) < RULES.assetFee && creditCovers(s, from, RULES.assetFee);
		if (!onCredit && balanceOf(s, from, NATIVE) < RULES.assetFee) fail(`launching costs ${RULES.assetFee / DZY} DZY`);
		const key = 'a' + id.slice(0, 16);
		if (own(s.assets, key)) fail('asset already exists');
		return () => {
			if (onCredit) creditUse(s, from, RULES.assetFee); else { sub(s, from, NATIVE, RULES.assetFee); toTreasury(s, RULES.assetFee); }
			s.assets[key] = { symbol, name, issuer: from, supply, minted: supply, mintable: false, decimals, ...(link === undefined ? {} : { link }) };
			(s.liquidity ??= {})[key] = { dzy: 0, token: supply, virt: RULES.launchVirtual, shares: 0, lp: {}, cum: '0', at: time, obs: [[time, '0']], born: time, launch: { creator: from } };
		};
	},
	/** Reward points with real value: each point is backed by `value` DZY shards that the chain holds, so whoever has
	    points can cash them in for DZY at that rate at any time (points.redeem), and the issuer can never take the
	    backing back. The issuer makes points only by paying their backing in (points.mint). Whole points (no decimals).
	    Costs what making a token costs (starter credit too). */
	'points.create'(s, from, d, id) {
		const symbol = typeof d.symbol === 'string' && /^[A-Z0-9]{2,10}$/.test(d.symbol) ? d.symbol : fail('bad symbol: 2 to 10 capital letters or digits');
		if (symbol === NATIVE) fail('that symbol is taken');
		const name = typeof d.name === 'string' && d.name.trim().length > 0 && d.name.length <= RULES.nameMax ? d.name : fail('bad name');
		const per = typeof d.value === 'number' && Number.isSafeInteger(d.value) && d.value >= 1 && d.value <= RULES.pointsMaxValue ? d.value : fail(`a point is worth 1 shard to ${RULES.pointsMaxValue / DZY} DZY`);
		const link = d.link === undefined ? undefined : typeof d.link === 'string' && d.link.length <= 200 && /^(https|ipfs|ar):\/\/[\x21-\x7e]+$/.test(d.link) ? d.link : fail('bad link: https://, ipfs:// or ar://, at most 200 characters');
		const onCredit = !!s.sun && balanceOf(s, from, NATIVE) < RULES.assetFee && creditCovers(s, from, RULES.assetFee);
		if (!onCredit && balanceOf(s, from, NATIVE) < RULES.assetFee) fail(`making points costs ${RULES.assetFee / DZY} DZY`);
		const key = 'a' + id.slice(0, 16);
		if (own(s.assets, key)) fail('asset already exists');
		return () => {
			if (onCredit) creditUse(s, from, RULES.assetFee); else { sub(s, from, NATIVE, RULES.assetFee); toTreasury(s, RULES.assetFee); }
			s.assets[key] = { symbol, name, issuer: from, supply: 0, minted: 0, mintable: false, decimals: 0, backed: { per, reserve: 0 }, ...(link === undefined ? {} : { link }) };
		};
	},
	/** the issuer makes `amount` points (to itself, or straight to `to`) by paying their backing in DZY */
	'points.mint'(s, from, d) {
		const asset = assetOf(s, d.asset), a = s.assets[asset], b = a.backed && !a.nft ? a.backed : fail('these are not points');
		if (a.issuer !== from) fail('only the issuer makes these points');
		const amount = amountOf(d.amount), to = d.to === undefined ? from : isAddr(d.to) ? d.to : fail('bad receiver');
		const cost = amount * b.per;
		if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(b.reserve + cost) || a.minted + amount > RULES.maxSupply) fail('too many points at once');
		if (balanceOf(s, from, NATIVE) < cost) fail(`${amount} points need ${cost / DZY} DZY behind them`);
		return () => { sub(s, from, NATIVE, cost); b.reserve += cost; a.supply += amount; a.minted += amount; add(s, to, asset, amount); };
	},
	/** anyone holding points cashes them in: the points are gone, and their backing comes back as DZY */
	'points.redeem'(s, from, d) {
		const asset = assetOf(s, d.asset), a = s.assets[asset], b = a.backed && !a.nft ? a.backed : fail('these are not points');
		const amount = amountOf(d.amount);
		if (balanceOf(s, from, asset) < amount) fail('not enough points');
		const pay = amount * b.per;
		if (pay > b.reserve) fail('the backing is short'); // cannot happen: reserve is always supply × per
		return () => { sub(s, from, asset, amount); a.supply -= amount; b.reserve -= pay; add(s, from, NATIVE, pay); };
	},
	/* ---- the exchange (EXCHANGE.md): DZY against BTC, ETH, SOL and USDC, held in vaults on their own chains ---- */
	/** a validator's reading of each coin's price (µ$ per whole coin), from its own price sources */
	'x.price'(s, from, d, _id, time) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		if (!mayVouch(s, from)) fail('only a validator posts prices');
		const p = d.p && typeof d.p === 'object' && !Array.isArray(d.p) ? d.p as Record<string, unknown> : fail('prices are { p: { BTC, ETH, SOL, USDC } } in millionths of a dollar');
		const out: Record<string, number> = {};
		for (const [c, v] of Object.entries(p)) {
			if (!xLive(s, c)) fail(`no coin ${c} on the exchange`);
			out[c] = typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail(`bad price for ${c}`);
		}
		return () => { (xOf(s).prices ??= {})[from] = { at: time, p: out }; };
	},
	/** a validator confirms a coin arrived in a vault, with the Dznye address it is for (from the payment's memo). Once
	    more than two thirds of the say agree on every detail: the coin is held, the address gets claims on exactly that
	    much, and DZY at today's rate from the sale. With no agreed price, past a limit, or with the sale over, it gets the
	    claims only, and may take its coin straight back (it is never stranded). */
	'x.deposit'(s, from, d, _id, time, ctx) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		if (!mayVouch(s, from)) fail('only a validator confirms a deposit');
		if (d.coin === 'wDZY') return wdzyIn(s, from, d, time); // DZY coming home from Solana
		const coin = typeof d.coin === 'string' && xLive(s, d.coin) ? d.coin : fail('no such coin on the exchange');
		const net = typeof d.net === 'string' && xLive(s, coin, d.net) ? d.net : fail(`${coin} is held on ${X_COINS[coin].nets.filter((n) => xLive(s, coin, n)).join(', ')}`);
		if (s.heart?.proof && net === 'btc') fail('a Bitcoin payment comes with its proof (x.prove): nobody\'s word counts');
		const amount = amountOf(d.amount), to = isAddr(d.to) ? d.to : fail('bad Dznye address');
		const tx = typeof d.tx === 'string' && d.tx.length >= 32 && d.tx.length <= 100 && /^[0-9A-Za-z]+$/.test(d.tx) ? d.tx : fail('bad payment id');
		const seen = `${net}:${tx}`;
		if (s.xseen && own(s.xseen, seen)) fail('that payment was already counted');
		if (s.xwaits && own(s.xwaits, seen)) fail('that payment is confirmed, and waits for anyone to object');
		const key = `${seen}:${coin}:${amount}:${to}`, c = s.xclaims && own(s.xclaims, key) ? s.xclaims[key] : null;
		if (c?.votes.includes(from)) fail('this validator already confirmed it');
		const votes = [...(c?.votes ?? []), from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
		if (said * 3 <= all * 2 || !vouched(s, votes)) return () => { (s.xclaims ??= {})[key] = { at: time, votes }; };
		const pay = { net, coin, amount, to, seen };
		if (s.heart?.proof) { // a little counts at once each day; the rest waits for anyone to object
			const price = xPrice(s, coin, time), usd = price === null ? Infinity : N((B(amount) * B(price)) / 10n ** B(X_COINS[coin].decimals));
			if (usd > instantLeft(s)) return () => { (s.xwaits ??= {})[seen] = { net, coin, amount, to, at: time, until: time + PROOF.wait, votes }; dropClaims(s, seen); };
			return () => { instantUse(s, usd); depositCounts(s, ctx.height, pay, time, time); };
		}
		return () => depositCounts(s, ctx.height, pay, time, time);
	},
	/** Any guardian (a key with 1 DZY staked and a day of seconds online) that cannot find a waiting payment on its chain stops
	    it, for everyone to look again. If it turns out to have been there, the guardian's seconds start again from nothing. */
	'x.doubt'(s, from, d, _id, time) {
		for (const k of Object.keys(d)) if (k !== 'id') fail(`"${k}" is not expected here`);
		const w = s.xwaits && own(s.xwaits, d.id) ? s.xwaits[d.id as string] : fail('no such payment waits');
		if (!isCandidate(s, from) || ownHours(s, from) < PROOF.guardian) fail('a guardian has 1 DZY staked and has been online for a day');
		if (w.by !== undefined) fail('it is being looked at again already');
		if (time > w.until) fail('too late: it may be counted now');
		return () => { w.by = from; w.until = time + PROOF.hold; };
	},
	/** An anchor throws out a waiting payment that was never made (if it was, it may be confirmed again). When a guardian had
	    objected, every other validator that said it saw it loses its seat for 30 days, all its raffle shards, and a tenth of its
	    stake: half to that guardian, half to the bonus drawn among the honest. (Not all of it: an honest one can be lied to by
	    the other chain's servers. What can be proven, signing two blocks, costs everything: evidence.) */
	'x.drop'(s, from, d, _id, time) {
		for (const k of Object.keys(d)) if (k !== 'id') fail(`"${k}" is not expected here`);
		if (!(s.xwaits && own(s.xwaits, d.id))) fail('no such payment waits');
		if (!vouchers(s).includes(from)) fail('only an original validator throws one out');
		const w = s.xwaits![d.id as string];
		return () => {
			delete s.xwaits![d.id as string]; if (emptyOf(s.xwaits!)) delete s.xwaits;
			if (w.by === undefined) return;
			for (const v of w.votes ?? []) {
				const st = !s.heart!.anchors.includes(v) && s.stakes && own(s.stakes, v) ? s.stakes[v] : null; if (!st || st.tomb) continue;
				const cut = mulDiv(st.bond, PROOF.liarBp, 10_000), half = Math.floor(cut / 2);
				st.bond -= cut; add(s, w.by, NATIVE, half); s.sun!.council.bonus += cut - half;
				st.jailed = Math.max(st.jailed ?? 0, time + PROOF.liarOut);
				if (s.nodes && own(s.nodes, v)) s.nodes[v] = { ...s.nodes[v], on: 0 };
			}
		};
	},
	/** the wait is over: it counts (anyone; the nodes send this by themselves) */
	'x.count'(s, _from, d, _id, time, ctx) {
		for (const k of Object.keys(d)) if (k !== 'id') fail(`"${k}" is not expected here`);
		const seen = s.xwaits && own(s.xwaits, d.id) ? (d.id as string) : fail('no such payment waits'), w = s.xwaits![seen];
		if (time <= w.until) fail('it still waits for anyone to object');
		if (w.block && !s.sun!.btc?.recent.some(([n, x]) => n === w.block![0] && x === w.block![1])) return () => { delete s.xwaits![seen]; if (emptyOf(s.xwaits!)) delete s.xwaits; }; // that block is not Bitcoin's any more: it was never paid (if it was, its real block proves it)
		return () => {
			delete s.xwaits![seen]; if (emptyOf(s.xwaits!)) delete s.xwaits;
			if (w.by !== undefined && s.nodes && own(s.nodes, w.by)) s.nodes[w.by] = { ...s.nodes[w.by], on: 0 };
			depositCounts(s, ctx.height, { net: w.net, coin: w.coin, amount: w.amount, to: w.to, seen }, time, w.at);
		};
	},
	/** A Bitcoin payment into the vault, with its whole proof: the transaction itself, the block header it is in (one the chain
	    holds, checked work and all: sun.btc), and the path between them. Anyone may hand it in; every node checks all of
	    it; nobody's word is needed. It pays the vault's address, and says whose it is in an OP_RETURN: "dzy:" + a Dznye address. */
	'x.prove'(s, _from, d, _id, time, ctx) {
		for (const k of Object.keys(d)) if (!['tx', 'header', 'height', 'path', 'pos'].includes(k)) fail(`"${k}" is not expected here`);
		if (!s.heart?.proof || !exchangeOn(s) || !xLive(s, 'BTC', 'btc')) fail('Bitcoin proofs are not open on this chain');
		const vault = btcAddress(exchangeVaults(s).btc) ?? fail('the chain has no Bitcoin vault yet');
		const btc = s.sun!.btc ?? fail('the chain holds no Bitcoin headers yet'), h = Number.isSafeInteger(d.height) ? (d.height as number) : fail('height: the Bitcoin block it is in');
		const hd = checkHeader(d.header, TEST_FLOOR.get(s.chain) ?? BTC_FLOOR) ?? fail('that is not a Bitcoin block header with real proof of work');
		if (!btc.recent.some(([n, hash]) => n === h && hash === hd.hash)) fail('that block is not one of the Bitcoin blocks the chain holds (about the last two days)');
		if (btc.height - h + 1 < PROOF.depth) fail(`that block is not under ${PROOF.depth} blocks yet: in about ${(PROOF.depth - (btc.height - h + 1)) * 10} minutes`);
		const path = Array.isArray(d.path) && d.path.length <= 24 && d.path.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) ? (d.path as string[]) : fail('path: the way from the payment to its block'), pos = Number.isSafeInteger(d.pos) && (d.pos as number) >= 0 && (d.pos as number) < 2 ** path.length ? (d.pos as number) : fail('pos: its place in the block');
		const tx = typeof d.tx === 'string' && d.tx.length <= RULES.maxBtcChars ? parseTx(d.tx) : null;
		if (!tx || tx.baseSize === 64) fail('tx: the payment itself, as Bitcoin has it'); // (a 64-byte "transaction" could be two inner hashes of the tree)
		if (merkleRootOf(tx!.txid, path, pos) !== hd.merkle) fail('that payment is not in that block');
		const script = vault!.script.join(), amount = tx!.outputs.filter((o) => o.script.join() === script).reduce((n, o) => n + o.value, 0);
		if (amount < PROOF.dust) fail('it does not pay the vault');
		const says = tx!.outputs.map((o) => opReturnData(o.script)).filter((x): x is Uint8Array => !!x).map((x) => String.fromCharCode(...x)).filter((x) => /^dzy:[0-9a-f]{64}$/.test(x));
		if (says.length !== 1) fail('it must say whose it is, once: "dzy:" and a Dznye address in an OP_RETURN');
		const seen = 'btc:' + tx!.txid; if (s.xseen && own(s.xseen, seen)) fail('that payment was already counted');
		if (s.xwaits && own(s.xwaits, seen)) fail('that payment is proven, and waits a little because it is big');
		// a very big one waits too, and its block must still be Bitcoin's then: worth more than making six false blocks would cost
		const price = xPrice(s, 'BTC', time), usd = price === null ? Infinity : N((B(amount) * B(price)) / 10n ** B(X_COINS.BTC.decimals));
		if (usd > PROOF.sure) return () => { (s.xwaits ??= {})[seen] = { net: 'btc', coin: 'BTC', amount, to: says[0].slice(4), at: time, until: time + PROOF.wait, block: [h, hd.hash] }; };
		return () => depositCounts(s, ctx.height, { net: 'btc', coin: 'BTC', amount, to: says[0].slice(4), seen }, time, time);
	},
	/** Take out free coin: give up `amount` of your free coin (claims) and get that coin, paid on `net` to `to`. Free coin
	    is coin parked on Dznye or bought on the order book: no DZY is owed for it. 0.1% goes to the pot. The payout is
	    recorded here; the vault pays it on proof of this block. */
	/** move your own DZY to Solana: the chain holds them, and the Solana vault pays you the same amount of wDZY */
	'wdzy.out'(s, from, d, id, time, ctx) {
		for (const k of Object.keys(d)) if (k !== 'amount' && k !== 'to') fail(`"${k}" is not expected here`);
		if (!wdzyOn(s, ctx.height)) fail('DZY on Solana is not open on this chain');
		if (!own(exchangeVaults(s), 'sol')) fail('the Solana vault is not listed yet');
		const amount = amountOf(d.amount), to = xPayTo('sol', d.to), held = s.wdzy?.held ?? 0;
		if (amount < WDZY.least) fail(`at least ${WDZY.least / DZY} DZY`);
		const cap = wdzyCap(s.chain); if (held + amount > cap) fail(`at most ${cap / DZY} DZY are on Solana for now: ${(cap - held) / DZY} more can go`);
		if (balanceOf(s, from, NATIVE) < amount) fail('not enough DZY');
		return () => {
			sub(s, from, NATIVE, amount); (s.wdzy ??= { held: 0 }).held += amount;
			(s.xpays ??= {})['p' + id.slice(0, 16)] = { h: ctx.height, at: time, by: from, coin: 'wDZY', net: 'sol', amount, to, dzy: amount };
		};
	},
	'x.sell'(s, from, d, id, time, ctx) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		const coin = xCoinOf(s, d.coin), net = xNetOf(s, coin, d.net), to = xPayTo(net, d.to), amount = amountOf(d.amount);
		if (balanceOf(s, from, 'x' + coin) < amount) fail(`you hold less free ${coin} than that (claims on less ${coin})`);
		const keep = xFee(amount), pay = amount - keep, held = `${net}:${coin}`;
		if (pay <= 0) fail('too small to pay out');
		if ((s.x?.vaults[held] ?? 0) < pay) fail(`the ${net} vault holds less ${coin} than that: choose another network`);
		return () => {
			const x = xOf(s);
			sub(s, from, 'x' + coin, amount); claimAsset(s, coin).supply -= amount;
			potAdd(s, coin, coinFee(s, coin, keep)); x.vaults[held] -= pay;
			(s.xpays ??= {})['p' + id.slice(0, 16)] = { h: ctx.height, at: time, by: from, coin, net, amount: pay, to, dzy: 0 };
		};
	},
	/** Close your lock (only its owner can): return `dzy` DZY (by default what the whole lock costs today) and get the coin
	    they buy at today's prices, never more than the lock. Coin cheaper than when bought: fewer DZY get the whole lock
	    back, and you keep the rest of your DZY. Coin dearer: you get what your DZY buy, and the rest of the lock goes to
	    the pot (or, with `keep`, stays locked for later). Paid on `net` to `to`, or to "wallet": as free coin on Dznye.
	    0.1% of what is paid goes to the pot; the DZY go back to the sale, never burned. */
	'x.close'(s, from, d, id, time, ctx) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		const coin = xCoinOf(s, d.coin), lk = `${from}:${coin}`, lock = lockAt(s, lk);
		if (!lock) fail(`you have no ${coin} locked`);
		const wallet = d.to === 'wallet', net = wallet ? null : xNetOf(s, coin, d.net), to = wallet ? from : xPayTo(net!, d.to);
		if (d.keep !== undefined && typeof d.keep !== 'boolean') fail('keep: true or false');
		const price = xPrice(s, coin, time) ?? fail(`no agreed ${coin} price right now: try again later`);
		const cfg = curveOf(s), spot = salePrice(cfg, B(s.sun!.sold)), one = 10n ** B(X_COINS[coin].decimals), sold = B(s.sun!.sold), curve = closeOnCurve(s, ctx.height);
		// DZY the whole lock costs today, rounded up: the stretch of the sale curve, from here down, that is worth the lock's dollars
		// (before: all of it at the price at the top, which let a round trip keep DZY for nothing; see closeOnCurve)
		const whole = curve ? N(saleBackFor(cfg, sold, (B(lock) * B(price) + one - 1n) / one)) : N((B(lock) * B(price) * B(DZY) + one * spot - 1n) / (one * spot));
		const offered = d.dzy === undefined ? whole : amountOf(d.dzy);
		const back = Math.min(offered, whole);
		if (balanceOf(s, from, NATIVE) < back) fail(`you hold less DZY than that (the whole lock costs ${whole / DZY} DZY today)`);
		if (back > s.sun!.sold) fail('more than the sale has sold');
		const worth = curve ? ((saleCost(cfg, sold - B(back), sold) - 1n) * one) / B(price) : (B(back) * spot * one) / (B(DZY) * B(price)); // rounded down
		const buys = back === whole ? lock : Math.min(lock, worth > 0n ? N(worth) : 0);
		const rest = lock - buys, fee = xFee(buys), out = buys - fee, held = net ? `${net}:${coin}` : '';
		if (out <= 0) fail('too small to pay out');
		if (net && (s.x?.vaults[held] ?? 0) < out) fail(`the ${net} vault holds less ${coin} than that: choose another network`);
		return () => {
			const x = xOf(s);
			if (d.keep && rest) locksOfX(s)![lk] = rest; else { delete locksOfX(s)![lk]; potAdd(s, coin, rest); }
			sub(s, from, NATIVE, back); s.sun!.salePot += back; s.sun!.sold -= back;
			potAdd(s, coin, coinFee(s, coin, fee));
			if (wallet) { claimAsset(s, coin).supply += out; claimAsset(s, coin).minted += out; add(s, from, 'x' + coin, out); }
			else { x.vaults[held] -= out; (s.xpays ??= {})['p' + id.slice(0, 16)] = { h: ctx.height, at: time, by: from, coin, net: net!, amount: out, to, dzy: back }; }
		};
	},
	/** Park: from now on, coin you deposit stays free coin on Dznye (to trade on the order book or take out) instead of
	    buying DZY. `on: false` goes back to buying. */
	'x.park'(s, from, d) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		if (typeof d.on !== 'boolean') fail('on: true or false');
		return () => {
			if (s.heart) { if (d.on) (s.xparks ??= {})[from] = 1; else if (s.xparks) { delete s.xparks[from]; if (emptyOf(s.xparks)) delete s.xparks; } return; }
			const x = xOf(s); if (d.on) (x.park ??= {})[from] = 1; else if (x.park) { delete x.park[from]; if (!Object.keys(x.park).length) delete x.park; }
		};
	},
	/** Give free coin to the reserve, for nothing back: it backs the unbacked DZY first (the fee account backs early DZY this
	    way), then lifts the price for everyone. Only from the index's block; it leaves only as DZY sold at the index price. */
	'reserve.give'(s, from, d, _id, _time, ctx) {
		if (!s.heart || ctx.height < indexFrom(s.chain)) fail('The reserve takes gifts from block ' + indexFrom(s.chain).toLocaleString('en-US') + '. Try again then.');
		const coin = xCoinOf(s, d.coin), amount = amountOf(d.amount);
		if (balanceOf(s, from, 'x' + coin) < amount) fail(`you hold less free ${coin} than that`);
		return () => {
			const price = xPrice(s, coin, s.time), n = indexOn(s) ? indexNav(s, s.time) : null;
			if (n && price) wash(s, n, (B(amount) * B(price)) / 10n ** B(X_COINS[coin].decimals), 10_000n); // the unbacked first
			sub(s, from, 'x' + coin, amount); s.assets['x' + coin].supply -= amount; potAdd(s, coin, amount);
		};
	},
	/** Validators vote a coin out of the reserve ('out'), count it as nothing ('zero'), or undo either ('back'): for a hack
	    or a coin shut down. More than two thirds of the say decide. It never sends a coin to anyone. */
	'reserve.retire'(s, from, d, _id, _time, ctx) {
		if (!s.heart || ctx.height < indexFrom(s.chain)) fail('Reserve votes open at block ' + indexFrom(s.chain).toLocaleString('en-US') + '.');
		if (!mayVouch(s, from)) fail('only validators decide which coins the reserve holds');
		const coin = xCoinOf(s, d.coin), mode = d.mode === 'out' || d.mode === 'zero' || d.mode === 'back' ? d.mode : fail("mode: 'out', 'zero' or 'back'");
		const key = `${coin}:${mode}`, was = s.x?.rvotes && own(s.x.rvotes, key) ? s.x.rvotes[key] : [];
		if (was.includes(from)) fail('this validator already voted for that');
		const votes = [...was, from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0), passes = said * 3 > all * 2 && vouched(s, votes);
		return () => {
			const x = xOf(s);
			if (!passes) { (x.rvotes ??= {})[key] = votes; return; }
			if (x.rvotes) { for (const m of ['out', 'zero', 'back']) delete x.rvotes[`${coin}:${m}`]; if (emptyOf(x.rvotes)) delete x.rvotes; }
			if (mode === 'back') { if (x.retired) { delete x.retired[coin]; if (emptyOf(x.retired)) delete x.retired; } }
			else (x.retired ??= {})[coin] = mode;
		};
	},
	/** Swap good coin into the reserve for a coin voted out ('out'): worth the same at the agreed prices, plus 0.5% */
	'reserve.swap'(s, from, d, _id, time) {
		if (!indexOn(s)) fail('Reserve swaps open once DZY has its reserve price.');
		const want = xCoinOf(s, d.want);
		if (retiredOf(s, want) !== 'out') fail(`${want} is not leaving the reserve`);
		const give = typeof d.give === 'string' && isXClaim(s, d.give) ? d.give.slice(1) : fail('give free coin the reserve takes (xUSDT, xUSDC, …)');
		if (retiredOf(s, give)) fail(`${give} is leaving the reserve too: give another coin`);
		const amount = amountOf(d.amount);
		if (balanceOf(s, from, 'x' + give) < amount) fail(`you hold less free ${give} than that`);
		const pg = xPrice(s, give, time), pw = xPrice(s, want, time);
		if (!pg || !pw) fail('no agreed price for both coins right now: try again later');
		const usd = (B(amount) * B(pg)) / 10n ** B(X_COINS[give].decimals);
		const pay = N((usd * B(10_000n + RETIRE_BONUS_BP) * 10n ** B(X_COINS[want].decimals)) / (10_000n * B(pw))), pot = s.x?.pot?.[want] ?? 0;
		if (pay <= 0) fail('too small');
		if (pay > pot) fail(`the reserve holds ${pot} of ${want}: give less`);
		if (isAmount(d.min) && pay < Number(d.min)) fail('the price moved: you would get less than your minimum');
		return () => {
			sub(s, from, 'x' + give, amount); s.assets['x' + give].supply -= amount; potAdd(s, give, amount);
			xOf(s).pot![want] -= pay; claimAsset(s, want).supply += pay; claimAsset(s, want).minted += pay; add(s, from, 'x' + want, pay);
		};
	},
	/** Sell DZY to the pot at the floor: the pot's value over the DZY in people's hands, never more. Paid as free coin on
	    Dznye (take it out with x.sell). The DZY go back to the sale, so the floor never falls from it. */
	'x.floor'(s, from, d, _id, time) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		const coin = xCoinOf(s, d.coin), dzy = amountOf(d.dzy), potHas = s.x?.pot?.[coin] ?? 0;
		if (!potHas) fail(`there is no ${coin} in the pot`);
		if (balanceOf(s, from, NATIVE) < dzy) fail('you hold less DZY than that');
		if (dzy > s.sun!.sold) fail('more than the sale has sold');
		if (indexWaiting(s)) fail('Selling to the reserve opens in a moment. Try again shortly.');
		if (indexOn(s)) { // the index: the same price as a swap, no daily limit
			const q = indexSale(s, coin, dzy, time) ?? fail('no agreed price for every coin in the reserve right now: try again later');
			if (q.pay > potHas) fail(`the reserve holds less ${coin} than that: choose another coin or sell less`);
			return () => { const n = indexNav(s, time); if (n) wash(s, n, B(q.fee), WASH_BP); sub(s, from, NATIVE, dzy); s.sun!.salePot += dzy; s.sun!.sold -= dzy; xOf(s).pot![coin] -= q.pay; claimAsset(s, coin).supply += q.pay; claimAsset(s, coin).minted += q.pay; add(s, from, 'x' + coin, q.pay); };
		}
		const f = xFloor(s, time) ?? fail('no agreed price for every coin in the pot right now: try again later');
		const price = xPrice(s, coin, time)!, one = 10n ** B(X_COINS[coin].decimals);
		const gross = N((B(dzy) * f.usd * one) / (f.hands * B(price))); // rounded down: never above the floor
		if (gross <= 0) fail('too small to pay');
		const t = takeBacking(s, coin, potHas, gross), pay = t.pay;
		if (pay > potHas) fail(`the pot holds less ${coin} than that: choose another coin or sell less`);
		return () => {
			t.done(); sub(s, from, NATIVE, dzy); s.sun!.salePot += dzy; s.sun!.sold -= dzy;
			xOf(s).pot![coin] -= pay; claimAsset(s, coin).supply += pay; claimAsset(s, coin).minted += pay; add(s, from, 'x' + coin, pay);
		};
	},
	/** Borrow Dznye dollars: lock `coll` of your free `coin` in a new loan and get `dusd` DUSD (millionths of a dollar), at
	    most 2/3 of the coin's value. Interest (5% a year) and 0.1% on borrowing are taken from the coin when it closes, to the pot. */
	'loan.open'(s, from, d, id, time) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		const coin = xCoinOf(s, d.coin), coll = amountOf(d.coll), dusd = amountOf(d.dusd);
		if (balanceOf(s, from, 'x' + coin) < coll) fail(`you hold less free ${coin} than that`);
		const price = xPrice(s, coin, time) ?? fail(`no agreed ${coin} price right now: try again later`);
		const max = loanMax(coin, coll, price);
		if (dusd > max) fail(`that much ${coin} lends at most ${dusdText(max)} DUSD`);
		const key = 'l' + id.slice(0, 16);
		if (loansOfX(s) && own(loansOfX(s)!, key)) fail('loan already exists');
		return () => {
			sub(s, from, 'x' + coin, coll);
			(s.heart ? (s.xloans ??= {}) : (xOf(s).loans ??= {}))[key] = { owner: from, coin, coll, debt: dusd, fee: Math.ceil((dusd * RULES.loanOpenBps) / 10_000), at: time };
			const a = dusdAsset(s); a.supply += dusd; a.minted += dusd; add(s, from, 'DUSD', dusd);
		};
	},
	/** borrow more on your loan, keeping it above 150% */
	'loan.borrow'(s, from, d, _id, time) {
		const id = d.id as string, l = loanOf(s, d.id), dusd = amountOf(d.dusd);
		if (l.owner !== from) fail('not your loan');
		const price = xPrice(s, l.coin, time) ?? fail(`no agreed ${l.coin} price right now: try again later`);
		const max = loanMax(l.coin, l.coll, price);
		if (l.debt + dusd > max) fail(`this loan can borrow at most ${dusdText(Math.max(0, max - l.debt))} DUSD more`);
		return () => {
			const x = loansOfX(s)![id]; x.fee = loanFee(x, time) + Math.ceil((dusd * RULES.loanOpenBps) / 10_000); x.at = time; x.debt += dusd;
			const a = dusdAsset(s); a.supply += dusd; a.minted += dusd; add(s, from, 'DUSD', dusd);
		};
	},
	/** pay back DUSD on a loan (anyone may, for anyone's loan); the DUSD paid back stop existing, as the debt does */
	'loan.repay'(s, from, d, _id, time) {
		const id = d.id as string, l = loanOf(s, d.id), dusd = amountOf(d.dusd);
		if (dusd > l.debt) fail(`the loan owes less than that: ${dusdText(l.debt)} DUSD`);
		if (balanceOf(s, from, 'DUSD') < dusd) fail('you hold less DUSD than that');
		return () => { const x = loansOfX(s)![id]; x.fee = loanFee(x, time); x.at = time; x.debt -= dusd; sub(s, from, 'DUSD', dusd); s.assets.DUSD.supply -= dusd; };
	},
	/** add free coin to your loan */
	'loan.add'(s, from, d, _id, time) {
		const id = d.id as string, l = loanOf(s, d.id), coll = amountOf(d.coll);
		if (l.owner !== from) fail('not your loan');
		if (balanceOf(s, from, 'x' + l.coin) < coll) fail(`you hold less free ${l.coin} than that`);
		return () => { const x = loansOfX(s)![id]; x.fee = loanFee(x, time); x.at = time; sub(s, from, 'x' + l.coin, coll); x.coll += coll; };
	},
	/** take coin out of your loan, keeping it above 150% */
	'loan.withdraw'(s, from, d, _id, time) {
		const id = d.id as string, l = loanOf(s, d.id), coll = amountOf(d.coll);
		if (l.owner !== from) fail('not your loan');
		if (coll >= l.coll) fail('that is all of its coin: repay it and close it instead');
		const price = xPrice(s, l.coin, time) ?? fail(`no agreed ${l.coin} price right now: try again later`);
		if (l.debt > loanMax(l.coin, l.coll - coll, price)) fail('that would leave the loan below 150%');
		return () => { const x = loansOfX(s)![id]; x.fee = loanFee(x, time); x.at = time; x.coll -= coll; add(s, from, 'x' + l.coin, coll); };
	},
	/** close your loan once it owes no DUSD: its fee is taken from its coin to the pot, and the rest is yours as free coin */
	'loan.close'(s, from, d, _id, time) {
		const id = d.id as string, l = loanOf(s, d.id);
		if (l.owner !== from) fail('not your loan');
		if (l.debt) fail(`the loan still owes ${dusdText(l.debt)} DUSD: repay it first`);
		const fee = loanFee(l, time), price = fee ? xPrice(s, l.coin, time) ?? fail(`no agreed ${l.coin} price right now: try again later`) : null;
		return () => loanSettle(s, id, fee, price, from);
	},
	/** Close someone's loan worth less than 120% of what it owes: pay its whole debt in DUSD and get its coin worth the debt
	    plus 5%; its fee goes to the pot and the rest back to its owner. This keeps every DUSD backed. */
	'loan.liquidate'(s, from, d, _id, time) {
		const id = d.id as string, l = loanOf(s, d.id);
		const price = xPrice(s, l.coin, time) ?? fail(`no agreed ${l.coin} price right now: try again later`);
		const fee = loanFee(l, time), value = collUsd(l.coin, l.coll, price);
		if (value * 10_000n >= B(l.debt + fee) * B(RULES.loanLiqBps)) fail('the loan is healthy (worth 120% or more of what it owes)');
		if (balanceOf(s, from, 'DUSD') < l.debt) fail(`closing it pays its debt: ${dusdText(l.debt)} DUSD`);
		const prize = Math.min(l.coll, coinFor(l.coin, (B(l.debt) * B(10_000 + RULES.loanBonusBps)) / 10_000n, price, false));
		return () => {
			sub(s, from, 'DUSD', l.debt); s.assets.DUSD.supply -= l.debt;
			const x = loansOfX(s)![id]; x.coll -= prize; x.debt = 0; add(s, from, 'x' + l.coin, prize);
			loanSettle(s, id, fee, price, l.owner);
		};
	},
	/* ---- prediction markets: yes/no questions, every share backed by 1 DZY, settled by the validators ---- */
	/** Ask a yes/no question that closes at `until` (it costs RULES.marketFee, to the Sun). Its shares are two tokens:
	    <id>Y (YES) and <id>N (NO), each paying 1 DZY if it wins. */
	'market.create'(s, from, d, id, time) {
		const question = typeof d.question === 'string' && d.question.trim().length >= 5 && d.question.length <= 300 ? d.question.trim() : fail('a question of 5 to 300 characters');
		const until = Number.isSafeInteger(d.until) && (d.until as number) > time ? (d.until as number) <= time + RULES.maxOfferTime ? (d.until as number) : fail('a market must close within a year') : fail('a market must close in the future');
		if (balanceOf(s, from, NATIVE) < RULES.marketFee) fail(`asking a question costs ${RULES.marketFee / DZY} DZY`);
		const key = 'p' + id.slice(0, 16);
		if (s.markets && own(s.markets, key)) fail('market already exists');
		return () => {
			sub(s, from, NATIVE, RULES.marketFee); toTreasury(s, RULES.marketFee);
			(s.markets ??= {})[key] = { maker: from, question, until, pool: 0 };
			for (const [k, sym] of [['Y', 'YES'], ['N', 'NO']]) s.assets[key + k] = { symbol: sym, name: `${sym}: ${question}`.slice(0, 120), issuer: '0'.repeat(64), supply: 0, minted: 0, mintable: false, decimals: 8 };
		};
	},
	/** before it closes: `amount` DZY makes `amount` YES and `amount` NO */
	'market.mint'(s, from, d, _id, time) {
		const id = d.id as string, m = marketOf(s, d.id), amount = amountOf(d.amount);
		if (time >= m.until) fail('this market has closed');
		if (balanceOf(s, from, NATIVE) < amount) fail('not enough DZY');
		return () => { sub(s, from, NATIVE, amount); m.pool += amount; for (const k of ['Y', 'N']) { const a = s.assets[id + k]; a.supply += amount; a.minted += amount; add(s, from, id + k, amount); } };
	},
	/** before it settles: `amount` YES and `amount` NO make `amount` DZY back */
	'market.merge'(s, from, d) {
		const id = d.id as string, m = marketOf(s, d.id), amount = amountOf(d.amount);
		if (m.outcome) fail('this market is settled: collect instead');
		if (balanceOf(s, from, id + 'Y') < amount || balanceOf(s, from, id + 'N') < amount) fail('you hold less than that of YES or of NO');
		return () => { for (const k of ['Y', 'N']) { sub(s, from, id + k, amount); s.assets[id + k].supply -= amount; } m.pool -= amount; add(s, from, NATIVE, amount); };
	},
	/** after it closes, validators say what happened: YES, NO, or VOID (the question could not be answered). It counts once
	    validators with more than two thirds of the say agree. */
	'market.settle'(s, from, d, _id, time) {
		const m = marketOf(s, d.id);
		if (!mayVouch(s, from)) fail('only validators settle a market');
		if (m.outcome) fail('this market is already settled');
		if (time < m.until) fail('this market is still open');
		const outcome = d.outcome === 'YES' || d.outcome === 'NO' || d.outcome === 'VOID' ? d.outcome : fail('the outcome is YES, NO or VOID');
		if (Object.values(m.votes ?? {}).some((v) => v.includes(from))) fail('this validator already voted');
		const votes = [...(m.votes?.[outcome] ?? []), from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
		return () => { if (said * 3 > all * 2 && vouched(s, votes)) { m.outcome = outcome; delete m.votes; } else (m.votes ??= {})[outcome] = votes; };
	},
	/** after it settles: your winning shares pay 1 DZY each (VOID: every share half), less 1% to the Sun and 0.5% to the maker */
	'market.redeem'(s, from, d) {
		const id = d.id as string, m = marketOf(s, d.id);
		if (!m.outcome) fail('this market is not settled yet');
		const y = balanceOf(s, from, id + 'Y'), n = balanceOf(s, from, id + 'N');
		const burnY = m.outcome === 'NO' ? 0 : y, burnN = m.outcome === 'YES' ? 0 : n;
		const gross = m.outcome === 'YES' ? y : m.outcome === 'NO' ? n : Math.floor((y + n) / 2);
		if (!gross) fail('you hold no winning shares in this market');
		const sun = Math.min(gross, Math.ceil((gross * RULES.marketSunBps) / 10_000)), mk = Math.min(gross - sun, Math.ceil((gross * RULES.marketMakerBps) / 10_000));
		return () => {
			if (burnY) { sub(s, from, id + 'Y', burnY); s.assets[id + 'Y'].supply -= burnY; }
			if (burnN) { sub(s, from, id + 'N', burnN); s.assets[id + 'N'].supply -= burnN; }
			m.pool -= gross; toTreasury(s, sun); if (mk) add(s, m.maker, NATIVE, mk); add(s, from, NATIVE, gross - sun - mk);
		};
	},
	/* ---- Up or Down: price rounds, an hour or a day, settled by the chain's own agreed prices; no house money ---- */
	/** bet `amount` DZY that `coin` ends the NEXT round of `period` up (or down) from where it starts */
	'round.bet'(s, from, d, _id, time) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		const coin = roundCoin(d.coin), period = roundPeriod(d.period);
		const side = d.side === 'up' || d.side === 'down' ? d.side : fail('side is up or down');
		const amount = amountOf(d.amount);
		if (amount < RULES.roundMin) fail(`a bet is at least ${RULES.roundMin / DZY} DZY`);
		if (balanceOf(s, from, NATIVE) < amount) fail('not enough DZY');
		const start = (Math.floor(time / period) + 1) * period, key = `${coin}:${period}:${start}`;
		return () => {
			const r = ((s.rounds ??= {})[key] ??= { up: 0, down: 0, left: 0, bets: {} });
			sub(s, from, NATIVE, amount); r[side] += amount; r.left += amount;
			const b = (r.bets[from] ??= { up: 0, down: 0 }); b[side] += amount;
		};
	},
	/** record a round's start price (in the 10 minutes after it starts) or end price (in the 10 minutes after it ends),
	    from the chain's agreed price at that moment. Anyone may; the validators' nodes do it by themselves. */
	'round.mark'(s, from, d, _id, time) {
		const { key, r, start, end } = roundOf(s, d);
		const w = RULES.roundWindow, opening = !r.open && time >= start && time < start + w, closing = !!r.open && !r.close && time >= end && time < end + w;
		if (!opening && !closing) fail('not now: a start price is marked in the 10 minutes after the start, an end price in the 10 minutes after the end');
		const price = xPrice(s, roundCoin(key.split(':')[0]), time) ?? fail('no agreed price right now');
		return () => { if (opening) r.open = price; else r.close = price; };
	},
	/** collect: the winners split the whole round in proportion to their stakes, less 2% to the Sun; a round with a
	    missing price, a tie, or nobody on one side gives every stake back */
	'round.claim'(s, from, d, _id, time) {
		const { key, r, end } = roundOf(s, d), w = RULES.roundWindow;
		if (time < end) fail('this round is not over yet');
		if (r.open && !r.close && time < end + w) fail('waiting for its end price');
		const b = r.bets[from] ?? fail('you have nothing to collect in this round');
		const win = !r.open || !r.close || r.close === r.open ? null : r.close > r.open ? 'up' : 'down';
		const settled = win && r[win] > 0 && r[win === 'up' ? 'down' : 'up'] > 0 ? win : null;
		let pay = 0, fee = 0;
		if (!settled) pay = b.up + b.down;
		else {
			if (!b[settled]) fail('this bet lost');
			const gross = N((B(b[settled]) * B(r.up + r.down)) / B(r[settled]));
			fee = Math.min(gross, Math.ceil((gross * RULES.roundFeeBps) / 10_000)); pay = gross - fee;
		}
		if (pay + fee > r.left) fail('this round holds less than that'); // cannot happen: shares never sum past the pool
		return () => {
			delete r.bets[from]; r.left -= pay + fee;
			if (pay) add(s, from, NATIVE, pay);
			if (fee) toTreasury(s, fee);
			const anyLeft = Object.values(r.bets).some((x) => (settled ? x[settled] > 0 : x.up + x.down > 0));
			if (!anyLeft) { if (r.left) toTreasury(s, r.left); delete s.rounds![key]; if (emptyOf(s.rounds!)) delete s.rounds; } // rounding dust to the Sun
		};
	},
	/** List a vault on a network (validators only; it counts once more than two thirds of the say agree on the same vault).
	    Each validator's node checks the contract on its own chain before it agrees (POST /exchange/list). A network's vault
	    is listed once and cannot be swapped for another. */
	'x.vault'(s, from, d, _id, time) {
		if (!exchangeOn(s)) fail('the exchange is not open on this chain');
		if (!mayVouch(s, from)) fail('only a validator lists a vault');
		const net = typeof d.net === 'string' && Object.keys(X_COINS).some((c) => xLive(s, c, d.net as string)) ? d.net : fail('no such network on the exchange');
		const address = typeof d.address === 'string' && (net === 'sol' ? X_ADDRESS.sol : net === 'btc' ? X_ADDRESS.btc : X_ADDRESS.evm).test(d.address) ? d.address : fail(`bad vault address on ${net}`);
		const block = d.from === undefined ? undefined : Number.isSafeInteger(d.from) && d.from >= 0 ? d.from : fail('bad block');
		if (own(vaultList(s), net)) fail('a vault is already listed on that network');
		const key = `vault:${net}:${address}:${block ?? ''}`, c = s.xclaims && own(s.xclaims, key) ? s.xclaims[key] : null;
		if (c?.votes.includes(from)) fail('this validator already agreed');
		const votes = [...(c?.votes ?? []), from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
		if (said * 3 <= all * 2 || !vouched(s, votes)) return () => { (s.xclaims ??= {})[key] = { at: time, votes }; };
		return () => { (xOf(s).listed ??= {})[net] = block === undefined ? address : `${address}@${block}`; if (s.xclaims && own(s.xclaims, key)) delete s.xclaims[key]; };
	},
	/** a validator records that a vault paid a payout (with the payment's id on that chain), so everyone can see it done */
	'x.done'(s, from, d) {
		if (!s.validators.includes(from)) fail('only a validator records a payout');
		const p = s.xpays && typeof d.id === 'string' && own(s.xpays, d.id) ? s.xpays[d.id] : fail('no such payout');
		if (p.tx) fail('already paid');
		const tx = typeof d.tx === 'string' && d.tx.length >= 32 && d.tx.length <= 100 && /^[0-9A-Za-z]+$/.test(d.tx) ? d.tx : fail('bad payment id');
		return () => { s.xpays![d.id] = { ...p, tx }; };
	},
	/** offer to swap: "I give this, I want that". What you give is held by the chain until taken or cancelled. */
	'offer.create'(s, from, d, id, time) {
		const give = sideOf(s, d.give), want = sideOf(s, d.want);
		if (give.asset === want.asset) fail('an offer needs two different assets');
		if (balanceOf(s, from, give.asset) < give.amount) fail('not enough balance');
		// an optional end: after it nobody can take the offer
		const until = d.until === undefined ? undefined : Number.isSafeInteger(d.until) && (d.until as number) > time && (d.until as number) <= time + RULES.maxOfferTime ? (d.until as number) : fail('an offer\'s end must be in the future, and within a year');
		const key = 'o' + id.slice(0, 16);
		if (own(s.offers, key)) fail('offer already exists');
		if (d.fill !== undefined && typeof d.fill !== 'boolean') fail('fill: true or false');
		if (!d.fill) return () => { sub(s, from, give.asset, give.amount); s.offers[key] = { maker: from, give, want, ...(until === undefined ? {} : { until }) }; bookAdd(s, key, time); };
		// fill: first trade with the offers on the other side that meet this price (each at its maker's own price, which is
		// as good or better), then leave the rest open at this offer's price
		const fills: Fill[] = [];
		let left = give.amount, wantLeft = want.amount;
		for (const k of bookFor(s, give.asset, want.asset, from, time)) {
			const o = s.offers[k];
			if (fills.length >= RULES.maxFills || left <= 0 || wantLeft <= 0) break;
			if (B(o.want.amount) * B(want.amount) > B(give.amount) * B(o.give.amount)) break; // dearer than this offer's price: stop
			const f = partFill(o, Math.min(left, N((B(wantLeft) * B(o.want.amount) + B(o.give.amount) - 1n) / B(o.give.amount))));
			if (!f) break;
			fills.push({ key: k, ...f }); left -= f.pay; wantLeft -= f.take;
		}
		const restWant = left > 0 && wantLeft > 0 ? N((B(left) * B(want.amount) + B(give.amount) - 1n) / B(give.amount)) : 0;
		return () => {
			for (const f of fills) fillOffer(s, f.key, from, f.take, f.pay, height_(s), time);
			if (left > 0 && restWant > 0) { sub(s, from, give.asset, left); s.offers[key] = { maker: from, give: { asset: give.asset, amount: left }, want: { asset: want.asset, amount: restWant }, ...(until === undefined ? {} : { until }) }; bookAdd(s, key, time); }
		};
	},
	/** Accept an offer, all of it or part: both sides move in one step, or nothing moves. `amount` (optional) is how much
	    of what the offer gives you take; you pay the same price, rounded up in the maker's favour by at most one part. */
	'offer.take'(s, from, d, _id, time, ctx) {
		const key = own(s.offers, d.id) ? d.id : fail('no such offer');
		const o = s.offers[key];
		if (o.maker === from) fail('you cannot take your own offer');
		if (o.until !== undefined && time > o.until) fail('this offer has ended');
		const take = d.amount === undefined ? o.give.amount : isAmount(d.amount) && d.amount <= o.give.amount ? d.amount : fail('take an amount above zero, at most what the offer gives');
		const pay = take === o.give.amount ? o.want.amount : Number((BigInt(take) * BigInt(o.want.amount) + BigInt(o.give.amount) - 1n) / BigInt(o.give.amount));
		if (take < o.give.amount && pay >= o.want.amount) fail('that part is too small to price: take all of it');
		if (balanceOf(s, from, o.want.asset) < pay) fail('not enough balance');
		return () => fillOffer(s, key, from, take, pay, ctx.height, time);
	},
	/** Swap in one step, at the best price there is: give `amount` of `give`, get at least `min` of `want`. Fills the open
	    offers for that pair cheapest first, each only while it beats the pool for that part, then sends what is left
	    through the pool (straight, or token → DZY → token). Each maker gets exactly their own price; all of it happens,
	    or none. Nobody takes a cut but the pool's own and the exchange's 0.05% on vault coin, which goes to the pot. */
	'swap'(s, from, d, _id, time, ctx) {
		const give = assetOf(s, d.give), want = assetOf(s, d.want);
		if (give === want) fail('that is the same asset');
		const amount = amountOf(d.amount), min = amountOf(d.min);
		if (balanceOf(s, from, give) < amount) fail('not enough balance');
		const plan = swapPlan(s, from, give, want, amount, time);
		if (!plan.fills.length && !plan.pool) fail('nothing to trade against: no offers and no pool for this pair');
		if (plan.out < min) fail('the price moved: you would get less than your minimum');
		return () => { for (const f of plan.fills) fillOffer(s, f.key, from, f.take, f.pay, ctx.height, time); plan.pool?.run(from, ctx.height, time); };
	},
	/** take back your own open offer; once an offer has ended, anyone may close it (what is left goes back to its maker) */
	'offer.cancel'(s, from, d, _id, time) {
		const key = own(s.offers, d.id) ? d.id : fail('no such offer');
		const o = s.offers[key];
		if (o.maker !== from && !(o.until !== undefined && time > o.until)) fail('only the maker can cancel');
		return () => { add(s, o.maker, o.give.asset, o.give.amount); bookDrop(s, o, key); delete s.offers[key]; };
	},

	/* ---- offers paid on another chain (see XOffer) ---- */
	'xoffer.create'(s, from, d, id, time) {
		const give = sideOf(s, d.give);
		const w = (d.want && typeof d.want === 'object' ? d.want : fail('bad offer')) as Record<string, unknown>;
		const net = typeof w.net === 'string' && own(XTOKENS, w.net) ? w.net : fail(`you can be paid on: ${Object.keys(XTOKENS).join(', ')}`);
		// an NFT: buy this exact ERC-721 on an Ethereum-style chain, delivered to payTo. Anyone may fill it (buy it on any
		// marketplace, or sell their own); validators check the delivery on that chain, and the DZY go to whoever delivered
		const isNft = w.token === 'NFT';
		if (isNft && (net === 'sol' || net === 'btc')) fail('NFTs can be asked for on Ethereum-style chains: ' + Object.keys(XTOKENS).filter((n) => n !== 'sol' && n !== 'btc').join(', '));
		const token = isNft ? 'NFT' : typeof w.token === 'string' && own(XTOKENS[net], w.token) ? w.token : fail(`there you can ask for: ${Object.keys(XTOKENS[net]).join(', ')}, or NFT`);
		const nft = isNft ? { contract: typeof w.contract === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w.contract) ? w.contract.toLowerCase() : fail('name the contract of the NFT (0x...)'), id: typeof w.id === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(w.id) && BigInt(w.id) < 2n ** 256n ? w.id : fail('name the id of the NFT, as a whole number in text') } : undefined;
		const want: XWant = isNft ? { net, token, amount: 1, nft } : { net, token, amount: amountOf(w.amount) };
		// where the maker is paid. On Solana: by default the same key. On an EVM chain: the address the maker gives, or by
		// default the Ethereum address linked to this account (name.link), so a person never types an address twice
		const linked = (n: string) => (own(s.accounts, from) ? s.accounts[from].links?.[n] : undefined);
		const payTo = net === 'btc' ? (d.payTo === undefined ? (linked('btc') ?? fail('give the Bitcoin address to be paid at')) : btcAddress(d.payTo)?.address ?? fail('bad Bitcoin address to be paid at'))
			: net === 'sol' ? (d.payTo === undefined ? toBase58(from) : typeof d.payTo === 'string' && fromSolana(d.payTo) ? d.payTo : fail('bad address to be paid at'))
			: typeof d.payTo === 'string' && /^0x[0-9a-fA-F]{40}$/.test(d.payTo) ? d.payTo.toLowerCase()
			: d.payTo === undefined && own(s.accounts, from) && isEthAddr(s.accounts[from].links?.eth) ? s.accounts[from].links!.eth : fail('give the 0x address to be paid at');
		const until = d.until === undefined ? undefined : Number.isSafeInteger(d.until) && (d.until as number) > time && (d.until as number) <= time + RULES.maxOfferTime ? (d.until as number) : fail('an offer\'s end must be in the future, and within a year');
		if (balanceOf(s, from, give.asset) < give.amount) fail('not enough balance');
		const key = 'x' + id.slice(0, 16);
		if (s.xoffers && own(s.xoffers, key)) fail('offer already exists');
		return () => { sub(s, from, give.asset, give.amount); (s.xoffers ??= {})[key] = { maker: from, give, want, payTo, ...(until === undefined ? {} : { until }), n: 0 }; };
	},
	/** hold an offer (all of it, or `amount` of what it gives) while you pay for it on the other chain */
	'xoffer.reserve'(s, from, d, _id, time) {
		const key = s.xoffers && own(s.xoffers, d.id) ? d.id : fail('no such offer');
		const o = s.xoffers![key];
		if (o.maker === from) fail('you cannot take your own offer');
		if (o.until !== undefined && time > o.until) fail('this offer has ended');
		if (o.hold && time <= o.hold.until + RULES.xGrace) fail('someone is paying for this offer right now: try again in a few minutes');
		const take = d.amount === undefined ? o.give.amount : isAmount(d.amount) && d.amount <= o.give.amount ? d.amount : fail('take an amount above zero, at most what the offer gives');
		if (o.want.nft && take !== o.give.amount) fail('an NFT is delivered whole: take all of it');
		const pay = take === o.give.amount ? o.want.amount : Number((BigInt(take) * BigInt(o.want.amount) + BigInt(o.give.amount) - 1n) / BigInt(o.give.amount));
		if (take < o.give.amount && pay >= o.want.amount) fail('that part is too small to price: take all of it');
		return () => { o.n += 1; o.hold = { by: from, take, pay, until: time + RULES.xHold, key: `${key}-${o.n}`, ...(o.want.nft ? { from: time } : {}) }; };
	},
	/** the taker says which transaction paid for their hold (validators then check exactly that one); the hold then
	    lasts up to RULES.xPaidWait, so slow chains have time to make the payment final */
	'xoffer.paid'(s, from, d, _id, time) {
		const key = s.xoffers && own(s.xoffers, d.id) ? d.id : fail('no such offer');
		const o = s.xoffers![key], h = o.hold ?? fail('nobody is paying for this offer');
		if (h.by !== from) fail('this hold belongs to another account');
		if (d.key !== h.key) fail('that is for another hold');
		if (time > h.until + RULES.xGrace) fail('this hold has ended');
		if (!isXTx(o.want.net, d.tx)) fail('bad payment id');
		return () => { h.tx = d.tx as string; h.until = Math.max(h.until, time + (o.want.net === 'btc' ? RULES.xPaidWaitBtc : RULES.xPaidWait)); };
	},
	/** a validator reports that the payment for a hold is final on the other chain (`tx`: that chain's transaction id).
	    Once validators with more than two thirds of the say have reported it, the held coins go to the taker. */
	'xoffer.attest'(s, from, d, _id, time, ctx) {
		if (!mayVouch(s, from)) fail('only a validator can report a payment');
		const key = s.xoffers && own(s.xoffers, d.id) ? d.id : fail('no such offer');
		const o = s.xoffers![key], h = o.hold ?? fail('nobody is paying for this offer');
		if (d.key !== h.key) fail('that payment is for another hold');
		if (!isXTx(o.want.net, d.tx)) fail('bad payment id');
		if (h.votes?.includes(from)) fail('this validator has already reported it');
		const seen = `${o.want.net}:${d.tx}`;
		if (o.want.nft && s.xseen && own(s.xseen, seen)) fail('that delivery was already counted');
		const votes = [...(h.votes ?? []), from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
		if (said * 3 <= all * 2 || !vouched(s, votes)) return () => { h.votes = votes; }; // not enough of the say yet
		// the network's cut: 0.1% of the DZY, to the Sun, which pays it out to validators and holders by the chain's rules
		const cut = o.give.asset === NATIVE ? Math.ceil((h.take * RULES.xServiceBps) / 10_000) : 0;
		return () => {
			add(s, h.by, o.give.asset, h.take - cut); if (cut) toTreasury(s, cut);
			if (o.want.nft) (s.xseen ??= {})[seen] = { at: time, to: o.maker, coin: 'NFT', amount: 1, dzy: h.take };
			const t: Trade = { h: ctx.height, t: time, offer: key, maker: o.maker, taker: h.by, sold: { asset: o.give.asset, amount: h.take }, paid: { asset: xAsset(o.want), amount: h.pay }, via: d.tx as string };
			s.trades = [...(s.trades ?? []), t].slice(-RULES.maxTrades);
			if (h.take === o.give.amount) { delete s.xoffers![key]; if (emptyOf(s.xoffers!)) delete s.xoffers; }
			else { o.give = { asset: o.give.asset, amount: o.give.amount - h.take }; o.want = { ...o.want, amount: o.want.amount - h.pay }; delete o.hold; }
		};
	},
	/** take back your own offer (anyone may close one that has ended), unless someone is paying for it right now */
	'xoffer.cancel'(s, from, d, _id, time) {
		const key = s.xoffers && own(s.xoffers, d.id) ? d.id : fail('no such offer');
		const o = s.xoffers![key];
		if (o.maker !== from && !(o.until !== undefined && time > o.until)) fail('only the maker can cancel');
		if (o.hold && time <= o.hold.until + RULES.xGrace) fail('someone is paying for this offer right now: try again in a few minutes');
		return () => { add(s, o.maker, o.give.asset, o.give.amount); delete s.xoffers![key]; if (emptyOf(s.xoffers!)) delete s.xoffers; };
	},

	/* ---- liquidity pools: instant swaps of any token against DZY (see LiquidityPool) ---- */
	/** open the pool for a token: put in DZY and the token, which sets the first price. One pool per token. */
	'pool.open'(s, from, d, _id, time) {
		const asset = assetOf(s, d.asset);
		if (asset === NATIVE) fail('a pool pairs a token with DZY: name the token');
		if (s.assets[asset].nft) fail('NFTs trade by offers (their royalties are paid there), not in pools');
		if (s.liquidity && own(s.liquidity, asset)) fail('this token already has a pool: add to it');
		const dzy = amountOf(d.dzy), token = amountOf(d.token);
		if (dzy < RULES.poolMinDzy) fail(`a pool starts with at least ${RULES.poolMinDzy / DZY} DZY`);
		const shares = Number(isqrt(big(dzy) * big(token)));
		if (shares <= RULES.poolLock * 2) fail('too little to open a pool with');
		if (balanceOf(s, from, NATIVE) < dzy + RULES.poolFee) fail(`not enough DZY (opening a pool costs ${RULES.poolFee / DZY} DZY)`);
		if (balanceOf(s, from, asset) < token) fail('not enough balance');
		return () => {
			sub(s, from, NATIVE, dzy + RULES.poolFee); toTreasury(s, RULES.poolFee); sub(s, from, asset, token);
			(s.liquidity ??= {})[asset] = { dzy, token, shares, lp: { [from]: shares - RULES.poolLock }, cum: '0', at: time, obs: [[time, '0']], born: time };
		};
	},
	/** back a pool: put in `dzy` and the matching amount of the token at the pool's price (at most `maxToken`) */
	'pool.add'(s, from, d, _id, time) {
		const asset = s.liquidity && own(s.liquidity, d.asset) ? d.asset : fail('no such pool'), p = s.liquidity![asset];
		if (p.launch) fail('a launch is its own market: nothing is added to it or taken from it');
		const dzy = amountOf(d.dzy), maxToken = amountOf(d.maxToken);
		// the token to put in is rounded up and the shares given are rounded down: never in the newcomer's favour
		const token = Number((big(dzy) * big(p.token) + big(p.dzy) - 1n) / big(p.dzy)), shares = Number((big(dzy) * big(p.shares)) / big(p.dzy));
		if (shares <= 0) fail('too little to add');
		if (token > maxToken) fail('the price moved: that needs more of the token than you allowed');
		if (!Number.isSafeInteger(p.dzy + dzy) || !Number.isSafeInteger(p.token + token) || !Number.isSafeInteger(p.shares + shares)) fail('this pool is full');
		if (balanceOf(s, from, NATIVE) < dzy || balanceOf(s, from, asset) < token) fail('not enough balance');
		return () => { poolTick(p, time); sub(s, from, NATIVE, dzy); sub(s, from, asset, token); p.dzy += dzy; p.token += token; p.shares += shares; p.lp[from] = (own(p.lp, from) ? p.lp[from] : 0) + shares; };
	},
	/** take your part of a pool back out: `shares` of yours, for that part of both amounts (at least `minDzy` and `minToken`) */
	'pool.remove'(s, from, d, _id, time) {
		const asset = s.liquidity && own(s.liquidity, d.asset) ? d.asset : fail('no such pool'), p = s.liquidity![asset];
		const shares = amountOf(d.shares);
		if (!own(p.lp, from) || p.lp[from] < shares) fail('you do not have that many shares of this pool');
		const dzy = Number((big(shares) * big(p.dzy)) / big(p.shares)), token = Number((big(shares) * big(p.token)) / big(p.shares));
		const min = (v: unknown) => (v === undefined ? 0 : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail('bad minimum'));
		if (dzy < min(d.minDzy) || token < min(d.minToken)) fail('the price moved: you would get less than you asked for');
		return () => {
			poolTick(p, time);
			p.dzy -= dzy; p.token -= token; p.shares -= shares;
			if (p.lp[from] === shares) delete p.lp[from]; else p.lp[from] -= shares;
			if (dzy > 0) add(s, from, NATIVE, dzy);
			if (token > 0) add(s, from, asset, token);
		};
	},
	/** Swap at once against a token's pool. `give`: DZY (you get the token) or the token (you get DZY). `min`: the least
	    you accept, so a price that moved before your turn refuses the swap instead of costing you. */
	'pool.swap'(s, from, d, _id, time, ctx) {
		const asset = s.liquidity && own(s.liquidity, d.asset) ? d.asset : fail('no such pool'), p = s.liquidity![asset];
		const giveDzy = d.give === NATIVE ? true : d.give === asset ? false : fail('give DZY or the pool\'s token');
		const amount = amountOf(d.amount), min = amountOf(d.min);
		const r = poolSwap(p, giveDzy, amount) ?? fail('too small to swap, or more than this pool can give');
		if (r.out < min) fail('the price moved: you would get less than your minimum');
		const gave = giveDzy ? NATIVE : asset, got = giveDzy ? asset : NATIVE;
		if (balanceOf(s, from, gave) < amount) fail('not enough balance');
		return () => {
			poolTick(p, time);
			sub(s, from, gave, amount); add(s, from, got, r.out); toTreasury(s, r.hub); p.dzy = r.dzy; p.token = r.token;
			if (r.creator) add(s, p.launch!.creator, NATIVE, r.creator);
			const t: Trade = { h: ctx.height, t: time, offer: 'pool:' + asset, maker: 'pool:' + asset, taker: from, sold: { asset: got, amount: r.out }, paid: { asset: gave, amount } };
			s.trades = [...(s.trades ?? []), t].slice(-RULES.maxTrades);
		};
	},
	/** Swap one token for another in one step, through DZY: `from` → DZY → `to`, both or neither. `min`: the least of `to` you accept. */
	'pool.route'(s, from, d, _id, time, ctx) {
		const pools = s.liquidity ?? {};
		const a = own(pools, d.from) ? d.from : fail('no pool for what you give'), b = own(pools, d.to) ? d.to : fail('no pool for what you want');
		if (a === b) fail('that is the same token');
		const amount = amountOf(d.amount), min = amountOf(d.min);
		const one = poolSwap(pools[a], false, amount) ?? fail('too small to swap, or more than this pool can give');
		const two = poolSwap(pools[b], true, one.out) ?? fail('too small to swap, or more than this pool can give');
		if (two.out < min) fail('the price moved: you would get less than your minimum');
		if (balanceOf(s, from, a) < amount) fail('not enough balance');
		return () => {
			poolTick(pools[a], time); poolTick(pools[b], time);
			sub(s, from, a, amount); add(s, from, b, two.out); toTreasury(s, one.hub + two.hub);
			if (one.creator) add(s, pools[a].launch!.creator, NATIVE, one.creator);
			if (two.creator) add(s, pools[b].launch!.creator, NATIVE, two.creator);
			pools[a].dzy = one.dzy; pools[a].token = one.token; pools[b].dzy = two.dzy; pools[b].token = two.token;
			const t1: Trade = { h: ctx.height, t: time, offer: 'pool:' + a, maker: 'pool:' + a, taker: from, sold: { asset: NATIVE, amount: one.out }, paid: { asset: a, amount } };
			const t2: Trade = { h: ctx.height, t: time, offer: 'pool:' + b, maker: 'pool:' + b, taker: from, sold: { asset: b, amount: two.out }, paid: { asset: NATIVE, amount: one.out } };
			s.trades = [...(s.trades ?? []), t1, t2].slice(-RULES.maxTrades);
		};
	},

	/* ---- leveraged trading: vaults lend, positions borrow, anyone closes an unhealthy one (see Position, MARGIN.md) ---- */
	/** lend to a pool's vault: DZY for longs (side L) or the pool's token for shorts (side S); get shares of the vault */
	'vault.deposit'(s, from, d) {
		const pool = s.liquidity && own(s.liquidity, d.pool) ? d.pool : fail('no such pool'), key = vaultKey(pool, d.side), asset = d.side === 'L' ? NATIVE : pool;
		if (s.liquidity![pool].launch) fail('no lending against a launch: its price is still a curve finding its feet');
		const amount = amountOf(d.amount), v = s.vaults && own(s.vaults, key) ? s.vaults[key] : null;
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		// the first deposit leaves RULES.poolLock shares to nobody for ever, as pools do: a share's worth can never be bent
		const shares = v ? Number((BigInt(amount) * BigInt(v.shares)) / BigInt(v.cash + v.lent)) : amount;
		if (!v && amount <= RULES.poolLock * 2) fail('too little to open a vault with');
		if (shares <= 0) fail('too little to lend');
		if (v && (!Number.isSafeInteger(v.cash + amount) || !Number.isSafeInteger(v.shares + shares))) fail('this vault is full');
		return () => {
			sub(s, from, asset, amount);
			if (!v) { (s.vaults ??= {})[key] = { cash: amount, lent: 0, shares, lp: { [from]: shares - RULES.poolLock } }; return; }
			v.cash += amount; v.shares += shares; v.lp[from] = (own(v.lp, from) ? v.lp[from] : 0) + shares;
		};
	},
	/** take your part out of a vault: `shares` of yours, for that part of it. Only what is not lent out can leave. */
	'vault.withdraw'(s, from, d) {
		const key = s.vaults && own(s.vaults, d.vault) ? d.vault : fail('no such vault'), v = s.vaults![key], shares = amountOf(d.shares);
		if (!own(v.lp, from) || v.lp[from] < shares) fail('you do not have that many shares of this vault');
		const amount = Number((BigInt(shares) * BigInt(v.cash + v.lent)) / BigInt(v.shares));
		if (amount > v.cash) fail('that much is lent out right now: take less, or wait for loans to be repaid');
		const asset = key.endsWith(':L') ? NATIVE : key.slice(0, -2);
		return () => { v.cash -= amount; v.shares -= shares; if (v.lp[from] === shares) delete v.lp[from]; else v.lp[from] -= shares; if (amount > 0) add(s, from, asset, amount); };
	},
	/** Open a position: put up `margin` DZY, borrow to `lev` tenths (11 = 1.1x ... 30 = 3x), and trade it through the
	    pool in one step. Long (L) buys the token; short (S) sells borrowed tokens. `min`: the least the trade must give. */
	'margin.open'(s, from, d, id, time, ctx) {
		const pool = s.liquidity && own(s.liquidity, d.pool) ? d.pool : fail('no such pool'), p = s.liquidity![pool], key = vaultKey(pool, d.side);
		const v = s.vaults && own(s.vaults, key) ? s.vaults[key] : fail('nobody lends for this yet: the vault is empty');
		if (s.assets[pool]?.mintable) fail('no positions on a token its maker can still issue more of');
		if (p.born === undefined || time - p.born < RULES.marginMinAge) fail('no positions on a pool younger than a day');
		const avg = poolAverage(p, time) ?? fail('this pool has no average price yet');
		const margin = amountOf(d.margin), min = amountOf(d.min);
		const lev = typeof d.lev === 'number' && Number.isSafeInteger(d.lev) && d.lev >= 11 && d.lev <= RULES.marginMaxLev ? d.lev : fail(`leverage is 11 to ${RULES.marginMaxLev} tenths (1.1x to ${RULES.marginMaxLev / 10}x)`);
		if (balanceOf(s, from, NATIVE) < margin) fail('not enough DZY');
		const side = d.side as 'L' | 'S';
		// long: borrow DZY; short: borrow tokens worth that much at the current price
		const borrowDzy = mulDiv(margin, lev - 10, 10);
		const debt = side === 'L' ? borrowDzy : Number((BigInt(borrowDzy) * BigInt(p.token)) / BigInt(p.dzy));
		if (debt <= 0) fail('too small to borrow against');
		if (debt > v.cash) fail('the vault does not have that much to lend right now');
		if ((v.lent + debt) * RULES.marginPoolShare > (side === 'L' ? p.dzy : p.token)) fail(`all borrowing on a pool is at most 1/${RULES.marginPoolShare} of it: this pool cannot take that much more`);
		const r = (side === 'L' ? poolSwap(p, true, margin + debt) : poolSwap(p, false, debt)) ?? fail('too small, or more than this pool can take');
		if (r.out < min) fail('the price moved: the trade would give less than your minimum');
		const pos: Position = { owner: from, pool, side, margin, held: side === 'L' ? r.out : margin + r.out, debt, rate: rateFor(s, v, debt), at: time };
		// healthy enough to open at both prices, measured after its own trade
		const after = { ...p, dzy: r.dzy, token: r.token };
		if (healthOf(pos, debt, BigInt(avg), 1_000_000_000n) < RULES.marginOpenPct || healthOf(pos, debt, BigInt(after.dzy), BigInt(after.token)) < RULES.marginOpenPct) fail('too much leverage for this price: lower it or add margin');
		const key2 = 'm' + id.slice(0, 16);
		if (s.positions && own(s.positions, key2)) fail('position already exists');
		return () => {
			poolTick(p, time);
			sub(s, from, NATIVE, margin); v.cash -= debt; v.lent += debt; toTreasury(s, r.hub); p.dzy = r.dzy; p.token = r.token;
			(s.positions ??= {})[key2] = pos;
			const tr: Trade = { h: ctx.height, t: time, offer: 'pool:' + pool, maker: 'pool:' + pool, taker: from, sold: side === 'L' ? { asset: pool, amount: r.out } : { asset: NATIVE, amount: r.out }, paid: side === 'L' ? { asset: NATIVE, amount: margin + debt } : { asset: pool, amount: debt } };
			s.trades = [...(s.trades ?? []), tr].slice(-RULES.maxTrades);
		};
	},
	/** make a position safer: long, by paying back part of the loan; short, by adding DZY to what it holds */
	'margin.add'(s, from, d) {
		const key = s.positions && own(s.positions, d.id) ? d.id : fail('no such position'), pos = s.positions![key], amount = amountOf(d.amount);
		if (pos.owner !== from) fail('this position belongs to another account');
		if (balanceOf(s, from, NATIVE) < amount) fail('not enough DZY');
		if (pos.side === 'L' && amount >= pos.debt) fail('that pays the whole loan: close the position instead');
		const v = s.vaults![vaultKey(pos.pool, pos.side)];
		return () => { sub(s, from, NATIVE, amount); if (pos.side === 'L') { pos.debt -= amount; v.lent -= amount; v.cash += amount; } else pos.held += amount; };
	},
	/** close your own position: trade back through the pool, repay the loan with interest, keep the rest (at least `min`, default 0) */
	'margin.close'(s, from, d, _id, time) {
		const key = s.positions && own(s.positions, d.id) ? d.id : fail('no such position'), pos = s.positions![key];
		if (pos.owner !== from) fail('this position belongs to another account');
		const min = d.min === undefined ? 0 : typeof d.min === 'number' && Number.isSafeInteger(d.min) && d.min >= 0 ? d.min : fail('bad minimum');
		const out = settle(s, pos, time) ?? fail('it no longer covers its loan: anyone can close it now (margin.liquidate), or add to it first');
		if (out.left < min) fail('the price moved: you would get back less than your minimum');
		return () => out.apply(key, from);
	},
	/** anyone closes a position that holds under RULES.marginLiqPct of what it owes, at the average AND the current price */
	'margin.liquidate'(s, from, d, _id, time) {
		const key = s.positions && own(s.positions, d.id) ? d.id : fail('no such position'), pos = s.positions![key];
		const h = positionHealth(s, pos, time);
		if (h.average === null || h.average >= RULES.marginLiqPct || h.now >= RULES.marginLiqPct) fail('this position is still healthy');
		const out = settle(s, pos, time, true, mulDiv(pos.margin, RULES.marginRewardPct, 100))!;
		return () => out.apply(key, from);
	},

	/* ---- Pay with Dznye: payments to a shop, with the shop's own cashback paid automatically ---- */
	/** set (or with `num: 0`, remove) the cashback for payments in `pay`: `reward` asset at num/den of what is paid */
	'shop.set'(s, from, d) {
		const pay = assetOf(s, d.pay), reward = assetOf(s, d.reward);
		const num = typeof d.num === 'number' && Number.isSafeInteger(d.num) && d.num >= 0 && d.num <= 1_000_000_000 ? d.num : fail('num is a whole number from 0 to 1,000,000,000');
		const den = typeof d.den === 'number' && Number.isSafeInteger(d.den) && d.den >= 1 && d.den <= 1_000_000_000 ? d.den : fail('den is a whole number from 1 to 1,000,000,000');
		if (d.name !== undefined && (typeof d.name !== 'string' || !d.name.trim() || d.name.length > RULES.nameMax)) fail('bad shop name');
		const sh = s.shops && own(s.shops, from) ? s.shops[from] : null;
		if (num && !(sh && own(sh.rules, pay)) && Object.keys(sh?.rules ?? {}).length >= 8) fail('a shop has at most 8 cashback rules');
		if (!num && !(sh && own(sh.rules, pay)) && !(!sh && typeof d.name === 'string')) fail('there is no cashback for that to remove'); // num 0 with a name, on no shop yet: open one with just its name
		return () => {
			const x = ((s.shops ??= {})[from] ??= { rules: {}, reserve: {} });
			if (num) x.rules[pay] = { reward, num, den }; else if (own(x.rules, pay)) delete x.rules[pay];
			if (typeof d.name === 'string') x.name = d.name;
		};
	},
	/** put coins in your shop's cashback reserve */
	'shop.fund'(s, from, d) {
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		if (!(s.shops && own(s.shops, from))) fail('set a cashback rule first (shop.set)');
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		return () => { const r = s.shops![from].reserve; sub(s, from, asset, amount); r[asset] = (own(r, asset) ? r[asset] : 0) + amount; };
	},
	/** take coins back out of your shop's reserve */
	'shop.withdraw'(s, from, d) {
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount), r = s.shops && own(s.shops, from) ? s.shops[from].reserve : fail('this account has no shop');
		if (!own(r, asset) || r[asset] < amount) fail('the reserve does not hold that much');
		return () => { r[asset] -= amount; if (!r[asset]) delete r[asset]; add(s, from, asset, amount); };
	},
	/** pay a shop: like a transfer, plus the shop's cashback to the payer while its reserve lasts. `order` is public. */
	'shop.pay'(s, from, d, _id, time) {
		const shop = isAddr(d.shop) && d.shop !== from ? d.shop : fail('bad shop (and you cannot pay yourself)');
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		if (d.order !== undefined && (typeof d.order !== 'string' || d.order.length > RULES.memoMax)) fail('bad order');
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		const sh = s.shops && own(s.shops, shop) ? s.shops[shop] : null, rule = sh && own(sh.rules, asset) ? sh.rules[asset] : null;
		const owed = rule ? Number((BigInt(amount) * BigInt(rule.num)) / BigInt(rule.den)) : 0;
		const back = rule ? Math.min(owed, own(sh!.reserve, rule.reward) ? sh!.reserve[rule.reward] : 0) : 0;
		return () => {
			sub(s, from, asset, amount); add(s, shop, asset, amount);
			if (sh) { (sh.orders ??= []).push({ ...(d.order !== undefined ? { order: d.order as string } : {}), from, asset, amount, at: time }); if (sh.orders.length > 100) sh.orders.splice(0, sh.orders.length - 100); }
			if (back > 0) { sh!.reserve[rule!.reward] -= back; if (!sh!.reserve[rule!.reward]) delete sh!.reserve[rule!.reward]; add(s, from, rule!.reward, back); }
		};
	},

	/* ---- creators: tips with a message, and things for sale (a picture, a video, a song, a file, an edition) ---- */
	/** open a creator's shop (from the checkout upgrade): free to do; $5 goes on what they owe, taken from their first
	    sales and tips. Selling needs it; being tipped does not. */
	'creator.join'(s, from, d, _id, time, ctx) {
		for (const k of Object.keys(d)) fail(`"${k}" is not expected here`);
		if (!checkoutV2(s)) fail('shops open with the checkout upgrade');
		if (s.creators && own(s.creators, from)) fail('your shop is already open');
		if (joinTrialOn(s, ctx.height)) return () => { (s.creators ??= {})[from] = time; (s.joinDue ??= {})[from] = time + JOIN_TRIAL_MS; }; // 40 free days first
		return () => { (s.creators ??= {})[from] = time; (s.feeOwed ??= {})[from] = feeOwedOf(s, from) + CREATOR_JOIN_USD; };
	},
	/** pay what your shop owes now (its $5, even before the free days end, and any fees on your tab) in any coin the chain
	    prices, to the network's fee account; `max`: the most you will pay in that coin */
	'fee.pay'(s, from, d, _id, time, ctx) {
		for (const k of Object.keys(d)) if (k !== 'asset' && k !== 'max') fail(`"${k}" is not expected here`);
		if (!joinTrialOn(s, ctx.height)) fail('paying the shop fee opens with the free days');
		const pending = s.joinDue && own(s.joinDue, from) ? CREATOR_JOIN_USD : 0, usd = feeOwedOf(s, from) + pending;
		if (!usd) fail('your shop owes nothing');
		const asset = typeof d.asset === 'string' ? d.asset : fail('name the coin you pay with'), max = Number.isSafeInteger(d.max) && (d.max as number) > 0 ? (d.max as number) : fail('max: the most you will pay');
		const pay = usdCost(s, asset, usd, time) ?? fail(`the chain has no price for ${asset} right now: pay with DZY, xUSDC or xUSDT`);
		if (pay > max) fail('the price changed: look again');
		if (balanceOf(s, from, asset) < pay) fail('not enough balance');
		return () => { sub(s, from, asset, pay); add(s, RULES.saleFeeTo, asset, pay); if (pending) { delete s.joinDue![from]; if (emptyOf(s.joinDue!)) delete s.joinDue; } if (s.feeOwed) delete s.feeOwed[from]; };
	},
	/** the network's fee account sets the creators' fee (from the checkout upgrade): 0 to 20%, in basis points. It counts from
	    the next sale; nothing already paid changes. */
	'fee.set'(s, from, d) {
		for (const k of Object.keys(d)) if (k !== 'bps') fail(`"${k}" is not expected here`);
		if (!checkoutV2(s)) fail('the fee setting opens with the checkout upgrade');
		if (from !== RULES.saleFeeTo) fail('only the fee account sets the fee');
		const bps = Number.isSafeInteger(d.bps) && (d.bps as number) >= 0 && (d.bps as number) <= SALE_FEE_MAX_BPS ? (d.bps as number) : fail(`bps: a whole number from 0 to ${SALE_FEE_MAX_BPS} (20%)`);
		return () => { s.saleFeeBps = bps; };
	},
	/** the network's fee account marks what a creator owes as paid (a fee it collected on another chain, e.g. from the Solana
	    permission the creator gave): it can only ever lower what they owe */
	'fee.clear'(s, from, d) {
		for (const k of Object.keys(d)) if (!['who', 'usd', 'tx'].includes(k)) fail(`"${k}" is not expected here`);
		if (!checkoutV2(s)) fail('clearing fees opens with the checkout upgrade');
		if (from !== RULES.saleFeeTo) fail('only the fee account clears fees');
		const who = isAddr(d.who) ? d.who : fail('who: a Dznye address');
		const usd = Number.isSafeInteger(d.usd) && (d.usd as number) > 0 ? (d.usd as number) : fail('usd: a whole number of µ$ above zero');
		if (d.tx !== undefined && !(typeof d.tx === 'string' && /^[0-9A-Za-z]{32,100}$/.test(d.tx))) fail('tx: the payment\'s id');
		const owed = feeOwedOf(s, who); if (!owed) fail('they owe nothing');
		return () => { const left = owed - Math.min(owed, usd); if (left) s.feeOwed![who] = left; else delete s.feeOwed![who]; };
	},
	/** tip a creator: `amount` of `asset` (DZY by default) with an optional public message; 0.5% to saleFeeTo */
	tip(s, from, d, _id, time) {
		for (const k of Object.keys(d)) if (!['to', 'asset', 'amount', 'msg'].includes(k)) fail(`"${k}" is not expected here`);
		const to = isAddr(d.to) && d.to !== from ? d.to : fail('bad creator (and you cannot tip yourself)');
		const asset = d.asset === undefined ? NATIVE : assetOf(s, d.asset), amount = amountOf(d.amount);
		if (d.msg !== undefined && (typeof d.msg !== 'string' || d.msg.length > RULES.tipMsgMax)) fail(`a message is at most ${RULES.tipMsgMax} characters`);
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		const fee = saleFee(amount, feeBpsOf(s)), usd = usdWorth(s, asset, amount, time), owed = collectOwed(s, to, asset, amount - fee);
		return () => {
			const back = owed(); // fees the creator owes for outside payments, paid from this first
			sub(s, from, asset, amount); add(s, to, asset, amount - fee - back); if (fee + back) add(s, RULES.saleFeeTo, asset, fee + back);
			const b = ((s.tipboxes ??= {})[to] ??= { total: {}, n: 0, last: [] });
			b.total[asset] = (own(b.total, asset) ? b.total[asset] : 0) + amount; b.n += 1; if (usd) b.usd = (b.usd ?? 0) + usd;
			b.last.push({ from, asset, amount, ...(usd ? { usd } : {}), ...(d.msg ? { msg: d.msg as string } : {}), at: time });
			if (b.last.length > RULES.tipsKept) b.last.splice(0, b.last.length - RULES.tipsKept);
		};
	},
	/** buy a seller's item (their record in space "items"): exactly its price, in its asset. The buyer then owns it on
	    the chain for good (what unlocks its sealed content); an item with `editions` sells that many, no more. */
	'item.buy'(s, from, d, _id, time, ctx) {
		const open = bizOn(s, ctx.height);
		for (const k of Object.keys(d)) if (!['seller', 'item', 'asset', 'amount', 'max', ...(open ? ['at', 'note'] : [])].includes(k)) fail(`"${k}" is not expected here`);
		const seller = isAddr(d.seller) && d.seller !== from ? d.seller : fail('bad seller (and you cannot buy your own item)');
		const item = typeof d.item === 'string' && RKEY.test(d.item) ? d.item : fail('bad item');
		const rec = s.records && own(s.records, `${seller}/items/${item}`) ? s.records[`${seller}/items/${item}`] : null;
		const v = itemOf(rec?.value) ?? fail('no such item for sale');
		if (v.off) fail('this item is not for sale right now');
		if (!creatorJoined(s, seller)) fail('this creator has not opened their shop yet');
		let asset: string, pay: number;
		if (v.usd) { // priced in dollars: the buyer picks the coin and names the most they will pay in it
			asset = typeof d.asset === 'string' ? d.asset : fail('name the coin you pay with');
			if (d.amount !== undefined) fail('a dollar price is paid with max: the most you will pay');
			const max = Number.isSafeInteger(d.max) && (d.max as number) > 0 ? (d.max as number) : fail('max: the most you will pay, in whole units of that coin');
			pay = usdCost(s, asset, v.usd, time) ?? fail(`the chain has no price for ${asset} right now: pay with DZY, xUSDC or xUSDT`);
			if (pay > max) fail('the price changed: look again');
		} else {
			if (d.max !== undefined || d.asset !== v.asset || d.amount !== v.price) fail('the price changed: look again'); // the buyer names the price, so a changed one never takes more
			asset = v.asset; pay = v.price;
		}
		const k = `${from}/${seller}/${item}`, sk = `${seller}/${item}`;
		const had = s.owned && own(s.owned, k) ? s.owned[k] : null;
		// a business offer: bought again and again, maybe with a note, a booking with its slot
		const rv = rec?.value as Record<string, unknown>, biz = open && typeof rv?.biz === 'string' && BIZ.kinds.includes(rv.biz) ? rv.biz : null, b = biz && rv.book !== undefined ? bookOf(rv.book) : null;
		if (d.note !== undefined && (!biz || typeof d.note !== 'string' || !d.note.trim() || d.note.length > BIZ.noteMax)) fail(`note: a business offer's note, at most ${BIZ.noteMax} letters`);
		if (d.at !== undefined && !b) fail('this is not something booked for a time');
		if (b) { const why = d.at === undefined ? 'at: choose a time' : slotProblem(b, d.at, time); if (why) fail(why); if ((s.slots?.[`${sk}/${d.at}`] ?? 0) >= b.seats) fail('that time is full: choose another'); }
		if (had && !biz && !(v.month && had.until !== undefined)) fail('you already own this');
		const sold = s.sales && own(s.sales, sk) ? s.sales[sk] : null;
		if (v.editions && !had && (sold?.n ?? 0) >= v.editions) fail('sold out');
		if (balanceOf(s, from, asset) < pay) fail('not enough balance');
		const card = itemNft(s, rec?.value);
		if (card && balanceOf(s, seller, card) < 1) fail('sold out: the creator holds no copy any more');
		const fee = saleFee(pay, feeBpsOf(s)), usd = v.usd || (usdWorth(s, asset, pay, time) ?? 0), owed = collectOwed(s, seller, asset, pay - fee);
		return () => {
			const back = owed(); // fees the creator owes for outside payments, paid from this first
			if (card) { sub(s, seller, card, 1); add(s, from, card, 1); } // the card itself, in the same step
			sub(s, from, asset, pay); add(s, seller, asset, pay - fee - back); if (fee + back) add(s, RULES.saleFeeTo, asset, fee + back);
			// a membership runs 30 days from now, or from when the last one ends if it is still running
			(s.owned ??= {})[k] = { at: time, asset, paid: pay, ...(usd ? { usd } : {}), ...(v.month ? { until: Math.max(time, had?.until ?? 0) + MONTH_MS } : {}), ...(edOn(s) ? (v.editions && !had ? { ed: (sold?.n ?? 0) + 1 } : had?.ed ? { ed: had.ed } : {}) : {}) };
			const x = ((s.sales ??= {})[sk] ??= { n: 0, total: 0 }); x.n += 1; x.total += pay; if (usd) x.usd = (x.usd ?? 0) + usd;
			if (biz) { // the business's list of orders and bookings (the newest BIZ.keep), and how full each slot is
				const at = b ? (d.at as number) : undefined, list = ((s.biz ??= {})[seller] ??= []);
				list.push({ i: item, by: from, t: time, asset, paid: pay, ...(at !== undefined ? { at } : {}), ...(typeof d.note === 'string' ? { note: d.note.trim() } : {}) });
				if (list.length > BIZ.keep) list.splice(0, list.length - BIZ.keep);
				if (at !== undefined) { const sl = (s.slots ??= {}); sl[`${sk}/${at}`] = (sl[`${sk}/${at}`] ?? 0) + 1; for (const q of Object.keys(sl)) if (q.startsWith(sk + '/') && Number(q.slice(sk.length + 1)) < time - 86_400_000) delete sl[q]; }
			}
		};
	},

	/** offer a numbered edition you own for `usd` µ$. `bps` is the fee you saw: if the creator changed it since, refused */
	'resale.list'(s, from, d, _id, time) {
		for (const k of Object.keys(d)) if (!['seller', 'item', 'usd', 'bps'].includes(k)) fail(`"${k}" is not expected here`);
		if (!resaleOn(s)) fail('resale is not open yet');
		const seller = isAddr(d.seller) ? d.seller : fail('bad creator');
		const item = typeof d.item === 'string' && RKEY.test(d.item) ? d.item : fail('bad item');
		const usd = Number.isSafeInteger(d.usd) && (d.usd as number) >= RESALE.minUsd && (d.usd as number) <= RESALE.maxUsd ? (d.usd as number) : fail('the price: $0.10 to $1,000,000');
		const k = `${from}/${seller}/${item}`, o = s.owned && own(s.owned, k) ? s.owned[k] : fail('you do not own this');
		if (!o.ed || o.until !== undefined) fail('only numbered editions can be resold');
		const rec = s.records && own(s.records, `${seller}/items/${item}`) ? s.records[`${seller}/items/${item}`] : null, bps = resaleBps(rec?.value), card = itemNft(s, rec?.value);
		if (card && balanceOf(s, from, card) < 1) fail('you do not hold the card any more');
		if (d.bps !== bps) fail('the resale fee changed: look again');
		return () => { (s.listings ??= {})[k] = { usd, bps, at: time }; };
	},
	/** take your offer back */
	'resale.cancel'(s, from, d) {
		for (const k of Object.keys(d)) if (!['seller', 'item'].includes(k)) fail(`"${k}" is not expected here`);
		const k = `${from}/${String(d.seller)}/${String(d.item)}`;
		if (!(s.listings && own(s.listings, k))) fail('you do not offer this');
		return () => { delete s.listings![k]; if (emptyOf(s.listings!)) delete s.listings; };
	},
	/** buy an edition from its owner, in any coin the chain prices: `usd` is the price you saw, `max` the most you pay */
	'resale.buy'(s, from, d, _id, time) {
		for (const k of Object.keys(d)) if (!['owner', 'seller', 'item', 'asset', 'usd', 'max'].includes(k)) fail(`"${k}" is not expected here`);
		const owner = isAddr(d.owner) && d.owner !== from ? d.owner : fail('bad owner (and you cannot buy your own)');
		const seller = isAddr(d.seller) ? d.seller : fail('bad creator');
		const item = typeof d.item === 'string' && RKEY.test(d.item) ? d.item : fail('bad item');
		const k = `${owner}/${seller}/${item}`, mine = `${from}/${seller}/${item}`, sk = `${seller}/${item}`;
		const l = s.listings && own(s.listings, k) ? s.listings[k] : fail('that is not for sale any more');
		const o = s.owned && own(s.owned, k) ? s.owned[k] : fail('that is not for sale any more');
		if (d.usd !== l.usd) fail('the price changed: look again');
		if (s.owned && own(s.owned, mine)) fail('you already own one of these');
		const asset = typeof d.asset === 'string' ? d.asset : fail('name the coin you pay with');
		const max = Number.isSafeInteger(d.max) && (d.max as number) > 0 ? (d.max as number) : fail('max: the most you will pay, in whole units of that coin');
		const pay = usdCost(s, asset, l.usd, time) ?? fail(`the chain has no price for ${asset} right now: pay with DZY, xUSDC or xUSDT`);
		if (pay > max) fail('the price changed: look again');
		if (balanceOf(s, from, asset) < pay) fail('not enough balance');
		const rec = s.records && own(s.records, `${seller}/items/${item}`) ? s.records[`${seller}/items/${item}`] : null, card = itemNft(s, rec?.value);
		if (card && balanceOf(s, owner, card) < 1) fail('that is not for sale any more');
		const x = resaleSplit(pay, l.bps), owed = collectOwed(s, seller, asset, x.creator);
		return () => {
			const back = owed(); // what the creator owes is taken from their share, as from any sale
			if (card) { sub(s, owner, card, 1); add(s, from, card, 1); } // the card itself, in the same step
			sub(s, from, asset, pay);
			add(s, owner, asset, x.owner);
			if (x.creator - back) add(s, seller, asset, x.creator - back);
			if (x.founder + back) add(s, RULES.saleFeeTo, asset, x.founder + back);
			delete s.listings![k]; if (emptyOf(s.listings!)) delete s.listings;
			delete s.owned![k];
			s.owned![mine] = { at: time, asset, paid: pay, usd: l.usd, ...(o.ed ? { ed: o.ed } : {}) };
			const r = ((s.resales ??= {})[sk] ??= { n: 0, usd: 0, last: 0, at: 0 }); r.n += 1; r.usd += l.usd; r.last = l.usd; r.at = time;
		};
	},

	/** open a checkout for a dollar-priced item, paid with `coin` on `net` from anywhere */
	'order.open'(s, from, d, id, time, ctx) {
		for (const k of Object.keys(d)) if (!['seller', 'item', 'net', 'coin'].includes(k)) fail(`"${k}" is not expected here`);
		const seller = isAddr(d.seller) && d.seller !== from ? d.seller : fail('bad seller (and you cannot buy your own item)');
		const item = typeof d.item === 'string' && RKEY.test(d.item) ? d.item : fail('bad item');
		const btcOk = orderBtcOn(s, ctx.height), coin = typeof d.coin === 'string' && (own(ORDER_COINS, d.coin) || (btcOk && d.coin === 'BTC')) ? d.coin : fail('pay with USDC, USDT, SOL, ETH or BNB');
		const net = typeof d.net === 'string' && (coin === 'BTC' ? ['btc'] : ORDER_COINS[coin]).includes(d.net) ? d.net : fail(`${coin} cannot be paid on that network`);
		const rec = s.records && own(s.records, `${seller}/items/${item}`) ? s.records[`${seller}/items/${item}`] : null;
		const v = itemOf(rec?.value) ?? fail('no such item for sale');
		if (v.off) fail('this item is not for sale right now');
		if (!v.usd) fail('this item is priced in a coin on Dznye: buy it with item.buy');
		const had = s.owned && own(s.owned, `${from}/${seller}/${item}`) ? s.owned[`${from}/${seller}/${item}`] : null;
		if (had && !(v.month && had.until !== undefined)) fail('you already own this');
		const sold = s.sales && own(s.sales, `${seller}/${item}`) ? s.sales[`${seller}/${item}`].n : 0;
		if (v.editions && !had && sold >= v.editions) fail('sold out');
		const v2 = checkoutV2(s, ctx.height);
		if (!v2 && (coin === 'POL' || coin === 'AVAX')) fail('pay with USDC, USDT, SOL, ETH or BNB');
		if (v2 && !creatorJoined(s, seller, ctx.height)) fail('this creator has not opened their shop yet');
		// Solana has no vault yet: it keeps paying the creator directly, the fee on their tab, until it does
		const vault = v2 && net !== 'sol' && net !== 'btc' ? checkoutVault(s, coin, net) ?? fail('pay with USDC or USDT on a network Dznye has a vault on, or with a coin on Dznye') : null;
		const card = itemNft(s, rec?.value, ctx.height);
		if (card && !vault) fail('a card is paid into a vault (USDC or USDT on a network Dznye has a vault on), or with a coin on Dznye');
		if (bizOn(s, ctx.height) && (rec?.value as Record<string, unknown> | undefined)?.book !== undefined) fail('a time is booked with a coin in your Dznye wallet, so the time goes with it');
		if (card && balanceOf(s, seller, card) < 1) fail('sold out: the creator holds no copy any more');
		if (!vault && feeOwedOf(s, seller) > RULES.feeOwedMax) fail('this creator cannot take outside payments right now: pay with a coin on Dznye');
		const payTo = vault ?? payToOf(s, seller, net) ?? fail('the creator has no address on that network yet: pick another');
		const base = orderBase(s, coin, v.usd, time) ?? fail(`the chain has no price for ${coin} right now: pick another coin`);
		const open = (s.heart ? ordersOf(s, 's' + seller).map((k) => s.orders![k]) : Object.values(s.orders ?? {})).filter((o) => orderOpen(o, time));
		if ((s.heart ? ordersOf(s, 'b' + from).map((k) => s.orders![k]).filter((o) => orderOpen(o, time)) : open.filter((o) => o.buyer === from)).length >= RULES.maxOpenOrders) fail(`at most ${RULES.maxOpenOrders} open checkouts at once: finish or wait for one`);
		const used = new Set(open.filter((o) => o.seller === seller && o.net === net && o.coin === coin).map((o) => o.due - o.base));
		const step = coin === 'USDC' || coin === 'USDT' ? 100 : 100; // 0.0001 of a dollar coin, 0.0000001 of SOL/ETH/BNB
		let tag = 0; for (let n = 1; n <= RULES.orderTags; n++) if (!used.has(n * step)) { tag = n * step; break; }
		if (!tag) fail('this creator has too many checkouts open in that coin right now: pick another coin or try in a few minutes');
		const key = 'o' + id.slice(0, 16);
		return () => {
			// clear away this buyer's and this creator's ended orders, so the list never grows
			if (s.heart) { for (const k of new Set([...ordersOf(s, 'b' + from), ...ordersOf(s, 's' + seller)])) if (!orderOpen(s.orders![k], time)) orderDrop(s, k); }
			else for (const [k, o] of Object.entries(s.orders ?? {})) if (!orderOpen(o, time) && (o.buyer === from || o.seller === seller)) delete s.orders![k];
			(s.orders ??= {})[key] = { buyer: from, seller, item, net, coin, payTo, base, due: base + tag, usd: v.usd, memo: 'dzy:' + key, at: time, until: time + RULES.orderLife, ...(vault ? { vault: true as const } : {}), ...(vault && NATIVE_PAY.has(coin) ? { tag: id } : {}) };
			orderAdd(s, key);
		};
	},
	/** the buyer names the payment (that chain's transaction id); naming another one replaces it until it is counted */
	'order.paid'(s, from, d, _id, time) {
		const key = s.orders && own(s.orders, d.id) ? d.id : fail('no such checkout');
		const o = s.orders![key];
		if (o.buyer !== from) fail('this checkout is someone else\'s');
		if (o.tag) fail('this checkout is paid by the vault deposit with its tag: nothing to name');
		if (o.tx === undefined && time > o.until + RULES.orderGrace) fail('this checkout has ended: start a new one');
		if (!isXTx(o.net, d.tx)) fail('that is not a transaction id on this network');
		if (s.xseen && own(s.xseen, `${o.net}:${d.tx}`)) fail('that payment was already counted');
		return () => { if (o.tx !== d.tx) delete o.votes; o.tx = d.tx as string; o.until = Math.max(o.until, time + RULES.orderPaidWait); };
	},
	/** a validator reports what that payment brought the creator (`amount`, in the coin's Dznye units), read on its chain */
	'order.attest'(s, from, d, _id, time) {
		if (!mayVouch(s, from)) fail('only a validator can report a payment');
		const key = s.orders && own(s.orders, d.id) ? d.id : fail('no such checkout');
		const o = s.orders![key];
		if (!o.tx || d.tx !== o.tx) fail('that is not the payment this checkout named');
		const amount = Number.isSafeInteger(d.amount) && (d.amount as number) > 0 ? (d.amount as number) : fail('bad amount');
		if (o.votes?.includes(from)) fail('this validator has already reported it');
		const seen = `${o.net}:${o.tx}`;
		if (s.xseen && own(s.xseen, seen)) fail('that payment was already counted');
		// enough: the exact amount, or more; or (an exchange that took its fee from it) at least 99% of the price itself
		if (amount < o.due && amount < Math.floor((o.base * 99) / 100)) fail('that payment is less than the price');
		// a payment of exactly another open checkout's amount belongs to that one
		if (amount !== o.due && (s.heart ? ordersOf(s, 's' + o.seller).map((k): [string, typeof o] => [k, s.orders![k]]) : Object.entries(s.orders!)).some(([k, x]) => k !== key && x.seller === o.seller && x.net === o.net && x.coin === o.coin && x.due === amount && orderOpen(x, time))) fail('that payment belongs to another checkout');
		const votes = [...(o.votes ?? []), from], w = powers(s);
		const said = votes.reduce((n, v) => n + (w[v] ?? 0), 0), all = Object.values(w).reduce((n, v) => n + v, 0);
		if (said * 3 <= all * 2 || !vouched(s, votes)) return () => { o.votes = votes; };
		return () => completeOrder(s, key, amount, time, seen);
	},
	/** drop a checkout: its buyer, any time before a payment is named; anyone, once it has ended */
	'order.cancel'(s, from, d, _id, time) {
		const key = s.orders && own(s.orders, d.id) ? d.id : fail('no such checkout');
		const o = s.orders![key];
		if (!(o.buyer === from && o.tx === undefined) && orderOpen(o, time) && time <= o.until) fail('this checkout is still open');
		return () => { orderDrop(s, key); };
	},
	/** move everything this key owns (things bought, memberships) to another account: a buyer who paid without a wallet
	    keeps their purchases in their new wallet. Only the key holding them can move them; open checkouts stay. */
	'owned.move'(s, from, d, _id, time) {
		for (const k of Object.keys(d)) if (k !== 'to' && !(k === 'items' && s.heart)) fail(`"${k}" is not expected here`);
		const to = isAddr(d.to) && d.to !== from ? d.to : fail('bad account to move them to');
		// (the Heart upgrade: it says which, 20 at once: not looked for in everyone's)
		if (s.heart && !(Array.isArray(d.items) && d.items.length >= 1 && d.items.length <= 20 && new Set(d.items).size === d.items.length && d.items.every((x) => typeof x === 'string' && x.length <= 140))) fail('items: which of them, "creator/item", at most 20 at once');
		const mine = s.heart ? (d.items as string[]).map((x) => `${from}/${x}`).filter((k) => !!s.owned && own(s.owned, k)) : Object.keys(s.owned ?? {}).filter((k) => k.startsWith(from + '/'));
		if (!mine.length) fail('this key owns nothing to move');
		return () => {
			for (const k of mine) {
				const rest = k.slice(from.length + 1), dst = `${to}/${rest}`, a = s.owned![k], b = own(s.owned!, dst) ? s.owned![dst] : null;
				// the account it moves to may own it too (a membership bought twice): keep the longer one
				s.owned![dst] = b ? { ...a, ...b, until: a.until !== undefined || b.until !== undefined ? Math.max(a.until ?? 0, b.until ?? 0) : undefined } : a;
				if (s.owned![dst].until === undefined) delete s.owned![dst].until;
				delete s.owned![k];
				if (s.listings && own(s.listings, k)) { delete s.listings[k]; if (emptyOf(s.listings)) delete s.listings; } // moved: no longer offered
			}
			void time;
		};
	},
	/** a creator pays the fees they owe for outside payments, in any coin the chain prices */
	'fee.settle'(s, from, d, _id, time) {
		const owed = feeOwedOf(s, from); if (!owed) fail('you owe no fees');
		const asset = d.asset === undefined ? NATIVE : assetOf(s, d.asset);
		const cost = usdCost(s, asset, owed, time) ?? fail(`the chain has no price for ${asset} right now`);
		if (balanceOf(s, from, asset) < cost) fail('not enough balance');
		return () => { sub(s, from, asset, cost); add(s, RULES.saleFeeTo, asset, cost); delete s.feeOwed![from]; };
	},

	/* ---- tasks: a site pays its users for doing something (signing up, buying, reviewing, inviting), from its own coins ---- */
	/** post a task: `reward` of `asset` for each of up to `count` accounts that `checker` (default: you) signs as done */
	'task.create'(s, from, d, id, time) {
		const asset = assetOf(s, d.asset), reward = amountOf(d.reward);
		const count = typeof d.count === 'number' && Number.isSafeInteger(d.count) && d.count >= 1 && d.count <= 5000 ? d.count : fail('count is 1 to 5,000');
		const checker = d.checker === undefined ? from : isAddr(d.checker) ? d.checker : fail('bad checker');
		const until = Number.isSafeInteger(d.until) && (d.until as number) > time && (d.until as number) <= time + RULES.maxOfferTime ? (d.until as number) : fail('a task\'s end must be in the future, and within a year');
		if (d.note !== undefined && (typeof d.note !== 'string' || d.note.length > RULES.memoMax)) fail('bad note');
		const total = reward * count;
		if (!Number.isSafeInteger(total)) fail('that is more than the chain can count');
		if (!Number.isSafeInteger(total)) fail('that is too much');
		if (balanceOf(s, from, asset) < total) fail(`posting it locks all the rewards: ${total} parts of ${asset}`);
		const key = 'q' + id.slice(0, 16);
		if (s.tasks && own(s.tasks, key)) fail('task already exists');
		return () => { sub(s, from, asset, total); (s.tasks ??= {})[key] = { by: from, asset, reward, left: count, checker, until, done: {}, ...(d.note ? { note: d.note as string } : {}) }; };
	},
	/** claim a task's reward: `sig` is the checker's signature of taskMessage(chain, id, to). Once per account. Anyone may send it. */
	'task.claim'(s, _from, d, _id, time, ctx) {
		const key = s.tasks && own(s.tasks, d.id) ? d.id : fail('no such task (never posted, finished, or closed)'), task = s.tasks![key];
		const to = isAddr(d.to) ? d.to : fail('bad receiver');
		if (time > task.until) fail('this task has ended');
		if (own(task.done, to)) fail('this account has already been rewarded for this task');
		if (!ctx.taskOk) fail('the claim must be signed by the task\'s checker');
		return () => {
			add(s, to, task.asset, task.reward); task.done[to] = 1; task.left -= 1;
			if (!task.left) { delete s.tasks![key]; if (emptyOf(s.tasks!)) delete s.tasks; }
		};
	},
	/** the site closes its task and takes back the rewards nobody has claimed */
	'task.close'(s, from, d) {
		const key = s.tasks && own(s.tasks, d.id) ? d.id : fail('no such task'), task = s.tasks![key];
		if (task.by !== from) fail('only the site that posted a task can close it');
		return () => { add(s, from, task.asset, task.reward * task.left); delete s.tasks![key]; if (emptyOf(s.tasks!)) delete s.tasks; };
	},

	/* ---- gifts: send to anyone by link (email, chat, a QR code), even before they have an account ---- */
	/** hold coins for whoever holds the claim key `key` (an address whose secret only the link carries) */
	'gift.create'(s, from, d, id, time) {
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount), key = isAddr(d.key) && d.key !== from ? d.key : fail('bad claim key');
		const until = Number.isSafeInteger(d.until) && (d.until as number) > time && (d.until as number) <= time + RULES.maxOfferTime ? (d.until as number) : fail('a gift\'s end must be in the future, and within a year');
		if (d.note !== undefined && (typeof d.note !== 'string' || d.note.length > RULES.memoMax)) fail('bad note');
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		const gid = 'g' + id.slice(0, 16);
		if (s.gifts && own(s.gifts, gid)) fail('gift already exists');
		return () => { sub(s, from, asset, amount); (s.gifts ??= {})[gid] = { from, asset, amount, key, until, ...(d.note ? { note: d.note as string } : {}) }; };
	},
	/** claim a gift to any account: `sig` is the claim key's signature of giftMessage(chain, id, to). Anyone may send this
	    (the welcome fund pays the fee for a newcomer); only the link's holder can make the signature. */
	'gift.claim'(s, _from, d, _id, time, ctx) {
		const gid = s.gifts && own(s.gifts, d.id) ? d.id : fail('no such gift (never made, already claimed, or taken back)'), g = s.gifts![gid];
		const to = isAddr(d.to) ? d.to : fail('bad receiver');
		if (time > g.until) fail('this gift has ended: its sender can take it back');
		if (!ctx.giftOk) fail('the claim must be signed with the gift\'s key (from its link)');
		return () => { add(s, to, g.asset, g.amount); delete s.gifts![gid]; if (emptyOf(s.gifts!)) delete s.gifts; };
	},
	/** the sender takes back a gift nobody claimed in time */
	'gift.refund'(s, from, d, _id, time) {
		const gid = s.gifts && own(s.gifts, d.id) ? d.id : fail('no such gift'), g = s.gifts![gid];
		if (g.from !== from) fail('only its sender can take a gift back');
		if (time <= g.until) fail('this gift can still be claimed: wait for its end');
		return () => { add(s, from, g.asset, g.amount); delete s.gifts![gid]; if (emptyOf(s.gifts!)) delete s.gifts; };
	},

	/* ---- records: an app's data on the chain (sign-ups, profiles, orders, entries, documents) ---- */
	/** keep (or replace) a record at <you>/<space>/<key>: a small `value`, or a file's `hash` and `link`; it pays for its size, once */
	'record.put'(s, from, d, _id, time, ctx) {
		for (const k of Object.keys(d)) if (!['space', 'key', 'value', 'hash', 'link'].includes(k)) fail(`"${k}" is not expected here`);
		const space = typeof d.space === 'string' && SPACE.test(d.space) ? d.space : fail('space: 1 to 32 lower-case letters, digits or dashes');
		const key = typeof d.key === 'string' && RKEY.test(d.key) ? d.key : fail('key: 1 to 64 letters, digits, dots, dashes, colons or underscores');
		if ((d.value === undefined) === (d.hash === undefined)) fail('a record holds a value, or a file\'s hash: one of the two');
		if (d.value !== undefined && canon(d.value).length > RULES.recordMax) fail(`a record's value is at most ${RULES.recordMax} characters: keep a bigger file elsewhere and record its hash`);
		if (d.hash !== undefined && !(typeof d.hash === 'string' && /^[0-9a-f]{64}$/.test(d.hash))) fail('hash: the SHA-256 of the file, 64 hex digits');
		if (d.link !== undefined && (d.hash === undefined || typeof d.link !== 'string' || d.link.length > 200 || !/^(https|ipfs|ar):\/\/[\x21-\x7e]+$/.test(d.link))) fail('link: https://, ipfs:// or ar://, at most 200 characters, with a hash');
		const k = `${from}/${space}/${key}`, isNew = !(s.records && own(s.records, k));
		if (space === 'capture' && resaleOn(s, ctx.height) && soldCount(s, from, key)) fail('someone owns this: its capture cannot change any more');
		if (space === 'items' && nftItemsOn(s, ctx.height)) { const why = nftItemProblem(s, from, d.value); if (why) fail(why); }
		if (space === 'items' && bizOn(s, ctx.height)) { const why = bizProblem(d.value); if (why) fail(why); }
		if (space === 'items' && resaleOn(s, ctx.height)) { const why = soldLock(s, from, key, d.value ?? null); if (why) fail(why); }
		// (the Heart upgrade: no count of everyone's records for each new one; the day's price keeps them in bounds)
		if (!s.heart && isNew && keysOf(s.records ?? {}).filter((x) => x.startsWith(from + '/')).length >= RULES.maxRecords) fail(`at most ${RULES.maxRecords} records for one account`);
		const fee = recordFee(space, key, d as { value?: unknown; hash?: string; link?: string }) * keptTimes(s) + (space === 'items' && resaleOn(s, ctx.height) ? itemFileFee(s, from, key, d.value) : 0);
		if (balanceOf(s, ctx.payer, NATIVE) < fee) fail(`keeping this record costs ${fee / DZY} DZY, and the payer does not hold it`);
		return () => {
			sub(s, ctx.payer, NATIVE, fee); toTreasury(s, fee); keptAdd(s, space.length + key.length + (d.value !== undefined ? canon(d.value).length : 64 + ((d.link as string | undefined)?.length ?? 0)));
			(s.records ??= {})[k] = { ...(d.value !== undefined ? { value: d.value } : { hash: d.hash as string, ...(d.link ? { link: d.link as string } : {}) }), at: time };
		};
	},
	/** delete one of your records (nothing is given back: the fee paid for keeping it until now) */
	'record.delete'(s, from, d) {
		const k = typeof d.space === 'string' && typeof d.key === 'string' ? `${from}/${d.space}/${d.key}` : fail('space and key');
		if (!(s.records && own(s.records, k))) fail('no such record');
		if (d.space === 'capture' && resaleOn(s) && soldCount(s, from, d.key as string)) fail('someone owns this: its capture cannot change any more');
		if (d.space === 'items' && resaleOn(s)) { const why = soldLock(s, from, d.key as string, null); if (why) fail(why); }
		return () => { delete s.records![k]; if (emptyOf(s.records!)) delete s.records; };
	},

	/* ---- streams: pay by the minute (subscriptions, salaries, rent, AI compute); nothing is sent while one runs ---- */
	/** open a stream of `perMinute` to `to`, paying `deposit` into it now (DZY, or `asset`) */
	'stream.open'(s, from, d, id, time) {
		for (const k of Object.keys(d)) if (!['to', 'asset', 'perMinute', 'deposit', 'note'].includes(k)) fail(`"${k}" is not expected here`);
		const to = isAddr(d.to) && d.to !== from ? d.to : fail('bad receiver (and you cannot stream to yourself)');
		const asset = d.asset === undefined ? NATIVE : assetOf(s, d.asset), perMinute = amountOf(d.perMinute), deposit = amountOf(d.deposit);
		if (deposit < perMinute) fail('the deposit must cover at least one minute');
		if (d.note !== undefined && (typeof d.note !== 'string' || d.note.length > RULES.memoMax)) fail('bad note');
		if (!s.heart && keysOf(s.streams ?? {}).filter((k) => (peek(s.streams!, k) as { from: string }).from === from).length >= RULES.maxStreams) fail(`at most ${RULES.maxStreams} open streams for one payer`);
		if (balanceOf(s, from, asset) < deposit) fail('not enough balance');
		const sid = 's' + id.slice(0, 16);
		if (s.streams && own(s.streams, sid)) fail('stream already exists');
		return () => { sub(s, from, asset, deposit); (s.streams ??= {})[sid] = { from, to, asset, perMinute, held: deposit, owed: 0, start: time, ...(d.note ? { note: d.note as string } : {}) }; };
	},
	/** the receiver collects what has flowed so far */
	'stream.withdraw'(s, from, d, _id, time) {
		const sid = s.streams && own(s.streams, d.id) ? d.id : fail('no such stream'), st = s.streams![sid];
		if (from !== st.to) fail('only its receiver can withdraw');
		if (st.owed + streamFlow(st, time).flowed === 0) fail('nothing has flowed yet');
		return () => { streamRebase(st, time); add(s, st.to, st.asset, st.owed); st.owed = 0; if (!st.held) { delete s.streams![sid]; if (emptyOf(s.streams!)) delete s.streams; } };
	},
	/** the payer adds to it (a stream that ran dry starts again from now: nothing is owed for the dry time) */
	'stream.topup'(s, from, d, _id, time) {
		const sid = s.streams && own(s.streams, d.id) ? d.id : fail('no such stream'), st = s.streams![sid];
		if (from !== st.from) fail('only its payer can top it up');
		const amount = amountOf(d.amount);
		if (balanceOf(s, from, st.asset) < amount) fail('not enough balance');
		return () => { streamRebase(st, time); sub(s, from, st.asset, amount); st.held += amount; };
	},
	/** either side stops it: the receiver gets what has flowed, the payer the rest */
	'stream.stop'(s, from, d, _id, time) {
		const sid = s.streams && own(s.streams, d.id) ? d.id : fail('no such stream'), st = s.streams![sid];
		if (from !== st.from && from !== st.to) fail('only its payer or receiver can stop it');
		return () => {
			streamRebase(st, time);
			if (st.owed) add(s, st.to, st.asset, st.owed);
			if (st.held) add(s, st.from, st.asset, st.held);
			delete s.streams![sid]; if (emptyOf(s.streams!)) delete s.streams;
		};
	},

	/* ---- hash locks: swaps with any other chain, and pay-on-proof ---- */
	/** lock coins for `to`, who gets them by showing the secret behind `hash` before `until`; otherwise they come back */
	'swap.lock'(s, from, d, id, time) {
		const to = isAddr(d.to) && d.to !== from ? d.to : fail('bad receiver');
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		const hash = typeof d.hash === 'string' && /^[0-9a-f]{64}$/.test(d.hash) ? d.hash : fail('the hash is 64 hex letters (SHA-256 of the secret)');
		const until = Number.isSafeInteger(d.until) && (d.until as number) > time && (d.until as number) <= time + RULES.maxSwapTime ? (d.until as number) : fail('a lock\'s end must be in the future, and within 30 days');
		if (d.note !== undefined && (typeof d.note !== 'string' || d.note.length > RULES.memoMax)) fail('bad note');
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		const key = 'sw' + id.slice(0, 16);
		if (s.swaps && own(s.swaps, key)) fail('lock already exists');
		return () => { sub(s, from, asset, amount); (s.swaps ??= {})[key] = { from, to, asset, amount, hash, until, ...(d.note ? { note: d.note as string } : {}) }; };
	},
	/** show the secret before the end: the coins go to the receiver. Anyone may send this (a helper can claim for you). */
	'swap.claim'(s, _from, d, _id, time, ctx) {
		const key = s.swaps && own(s.swaps, d.id) ? d.id : fail('no such lock');
		const w = s.swaps![key];
		if (time >= w.until) fail('this lock has ended: it can only be refunded');
		if (typeof d.secret !== 'string' || !/^[0-9a-f]{64}$/.test(d.secret)) fail('the secret is 64 hex letters (32 bytes)');
		if (ctx.secretHash !== w.hash) fail('that is not the secret');
		return () => { add(s, w.to, w.asset, w.amount); closeSwap(s, key, { id: key, h: ctx.height, hash: w.hash, secret: d.secret as string }); };
	},
	/** after the end, the coins go back to whoever locked them. Anyone may send this. */
	'swap.refund'(s, _from, d, _id, time, ctx) {
		const key = s.swaps && own(s.swaps, d.id) ? d.id : fail('no such lock');
		const w = s.swaps![key];
		if (time < w.until) fail('this lock has not ended yet');
		return () => { add(s, w.from, w.asset, w.amount); closeSwap(s, key, { id: key, h: ctx.height, hash: w.hash, refunded: true }); };
	},

	/* ---- one account, several devices ---- */
	/** let another device's key sign for this account (or switch the first key back on) */
	'key.add'(s, from, d) {
		const a = existing(s, from), key = isAddr(d.key) ? d.key : fail('bad key');
		if (key === from) return a.off ? () => { delete a.off; } : fail('that key is already on this account');
		if (a.keys?.includes(key)) fail('that key is already on this account');
		if ((a.keys?.length ?? 0) >= RULES.maxKeys) fail(`an account can have ${RULES.maxKeys} extra keys`);
		return () => { (a.keys ??= []).push(key); };
	},
	/** take a device's key off this account (a lost or sold device). At least one key always stays. */
	'key.remove'(s, from, d) {
		const a = existing(s, from), key = isAddr(d.key) ? d.key : fail('bad key');
		const extra = a.keys?.length ?? 0;
		if (key === from) {
			if (a.off) fail('that key is not on this account');
			if (!extra) fail('an account needs at least one key');
			return () => { a.off = true; };
		}
		const i = a.keys?.indexOf(key) ?? -1;
		if (i < 0) fail('that key is not on this account');
		if (a.off && extra === 1) fail('an account needs at least one key');
		return () => { a.keys!.splice(i, 1); if (!a.keys!.length) delete a.keys; };
	},

	/* ---- limited keys for agents and apps ---- */
	/** give a key a spending allowance: one asset, a total amount, an end time. Only a full key can do this. */
	'agent.allow'(s, from, d, _id, time) {
		const a = existing(s, from), key = isAddr(d.key) && d.key !== from ? d.key : fail('bad key');
		if (a.keys?.includes(key)) fail('that key already has full access');
		const asset = assetOf(s, d.asset), max = amountOf(d.max);
		const until = typeof d.until === 'number' && Number.isSafeInteger(d.until) && d.until > time ? d.until : fail('the end time must be in the future');
		const fees = d.fees === undefined ? 0 : typeof d.fees === 'number' && Number.isSafeInteger(d.fees) && d.fees >= 0 ? d.fees : fail('bad fee allowance');
		if (!(a.agents && own(a.agents, key)) && Object.keys(a.agents ?? {}).length >= RULES.maxKeys) fail(`an account can have ${RULES.maxKeys} agent keys`);
		return () => { (a.agents ??= {})[key] = { asset, left: max, until, ...(fees ? { fees } : {}) }; };
	},
	'agent.revoke'(s, from, d) {
		const a = existing(s, from);
		const key = a.agents && own(a.agents, d.key) ? d.key : fail('that agent key is not on this account');
		return () => { delete a.agents![key]; if (!Object.keys(a.agents!).length) delete a.agents; };
	},

	/* ---- getting back in after losing every device ----
	   The owner may name a guardian. A guardian cannot move anything: it can only ask for a new key to be added,
	   and that request waits out a delay during which any of the owner's keys can cancel it. */
	'guardian.set'(s, from, d) {
		const a = existing(s, from);
		const g = d.guardian === null ? null : isAddr(d.guardian) && d.guardian !== from ? d.guardian : fail('bad guardian');
		return () => { if (g) a.guardian = g; else delete a.guardian; delete a.recover; };
	},
	'recover.start'(s, from, d, _id, time) {
		const t = own(s.accounts, d.account) ? s.accounts[d.account] : fail('no such account');
		if (t.guardian !== from) fail('only that account\'s guardian can start a recovery');
		const key = isAddr(d.key) && d.key !== d.account ? d.key : fail('bad key');
		if (t.keys?.includes(key)) fail('that key is already on this account');
		return () => { t.recover = { key, at: time + RULES.recoverDelay }; };
	},
	'recover.cancel'(s, from) {
		const a = existing(s, from);
		if (!a.recover) fail('there is no recovery to cancel');
		return () => { delete a.recover; };
	},
	/** after the delay, anyone with an account may complete it: the new key joins, nothing else changes */
	/** Set this account's hash key: one no quantum computer breaks (wots.ts). Its root goes on the chain; its 32 secret bytes stay with
	    the owner. Once set, only the hash key itself changes it: a thief with the ordinary key cannot. */
	'q.set'(s, from, d) {
		if (!s.heart?.fut) fail('hash keys are not open on this chain yet');
		for (const k of Object.keys(d)) if (k !== 'root') fail(`"${k}" is not expected here`);
		existing(s, from); if (s.accounts[from].q) fail('it has one already: only that key changes it');
		const root = typeof d.root === 'string' && /^[0-9a-f]{64}$/.test(d.root) ? d.root : fail('root: the hash key\'s root');
		return () => { s.accounts[from].q = { root, n: 0 }; };
	},
	/** Signed by an account's hash key, handed in by anyone (who pays the fee). It names the next hash key (each signs once), and may:
	    put a new ordinary key in charge, every other way in gone (`key`); say that from now on nothing but the hash key moves the
	    account (`only`: true, or false to end that); and do one thing as the account (`act`). */
	'q.run'(s, _from, d, id, time, ctx) {
		if (!s.heart?.fut) fail('hash keys are not open on this chain yet');
		for (const k of Object.keys(d)) if (!['account', 'root', 'key', 'only', 'act', 'seed', 'sig'].includes(k)) fail(`"${k}" is not expected here`);
		const who = typeof d.account === 'string' && own(s.accounts, d.account) ? d.account : fail('no such account'), a = s.accounts[who], q = a.q ?? fail('that account has no hash key');
		const root = typeof d.root === 'string' && /^[0-9a-f]{64}$/.test(d.root) && d.root !== q.root ? d.root : fail('root: the next hash key, a new one');
		const key = d.key === undefined ? undefined : isAddr(d.key) && d.key !== who ? d.key : fail('key: the new ordinary key'), only = d.only === undefined || typeof d.only === 'boolean' ? d.only : fail('only: true or false');
		const act = d.act === undefined ? undefined : d.act && typeof d.act === 'object' && !Array.isArray(d.act) && Object.keys(d.act).sort().join() === 'data,type' ? (d.act as { type: string; data: Record<string, unknown> }) : fail('act: { type, data }');
		if (act && (!Q_ACTS.has(act.type) || !act.data || typeof act.data !== 'object' || Array.isArray(act.data))) fail('a hash key does not do that: it sends, takes back stakes and offers, changes coins and keys');
		if (typeof d.seed !== 'string' || typeof d.sig !== 'string' || wotsRoot(d.seed, d.sig, qMessage(s.chain, who, q.n, { root, key, only, act })) !== q.root) fail('that is not signed by the account\'s hash key');
		const run = act ? HANDLERS[act.type](s, who, act.data, id, time, ctx) : null;
		return () => {
			run?.(); const x = account(s, who), on = only === undefined ? x.q?.only : only || undefined;
			x.q = { root, n: q.n + 1, ...(on ? { only: true as const } : {}) };
			if (key) { x.keys = [key]; x.off = true; delete x.agents; delete x.guardian; delete x.recover; delete x.multi; }
		};
	},
	/** Make a lock validator stake (the last rules). It leaves the lockers' share and joins the account's stake, where it counts in the
	    raffle for blocks (from now: its seconds start again) and pays for cheating. It stays held until the minute the lock would have
	    ended: a lock is a promise, and moving it never shortens it. */
	'lock.stake'(s, from, d) {
		if (!s.heart?.fut || !s.sun) fail('locks become stake from the last rules on');
		for (const k of Object.keys(d)) if (k !== 'id') fail(`"${k}" is not expected here`);
		const l = lockOf(s, from, d.id) ?? fail('no such lock of yours'); if (s.stakes?.[from]?.tomb) fail('this key was caught signing two different votes and can never stake again');
		return () => { const clock = bondAdded(s, from, l.amt), { amt, end } = lockOut(s, from, l.id), st = stakeOf(s, from); st.bond += amt; (st.kept ??= []).push({ n: amt, m: end }); clock?.(st); };
	},
	'recover.finish'(s, from, d, _id, time) {
		existing(s, from);
		const t = own(s.accounts, d.account) ? s.accounts[d.account] : fail('no such account');
		const r = t.recover ?? fail('there is no recovery waiting');
		if (time < r.at) fail('the waiting time is not over yet');
		return () => { if (!t.keys?.includes(r.key)) (t.keys ??= []).push(r.key); delete t.recover; };
	},

	/* ---- staking: locking up DZY to make blocks ----
	   A validator's key is its account. Locked DZY gives it a seat (the most-staked keys, up to maxValidators); it can be
	   taken out only after unbondDelay, so a validator cannot cheat and leave with its stake in the same moment. */
	'stake.bond'(s, from, d) {
		const amount = amountOf(d.amount);
		if (s.stakes?.[from]?.tomb) fail('this key was caught signing two different votes and can never stake again; use a new key');
		if (balanceOf(s, from, NATIVE) < amount) fail('not enough DZY');
		return () => { const clock = bondAdded(s, from, amount); sub(s, from, NATIVE, amount); const st = stakeOf(s, from); st.bond += amount; clock?.(st); };
	},
	'stake.unbond'(s, from, d, _id, time) {
		const amount = amountOf(d.amount), st = s.stakes && own(s.stakes, from) ? s.stakes[from] : fail('this account has nothing staked');
		if (st.bond < amount) fail('that is more than is staked');
		const held = keptNow(s, st); if (st.bond - amount < held) fail(`${(held / DZY).toLocaleString('en-US')} DZY of this stake came from a lock, and stays until that lock would have ended: at most ${((st.bond - held) / DZY).toLocaleString('en-US')} DZY can be taken back now`);
		if ((st.unbonding?.length ?? 0) >= RULES.maxUnbonding) fail(`at most ${RULES.maxUnbonding} unlocks can wait at once; withdraw first`);
		return () => { st.bond -= amount; (st.unbonding ??= []).push({ amount, at: time + RULES.unbondDelay }); };
	},
	/** take out every unlock whose waiting time is over */
	'stake.withdraw'(s, from, _d, _id, time) {
		const st = s.stakes && own(s.stakes, from) ? s.stakes[from] : fail('this account has nothing staked');
		const ready = (st.unbonding ?? []).filter((u) => u.at <= time);
		if (!ready.length) fail('nothing has finished unlocking yet');
		const total = ready.reduce((n, u) => n + u.amount, 0);
		return () => {
			st.unbonding = st.unbonding!.filter((u) => u.at > time);
			if (!st.unbonding.length) delete st.unbonding;
			add(s, from, NATIVE, total); tidyStake(s, from);
		};
	},
	/** back a validator with your DZY: it counts toward its seat and its say. If it is caught cheating, you lose the same share. */
	'stake.delegate'(s, from, d) {
		const v = isAddr(d.validator) && d.validator !== from ? d.validator : fail('name the validator to back (not yourself)');
		// on a chain with the Sun anyone with 1% of a seat staked is a candidate holders may back, so a newcomer can gather
		// the rest of a seat from people who trust it; elsewhere only a staked validator
		if (s.sun ? !isCandidate(s, v) : !isStaker(s, v)) fail(s.sun ? 'that key has not staked the 1% of a seat that makes it a candidate' : 'that key is not a staked validator right now');
		const amount = amountOf(d.amount);
		if (balanceOf(s, from, NATIVE) < amount) fail('not enough DZY');
		// (the Heart upgrade: at least 1 DZY behind each, so a validator's pay is never shared among thousands of grains)
		if (s.heart && amount + (s.delegations && own(s.delegations, v) && own(s.delegations[v], from) ? s.delegations[v][from] : 0) < DZY) fail('back a validator with at least 1 DZY');
		const mine = Object.values(s.delegations ?? {}).filter((m) => own(m, from)).length;
		if (!(s.delegations && own(s.delegations, v) && own(s.delegations[v], from)) && mine >= RULES.maxDelegations) fail(`you can back at most ${RULES.maxDelegations} validators at once`);
		return () => { backAdded(s, v, from, amount); sub(s, from, NATIVE, amount); const m = ((s.delegations ??= {})[v] ??= {}); m[from] = (own(m, from) ? m[from] : 0) + amount; };
	},
	/** stop backing a validator with some DZY: it comes back after the same wait as a validator's own stake */
	'stake.undelegate'(s, from, d, _id, time) {
		const v = typeof d.validator === 'string' && s.delegations && own(s.delegations, d.validator) && own(s.delegations[d.validator], from) ? d.validator : fail('you are not backing that validator');
		const amount = amountOf(d.amount), m = s.delegations![v];
		if (m[from] < amount) fail('that is more than you back it with');
		if (s.heart && m[from] - amount > 0 && m[from] - amount < DZY) fail('leave at least 1 DZY behind it, or take all of it back');
		if ((s.undelegating?.[from]?.length ?? 0) >= RULES.maxUnbonding) fail(`at most ${RULES.maxUnbonding} unlocks can wait at once; claim first`);
		return () => {
			m[from] -= amount; if (!m[from]) { delete m[from]; backGone(s, v, from); }
			if (!Object.keys(m).length) { delete s.delegations![v]; if (emptyOf(s.delegations!)) delete s.delegations; }
			((s.undelegating ??= {})[from] ??= []).push({ v, amount, at: time + RULES.unbondDelay });
		};
	},
	/** take back every delegation whose wait is over */
	'stake.claim'(s, from, _d, _id, time) {
		const list = s.undelegating && own(s.undelegating, from) ? s.undelegating[from] : fail('nothing is on its way back to you');
		const ready = list.filter((u) => u.at <= time);
		if (!ready.length) fail('nothing has finished unlocking yet');
		const total = ready.reduce((n, u) => n + u.amount, 0);
		return () => {
			const rest = list.filter((u) => u.at > time);
			if (rest.length) s.undelegating![from] = rest; else { delete s.undelegating![from]; if (emptyOf(s.undelegating!)) delete s.undelegating; }
			if (total > 0) add(s, from, NATIVE, total);
		};
	},
	/** the crew upgrade: a staked key's node says it is online, and where to reach it (other nodes connect to it) */
	'node.checkin'(s, from, d, _id, time) {
		if (!crewOn(s)) fail('nodes check in from the crew upgrade on');
		if (!isCandidate(s, from)) fail(`stake at least ${RULES.crewMinStake / DZY} DZY first`);
		// a public address makes it reachable, and so able to be drawn to make blocks; without one, it only checks
		const url = d.url === undefined ? undefined : typeof d.url === 'string' && d.url.length <= 200 && /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(d.url) ? d.url.replace(/\/+$/, '') : fail('a node\'s public address is http or https');
		// the block it checked: one of the last few, by height and hash. A node following another chain cannot know it
		const seen = d.seen, h = Array.isArray(seen) && Number.isSafeInteger(seen[0]) ? seen[0] : fail('say which block this node checked: seen = [height, hash]');
		const known = h === s.height ? s.last : s.recent && h >= s.recent.h && h < s.recent.h + s.recent.hashes.length ? s.recent.hashes[h - s.recent.h] : null;
		if (known === null) fail(`that block is not one of the last ${RULES.recentBlocks}: check a newer one`);
		if (seen[1] !== known) fail(`that is not this chain's block ${h}: this node follows something else`);
		const was = s.nodes && own(s.nodes, from) ? s.nodes[from] : null;
		if (was && time - was.at < RULES.checkinGapMs) fail('this node checked in a moment ago');
		// the hours it was seen in since the last pay day (one count per clock hour, however often it checks in)
		const hr = Math.floor(time / 3_600_000), hrs = was?.hr === hr ? (was.hrs ?? 1) : (was?.hrs ?? 0) + 1;
		if (d.big !== undefined && !(s.heart && Number.isSafeInteger(d.big) && (d.big as number) >= HEART.sizeMin && (d.big as number) <= HEART.sizeMax)) fail('big: the biggest block this node takes, in bytes');
		const seat = s.heart && url !== undefined ? seatFor(s, from, was, time) : undefined;
		return () => { (s.nodes ??= {})[from] = { ...(url === undefined ? {} : { url }), at: time, hr, hrs, ...(s.heart ? clockAfter(s, was, time) : {}), ...(seat ? { seat } : {}), ...(d.big !== undefined ? { big: d.big as number } : {}) }; };
	},
	/** the crew upgrade: the share of its pay an operator keeps before its backers' share (basis points, 0 to 10,000) */
	'stake.commission'(s, from, d) {
		const st = s.stakes && own(s.stakes, from) ? s.stakes[from] : fail('this account has nothing staked');
		const bp = typeof d.bp === 'number' && Number.isSafeInteger(d.bp) && d.bp >= 0 && d.bp <= 10_000 ? d.bp : fail('a commission is 0 to 10,000 basis points');
		return () => { st.commission = bp; };
	},
	/** a benched validator asks to come back, once its time is over */
	'validator.unjail'(s, from, _d, _id, time) {
		const st = s.stakes && own(s.stakes, from) ? s.stakes[from] : fail('this account has nothing staked');
		const until = st.jailed ?? fail('this validator is not benched');
		if (time < until) fail('the waiting time is not over yet');
		return () => { delete st.jailed; delete st.missed; };
	},
	/** Proof that a validator signed two different votes in the same place (same height, round and kind). Anyone may
	    send it. The signatures were checked before this (see applyTx). The validator loses slashPct of everything it has
	    staked, including what is unlocking, and is barred for good; the sender gets reporterPct of that; the rest goes to the treasury. */
	evidence(s, from, d) {
		const a = voteOf(d.a), b = voteOf(d.b);
		if (a.validator !== b.validator || a.type !== b.type || a.height !== b.height || a.round !== b.round) fail('those votes are not in the same place');
		if (a.block === b.block) fail('those votes agree');
		if (a.height > s.height + 1) fail('that height has not happened yet');
		const v = a.validator, st = s.stakes && own(s.stakes, v) ? s.stakes[v] : fail('that key has nothing staked');
		if (st.tomb) fail('that validator has already been punished');
		if (v === from) fail('you cannot report yourself');
		const held = st.bond + (st.unbonding ?? []).reduce((n, u) => n + u.amount, 0);
		const penalty = mulDiv(held, crewOn(s) ? RULES.crewSlashPct : RULES.slashPct, 100), reward = mulDiv(penalty, RULES.reporterPct, 100);
		// those who backed it lose the same share, of what backs it and of what is on its way back from it
		const cut = (n: number) => mulDiv(n, RULES.slashPct, 100);
		return () => {
			let backers = 0;
			const m = s.delegations?.[v];
			if (m) for (const k of Object.keys(m)) { const c = cut(m[k]); m[k] -= c; backers += c; if (!m[k]) delete m[k]; }
			if (m && !Object.keys(m).length) { delete s.delegations![v]; if (emptyOf(s.delegations!)) delete s.delegations; }
			for (const list of Object.values(s.undelegating ?? {})) for (const u of list) if (u.v === v) { const c = cut(u.amount); u.amount -= c; backers += c; }
			if (!s.heart?.proof) toTreasury(s, backers);
			let left = penalty; // taken from the seat first, then from what is unlocking
			const take = Math.min(st.bond, left); st.bond -= take; left -= take;
			for (const u of st.unbonding ?? []) { const t = Math.min(u.amount, left); u.amount -= t; left -= t; }
			if (st.unbonding) { st.unbonding = st.unbonding.filter((u) => u.amount > 0); if (!st.unbonding.length) delete st.unbonding; }
			st.tomb = true; delete st.missed; delete st.jailed;
			if (reward) add(s, from, NATIVE, reward);
			if (s.heart?.proof) s.sun!.council.bonus += penalty - reward + backers; // the proof rules: the bonus, drawn among the honest
			else toTreasury(s, penalty - reward);
		};
	},

	/** The treasury pays out: grants, rewards, running the network. Only the chain's issuing key may ask, it must say
	    why (written on the chain for anyone to read), and it cannot pay itself. */
	'treasury.spend'(s, from, d) {
		if (s.sun) fail('nobody can pay out the Sun: it pays only by its formulas');
		if (from !== s.authority) fail('only the chain\'s issuing key can pay from the treasury');
		const amount = amountOf(d.amount), to = isAddr(d.to) ? d.to : fail('bad receiver');
		if (to === from) fail('the treasury cannot pay the issuing key itself');
		if (typeof d.reason !== 'string' || d.reason.trim().length < RULES.reasonMin || d.reason.length > RULES.reasonMax) fail('say what the payment is for');
		if ((s.treasury ?? 0) < amount) fail('the treasury does not hold that much');
		return () => { s.treasury! -= amount; if (!s.treasury) delete s.treasury; add(s, to, NATIVE, amount); };
	},

	/** Propose a treasury payout. Anyone with DZY staked or delegated may; it says why, and is open for RULES.voteDays. */
	'treasury.propose'(s, from, d, id, time) {
		if (s.sun) fail('nobody can pay out the Sun: it pays only by its formulas');
		if (voteWeight(s, from) <= 0) fail('only someone with DZY staked or delegated can propose');
		const amount = amountOf(d.amount), to = isAddr(d.to) ? d.to : fail('bad receiver');
		if (typeof d.reason !== 'string' || d.reason.trim().length < RULES.reasonMin || d.reason.length > RULES.reasonMax) fail('say what the payment is for');
		if (Object.keys(s.proposals ?? {}).length >= RULES.maxProposals) fail('too many proposals are open: wait for some to end');
		const key = 'p' + id.slice(0, 16);
		if (s.proposals && own(s.proposals, key)) fail('proposal already exists');
		return () => { (s.proposals ??= {})[key] = { by: from, to, amount, reason: d.reason as string, until: time + RULES.voteDays, votes: {} }; };
	},
	/** Vote yes or no (or change your vote) while a proposal is open. Votes count at the voter's stake when counted, so stake
	    cannot be voted twice. The moment more than two thirds of all stake says yes, it is paid, if the treasury holds enough. */
	'treasury.vote'(s, from, d, _id, time) {
		const key = s.proposals && own(s.proposals, d.id) ? d.id : fail('no such proposal'), p = s.proposals![key];
		if (time > p.until) fail('voting on this proposal has ended');
		if (typeof d.yes !== 'boolean') fail('vote yes: true or yes: false');
		if (voteWeight(s, from) <= 0) fail('only someone with DZY staked or delegated can vote');
		const votes = { ...p.votes, [from]: d.yes as boolean };
		const yes = Object.entries(votes).filter(([, y]) => y).reduce((n, [a]) => n + voteWeight(s, a), 0), all = totalVoteWeight(s);
		const passes = yes * 3 > all * 2 && (s.treasury ?? 0) >= p.amount;
		return () => {
			p.votes = votes;
			if (!passes) return;
			s.treasury! -= p.amount; if (!s.treasury) delete s.treasury; add(s, p.to, NATIVE, p.amount);
			delete s.proposals![key]; if (emptyOf(s.proposals!)) delete s.proposals;
		};
	},
	/** anyone may clear away a proposal whose voting has ended without passing */
	'treasury.close'(s, _from, d, _id, time) {
		const key = s.proposals && own(s.proposals, d.id) ? d.id : fail('no such proposal');
		if (time <= s.proposals![key].until) fail('voting on this proposal has not ended');
		return () => { delete s.proposals![key]; if (emptyOf(s.proposals!)) delete s.proposals; };
	},

	/* ---- contributors (the Heart upgrade): 10% of every fee waits here; whoever has stake proposes whom it pays ---- */
	'grant.propose'(s, from, d, id, time) {
		const h = s.heart ?? fail('grants start with the Heart upgrade');
		for (const k of Object.keys(d)) if (!['to', 'asset', 'amount', 'reason'].includes(k)) fail(`"${k}" is not expected here`);
		if (voteWeight(s, from) <= 0) fail('only someone with DZY staked or delegated can propose');
		const to = isAddr(d.to) ? d.to : fail('bad receiver'), amount = amountOf(d.amount), asset = typeof d.asset === 'string' && (d.asset === NATIVE || own(X_COINS, d.asset)) ? d.asset : fail('asset: DZY, or a coin the exchange takes');
		if (typeof d.reason !== 'string' || d.reason.trim().length < RULES.reasonMin || d.reason.length > RULES.reasonMax) fail('say what the payment is for');
		if (Object.keys(h.props).length >= HEART.maxGrants) fail('too many proposals are open: wait for some to end');
		const key = 'g' + id.slice(0, 16);
		return () => { h.props[key] = { by: from, to, asset, amount, reason: d.reason as string, until: time + HEART.grantDays, votes: {} }; };
	},
	/** vote yes or no; the moment more than two thirds of all stake says yes, it is paid, if the contributors' fund holds enough */
	'grant.vote'(s, from, d, _id, time) {
		const h = s.heart ?? fail('grants start with the Heart upgrade'), key = own(h.props, d.id) ? d.id : fail('no such proposal'), p = h.props[key];
		if (time > p.until) fail('voting on this proposal has ended');
		if (typeof d.yes !== 'boolean') fail('vote yes: true or yes: false');
		if (voteWeight(s, from) <= 0) fail('only someone with DZY staked or delegated can vote');
		const votes = { ...p.votes, [from]: d.yes as boolean };
		const yes = Object.entries(votes).filter(([, y]) => y).reduce((n, [a]) => n + voteWeight(s, a), 0);
		const passes = yes * 3 > totalVoteWeight(s) * 2 && grantOf(h, p.asset) >= p.amount;
		return () => {
			p.votes = votes;
			if (!passes) return;
			delete h.props[key];
			if (p.asset === NATIVE) { h.grants -= p.amount; add(s, p.to, NATIVE, p.amount); }
			else { h.coin.g[p.asset] -= p.amount; if (!h.coin.g[p.asset]) delete h.coin.g[p.asset]; creditCoin(s, p.to, p.asset, p.amount); }
		};
	},
	'grant.close'(s, _from, d, _id, time) {
		const h = s.heart ?? fail('grants start with the Heart upgrade'), key = own(h.props, d.id) ? d.id : fail('no such proposal');
		if (time <= h.props[key].until) fail('voting on this proposal has not ended');
		return () => { delete h.props[key]; };
	},

	/* ---- contracts ---- */
	/** put a program on the chain. Its address comes from this transaction; nobody holds a key for it. */
	'contract.deploy'(s, from, d, _id, time, ctx) {
		const prog = checkProgram(d.code, !!s.heart);
		if (canon(d.code).length > LIMITS.codeChars) fail(`a program is at most ${LIMITS.codeChars} characters`);
		const gas = gasLimitOf(d);
		const onCredit = !!s.sun && balanceOf(s, from, NATIVE) < RULES.deployFee && creditCovers(s, from, RULES.deployFee);
		if (!onCredit && balanceOf(s, from, NATIVE) < RULES.deployFee) fail(`putting a contract on the chain costs ${RULES.deployFee / DZY} DZY`);
		const at = ctx.contract!;
		if (s.contracts && own(s.contracts, at)) fail('that contract already exists');
		const c: Contract = { creator: from, code: prog, storage: {}, entries: 0 };
		const session = makeSession(s, time, ctx.height, false, { at, c });
		try { ctx.gasUsed = session.run(at, from, {}, null, [], gas).gasUsed; }
		catch (e) {
			if (!(e instanceof ContractFailure)) throw e;
			ctx.gasUsed = e.gasUsed; ctx.failed = e.message;
			return () => { /* its set-up failed: nothing is created, the gas is paid */ };
		}
		return () => {
			if (onCredit) creditUse(s, from, RULES.deployFee); else { sub(s, from, NATIVE, RULES.deployFee); toTreasury(s, RULES.deployFee); }
			(s.contracts ??= {})[at] = c;
			session.apply();
		};
	},
	/** call a function of a contract, optionally sending it coins (`pay`). All or nothing. */
	'contract.call'(s, from, d, _id, time, ctx) {
		const at = s.contracts && own(s.contracts, d.contract) ? d.contract : fail('no such contract');
		const c = s.contracts![at];
		const fn = typeof d.fn === 'string' ? d.fn : fail('name the function to call');
		const args = argsOf(d.args);
		const gas = gasLimitOf(d);
		const paid: Record<string, number> = {};
		if (d.pay !== undefined) {
			const p = sideOf(s, d.pay);
			if (balanceOf(s, from, p.asset) < p.amount) fail('not enough balance to pay that');
			paid[p.asset] = p.amount;
		}
		checkCall(c.code, fn, args, false); // a malformed call is refused outright
		const session = makeSession(s, time, ctx.height, false);
		try { ctx.gasUsed = session.run(at, from, paid, fn, args, gas).gasUsed; }
		catch (e) {
			if (!(e instanceof ContractFailure)) throw e;
			// it failed while running: nothing it did happens, the gas it used is paid, and the failure is recorded
			ctx.gasUsed = e.gasUsed; ctx.failed = e.message;
			return () => { c.events = [...(c.events ?? []), { h: ctx.height, failed: e.message.slice(0, LIMITS.valueChars), by: from }].slice(-LIMITS.events); };
		}
		return () => session.apply();
	},

	/* ---- names: @alex instead of a 64-letter address ---- */
	/** choose a name for this account (one per account; choosing another frees the old one). Wallets look a name up
	    before signing, so a signature always covers the real address. */
	'name.set'(s, from, d, _id, _t, ctx) {
		const v2 = namesV2On(s, ctx.height);
		const name = typeof d.name === 'string' && (v2 ? isNameV2(d.name) : isName(d.name)) ? d.name
			: fail(v2 ? 'a name is 4 to 20 small letters, digits or dashes (1 to 3 characters: a premium name), starting and ending with a letter or digit' : 'a name is 3 to 20 small letters, digits or dashes, starting and ending with a letter or digit');
		if (RESERVED.has(name) && from !== s.authority) fail('that name is kept for the chain itself');
		const holder = s.names && own(s.names, name) ? s.names[name] : null;
		if (holder === from) fail('this account already has that name');
		if (holder) fail('that name is taken');
		// 1 to 3 characters: a premium name, paid in DZY at its dollar price, to the fee account (who can also give one: name.grant)
		const usd = v2 && name.length <= 3 ? premiumNameUsd(s, name.length) : 0;
		if (usd) {
			const cost = usdCost(s, NATIVE, usd) ?? fail('premium names open once DZY has a price');
			if (balanceOf(s, ctx.payer, NATIVE) < cost) fail(`@${name} is a premium name: $${usd / 1e6} in DZY (${(cost / DZY).toLocaleString('en-US', { maximumFractionDigits: 2 })} DZY)`);
			return () => {
				sub(s, ctx.payer, NATIVE, cost); add(s, RULES.saleFeeTo, NATIVE, cost);
				giveName(s, from, name); premiumTaken(s, name.length);
			};
		}
		const onCredit = !!s.sun && balanceOf(s, ctx.payer, NATIVE) < RULES.nameFee && creditCovers(s, ctx.payer, RULES.nameFee, name);
		if (!onCredit && balanceOf(s, ctx.payer, NATIVE) < RULES.nameFee) fail(`a name costs ${RULES.nameFee / DZY} DZY (on starter credit: a name of 6 or more characters)`);
		return () => {
			if (onCredit) creditUse(s, ctx.payer, RULES.nameFee, name); else { sub(s, ctx.payer, NATIVE, RULES.nameFee); toTreasury(s, RULES.nameFee); }
			const a = account(s, from);
			if (a.name) delete s.names![a.name];
			(s.names ??= {})[name] = from; a.name = name;
		};
	},
	/** link this account's address on another chain (so @name works there too), proven by that address's own
	    signature of linkMessage; or `address: null` to remove a link */
	'name.link'(s, from, d, _id, _t, ctx) {
		const net = typeof d.net === 'string' && own(LINKABLE, d.net) ? d.net : fail(`you can link: ${Object.keys(LINKABLE).join(', ')}`);
		const a = existing(s, from);
		if (d.address === null) return a.links && own(a.links, net) ? () => { delete a.links![net]; if (!Object.keys(a.links!).length) delete a.links; } : fail('nothing linked there');
		if (net === 'eth' ? !isEthAddr(d.address) : net === 'btc' ? !isLinkableBtc(d.address) : typeof d.address !== 'string' || !fromSolana(d.address))
			fail(net === 'eth' ? 'bad address: 0x and 40 lower-case hex digits' : net === 'btc' ? 'bad address: a Bitcoin address starting 1, 3 or bc1q (bc1 in lower case); taproot (bc1p) addresses cannot sign a message this way' : 'bad address');
		if (!ctx.linkOk) fail('that address must sign to agree to the link');
		if (!(a.links && own(a.links, net)) && Object.keys(a.links ?? {}).length >= RULES.maxLinks) fail('too many links');
		return () => { (a.links ??= {})[net] = d.address as string; };
	},
	/** the fee account gives a premium name (1 to 3 characters, sold or gifted off the chain) to an account; it replaces
	    that account's name, if it had one */
	'name.grant'(s, from, d, _id, _t, ctx) {
		if (!namesV2On(s, ctx.height)) fail('premium names are not open yet');
		if (from !== RULES.saleFeeTo && from !== s.authority) fail('only the fee account gives premium names');
		const name = typeof d.name === 'string' && isNameV2(d.name) && d.name.length <= 3 ? d.name : fail('a premium name is 1 to 3 small letters or digits');
		const to = typeof d.to === 'string' && /^[0-9a-f]{64}$/.test(d.to) ? d.to : fail('to: the account that gets the name');
		if (s.names && own(s.names, name)) fail('that name is taken');
		return () => { giveName(s, to, name); premiumTaken(s, name.length); };
	},
	'name.release'(s, from) {
		const a = existing(s, from), name = a.name ?? fail('this account has no name');
		return () => { delete s.names![name]; if (emptyOf(s.names!)) delete s.names; delete a.name; };
	},

	/* ---- several keys must agree ---- */
	/** require `need` of `keys` to sign everything this account does from now on (keys: null removes the rule). This
	    transaction itself must already satisfy any rule in force. */
	'account.multisig'(s, from, d) {
		const a = existing(s, from);
		if (d.keys === null) return a.multi ? () => { delete a.multi; } : fail('this account has no such rule');
		const keys = Array.isArray(d.keys) && d.keys.length >= 2 && d.keys.length <= 8 && d.keys.every(isAddr) && new Set(d.keys).size === d.keys.length ? (d.keys as string[]).slice().sort() : fail('give 2 to 8 different keys');
		const need = Number.isSafeInteger(d.need) && (d.need as number) >= 1 && (d.need as number) <= keys.length ? (d.need as number) : fail('need must be from 1 to the number of keys');
		return () => { a.multi = { keys, need }; };
	},

	/* ---- the second layer: payment channels ---- */
	/** lock coins in a channel with someone; you are side a, they are side b */
	'channel.open'(s, from, d, id) {
		const to = isAddr(d.to) && d.to !== from ? d.to : fail('bad other side');
		const asset = assetOf(s, d.asset), amount = amountOf(d.amount);
		if (balanceOf(s, from, asset) < amount) fail('not enough balance');
		const key = 'ch' + id.slice(0, 16);
		if (s.channels && own(s.channels, key)) fail('channel already exists');
		return () => { sub(s, from, asset, amount); (s.channels ??= {})[key] = { a: from, b: to, asset, total: amount, fundedA: amount, fundedB: 0 }; };
	},
	/** side b adds its own coins, before anyone starts closing */
	'channel.fund'(s, from, d) {
		const ch = channelOf(s, d.id), amount = amountOf(d.amount);
		if (from !== ch.b && from !== ch.a) fail('only the two sides can add to a channel');
		if (ch.closing) fail('this channel is closing');
		if (balanceOf(s, from, ch.asset) < amount) fail('not enough balance');
		if (!Number.isSafeInteger(ch.total + amount)) fail('too much');
		return () => { sub(s, from, ch.asset, amount); ch.total += amount; if (from === ch.a) ch.fundedA += amount; else ch.fundedB += amount; };
	},
	/** both sides agree on the final state: paid out at once */
	'channel.close'(s, from, d, _id, _t, ctx) {
		const ch = channelOf(s, d.id), st = stateOf(ch, d, ctx);
		if (from !== ch.a && from !== ch.b) fail('only the two sides can close a channel');
		return () => payOut(s, d.id as string, ch, st.a, st.b);
	},
	/** one side starts closing on its own: with the newest state both signed, or the deposits if none was signed.
	    The other side then has channelWait to show a newer state. */
	'channel.start'(s, from, d, _id, time, ctx) {
		const ch = channelOf(s, d.id);
		if (from !== ch.a && from !== ch.b) fail('only the two sides can close a channel');
		if (ch.closing) fail('this channel is already closing');
		const st = d.nonce === undefined ? { nonce: 0, a: ch.fundedA, b: ch.fundedB } : stateOf(ch, d, ctx);
		return () => { ch.closing = { ...st, at: time + RULES.channelWait, by: from }; };
	},
	/** while a channel is closing, a newer state both signed replaces the one being closed on */
	'channel.update'(s, from, d, _id, time, ctx) {
		const ch = channelOf(s, d.id);
		if (from !== ch.a && from !== ch.b) fail('only the two sides can update a channel');
		const c = ch.closing ?? fail('this channel is not closing');
		if (time >= c.at) fail('the waiting time is over: settle it');
		const st = stateOf(ch, d, ctx);
		if (st.nonce <= c.nonce) fail('that state is not newer');
		return () => { ch.closing = { ...st, at: c.at, by: c.by }; };
	},
	/** after the waiting time, anyone may pay a closing channel out */
	'channel.settle'(s, _from, d, _id, time) {
		const ch = channelOf(s, d.id), c = ch.closing ?? fail('this channel is not closing');
		if (time < c.at) fail('the waiting time is not over yet');
		return () => payOut(s, d.id as string, ch, c.a, c.b);
	}
};

/* ---- names ---- */
const isName = (v: string) => /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/.test(v) && !v.includes('--');
/** names from NAMES_V2_FROM: 1 to 20 characters; 4 or more as before, 1 to 3 premium */
const isNameV2 = (v: string) => /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(v) && !v.includes('--');
/** premium names (1 to 3 characters) start at $5 and go up with every one taken, by length: 1 character +$5 each
    ($5, $10, $15...), 2 characters +$2.50 ($5, $7.50, $10...), 3 characters +$1.25 ($5, $6.25, $7.50...). The chain
    counts them (s.premiumSold), so the price is the same for everyone and nobody sets it by hand. */
export const PREMIUM_NAME_BASE = 5_000_000;
export const PREMIUM_NAME_STEP: Readonly<Record<number, number>> = { 1: 5_000_000, 2: 2_500_000, 3: 1_250_000 };
/** what the next premium name of this length costs, in µ$ */
export const premiumNameUsd = (s: State, len: number) => PREMIUM_NAME_BASE + PREMIUM_NAME_STEP[len] * (s.premiumSold?.[String(len)] ?? 0);
function premiumTaken(s: State, len: number) { const k = String(len); (s.premiumSold ??= {})[k] = (s.premiumSold[k] ?? 0) + 1; }
const NAMES_V2_FROM: Record<string, number> = { 'dznye-mainnet': 4_885 }; // just ahead of the live height (4,858) when deployed, 20 Nov 2026
const TEST_NAMES_V2 = new Map<string, number>();
/** TEST ONLY: the block a test chain takes the new name rules from (null: back to the rule) */
export function testNamesV2From(chain: string, height: number | null) { if (height === null) TEST_NAMES_V2.delete(chain); else TEST_NAMES_V2.set(chain, height); }
export const namesV2On = (s: State, height: number = s.height + 1) => height >= (TEST_NAMES_V2.get(s.chain) ?? (Object.hasOwn(NAMES_V2_FROM, s.chain) ? NAMES_V2_FROM[s.chain] : Infinity)); // other chains: the old rule unless set
/** `who` takes `name`, freeing the name it had */
function giveName(s: State, who: string, name: string) {
	const a = account(s, who);
	if (a.name) Reflect.deleteProperty(s.names!, a.name);
	(s.names ??= {})[name] = who; a.name = name;
}
/** names nobody but the chain's issuing key may take, so nobody can pose as the project */
export const RESERVED: ReadonlySet<string> = new Set(['dznye', 'admin', 'administrator', 'treasury', 'support', 'help', 'official', 'chain', 'wallet', 'api', 'explorer', 'status', 'developers', 'validator', 'security', 'root', 'system', 'team', 'staff']);
/** who has this name, or null */
export const whoIs = (s: State, name: string) => (s.names && own(s.names, name) ? s.names[name] : null);

/* ---- contracts: helpers ---- */
/** arguments: plain values only (whole numbers, text, true/false, null), and not too much of them */
function argsOf(v: unknown): Value[] {
	const a = v === undefined ? [] : Array.isArray(v) ? v : fail('args must be a list');
	for (const x of a) if (!(x === null || typeof x === 'boolean' || (typeof x === 'string' && x.length <= LIMITS.valueChars) || (typeof x === 'number' && Number.isSafeInteger(x)))) fail('an argument must be a whole number, text, true, false or null');
	if (canon(a).length > LIMITS.argChars) fail('too many arguments');
	return a as Value[];
}
/** One call and everything it leads to (other contracts it calls, coins moved, tokens made and issued, storage,
    events) share one draft. Only `apply` makes it real, so the whole call is all or nothing. A contract that is
    running is locked: it cannot be called back until it finishes. */
function makeSession(s: State, time: number, height: number, readonly: boolean, newborn?: { at: string; c: Contract }) {
	const stores = new Map<string, Map<string, Value | undefined>>(); // per contract; undefined = deleted
	const entries = new Map<string, number>(), made = new Map<string, number>(), events = new Map<string, ContractEvent[]>();
	const delta = new Map<string, number>(); // "address|asset" → change
	const newAssets = new Map<string, Asset>(), minted = new Map<string, number>();
	const running = new Set<string>();
	let treasury = 0;
	const dk = (who: string, asset: string) => who + '|' + asset;
	const contractAt = (at: string): Contract | null => (newborn?.at === at ? newborn.c : s.contracts && own(s.contracts, at) ? s.contracts[at] : null);
	const assetAt = (id: string): Asset | null => (own(s.assets, id) ? s.assets[id] : newAssets.get(id) ?? null);
	const bal = (who: string, asset: string) => balanceOf(s, who, asset) + (delta.get(dk(who, asset)) ?? 0);
	const change = (who: string, asset: string, n: number) => delta.set(dk(who, asset), (delta.get(dk(who, asset)) ?? 0) + n);
	const move = (asset: string, a: string, b: string, n: number) => { change(a, asset, -n); change(b, asset, n); };
	const count = (at: string) => entries.get(at) ?? contractAt(at)!.entries;

	const worldFor = (at: string, caller: string, paid: Record<string, number>): World => {
		const c = contractAt(at)!;
		if (!stores.has(at)) stores.set(at, new Map());
		const store = stores.get(at)!;
		const w: World = {
			self: at, caller, time, height, paid, readonly,
			get: (k) => (store.has(k) ? store.get(k) : own(c.storage, k) ? c.storage[k] : undefined),
			set: (k, v) => { if (w.get(k) === undefined) entries.set(at, count(at) + 1); store.set(k, v); },
			del: (k) => { if (w.get(k) !== undefined) entries.set(at, count(at) - 1); store.set(k, undefined); },
			entries: () => count(at), maxEntries: s.heart ? LIMITS.heartEntries : LIMITS.entries, layerRoot: (id) => layerRoot(s, id, time),
			balance: bal,
			transfer: (asset, to, amount) => {
				if (!assetAt(asset)) fail('no such asset');
				if (bal(at, asset) < amount) fail('the contract does not hold that much');
				move(asset, at, to, amount);
			},
			call: (target, fn, args, pay, gasLeft) => {
				const t = contractAt(target) ?? fail('no such contract');
				if (running.has(target)) fail('a contract that is running cannot be called back');
				if (running.size >= LIMITS.callDepth) fail(`contracts can call contracts at most ${LIMITS.callDepth} deep`);
				const p: Record<string, number> = {};
				if (pay) {
					if (!assetAt(pay.asset)) fail('no such asset');
					if (bal(at, pay.asset) < pay.amount) fail('the contract does not hold that much');
					move(pay.asset, at, target, pay.amount); p[pay.asset] = pay.amount;
				}
				running.add(target);
				try { return run(t.code, fn, args, worldFor(target, at, p), gasLeft); } finally { running.delete(target); }
			},
			emit: (v) => { if (!events.has(at)) events.set(at, []); events.get(at)!.push({ h: height, v }); },
			newToken: (symbol, name, decimals, cap) => {
				if (!/^[A-Z0-9]{2,10}$/.test(symbol) || symbol === NATIVE) fail('a symbol is 2 to 10 capital letters or digits');
				if (!name.trim() || name.length > RULES.nameMax) fail('bad token name');
				if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > RULES.maxDecimals) fail('bad decimals');
				if (cap !== null && cap <= 0) fail('a limit must be above zero');
				if (bal(at, NATIVE) < RULES.assetFee) fail(`making a token costs ${RULES.assetFee / DZY} DZY, from the contract's own DZY`);
				const n = made.get(at) ?? c.made ?? 0;
				const id = 't' + at.slice(0, 12) + n.toString(16).padStart(3, '0');
				if (n > 0xfff || assetAt(id)) fail('this contract cannot make more tokens');
				made.set(at, n + 1);
				change(at, NATIVE, -RULES.assetFee); treasury += RULES.assetFee;
				newAssets.set(id, { symbol, name, issuer: at, supply: 0, minted: 0, mintable: true, decimals, ...(cap !== null ? { cap } : {}) });
				return id;
			},
			mint: (asset, to, amount) => {
				const a = assetAt(asset) ?? fail('no such asset');
				if (a.issuer !== at) fail('a contract can only issue tokens it made itself');
				const before = minted.get(asset) ?? 0;
				if (a.minted + before + amount > (a.cap ?? RULES.maxSupply)) fail('supply limit reached');
				minted.set(asset, before + amount); change(to, asset, amount);
			}
		};
		return w;
	};
	return {
		/** run one contract's function (or its set-up, fn null) for `caller`, which sends `paid` with it */
		run(at: string, caller: string, paid: Record<string, number>, fn: string | null, args: Value[], gas: number) {
			for (const [asset, n] of Object.entries(paid)) move(asset, caller, at, n); // what a call brings is the contract's from the start
			running.add(at);
			try { return run(contractAt(at)!.code, fn, args, worldFor(at, caller, paid), gas); } finally { running.delete(at); }
		},
		apply() {
			for (const [id, a] of newAssets) s.assets[id] = a;
			for (const [id, n] of minted) { s.assets[id].supply += n; s.assets[id].minted += n; }
			for (const [at, store] of stores) {
				const c = contractAt(at)!;
				for (const [k, v] of store) { if (v === undefined) delete c.storage[k]; else c.storage[k] = v; }
				if (entries.has(at)) c.entries = entries.get(at)!;
			}
			for (const [at, n] of made) contractAt(at)!.made = n;
			for (const [at, list] of events) { const c = contractAt(at)!; c.events = [...(c.events ?? []), ...list].slice(-LIMITS.events); }
			for (const [k, n] of delta) {
				if (!n) continue;
				const [who, asset] = k.split('|');
				if (n > 0) add(s, who, asset, n); else sub(s, who, asset, -n);
			}
			toTreasury(s, treasury);
		}
	};
}
/** Ask a contract something without changing anything (a "view" function, which may ask other views). No fee. */
export function viewContract(s: State, at: string, fn: string, args: unknown, time: number = s.time, caller = '0'.repeat(64)) {
	if (!(s.contracts && own(s.contracts, at))) fail('no such contract');
	return makeSession(s, time, s.height, true).run(at, caller, {}, fn, argsOf(args), LIMITS.maxGas);
}
/** the address a contract deployed by the transaction with this id lives at */
export const contractAddress = (txId: string) => sha256('dzy-contract:' + txId);

/* ---- channels: helpers ---- */
function channelOf(s: State, id: unknown): Channel { return s.channels && own(s.channels, id) ? s.channels[id] : fail('no such channel'); }
/** a state both sides signed (signatures were checked before, while waiting was allowed); it must add up */
function stateOf(ch: Channel, d: Record<string, unknown>, ctx: Ctx) {
	const nonce = d.nonce, a = d.a, b = d.b;
	if (!Number.isSafeInteger(nonce) || (nonce as number) < 1) fail('a signed state has a nonce of 1 or more');
	if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (a as number) < 0 || (b as number) < 0) fail('bad amounts');
	if ((a as number) + (b as number) !== ch.total) fail('the amounts must add up to what is in the channel');
	if (!ctx.sigsOk) fail('both sides must sign the state');
	return { nonce: nonce as number, a: a as number, b: b as number };
}
function payOut(s: State, id: string, ch: Channel, a: number, b: number) {
	if (a) add(s, ch.a, ch.asset, a);
	if (b) add(s, ch.b, ch.asset, b);
	delete s.channels![id];
	if (emptyOf(s.channels!)) delete s.channels;
}
/* ---- hash locks: helpers ---- */
function closeSwap(s: State, key: string, done: SwapDone) {
	delete s.swaps![key];
	if (emptyOf(s.swaps!)) delete s.swaps;
	s.swapLog = [...(s.swapLog ?? []), done].slice(-RULES.maxSwapLog);
}

/** DZY paid to the chain's treasury: it stays in the supply and can be paid out again */
/** Work out closing a position without changing anything: pay the closer's reward first (at most `rewardCap` DZY, so
    closing a position that is under water is always worth someone's while), trade back through its pool, repay what
    it owes (or as much as there is, when `partial`), and say what is left for its owner. Null when it cannot repay in
    full and `partial` is not set. `apply(key, closer)` then does it: the vault is repaid (a tenth of DZY interest to
    the treasury); a shortfall is that vault's loss; nothing is created or destroyed. */
function settle(s: State, pos: Position, time: number, partial = false, rewardCap = 0): { left: number; reward: number; apply: (key: string, closer: string) => void } | null {
	const p = s.liquidity![pos.pool], v = s.vaults![`${pos.pool}:${pos.side}`], owed = owedOf(pos, time);
	let repay: number, left: number, reward: number, r: { out: number; hub: number; dzy: number; token: number } | null;
	if (pos.side === 'L') {
		r = poolSwap(p, false, pos.held);
		const got = r?.out ?? 0;
		reward = Math.min(got, rewardCap);
		if (got - reward < owed && !partial) return null;
		repay = Math.min(got - reward, owed); left = got - reward - repay;
	} else {
		reward = Math.min(pos.held, rewardCap);
		const budget = pos.held - reward, need = dzyFor(p, owed);
		if (need !== null && need <= budget) { r = poolSwap(p, true, need)!; repay = owed; left = budget - need; }
		else { if (!partial) return null; r = budget > 0 ? poolSwap(p, true, budget) : null; repay = Math.min(r?.out ?? 0, owed); left = r ? 0 : budget; }
	}
	const interest = Math.max(0, repay - pos.debt), hub = pos.side === 'L' ? mulDiv(interest, RULES.marginHubBps, 10_000) : 0;
	return {
		left, reward,
		apply(key, closer) {
			poolTick(p, time);
			if (r) { p.dzy = r.dzy; p.token = r.token; toTreasury(s, r.hub); }
			else if (pos.side === 'L' && pos.held > 0) add(s, pos.owner, pos.pool, pos.held); // too small to trade back: it goes back to its owner, never vanishes
			// a short that bought more tokens than it owes (rounding) leaves them in the vault for its lenders
			const intoVault = pos.side === 'S' && r ? r.out : repay - hub;
			v.lent -= pos.debt; v.cash += intoVault; toTreasury(s, hub);
			if (reward > 0) add(s, closer, NATIVE, reward);
			if (left > 0) add(s, pos.owner, NATIVE, left);
			delete s.positions![key];
			if (emptyOf(s.positions!)) delete s.positions;
		}
	};
}
function toTreasury(s: State, n: number) { if (s.sun) toSun(s, n); else if (n > 0) s.treasury = (s.treasury ?? 0) + n; }

/* ---- staking helpers ---- */
function stakeOf(s: State, addr: string): Stake {
	const all = (s.stakes ??= {});
	if (!own(all, addr)) all[addr] = { bond: 0 };
	return all[addr];
}
/** forget a stake that holds nothing and has no record worth keeping */
function tidyStake(s: State, addr: string) {
	const st = s.stakes?.[addr];
	if (st && !st.bond && !st.unbonding && !st.tomb && st.jailed === undefined) {
		delete s.stakes![addr];
		if (emptyOf(s.stakes!)) delete s.stakes;
	}
}
function voteOf(v: unknown): SignedVote {
	const o = (v && typeof v === 'object' ? v : fail('bad vote')) as Record<string, unknown>;
	if (o.type !== 'prevote' && o.type !== 'precommit') fail('bad vote');
	if (!Number.isSafeInteger(o.height) || (o.height as number) < 1 || !Number.isSafeInteger(o.round) || (o.round as number) < 0) fail('bad vote');
	if (o.block !== null && (typeof o.block !== 'string' || !/^[0-9a-f]{64}$/.test(o.block))) fail('bad vote');
	if (!isAddr(o.validator) || typeof o.sig !== 'string') fail('bad vote');
	return { type: o.type as SignedVote['type'], height: o.height as number, round: o.round as number, block: o.block as string | null, validator: o.validator as string, sig: o.sig as string };
}
/** all DZY backing validator `v` by delegation */
export const delegatedTo = (s: State, v: string) => Object.values(s.delegations?.[v] ?? {}).reduce((n, x) => n + x, 0);
/** a validator's weight: its own stake and what backs it */
export const weightOf = (s: State, v: string) => (s.stakes?.[v]?.bond ?? 0) + delegatedTo(s, v);
/** an account's say in treasury votes: what it has staked plus what it has delegated (unlocking DZY has no say) */
export function voteWeight(s: State, a: string): number {
	let n = s.stakes?.[a] && !s.stakes[a].tomb ? s.stakes[a].bond : 0;
	for (const m of Object.values(s.delegations ?? {})) if (own(m, a)) n += m[a];
	return n;
}
export function totalVoteWeight(s: State): number {
	let n = 0;
	for (const st of Object.values(s.stakes ?? {})) if (!st.tomb) n += st.bond;
	for (const m of Object.values(s.delegations ?? {})) for (const x of Object.values(m)) n += x;
	return n;
}
/** What a seat costs (on a chain with the Sun): every seat the same SHARE of the DZY still circulating. DZY locked or
    staked counts as burned (it is out of circulation, as the lock weights treat it too), so the remaining DZY is scarcer
    and the next seat needs fewer of them:  price = minStake x (12,000,000 - DZY locked or staked) / 12,000,000.
    After the first 1,000 DZY are staked the next seat is 999.92 DZY; with 10% of all DZY locked, 900. Its value in the
    market is the same share for everyone; what that share is worth, the market decides. Exact whole numbers. */
export function seatPrice(s: State): number {
	if (!s.sun) return RULES.minStake;
	const away = stakedTotal(s) + sunHeld(s).locked;
	return Number((BigInt(RULES.minStake) * BigInt(Math.max(0, RULES.dzyCap - away))) / BigInt(RULES.dzyCap));
}
/* ---------- the exchange (EXCHANGE.md, 2026-11-17) ----------
   DZY against coins of real value, both ways, settled by contracts; nothing burned, nothing printed. Each coin lives in
   vaults on its own chains (Bitcoin; Ethereum and the chains that share its addresses; Solana). Buying: a coin arrives in a
   vault, validators confirm it, the buyer gets claims on exactly that coin and DZY at today's rate from the sale. Selling
   back: claims and DZY at today's rate return, and the vault pays the coin (less 0.1%, to the pot). A payout is never
   more than the claims given up, so no vault ever owes more than it holds. */
export interface XState { vaults: Record<string, number>; prices?: Record<string, { at: number; p: Record<string, number> }>; /** unused since locks (kept so older states read the same) */ free: Record<string, number>;
	/** coin locked in its buyer's own name ("address:COIN" -> units): only that address can close it */ locks?: Record<string, number>;
	/** the exchange's own coin (COIN -> units): lock leftovers and the exchange's fees. Nobody owns it; it only ever pays out at the floor */ pot?: Record<string, number>;
	/** addresses whose deposits stay free coin instead of buying DZY */ park?: Record<string, 1>;
	/** the block the index turned on (DZY priced by the reserve), its last price (µ$), and the DZY in hands still not backed (early DZY, washed by fees) */ index?: number; nav?: number; unbacked?: number;
	/** coins voted out of the reserve ('out': swapped out for good coins) or counted as nothing ('zero'), and the votes on the way */ retired?: Record<string, 'out' | 'zero'>; rvotes?: Record<string, string[]>;
	/** Dznye dollar loans (DUSD): id -> the loan */ loans?: Record<string, Loan>; /** vaults the validators listed (x.vault): network -> "address" or "address@block" */ listed?: Record<string, string> }
/** A Dznye dollar loan: `coll` of a vault coin's free coin held by the loan; `debt` DUSD borrowed (millionths of a dollar);
    `fee` the interest and borrowing fee owed so far (µ$), counted up to `at` */
export interface Loan { owner: string; coin: string; coll: number; debt: number; fee: number; at: number }
/** a prediction market: its question, when it closes, the DZY behind its shares, and how validators settled it */
export interface Market { maker: string; question: string; until: number; pool: number; outcome?: 'YES' | 'NO' | 'VOID'; votes?: Record<string, string[]> }
/** an Up or Down round: DZY on each side, what it still holds, each bettor's stakes, and its start and end prices */
export interface Round { up: number; down: number; left: number; bets: Record<string, { up: number; down: number }>; open?: number; close?: number }
export interface XPayout { h: number; at: number; by: string; coin: string; net: string; amount: number; to: string; dzy: number; tx?: string }
/** the coins, in the units the chain counts them in (ETH in gwei), and the networks each is held on */
export const X_COINS: Readonly<Record<string, { decimals: number; nets: readonly string[]; name: string }>> = Object.freeze({
	BTC: { decimals: 8, nets: ['btc'], name: 'Bitcoin' },
	ETH: { decimals: 9, nets: ['eth', 'base', 'arb', 'op'], name: 'Ether' },
	SOL: { decimals: 9, nets: ['sol'], name: 'Solana' },
	USDC: { decimals: 6, nets: ['eth', 'base', 'arb', 'op', 'polygon', 'avax', 'sol', 'bsc'], name: 'USD Coin' },
	USDT: { decimals: 6, nets: ['eth', 'arb', 'op', 'polygon', 'bsc', 'avax'], name: 'Tether' },
	BNB: { decimals: 9, nets: ['bsc'], name: 'BNB' },
	POL: { decimals: 9, nets: ['polygon'], name: 'Polygon' },
	AVAX: { decimals: 9, nets: ['avax'], name: 'Avalanche' },
	// gold (from GOLD_FROM): one troy ounce each, held in the Ethereum vault; PAXG counted in billionths of an ounce, XAUT in millionths (its own)
	PAXG: { decimals: 9, nets: ['eth'], name: 'PAX Gold' },
	XAUT: { decimals: 6, nets: ['eth'], name: 'Tether Gold' },
});
/* ---------- more coins and networks (2026-11-19, the owner: "buy DZY from every chain") ----------
   Tether on six networks, USDC on BNB Chain, and BNB, POL and AVAX, each paid into the same vault contract on its own
   network. Before a set block of each chain only the first coins and networks count (the table as it was), so every
   block before it keeps the old rules and a node that has not updated agrees with every block until then. */
const X_FIRST: Readonly<Record<string, readonly string[]>> = Object.freeze({ BTC: ['btc'], ETH: ['eth', 'base', 'arb', 'op'], SOL: ['sol'], USDC: ['eth', 'base', 'arb', 'op', 'polygon', 'avax', 'sol'] });
const X_MORE_FROM: Record<string, number> = { 'dznye-mainnet': 2_800 };
/** edition numbers (#3 of 50) on what buyers own: from this block on mainnet (older blocks replay as they were) */
const ED_FROM: Record<string, number> = { 'dznye-mainnet': 4_600 };
const edOn = (s: State, height: number = s.height + 1) => height >= (Object.hasOwn(ED_FROM, s.chain) ? ED_FROM[s.chain] : 0);
const TEST_X_MORE = new Map<string, number>();
/** TEST ONLY: the block a test chain takes the new coins from (null: back to the rule) */
export function testXMoreFrom(chain: string, height: number | null) { if (height === null) TEST_X_MORE.delete(chain); else TEST_X_MORE.set(chain, height); }
export const xMoreFrom = (chain: string) => TEST_X_MORE.get(chain) ?? (Object.hasOwn(X_MORE_FROM, chain) ? X_MORE_FROM[chain] : 0); // test and new chains: from the start
/** does this coin (on this network) count at this block? */
export const xLive = (s: State, coin: string, net?: string, height: number = s.height + 1): boolean => {
	if (!own(X_COINS, coin) || (net !== undefined && !X_COINS[coin].nets.includes(net))) return false;
	if (GOLD.has(coin) && height < goldFrom(s.chain)) return false; // gold counts from its block
	if (height >= xMoreFrom(s.chain)) return true;
	return own(X_FIRST, coin) && (net === undefined || X_FIRST[coin].includes(net));
};
/** starting limits, small on purpose (raised by an upgrade as the vaults prove themselves): the most one deposit and all
    of a coin's vaults may hold, in its units. Past them a deposit is still held for its owner, who may take it back. */
export const X_LIMITS: Readonly<Record<string, { deposit: number; vault: number }>> = Object.freeze({
	BTC: { deposit: 5_000_000, vault: 50_000_000 }, ETH: { deposit: 1_000_000_000, vault: 10_000_000_000 },
	SOL: { deposit: 20_000_000_000, vault: 200_000_000_000 }, USDC: { deposit: 1_000_000_000, vault: 10_000_000_000 },
	USDT: { deposit: 1_000_000_000, vault: 10_000_000_000 }, BNB: { deposit: 3_000_000_000, vault: 30_000_000_000 },
	POL: { deposit: 5_000_000_000_000, vault: 50_000_000_000_000 }, AVAX: { deposit: 50_000_000_000, vault: 500_000_000_000 },
	PAXG: { deposit: 1_000_000_000, vault: 10_000_000_000 }, XAUT: { deposit: 1_000_000, vault: 10_000_000 }, // an ounce a deposit, ten in the vault
});
/* the starting limits lifted (2026-11-21): from this block on mainnet a deposit is never held back for
   its size or for how full the vault is; every block before it replays under the limits as they were, so a node that has
   not updated agrees with every block until it. Other chains keep the limits. What stays: the sale's own end (3,000,000
   DZY), the need for an agreed coin price, and "park". */
const X_UNLIMITED_FROM: Record<string, number> = { 'dznye-mainnet': 6_900 }; // live height 6,769 when deployed, 21 Nov 2026
const TEST_X_UNLIMITED = new Map<string, number>();
/** TEST ONLY: the block a test chain lifts the limits from (null: back to the rule) */
export function testXUnlimitedFrom(chain: string, height: number | null) { if (height === null) TEST_X_UNLIMITED.delete(chain); else TEST_X_UNLIMITED.set(chain, height); }
export const xUnlimited = (s: State, height: number = s.height + 1) => height >= (TEST_X_UNLIMITED.get(s.chain) ?? (Object.hasOwn(X_UNLIMITED_FROM, s.chain) ? X_UNLIMITED_FROM[s.chain] : Infinity));
export const X_ADDRESS: Readonly<Record<string, RegExp>> = Object.freeze({ btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, evm: /^0x[0-9a-fA-F]{40}$/, sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ });
/** a price counts only when validators with more than two thirds of the say read it within the last hour and agree
    within 2%: then the middle reading. Otherwise there is none, and trades wait. */
export const X_PRICE_AGE = 60 * 60_000, X_PRICE_SPREAD_BP = 200;
// dznye-mainnet: from block 720 nothing is burned (the owner, 2026-11-17); buying waits for the first vault to be listed
const X_FROM: Record<string, number> = { 'dznye-mainnet': 720 };
const TEST_X = new Map<string, number>();
/** TEST ONLY: the block a test chain opens the exchange at (null: back to the rule) */
export function testExchangeFrom(chain: string, height: number | null) { if (height === null) TEST_X.delete(chain); else TEST_X.set(chain, height); }
export const exchangeFrom = (chain: string) => TEST_X.get(chain) ?? (Object.hasOwn(X_FROM, chain) ? X_FROM[chain] : Infinity);
/** is the exchange open (on a chain with the Sun)? From then on nobody buys DZY by burning money */
export const exchangeOn = (s: State, height: number = s.height + 1) => !!s.sun && height >= exchangeFrom(s.chain);
/* Closing a lock on the curve (found 22 Nov 2026). Until this block, closing priced the whole lock at the curve's price at
   the top, while buying it had walked the curve up: a deposit closed at once came back less 0.1% and left DZY over for
   nothing ($10,000 round left 4,271 DZY). From it, closing walks the same curve back down. No lock had ever been closed
   on the live chain before it, so every block replays the same. Other chains: from the start, unless set. */
const CLOSE_FROM: Record<string, number> = { 'dznye-mainnet': 8_300 };
const TEST_CLOSE = new Map<string, number>();
/** TEST ONLY: the block a test chain closes locks on the curve from (null: back to the rule) */
export function testCloseFrom(chain: string, height: number | null) { if (height === null) TEST_CLOSE.delete(chain); else TEST_CLOSE.set(chain, height); }
export const closeOnCurve = (s: State, height: number = s.height + 1) => height >= (TEST_CLOSE.get(s.chain) ?? (own(CLOSE_FROM, s.chain) ? CLOSE_FROM[s.chain] : 0));
const xOf = (s: State) => (s.x ??= { vaults: {}, free: {} });
const xCoinOf = (s: State, c: unknown): string => (typeof c === 'string' && xLive(s, c) ? c : fail('no such coin on the exchange'));
const xNetOf = (s: State, coin: string, n: unknown): string => (typeof n === 'string' && xLive(s, coin, n) ? n : fail(`${coin} is paid out on ${X_COINS[coin].nets.filter((x) => xLive(s, coin, x)).join(', ')}`));
const xPayTo = (net: string, a: unknown): string => (typeof a === 'string' && X_ADDRESS[net === 'btc' ? 'btc' : net === 'sol' ? 'sol' : 'evm'].test(a) ? a : fail(`bad ${net} address to pay`));
/** the exchange's cut (0.1% on payouts, 0.05% on fills), rounded up so that splitting a trade into small ones never avoids it */
const xFee = (n: number, bps: number = RULES.xFeeBps) => N((B(n) * B(bps) + 9_999n) / 10_000n);
const potAdd = (s: State, coin: string, n: number) => { if (n > 0) { const x = xOf(s); (x.pot ??= {})[coin] = (x.pot[coin] ?? 0) + n; } };
/** is this asset a vault coin's free claims (made by the chain, not a token someone named so)? */
const isXClaim = (s: State, id: string) => id.length > 1 && id[0] === 'x' && own(X_COINS, id.slice(1)) && own(s.assets, id) && s.assets[id].issuer === '0'.repeat(64);
/** The floor: the pot's value (µ$) over the DZY in people's hands (all 12,000,000 but the Sun's and the unsold), or null
    while a coin in the pot has no agreed price. */
/* ---- the Dznye dollar (DUSD): borrowed against free vault coin, never more than 2/3 of its value ---- */
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
function dusdAsset(s: State): Asset {
	if (!own(s.assets, 'DUSD')) s.assets.DUSD = { symbol: 'DUSD', name: 'Dznye dollar (borrowed against BTC, ETH, SOL and USDC in the vaults)', issuer: '0'.repeat(64), supply: 0, minted: 0, mintable: false, decimals: 6 };
	return s.assets.DUSD;
}
/** a loan's fee (µ$) counted up to `time`, rounded up: interest never rounds in the borrower's favour */
const loanFee = (l: Loan, time: number) => l.fee + (time > l.at && l.debt ? N((B(l.debt) * B(RULES.loanRateBps) * B(time - l.at) + B(10_000 * YEAR_MS) - 1n) / B(10_000 * YEAR_MS)) : 0);
/** what `coll` units of a coin are worth (µ$) at `price` */
const collUsd = (coin: string, coll: number, price: number) => (B(coll) * B(price)) / 10n ** B(X_COINS[coin].decimals);
/** units of a coin worth `usd` µ$ at `price`, rounded up (`up`) or down */
const coinFor = (coin: string, usd: bigint, price: number, up: boolean) => { const one = 10n ** B(X_COINS[coin].decimals); return N(up ? (usd * one + B(price) - 1n) / B(price) : (usd * one) / B(price)); };
/** the most DUSD a loan with this coin may owe: 2/3 of its value */
const loanMax = (coin: string, coll: number, price: number) => N((collUsd(coin, coll, price) * 10_000n) / B(RULES.loanMinBps));
const ROUND_COINS = ['BTC', 'ETH', 'SOL'], ROUND_PERIODS = [3_600_000, 86_400_000];
const roundCoin = (c: unknown): string => (typeof c === 'string' && ROUND_COINS.includes(c) ? c : fail('rounds are on BTC, ETH or SOL'));
const roundPeriod = (p: unknown): number => (typeof p === 'number' && ROUND_PERIODS.includes(p) ? p : fail('a round is an hour or a day (3600000 or 86400000)'));
function roundOf(s: State, d: Record<string, unknown>) {
	const coin = roundCoin(d.coin), period = roundPeriod(d.period), start = Number.isSafeInteger(d.start) && (d.start as number) % period === 0 ? (d.start as number) : fail('start is a round\'s starting time');
	const key = `${coin}:${period}:${start}`, r = s.rounds && own(s.rounds, key) ? s.rounds[key] : fail('no round with any bets at that time');
	return { key, r, start, end: start + period };
}
const marketOf = (s: State, id: unknown): Market => (s.markets && typeof id === 'string' && own(s.markets, id) ? s.markets[id] : fail('no such market'));
const loanOf = (s: State, id: unknown): Loan => (loansOfX(s) && typeof id === 'string' && own(loansOfX(s)!, id) ? loansOfX(s)![id] : fail('no such loan'));
const dusdText = (n: number) => (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
/** a loan closing: its fee taken from its coin to the pot, then the rest to `to` as free coin (price only needed if a fee is owed) */
function loanSettle(s: State, id: string, fee: number, price: number | null, to: string) {
	const l = loansOfX(s)![id], feeCoin = fee && price ? Math.min(l.coll, coinFor(l.coin, B(fee), price, true)) : 0;
	potAdd(s, l.coin, coinFee(s, l.coin, feeCoin));
	claimAsset(s, l.coin).supply -= feeCoin; // fee coin leaves the free coin for the pot
	if (l.coll - feeCoin > 0) add(s, to, 'x' + l.coin, l.coll - feeCoin);
	delete loansOfX(s)![id];
}
/** an account's Dznye dollar loans, each with its fee so far and its health (value ÷ what it owes, in %; null with no price) */
export function loansOf(s: State, who: string, time: number = s.time) {
	return Object.entries(loansOfX(s) ?? {}).filter(([, l]) => l.owner === who).map(([id, l]) => {
		const fee = loanFee(l, time), price = xPrice(s, l.coin, time), owes = l.debt + fee;
		return { id, ...l, fee, price, health: price === null ? null : owes ? N((collUsd(l.coin, l.coll, price) * 10_000n) / B(owes)) / 100 : null, max: price === null ? null : loanMax(l.coin, l.coll, price) };
	});
}
export function xFloor(s: State, time: number = s.time): { usd: bigint; hands: bigint; perDzy: number } | null {
	let usd = 0n;
	for (const [c, n] of Object.entries(s.x?.pot ?? {})) {
		if (!n || retiredOf(s, c) === 'zero') continue; // voted worthless: counts nothing
		const p = xPrice(s, c, time);
		if (p === null) { if (indexOn(s) && priceGone(s, c, time)) continue; return null; } // gone a day: nothing; else wait for its price
		usd += (B(n) * B(p)) / 10n ** B(X_COINS[c].decimals);
	}
	const hands = B(SUN_SUPPLY - (s.treasury ?? 0) - s.sun!.salePot); // (not sunSupply: it asks the price, which asks this)
	if (hands <= 0n) return null;
	return { usd, hands, perDzy: N((usd * B(DZY)) / hands) };
}
/** coin the chain owes `who` becomes their free coin (the Heart upgrade pays the exchange's fees out this way) */
export function creditCoin(s: State, who: string, coin: string, n: number) { if (n > 0) { const c = claimAsset(s, coin); c.supply += n; c.minted += n; add(s, who, 'x' + coin, n); } }
/** the claims on a coin: a token the chain makes and nobody can issue, one unit per unit of coin held for its holder */
function claimAsset(s: State, coin: string): Asset {
	const id = 'x' + coin;
	if (!own(s.assets, id)) s.assets[id] = { symbol: 'X' + coin, name: `Claim on ${X_COINS[coin].name} in the Dznye vaults`, issuer: '0'.repeat(64), supply: 0, minted: 0, mintable: false, decimals: X_COINS[coin].decimals };
	return s.assets[id];
}
/** the agreed price of a coin now, in µ$ per whole coin, or null */
export function xPrice(s: State, coin: string, time: number = s.time): number | null {
	const w = powers(s), all = Object.values(w).reduce((n, v) => n + v, 0), got: number[] = [];
	let say = 0; const by: string[] = [];
	for (const [v, r] of Object.entries(s.x?.prices ?? {})) {
		if (!mayVouch(s, v) || time - r.at > X_PRICE_AGE || !own(r.p, coin)) continue;
		got.push(r.p[coin]); say += w[v] ?? 0; by.push(v);
	}
	if (!got.length || say * 3 <= all * 2 || !vouched(s, by)) return null;
	got.sort((a, b) => a - b);
	if (BigInt(got[got.length - 1]) * 10_000n > BigInt(got[0]) * BigInt(10_000 + X_PRICE_SPREAD_BP)) return null;
	return got[Math.floor((got.length - 1) / 2)];
}
const B = BigInt, N = Number;
/** the vaults' addresses on each network, per chain: filled in when each vault is deployed (the owner's step). The
    wallet shows a vault only where one is listed */
const X_VAULTS: Record<string, Record<string, string>> = {};
const TEST_VAULTS = new Map<string, Record<string, string>>();
/** TEST ONLY: a test chain's vault addresses */
export function testExchangeVaults(chain: string, v: Record<string, string> | null) { if (v === null) TEST_VAULTS.delete(chain); else TEST_VAULTS.set(chain, v); }
/** a vault is listed as its address, or "address@block" with the block it was deployed at (where watching starts) */
/** every listed vault: in the code (X_VAULTS), listed on the chain by its validators (x.vault), or set by a test */
const vaultList = (s: State): Record<string, string> => ({ ...(X_VAULTS[s.chain] ?? {}), ...(s.x?.listed ?? {}), ...(TEST_VAULTS.get(s.chain) ?? {}) });
export const exchangeVaults = (s: State): Record<string, string> => Object.fromEntries(Object.entries(vaultList(s)).map(([n, v]) => [n, v.split('@')[0]]));
/** the block a vault on an Ethereum-style network was deployed at, if listed */
export const exchangeVaultFrom = (s: State, net: string): number | undefined => { const v = vaultList(s)[net], b = v?.split('@')[1]; return b && /^\d+$/.test(b) ? Number(b) : undefined; };
/** what the exchange looks like now (GET /exchange): anyone can check every vault against every claim */
/** the index as anyone may see it: on since which block, the price, what the reserve holds and is worth, the DZY in hands
    and how many of them are still unbacked (early DZY, washed by fees), and the part of every fee that washes */
export function indexView(s: State) {
	const f = xFloor(s), from = indexFrom(s.chain);
	const held = Object.entries(s.x?.pot ?? {}).filter(([, n]) => n > 0).map(([coin, units]) => { const p = xPrice(s, coin); return { coin, units, usd: p === null ? null : N((B(units) * B(p)) / 10n ** B(X_COINS[coin].decimals)) }; });
	return { retired: s.x?.retired ?? {}, from: Number.isFinite(from) ? from : null, on: s.x?.index ?? null, price: indexOn(s) ? indexPrice(s) ?? s.x?.nav ?? null : null, reserveUsd: f ? N(f.usd) : null, hands: f ? N(f.hands) : null, unbacked: s.x?.unbacked ?? 0, feeBps: RULES.xFeeBps, washBp: N(WASH_BP), held };
}
export function exchangeView(s: State) {
	const from = exchangeFrom(s.chain), vaults = exchangeVaults(s);
	const coins = Object.fromEntries(Object.entries(X_COINS).filter(([c]) => xLive(s, c)).map(([c, k0]) => {
		const k = { ...k0, nets: k0.nets.filter((n) => xLive(s, c, n)) }; // only what counts now
		const held = Object.fromEntries(k.nets.map((n) => [n, s.x?.vaults[`${n}:${c}`] ?? 0])), total = Object.values(held).reduce((a, b) => a + b, 0);
		const claims = s.assets['x' + c]?.supply ?? 0, locked = Object.entries(locksOfX(s) ?? {}).filter(([q]) => q.endsWith(':' + c)).reduce((n, [, v]) => n + v, 0);
		return [c, { name: k.name, decimals: k.decimals, nets: k.nets, vaults: Object.fromEntries(k.nets.filter((n) => own(vaults, n)).map((n) => [n, vaults[n]])), held, total, claims, locked, pot: s.x?.pot?.[c] ?? 0, ...(s.heart ? { fees: heartCoin(s)[c] ?? 0 } : {}), price: xPrice(s, c), limits: xUnlimited(s) ? {} : X_LIMITS[c] }];
	}));
	const f = xFloor(s), btc = xPrice(s, 'BTC');
	const floor = f ? { usd: f.perDzy, sats: btc ? N((B(f.perDzy) * 100_000_000n) / B(btc)) : null } : null;
	const dzyUsd = s.sun ? spotPrice(s) : null;
	const pays = Object.entries(s.xpays ?? {}).slice(-50).map(([id, p]) => ({ id, ...p }));
	return { open: exchangeOn(s), checkoutVault: checkoutV2(s), btcOrders: orderBtcOn(s), reserve: { open: reserveOn(s), from: Number.isFinite(reserveFrom(s.chain)) ? reserveFrom(s.chain) : null }, index: indexView(s), wdzy: { open: wdzyOn(s), mint: wdzyMint(s.chain), held: s.wdzy?.held ?? 0, cap: wdzyCap(s.chain) }, nftItems: { open: nftItemsOn(s), from: Number.isFinite(nftItemsFrom(s.chain)) ? nftItemsFrom(s.chain) : null }, resale: { open: resaleOn(s), from: Number.isFinite(resaleFrom(s.chain)) ? resaleFrom(s.chain) : null, ...RESALE }, fee: { bps: feeBpsOf(s), to: RULES.saleFeeTo }, from: Number.isFinite(from) ? from : null, feeBps: RULES.xFeeBps, tradeFeeBps: RULES.xTradeBps, priceMaxAgeMs: X_PRICE_AGE, priceMaxSpreadBp: X_PRICE_SPREAD_BP, dzyPrice: dzyUsd, dzySats: dzyUsd !== null && btc ? N((B(dzyUsd) * 100_000_000n) / B(btc)) : null, btcUsd: btc, floor, coins, payouts: pays,
		dusd: { owed: s.assets.DUSD?.supply ?? 0, loans: keysOf(loansOfX(s) ?? {}).length, rateBps: RULES.loanRateBps, openBps: RULES.loanOpenBps, minBps: RULES.loanMinBps, liqBps: RULES.loanLiqBps, bonusBps: RULES.loanBonusBps } };
}

/* ---------- the crew upgrade (2026-11-17) ----------
   Anyone with 1 DZY staked runs a node and is a candidate; its node checks in every few minutes (node.checkin) with its
   public address, which is also how other nodes find it. Each period a crew is drawn from the candidates online, by
   lottery with one ticket per staked shard (its own and its backers'), seeded by the newest Bitcoin block: block-making
   passes around everyone, and the more one has staked the more often it is picked. It starts at a set block of each
   chain: the same chain and genesis, and every block before it keeps the old rules. */
// dznye-core switched on at block 2,000 (it was replaced by dznye-mainnet before then); dznye-mainnet, the live chain,
// and dznye-dev (the local preview's test chain) have the crew rules, checkers included, from their first block
const CREW_FROM: Record<string, number> = { 'dznye-core': 2_000, 'dznye-mainnet': 1, 'dznye-dev': 1 };
const TEST_CREW = new Map<string, number>();
/** TEST ONLY: the block a test chain starts the crew rules at (null: back to the rule) */
export function testCrewFrom(chain: string, height: number | null) { if (height === null) TEST_CREW.delete(chain); else TEST_CREW.set(chain, height); }
export const crewFrom = (chain: string) => TEST_CREW.get(chain) ?? (Object.hasOwn(CREW_FROM, chain) ? CREW_FROM[chain] : Infinity);
/** do the crew rules apply to block `height` (by default the next block, the one being made)? */
export const crewOn = (s: State, height: number = s.height + 1) => height >= crewFrom(s.chain);
/** has this key's node checked in lately (at `time`)? */
export const isOnline = (s: State, addr: string, time: number = s.time) => !!s.nodes && own(s.nodes, addr) && time - s.nodes[addr].at <= RULES.checkinWindowMs;
const crewHash = (text: string) => { const b = btcSha256(new TextEncoder().encode(text)); let h = ''; for (const x of b) h += x.toString(16).padStart(2, '0'); return h; };
/** Draw a crew from `cands` for period `epoch`: with crewMin or fewer, all of them, each with a say by its stake;
    else crewShareBp of them (crewMin to crewMax seats), each seat a ticket drawn by staked shards, so a big staker can
    hold several seats (several votes). Seeded by the newest Bitcoin block the chain holds, else its last block. */
export function drawCrew(s: State, cands: string[], epoch: number): { validators: string[]; powers: Record<string, number> } {
	const sorted = [...new Set(cands)].sort(), powers: Record<string, number> = {};
	if (sorted.length <= RULES.crewMin) {
		for (const a of sorted) powers[a] = Math.max(1, Math.floor(weightOf(s, a) / DZY));
		return { validators: sorted, powers };
	}
	const size = Math.min(RULES.crewMax, Math.max(RULES.crewMin, Math.ceil(sorted.length * RULES.crewShareBp / 10_000)));
	const list: [bigint, string][] = [];
	let W = 0n;
	for (const a of sorted) { const w = BigInt(weightOf(s, a)); if (w > 0n) { W += w; list.push([W, a]); } }
	const seed = crewHash(`dznye-crew:${s.sun?.btc?.hash ?? s.last}:${epoch}`);
	for (let k = 0; k < size; k++) {
		const x = BigInt('0x' + crewHash(seed + ':' + k)) % W;
		let lo = 0, hi = list.length - 1;
		while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid][0] > x) hi = mid; else lo = mid + 1; }
		powers[list[lo][1]] = (powers[list[lo][1]] ?? 0) + 1;
	}
	return { validators: Object.keys(powers).sort(), powers };
}
/** a candidate: under the crew rules, 1 DZY or more staked; before them (on a chain with the Sun), 1% of a seat. Not
    benched or barred. Holders may back it. */
export const isCandidate = (s: State, addr: string) => {
	const st = s.stakes && own(s.stakes, addr) ? s.stakes[addr] : null;
	if (!st || st.tomb || st.jailed !== undefined) return false;
	if (crewOn(s)) return st.bond >= RULES.crewMinStake;
	return st.bond * 100 >= seatPrice(s);
};
/** may this key make blocks right now and earn from them: enough staked, not benched, not barred */
export const isStaker = (s: State, addr: string) => {
	const st = s.stakes && own(s.stakes, addr) ? s.stakes[addr] : null;
	if (!st || st.tomb || st.jailed !== undefined) return false;
	if (crewOn(s)) return st.bond >= RULES.crewMinStake; // the crew rules: any candidate may make blocks when drawn
	if (!s.sun) return st.bond >= RULES.minStake;
	// on a chain with the Sun: a seat is the seat price in own stake plus what holders back it with, of which at least
	// 1% its own (skin in the game). So anyone can validate however valuable DZY becomes: holders choose whom to back
	const price = seatPrice(s);
	return st.bond * 100 >= price && weightOf(s, addr) >= price;
};
/** Who the validators are for the next block. Until staking has taken over: the starting set. It takes over once every
    starting validator has staked enough, or once at least `handover` keys have (so a lone outsider can never replace a
    chain's starting validators). From then on: the most-staked keys, up to maxValidators, in address order. The set
    is never left empty: with no staker left, it stays as it was. */
export function nextValidators(s: State, height: number = s.height + 1, time: number = s.time): { validators: string[]; staked: boolean } {
	if (s.heart) return nextHeartCrew(s, time);
	if (crewOn(s, height)) return nextCrew(s, time);
	const cands = Object.keys(s.stakes ?? {}).filter((a) => isStaker(s, a))
		.sort((x, y) => weightOf(s, y) - weightOf(s, x) || (x < y ? -1 : 1))
		.slice(0, RULES.maxValidators).sort();
	if (!s.staked && cands.length < RULES.handover && !s.validators.every((v) => isStaker(s, v))) return { validators: s.validators, staked: false };
	return { validators: cands.length ? cands : s.validators, staked: true };
}

/** Under the crew rules: the crew for the next block. Until staking has taken over (as before: every starting
    validator a candidate online, or `handover` candidates online), the starting set. Then the crew of this period,
    drawn once per period from the candidates online; drawn again at once if one of its members is benched or barred. */
function nextCrew(s: State, time: number): { validators: string[]; staked: boolean } {
	const online = Object.keys(s.stakes ?? {}).filter((a) => isCandidate(s, a) && isOnline(s, a, time) && s.nodes![a].url !== undefined); // a checker with no public address cannot be reached to make blocks
	if (!s.staked && online.length < RULES.handover && !s.validators.every((v) => online.includes(v))) return { validators: s.validators, staked: false };
	if (!online.length) return { validators: s.validators, staked: true }; // never empty
	const epoch = Math.floor(time / RULES.crewEveryMs);
	if (s.crew && s.crew.epoch === epoch && s.crew.validators.every((v) => isCandidate(s, v))) return { validators: s.crew.validators, staked: true };
	s.crew = { epoch, ...drawCrew(s, online, epoch) };
	return { validators: s.crew.validators, staked: true };
}
/** the Heart upgrade's crew (heart.ts): drawn once a period by stake x time, or at once when a member may not serve any more */
function nextHeartCrew(s: State, time: number): { validators: string[]; staked: boolean } {
	const epoch = Math.floor(time / RULES.crewEveryMs), was = s.crew;
	if (was?.seed !== undefined && was.epoch === epoch && was.validators.every((v) => isCandidate(s, v))) return { validators: was.validators, staked: !!s.staked };
	// the starting validators of a chain where staking has not begun: they carry on, one say each, until one of them stakes
	const drawn = Object.keys(s.stakes ?? {}).some((a) => s.heart!.anchors.includes(a) && isCandidate(s, a)) || s.staked ? drawHeartCrew(s, time, epoch) : null;
	if (!drawn) { delete s.crew; return { validators: s.validators, staked: !!s.staked }; }
	s.crew = { epoch, ...drawn };
	return { validators: s.crew.validators, staked: true };
}
/** Each validator's say in agreement. Before staking takes over: one each. After: the whole DZY it has staked, so
    halting the chain takes more than a third of all the stake, and controlling it more than two thirds, however many
    keys it is spread over. (A validator kept only because the set may not be empty has a say of 1.) */
export function powers(s: State): Record<string, number> {
	const out: Record<string, number> = {};
	if (s.crew && crewOn(s)) { for (const v of s.validators) out[v] = s.crew.powers[v] ?? 1; return out; } // seats won in the draw
	for (const v of s.validators) {
		const st = s.staked && s.stakes && own(s.stakes, v) ? s.stakes[v] : null;
		out[v] = st ? Math.max(1, Math.floor(weightOf(s, v) / DZY)) : 1;
	}
	return out;
}

/** What happens at the end of every block, after its transactions: keeping track of validators that miss their turn,
    benching one that has missed too many, and choosing the validators for the next block.
    `round` is the round in which the block was made: the validators whose turn it was in rounds 0..round-1 did not
    propose (offline, or too slow). If the round is very high the whole network was stuck, and nobody is blamed. */
export function endBlock(s: State, height: number, round: number, proposer: string, time: number) {
	const vs = s.validators, n = vs.length;
	if (crewOn(s, height)) { // checkers: the block before this one joins the recent hashes (this one's own hash is `last` once it is made)
		const r = (s.recent ??= { h: height - 1, hashes: [] });
		r.hashes = [...r.hashes, s.last];
		if (r.hashes.length > RULES.recentBlocks) { r.hashes = r.hashes.slice(-RULES.recentBlocks); r.h = height - RULES.recentBlocks; }
		if (r.h + r.hashes.length !== height) s.recent = { h: height - 1, hashes: [s.last] }; // a gap (cannot happen on a live chain): start again
	}
	if (s.stakes) {
		const st = own(s.stakes, proposer) ? s.stakes[proposer] : null;
		if (st?.missed) delete st.missed;
		if (round > 0 && round < 2 * n) {
			const missed = new Set<string>();
			const pw = s.heart ? powers(s) : null;
			for (let k = 0; k < round; k++) missed.add(pw ? turnFor(vs, pw, s.crew?.seed ?? '', height, k) : vs[(height + k) % n]);
			missed.delete(proposer);
			for (const v of missed) { const m = own(s.stakes, v) ? s.stakes[v] : null; if (m && !m.tomb) { m.missed = (m.missed ?? 0) + 1; if (s.heart) missedTurn(s, v); } }
			// bench at most one validator per block, and never the last one
			const out = [...missed].sort().find((v) => own(s.stakes!, v) && (s.stakes![v].missed ?? 0) >= (s.heart ? HEART.missLimit : RULES.missLimit) && s.stakes![v].jailed === undefined && (!s.heart || benchable(s, v)));
			if (out && n > 1) s.stakes[out].jailed = time + RULES.jailTime;
		}
	}
	const heartWas = !!s.heart; startHeart(s, height, time); if (s.heart && !heartWas) startLists(s); startTime(s, height); startProof(s, height); startFuture(s, height);
	indexBlock(s, height, time); // the index: turns on at its block, then keeps its last price
	const next = nextValidators(s, height, time);
	s.validators = next.validators;
	if (next.staked) s.staked = true;
}
export const TX_TYPES = Object.keys(HANDLERS);

/** Apply one transaction. Returns its id, or throws with the reason and leaves the state exactly as it was.
    `proposer`: the validator making the block it goes in, which earns its share of the fee if it has staked
    (left out when a transaction is only being checked at the door). */
export async function applyTx(s: State, tx: Tx, time: number = s.time, proposer?: string, report?: TxReport): Promise<string> {
	if (!tx || typeof tx !== 'object') fail('bad transaction');
	if (tx.chain !== s.chain) fail('wrong chain');
	if (!isAddr(tx.from)) fail('bad sender');
	if (tx.signer !== undefined && (!isAddr(tx.signer) || tx.signer === tx.from)) fail('bad signer');
	if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 1) fail('bad nonce');
	if (!own(HANDLERS, tx.type)) fail('unknown transaction type');
	if (!tx.data || typeof tx.data !== 'object' || Array.isArray(tx.data)) fail('bad data');
	if (typeof tx.sig !== 'string') fail('missing signature');
	if (tx.payer !== undefined && (!isAddr(tx.payer) || tx.payer === tx.from)) fail('bad payer');
	if (tx.payer === undefined && tx.payerSig !== undefined) fail('bad payer');
	if (tx.tip !== undefined || tx.max !== undefined) {
		if (!s.heart?.fut) fail('tips and limits are not open on this chain yet');
		if (tx.tip !== undefined && !(Number.isSafeInteger(tx.tip) && tx.tip > 0 && tx.tip <= 1e13)) fail('tip: whole shards, above nothing');
		if (tx.max !== undefined && !(Number.isSafeInteger(tx.max) && tx.max > 0)) fail('max: the most fee, in whole shards');
	}
	const msg = txMessage(tx);
	if (msg.length > (tx.type === 'contract.deploy' ? RULES.maxDeployChars : tx.type === 'transfer.many' ? RULES.maxBatchChars : tx.type === 'evm.run' && s.heart ? EVM_RULES.maxRaw + 1_000 : tx.type === 'x.prove' && s.heart?.proof ? RULES.maxBtcChars + 3_000 : tx.type === 'q.run' && s.heart?.fut ? FUTURE.qChars : (tx.type.startsWith('layer.') || tx.type.startsWith('blob.')) && s.heart ? RULES.maxProofChars : RULES.maxTxChars)) fail('transaction too big');
	if (!(await verify(tx.signer ?? tx.from, msg, tx.sig))) fail('bad signature');
	if (tx.payer !== undefined && (typeof tx.payerSig !== 'string' || !(await verify(tx.payer, payerMessage(tx), tx.payerSig)))) fail('bad payer signature');
	if (tx.type === 'evidence') { // a proof of cheating: both votes must really carry that validator's signature
		for (const v of [voteOf(tx.data.a), voteOf(tx.data.b)]) if (!(await verify(v.validator, voteMessage(s.chain, v.type, v.height, v.round, v.block), v.sig))) fail('a vote in that proof is not signed by that validator');
	}
	const id = await sha256(msg);
	if (tx.side !== undefined && (tx.type !== 'blob.part' || !s.heart || typeof tx.side !== 'string' || tx.side.length > RULES.maxPartChars)) fail('only a file\'s part brings bytes beside it');
	const ctx: Ctx = { height: s.height + 1, payer: tx.payer ?? tx.from, ...(tx.side === undefined ? {} : { side: tx.side }) };
	// co-signatures: other keys agreeing to exactly this transaction (for accounts that need several keys)
	const cosigners = new Set<string>();
	if (tx.cosigs !== undefined) {
		if (!Array.isArray(tx.cosigs) || !tx.cosigs.length || tx.cosigs.length > RULES.maxCosigs) fail('bad co-signatures');
		for (const c of tx.cosigs) {
			if (!c || !isAddr(c.key) || typeof c.sig !== 'string') fail('bad co-signatures');
			if (!(await verify(c.key, msg, c.sig))) fail('a co-signature does not match');
			cosigners.add(c.key);
		}
	}
	if (tx.type === 'contract.deploy') ctx.contract = await contractAddress(id);
	if (tx.type === 'swap.claim' && typeof tx.data.secret === 'string' && /^[0-9a-f]{64}$/.test(tx.data.secret)) ctx.secretHash = await sha256Bytes(tx.data.secret);
	if (tx.type === 'task.claim' && typeof tx.data.id === 'string' && typeof tx.data.to === 'string' && typeof tx.data.sig === 'string') {
		const q = s.tasks && own(s.tasks, tx.data.id) ? s.tasks[tx.data.id] : null;
		ctx.taskOk = !!q && (await verify(q.checker, taskMessage(s.chain, tx.data.id, tx.data.to), tx.data.sig));
	}
	if ((tx.type === 'layer.prove' || tx.type === 'layer.force') && s.heart && tx.data.op && typeof tx.data.op === 'object') { // a layer's step: its owner's signature
		const seen = tx.type === 'layer.force' ? { fo: tx.from } : (tx.data.seen as { fo?: unknown } | undefined);
		try { const op = checkOp(tx.data.op); if (op.k !== 'd' && typeof tx.data.id === 'string' && isOwner(seen?.fo)) ctx.stepSig = await verify(seen!.fo as string, opMessage(s.chain, tx.data.id, op), op.sig); } catch { /* the handler says why */ }
	}
	if (tx.type === 'gift.claim' && typeof tx.data.id === 'string' && typeof tx.data.to === 'string' && typeof tx.data.sig === 'string') {
		const g = s.gifts && own(s.gifts, tx.data.id) ? s.gifts[tx.data.id] : null;
		ctx.giftOk = !!g && (await verify(g.key, giftMessage(s.chain, tx.data.id, tx.data.to), tx.data.sig));
	}
	if (tx.type === 'name.link' && typeof tx.data.address === 'string' && typeof tx.data.net === 'string' && typeof tx.data.sig === 'string') {
		const text = linkMessage(s.chain, tx.from, tx.data.net, tx.data.address);
		if (tx.data.net === 'eth') ctx.linkOk = isEthAddr(tx.data.address) && personalSigner(text, tx.data.sig) === tx.data.address; // the address's own wallet signed (secp.ts)
		else if (tx.data.net === 'btc') ctx.linkOk = isLinkableBtc(tx.data.address) && btcMessageSigners(text, tx.data.sig).includes(tx.data.address); // its own Bitcoin wallet signed (btc.ts)
		else { const key = fromSolana(tx.data.address); ctx.linkOk = !!key && (await verify(key, text, tx.data.sig)); } // an Ed25519 key signed
	}
	if (tx.type.startsWith('channel.') && tx.data.sigA !== undefined) { // a channel state: both sides must have signed it
		const ch = s.channels && own(s.channels, tx.data.id) ? s.channels[tx.data.id] : null;
		const n = tx.data.nonce, a = tx.data.a, b = tx.data.b;
		if (ch && Number.isSafeInteger(n) && Number.isSafeInteger(a) && Number.isSafeInteger(b) && typeof tx.data.sigA === 'string' && typeof tx.data.sigB === 'string') {
			const m = channelMessage(s.chain, tx.data.id as string, n as number, a as number, b as number);
			ctx.sigsOk = (await verify(ch.a, m, tx.data.sigA)) && (await verify(ch.b, m, tx.data.sigB));
		}
	}
	// No waiting below this line: the checks and the change happen as one step, so two transactions cannot interleave.
	const acct = own(s.accounts, tx.from) ? s.accounts[tx.from] : null;
	let agent: Agent | null = null;
	if (tx.signer === undefined) { if (acct?.off) fail('this key cannot sign for that account'); }
	else if (acct?.keys?.includes(tx.signer)) { /* a full device key */ }
	else if (acct?.agents && own(acct.agents, tx.signer)) {
		agent = acct.agents[tx.signer];
		if (tx.type !== 'transfer') fail('an agent key can only send');
		if (time > agent.until) fail('this agent key has ended');
		if (tx.data.asset !== agent.asset || !isAmount(tx.data.amount) || tx.data.amount > agent.left) fail('that is more than this agent key is allowed');
	} else fail('this key cannot sign for that account');
	if (acct?.multi && !agent) { // several keys must agree: count the distinct listed keys that signed
		const signed = new Set([...cosigners].filter((k) => acct.multi!.keys.includes(k)));
		if (acct.multi.keys.includes(tx.signer ?? tx.from)) signed.add(tx.signer ?? tx.from);
		if (signed.size < acct.multi.need) fail(`this account needs ${acct.multi.need} of its ${acct.multi.keys.length} keys to sign; ${signed.size} did`);
	}
	if (acct?.q?.only) fail('this account moves only by its hash key (q.run)');
	if (tx.payer !== undefined && own(s.accounts, tx.payer) && s.accounts[tx.payer].q?.only) fail('that payer moves only by its hash key');
	if (tx.payer !== undefined && own(s.accounts, tx.payer) && s.accounts[tx.payer].multi) fail('an account that needs several keys cannot pay others\' fees');
	const next = nonceOf(s, tx.from) + 1;
	if (tx.nonce !== next) fail(`nonce must be ${next}`);

	/* The fee: taken from the payer (the sender, unless another account signed to pay it). It is taken before the
	   transaction's own checks so they see what is left (sending your whole DZY balance leaves nothing for the fee),
	   and given back exactly if the transaction is refused, so a refused transaction still leaves no trace. */
	const payer = tx.payer ?? tx.from, tip = tx.tip ?? 0, base = feeFor(s, tx) + tip;
	if (tx.max !== undefined && base > tx.max) fail(`the fee is ${base} now, above its limit of ${tx.max}: it waits for a quieter moment`);
	// free transactions: a partner shop's monthly allowance first, else the daily share of a locker (by DZY locked)
	const partnerOk = !tip && base > 0 && base === (s.fee ?? 0) && partnerFreeLeft(s, payer, time) > 0;
	const lockOk = !tip && !partnerOk && !!s.sun && base > 0 && base === (s.fee ?? 0) && lockFreeLeft(s, payer) > 0;
	const waived = partnerOk || lockOk;
	const fee = waived ? 0 : base;
	const payerAcct = own(s.accounts, payer) ? s.accounts[payer] : null;
	if (tx.payer !== undefined && payerAcct?.off) fail('the payer\'s key is switched off');
	// on a chain with the Sun, a new or tiny account's fee is paid by the Sun, within its welcome budget
	const entries = s.heart ? newEntries(s, tx) : 0; // counted before anything changes
	const bySun = !tip && !!s.sun && tx.payer === undefined && sunPays(s, payer, fee, entries > 0);
	if (fee && !bySun && agent && tx.payer === undefined && fee > (agent.fees ?? 0)) fail('this agent key has no allowance left for fees');
	let before = 0;
	const takes = fee > 0 && !bySun;
	const fromTrade = takes && tx.payer === undefined && !agent && s.heart && indexOn(s) ? feeFromTrade(s, tx, payer, fee) : null; // the fee from the trade itself
	const data = fromTrade?.data ?? tx.data;
	if (takes) {
		if (balanceOf(s, payer, NATIVE) < fee) { fromTrade?.undo(); fail(tx.payer === undefined ? `every transaction costs a fee of ${fee} DZY parts; this account does not hold enough` : 'the payer does not hold enough DZY for the fee'); }
		before = payerAcct!.bal[NATIVE];
		if (s.sun) payerAcct!.bal[NATIVE] = before - fee; // only for the checks below; taken for real once they pass
		else sub(s, payer, NATIVE, fee);
	}
		ctx.fee = bySun ? 0 : fee; // (a fee the Sun paid is nobody's to get back)
	let commit: () => void;
	try { commit = HANDLERS[tx.type](s, tx.from, data, id, time, ctx); } catch (e) {
		if (takes) payerAcct!.bal[NATIVE] = before;
		fromTrade?.undo();
		throw e;
	}
	if (s.sun) { if (takes) payerAcct!.bal[NATIVE] = before; sunCharge(s, tx.from, payer, fee, bySun, entries > 0); } // the sender renews; the fee waits in the profit pot
	account(s, tx.from).nonce = tx.nonce;
	commit();
	if (entries) keptAdd(s, entries * KEPT.entryBytes);
	if (ctx.gasUsed !== undefined) workAdd(s, ctx.gasUsed, roomOf(s).gas); // a contract's work fills the block as bytes do
	if (lockOk) lockFreeUse(s, payer);
	if (partnerOk && s.shops && own(s.shops, payer)) { const sh = s.shops[payer], period = Math.floor(time / PERIOD); sh.free = [period, (sh.free && sh.free[0] === period ? sh.free[1] : 0) + 1]; }
	// a contract pays only for the gas it used: the rest of what it put up comes back to whoever paid
	let used = fee;
	if (s.sun) {
		// a contract pays only for the gas it used: the rest goes back to whoever paid (the Sun, if it did)
		if (fee && ctx.gasUsed !== undefined) { used = Math.min(fee, gasFee(s, ctx.gasUsed) + sizeExtra(s, tx) + tip); if (fee - used) { if (bySun) { s.sun.feePot -= fee - used; toSun(s, fee - used); } else sunRefund(s, payer, fee - used); } }
	} else {
		if (fee && ctx.gasUsed !== undefined) { used = Math.min(fee, gasFee(s, ctx.gasUsed)); if (fee - used) add(s, payer, NATIVE, fee - used); }
		// a staked validator that makes the block earns its share of the fee; the rest goes to the treasury
		const share = used && proposer && isStaker(s, proposer) ? mulDiv(used, RULES.feeShare, 100) : 0;
		if (share) add(s, proposer!, NATIVE, share);
		toTreasury(s, used - share);
	}
	if (s.heart && used && !bySun && tx.type === 'contract.call' && s.contracts && own(s.contracts, tx.data.contract)) { const by = s.contracts[tx.data.contract].creator; s.heart.dev[by] = (own(s.heart.dev, by) ? s.heart.dev[by] : 0) + used; }
	if (used && !bySun && agent && tx.payer === undefined) { agent.fees! -= used; if (!agent.fees) delete agent.fees; }
	if (report) { report.fee = used; if (ctx.gasUsed !== undefined) report.gasUsed = ctx.gasUsed; if (ctx.failed) report.failed = ctx.failed; }
	if (agent && acct?.agents) {
		agent.left -= tx.data.amount as number;
		if (agent.left === 0) { delete acct.agents[tx.signer!]; if (!Object.keys(acct.agents).length) delete acct.agents; }
	}
	return id;
}

/** one fingerprint of every account, asset and open offer */
export async function stateRoot(s: State): Promise<string> {
	// root.ts: a fixed tree of buckets; a block (a layer, layer.ts) re-hashes only what it changed
	return stateRootOf(s as unknown as Record<string, unknown>, rootCacheFor(s.chain));
}

/** the public numbers for one asset. Circulating leaves out what the issuer itself still holds (and, for DZY, what is
    staked and what the treasury holds).
    For DZY it also lists every pool: its limit, what has been issued from it, and what is unlocked at `time`. */
export function supplyOf(s: State, id: string, time: number = s.time) {
	const a = s.assets[id], held = balanceOf(s, a.issuer, id);
	if (s.sun && id === NATIVE) { const v = sunSupply(s); return { asset: id, symbol: a.symbol, name: a.name, decimals: a.decimals, cap: a.cap ?? null, issued: a.minted, burned: 0, supply: a.supply, heldByIssuer: 0, circulating: v.circulating - stakedTotal(s), left: 0, staked: stakedTotal(s), treasury: v.sun, sun: v.sun, unsold: v.unsold, locked: v.locked, pots: v.pots, price: v.price }; }
	const pools = id !== NATIVE ? undefined : Object.fromEntries(Object.entries(POOLS).map(([k, p]) => [k, { cap: p.cap, issued: s.pools[k], unlocked: unlocked(p, elapsed(s, time)), what: p.what, cliffMonths: p.cliff, months: p.months }]));
	return { asset: id, symbol: a.symbol, name: a.name, decimals: a.decimals, cap: a.cap ?? null, issued: a.minted, burned: a.minted - a.supply, supply: a.supply, heldByIssuer: held, circulating: a.supply - held - (id === NATIVE ? stakedTotal(s) + (s.treasury ?? 0) : 0), left: a.cap === undefined ? null : a.cap - a.minted, pools, ...(id === NATIVE ? { staked: stakedTotal(s), treasury: s.treasury ?? 0 } : {}) };
}

/** all DZY locked up by validators, including what is unlocking */
export function stakedTotal(s: State): number {
	let n = 0;
	for (const st of Object.values(s.stakes ?? {})) { n += st.bond; for (const u of st.unbonding ?? []) n += u.amount; }
	for (const m of Object.values(s.delegations ?? {})) for (const x of Object.values(m)) n += x;
	for (const list of Object.values(s.undelegating ?? {})) for (const u of list) n += u.amount;
	return n;
}

/** for every asset: what accounts hold + what open offers hold. Must always equal the asset's supply. */
export function holdings(s: State): Record<string, number> {
	const t: Record<string, number> = {};
	for (const id of Object.keys(s.assets)) t[id] = 0;
	for (const a of Object.values(s.assets)) if (a.backed) t[NATIVE] += a.backed.reserve; // DZY behind reward points
	for (const a of Object.values(s.accounts)) for (const [id, n] of Object.entries(a.bal)) t[id] += n;
	for (const o of Object.values(s.offers)) t[o.give.asset] += o.give.amount;
	t[NATIVE] += stakedTotal(s) + (s.treasury ?? 0);
	if (s.sun) { const h = sunHeld(s); t[NATIVE] += h.locked + h.pots + h.unsold; }
	for (const ch of Object.values(s.channels ?? {})) t[ch.asset] += ch.total;
	for (const w of Object.values(s.swaps ?? {})) t[w.asset] += w.amount;
	for (const g of Object.values(s.gifts ?? {})) t[g.asset] += g.amount;
	for (const st of Object.values(s.streams ?? {})) t[st.asset] += st.held + st.owed;
	for (const sh of Object.values(s.shops ?? {})) for (const [a, n] of Object.entries(sh.reserve)) t[a] += n;
	for (const q of Object.values(s.tasks ?? {})) t[q.asset] += q.reward * q.left;
	for (const o of Object.values(s.xoffers ?? {})) t[o.give.asset] += o.give.amount;
	t[NATIVE] += s.wdzy?.held ?? 0; // DZY on Solana: held here, as wDZY there
	for (const [id, p] of Object.entries(s.liquidity ?? {})) { t[NATIVE] += p.dzy; t[id] += p.token; }
	for (const [k, v] of Object.entries(s.vaults ?? {})) t[k.endsWith(':L') ? NATIVE : k.slice(0, -2)] += v.cash; // what is lent out was spent into a pool: counted there
	for (const pos of Object.values(s.positions ?? {})) t[pos.side === 'L' ? pos.pool : NATIVE] += pos.held;
	for (const l of Object.values(loansOfX(s) ?? {})) t['x' + l.coin] += l.coll; // free coin held by Dznye dollar loans
	for (const m of Object.values(s.markets ?? {})) t[NATIVE] += m.pool; // the DZY behind prediction-market shares
	for (const r of Object.values(s.rounds ?? {})) t[NATIVE] += r.left; // the DZY in Up or Down rounds
	t[NATIVE] += blobHeld(s as unknown as Parameters<typeof blobHeld>[0]); // what keeps files
	evmHeld(s as unknown as Parameters<typeof evmHeld>[0], t); // coins among Ethereum contracts
	zoneHeld(s, t); // coins in layers, their bonds and the deposits of questions
	return t;
}
