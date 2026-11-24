// The exchange's watchers (EXCHANGE.md), run by every validator's node: prices from several public sources, and deposits
// into (and payouts from) the vaults on other chains. They only read other chains and send transactions the chain's rules
// already check (x.price, x.deposit, x.done); a validator that reads wrongly is simply outvoted, since every one of these
// counts only when more than two thirds of the validators agree.
import { keccak256 } from './secp.ts';
import { onCurve } from './solana.ts';
import { toBase58 } from './crypto.ts';
import { fromBase58 } from './xrelease.ts';
import { evmCoinOf } from './xtokens.ts';

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export type Rpc = (method: string, params: unknown[]) => Promise<any>;
/** one call, asked of each node in turn until one answers (a node that is down or busy never stops a reading) */
export const eachInTurn = (list: Rpc[]): Rpc | null => (list.length ? async (method, params) => { let last: unknown; for (const r of list) { try { return await r(method, params); } catch (e) { last = e; } } throw last; } : null);

/* ---------------- prices, read from the blockchains themselves ----------------
   No company's price page: the markets that run on the chains. On Ethereum, Uniswap's largest pools keep a 30-minute
   average price inside the pool itself (manipulating it would mean holding a wrong price for half an hour against
   everyone's arbitrage); on Solana, Orca's SOL/USDC pool. Bitcoin is the base: ETH is priced against BTC (the WBTC/WETH
   pool) and checked against its dollar pool, SOL through the dollar and so against BTC. A USDC/USDT pool checks that the
   dollar coins are worth a dollar; if not, no price at all. (Bitcoin's own chain has no market in it: its on-chain price
   is that of WBTC, Bitcoin wrapped on Ethereum.) */
export const PRICE_POOLS = Object.freeze({
	WBTC_USDC: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35', // Uniswap v3, 0.3%: token0 WBTC (8), token1 USDC (6)
	USDC_WETH: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', // 0.05%: token0 USDC (6), token1 WETH (18)
	WBTC_WETH: '0x4585FE77225b41b697C938B018E2Ac67Ac5a20c0', // 0.05%: token0 WBTC (8), token1 WETH (18)
	USDC_USDT: '0x3416cF6C708Da44DB2624D63ea0AAef7113527C6', // 0.01%: token0 USDC (6), token1 USDT (6)
	SOL_USDC: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', // Orca whirlpool on Solana: mint A SOL (9), mint B USDC (6)
});
export const PRICE_WINDOW_S = 1800;
const OBSERVE = '0x883bdbfd'; // observe(uint32[])
/** a Uniswap v3 pool's average tick over the last `window` seconds, from its own record */
export async function averageTick(rpc: Rpc, pool: string, window = PRICE_WINDOW_S): Promise<number> {
	const w = (n: number) => n.toString(16).padStart(64, '0');
	const out: string = await rpc('eth_call', [{ to: pool, data: OBSERVE + w(32) + w(2) + w(window) + w(0) }, 'latest']);
	const words = (out ?? '').replace(/^0x/, '').match(/.{64}/g) ?? [];
	const at = Number(BigInt('0x' + words[0])) / 32, n = Number(BigInt('0x' + words[at]));
	if (n !== 2) throw new Error('not a Uniswap v3 pool');
	const int = (h: string) => { const v = BigInt('0x' + h); return v >= 1n << 255n ? v - (1n << 256n) : v; };
	const d = int(words[at + 2]) - int(words[at + 1]);
	return Number(d / BigInt(window)) - (d % BigInt(window) < 0n ? 1 : 0); // rounded toward minus infinity, as Uniswap does
}
const tickPrice = (tick: number, decimals0: number, decimals1: number) => Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1); // token1 per token0
/** a Solana Orca whirlpool's price now (mint B per mint A), from its account: sqrt price as a Q64.64 number */
export async function whirlpoolPrice(rpc: Rpc, account: string, decimalsA: number, decimalsB: number): Promise<number> {
	const r = await rpc('getAccountInfo', [account, { encoding: 'base64', commitment: 'finalized' }]);
	const b = Uint8Array.from(atob(r?.value?.data?.[0] ?? ''), (c) => c.charCodeAt(0));
	if (b.length < 213) throw new Error('not a whirlpool');
	let sqrt = 0n;
	for (let i = 15; i >= 0; i--) sqrt = (sqrt << 8n) | BigInt(b[65 + i]);
	const s = Number(sqrt) / 2 ** 64;
	return s * s * Math.pow(10, decimalsA - decimalsB);
}
const agree = (a: number, b: number, bp = 200) => Math.abs(a - b) * 10_000 <= Math.min(a, b) * bp;
/** Every coin's price in µ$ per whole coin, read from the chains: BTC from WBTC/USDC, ETH through BTC (WBTC/WETH) and
    checked against WETH/USDC, SOL from Solana's own market, USDC 1 dollar while USDC/USDT agrees. A coin that cannot be
    read or does not check out is left out (and is not traded until it can be). */
export async function readChainPrices(eth: Rpc | null, sol: Rpc | null): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	if (!eth) return out;
	// one after another: public nodes (and Cloudflare) refuse many calls at once
	const ticks: (number | null)[] = [];
	for (const pool of [PRICE_POOLS.WBTC_USDC, PRICE_POOLS.USDC_WETH, PRICE_POOLS.WBTC_WETH, PRICE_POOLS.USDC_USDT]) ticks.push(await averageTick(eth, pool).catch(() => null));
	const [tBtc, tEth, tBtcEth, tUsd] = ticks;
	if (tUsd === null || !agree(tickPrice(tUsd, 6, 6), 1)) return out; // the dollar coins are not a dollar: no price is safe
	out.USDC = 1_000_000;
	if (tBtc === null) return out;
	const btc = tickPrice(tBtc, 8, 6); // USDC per BTC
	out.BTC = Math.round(btc * 1e6);
	if (tBtcEth !== null && tEth !== null) {
		const ethViaBtc = btc / tickPrice(tBtcEth, 8, 18), ethDirect = 1 / tickPrice(tEth, 6, 18);
		if (agree(ethViaBtc, ethDirect)) out.ETH = Math.round(ethViaBtc * 1e6); // Bitcoin is the base
	}
	if (sol) { const p = await whirlpoolPrice(sol, PRICE_POOLS.SOL_USDC, 9, 6).catch(() => 0); if (p > 0) out.SOL = Math.round(p * 1e6); }
	out.USDT = 1_000_000; // the USDC/USDT pool above already showed both dollar coins are a dollar
	// BNB, POL and AVAX have no deep pool on Ethereum: Chainlink's feeds there, read on the chain, and only while fresh
	for (const [c, feed] of Object.entries(PRICE_FEEDS)) { const p = await feedPrice(eth, feed).catch(() => 0); if (p > 0) out[c] = Math.round(p * 1e6); }
	// gold: an ounce of PAXG or XAUT at Chainlink's XAU / USD (the node posts it only once gold counts: xLive)
	{ const g = await feedPrice(eth, GOLD_FEED).catch(() => 0); if (g > 0) { out.PAXG = Math.round(g * 1e6); out.XAUT = Math.round(g * 1e6); } }
	return out;
}
/** Chainlink's price feeds on Ethereum (8 decimals; descriptions checked on the chain 2026-11-19: "BNB / USD", "MATIC / USD"
    (POL is MATIC renamed, one for one), "AVAX / USD") */
export const PRICE_FEEDS: Readonly<Record<string, string>> = Object.freeze({ BNB: '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A', POL: '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676', AVAX: '0xFF3EEb22B5E3dE6e705b44749C2559d704923FD7' });
/* these three feeds write a new answer when the price moves 1% (their deviation threshold) and at least once a day (their
   heartbeat; gaps of up to 22 hours seen on the chain 2026-11-19). So an answer under 25 hours old is within about 1% of the
   price; an older one means the feed is stuck, and is no price. (3 hours, the first rule, refused them most of the day.) */
export const FEED_MAX_AGE_S = 25 * 3600;
/** Chainlink's gold feed on Ethereum (description checked on the chain 2026-11-24: "XAU / USD", 8 decimals) */
export const GOLD_FEED = '0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6';
/** a feed's latest answer in dollars, or 0 when it is not positive or older than FEED_MAX_AGE_S (a stuck feed is no price) */
export async function feedPrice(rpc: Rpc, feed: string, now: number = Date.now()): Promise<number> {
	const r: string = await rpc('eth_call', [{ to: feed, data: '0xfeaf968c' }, 'latest']); // latestRoundData()
	if (typeof r !== 'string' || r.length < 2 + 64 * 5) return 0;
	const h = r.slice(2), answer = BigInt.asIntN(256, BigInt('0x' + h.slice(64, 128))), updated = Number(BigInt('0x' + h.slice(192, 256)));
	if (answer <= 0n || now / 1000 - updated > FEED_MAX_AGE_S || updated > now / 1000 + 300) return 0;
	return Number(answer) / 1e8;
}
/** post again when there is no reading of ours on the chain, it is over 30 minutes old, a coin moved more than 0.5%, or a coin is newly readable */
export function pricesWorthPosting(mine: { at: number; p: Record<string, number> } | undefined, next: Record<string, number>, now: number): boolean {
	if (!Object.keys(next).length) return false;
	if (!mine || now - mine.at > 30 * 60_000) return true;
	return Object.entries(next).some(([c, v]) => !mine.p[c] || Math.abs(v - mine.p[c]) * 1000 > mine.p[c] * 5);
}

/* ---------------- Ethereum-style vaults (vaults/evm/src/DznyeVault.sol) ---------------- */
const topic = (sig: string) => '0x' + hex(keccak256(enc.encode(sig)));
export const DEPOSIT_TOPIC = topic('Deposit(address,address,uint256,bytes32)'), RELEASED_TOPIC = topic('Released(bytes32,address,address,uint256)');
export interface FoundDeposit { tx: string; coin: string; amount: number; to: string }
/** The vault's deposits and releases in blocks from..to (both final). The network's own coin is counted in billionths
    (ETH in gwei) and the dollar coins in millionths, as the chain counts them (xtokens.ts). Deposits of any other token
    are not counted: they stay in the vault for good. The id names the payment and its place in it (one transaction may
    hold several). */
export async function scanEvmVault(rpc: Rpc, vault: string, net: string, from: number, to: number) {
	const logs: any[] = await rpc('eth_getLogs', [{ address: vault, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [[DEPOSIT_TOPIC, RELEASED_TOPIC]] }]);
	return vaultLogs(logs, vault, net);
}
/** One payment's deposits into the vault, from its receipt alone (eth_getTransactionReceipt: a call every public node
    answers, unlike eth_getLogs over a range): null while it is not yet final (or not found yet); otherwise what it
    deposited, possibly nothing (a failed payment, or one to another address). Anyone may name the transaction: only the
    chain's own receipt counts, so a wrong or made-up one gives nothing. */
/** Is this very payment there, final, into this vault? true: yes. false: the chain answers, and it is not (no such
    transaction, or it does not pay that). Throws when the node cannot be asked. */
export async function paymentThere(rpc: Rpc, vault: string, want: { net: string; coin: string; amount: number; to: string }, id: string, depth?: number): Promise<boolean> {
	const fin = await finalBlock(rpc, depth ?? 64, depth === undefined), found = await depositsInTx(rpc, vault, want.net, id.split('l')[0], fin);
	return !!found && found.deposits.some((d) => d.tx === id && d.coin === want.coin && d.amount === want.amount && d.to === want.to);
}
export async function depositsInTx(rpc: Rpc, vault: string, net: string, tx: string, finalBlockNo: number): Promise<{ deposits: FoundDeposit[]; released: { id32: string; tx: string }[] } | null> {
	if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return { deposits: [], released: [] };
	const r: any = await rpc('eth_getTransactionReceipt', [tx]);
	if (!r?.blockNumber) return null; // not in a block yet
	if (Number(BigInt(r.blockNumber)) > finalBlockNo) return null; // not final yet: look again later
	if (r.status !== '0x1' || String(r.transactionHash).toLowerCase() !== tx.toLowerCase()) return { deposits: [], released: [] };
	return vaultLogs(r.logs ?? [], vault, net);
}
function vaultLogs(logs: any[], vault: string, net: string) {
	const deposits: FoundDeposit[] = [], released: { id32: string; tx: string }[] = [];
	for (const l of logs ?? []) {
		if (String(l.address).toLowerCase() !== vault.toLowerCase() || l.removed) continue;
		const at = `${String(l.transactionHash).toLowerCase()}l${Number(l.logIndex)}`;
		if (l.topics?.[0] === DEPOSIT_TOPIC && l.topics.length === 4) {
			const token = '0x' + String(l.topics[1]).slice(26).toLowerCase(), raw = BigInt(l.data), to = String(l.topics[3]).slice(2).toLowerCase();
			const k = evmCoinOf(net, token), coin = k?.coin ?? null;
			if (!k || /^0+$/.test(to)) continue;
			const amount = raw / 10n ** BigInt(k.scale); // dust below the chain's unit stays in the vault
			if (amount > 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER)) deposits.push({ tx: at, coin, amount: Number(amount), to });
		} else if (l.topics?.[0] === RELEASED_TOPIC) released.push({ id32: String(l.topics[1]).toLowerCase(), tx: at });
	}
	return { deposits, released };
}
/** the newest final block: the chain's own "finalized" block where it has one, else `depth` blocks behind the newest
    (`useTag` false: always the depth, for a test chain whose "finalized" block never moves) */
export async function finalBlock(rpc: Rpc, depth = 64, useTag = true): Promise<number> {
	if (useTag) try { const b = await rpc('eth_getBlockByNumber', ['finalized', false]); if (b?.number) return Number(BigInt(b.number)); } catch { /* no finality tag here */ }
	return Math.max(0, Number(BigInt(await rpc('eth_blockNumber', []))) - depth);
}

/* ---------------- the Solana vault (vaults/sol/src/lib.rs) ---------------- */
/** The program's own log lines in a transaction's logs: only lines printed while the program itself was running (any
    other program in the same transaction could print a line that looks the same) */
export function programLines(logs: string[], program: string): string[] {
	const stack: string[] = [], out: string[] = [];
	for (const l of logs) {
		const inv = l.match(/^Program (\S+) invoke \[\d+\]$/);
		if (inv) { stack.push(inv[1]); continue; }
		if (/^Program \S+ (success|failed)/.test(l)) { stack.pop(); continue; }
		const m = l.match(/^Program log: (.*)$/);
		if (m && stack[stack.length - 1] === program) out.push(m[1]);
	}
	return out;
}
/** Deposits and releases in the vault program's finalized transactions after `until` (a transaction signature): oldest
    first, at most `limit`. SOL in lamports, USDC in millionths (the chain's units). `next`: the newest signature read. */
export async function scanSolVault(rpc: Rpc, program: string, usdcMint: string, until: string | undefined, limit = 50, pages = 10, wdzyMint: string | null = null) {
	// newest first, page by page back to `until`, so nothing between two looks is skipped however many there were
	const sigs: { signature: string; err: unknown }[] = [];
	let before: string | undefined;
	for (let p = 0; p < pages; p++) {
		const page: { signature: string; err: unknown }[] = await rpc('getSignaturesForAddress', [program, { limit, commitment: 'finalized', ...(until ? { until } : {}), ...(before ? { before } : {}) }]);
		sigs.push(...(page ?? []));
		if (!page || page.length < limit) break;
		before = page[page.length - 1].signature;
	}
	const deposits: FoundDeposit[] = [], released: { id32: string; tx: string }[] = [];
	for (const s of [...sigs].reverse()) {
		if (s.err) continue;
		const t = await rpc('getTransaction', [s.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
		if (!t || t.meta?.err) continue;
		let k = 0;
		for (const line of programLines(t.meta?.logMessages ?? [], program)) {
			const d = line.match(/^dznye-deposit (\S+) ([0-9a-f]{64}) (\d+)$/), r = line.match(/^dznye-released ([0-9a-f]{64}) \d+$/);
			if (d) {
				const coin = d[1] === 'SOL' ? 'SOL' : d[1] === usdcMint ? 'USDC' : wdzyMint && d[1] === wdzyMint ? 'wDZY' : null, amount = Number(d[3]);
				if (coin && Number.isSafeInteger(amount) && amount > 0 && !/^0+$/.test(d[2])) deposits.push({ tx: k++ ? `${s.signature}n${k}` : s.signature, coin, amount, to: d[2] }); // several in one transaction: each its own id
			} else if (r) released.push({ id32: '0x' + r[1], tx: s.signature });
		}
	}
	return { deposits, released, next: sigs.length ? sigs[0].signature : until };
}

/* ---------------- checking a vault before the validators list it (POST /exchange/list) ---------------- */
/** an Ethereum-style vault: code is there, it is on its first validator set, and its signers are exactly `signers` with
    power 1 each. The reason it is not, or '' */
export async function checkEvmVault(rpc: Rpc, vault: string, signers: string[]): Promise<string> {
	const code: string = await rpc('eth_getCode', [vault, 'latest']);
	if (!code || code === '0x') return 'no contract at that address';
	const set = BigInt(await rpc('eth_call', [{ to: vault, data: '0x087e926c' }, 'latest'])); // setId()
	if (set !== 1n) return 'the vault is not on its first validator set';
	const out: string = await rpc('eth_call', [{ to: vault, data: '0x46f0975a' }, 'latest']); // signers()
	const words = (out ?? '').replace(/^0x/, '').match(/.{64}/g) ?? [];
	if (words.length < 2) return 'not a Dznye vault';
	const arr = (at: number) => { const i = Number(BigInt('0x' + words[at])) / 32, n = Number(BigInt('0x' + words[i])); return words.slice(i + 1, i + 1 + n); };
	const keys = arr(0).map((w) => '0x' + w.slice(24).toLowerCase()), powers = arr(1).map((w) => BigInt('0x' + w));
	const want = [...signers].map((a) => a.toLowerCase()).sort();
	if (keys.length !== want.length || keys.some((k, i) => k !== want[i]) || powers.some((p) => p !== 1n)) return `its signers are ${keys.join(', ') || 'none'}, not this chain's validators (${want.join(', ')})`;
	return '';
}
/** a Solana vault program: its config account is owned by it, on set 1, and its keys are exactly `keys` (32 bytes hex) */
export async function checkSolVault(rpc: Rpc, program: string, keys: string[], configAddress: string): Promise<string> {
	const r = await rpc('getAccountInfo', [configAddress, { encoding: 'base64', commitment: 'finalized' }]);
	if (!r?.value) return 'the vault is not set up';
	if (r.value.owner !== program) return 'that config account is not the program\'s';
	const b = Uint8Array.from(atob(r.value.data?.[0] ?? ''), (c) => c.charCodeAt(0));
	if (b.length < 17) return 'not a Dznye vault';
	let id = 0n; for (let i = 7; i >= 0; i--) id = (id << 8n) | BigInt(b[i]);
	if (id !== 1n) return 'the vault is not on its first validator set';
	const n = b[16], got: string[] = [];
	for (let i = 0; i < n; i++) got.push(hex(b.slice(17 + i * 40, 17 + i * 40 + 32)));
	const want = [...keys].sort();
	if (got.length !== want.length || got.some((k, i) => k !== want[i])) return 'its signers are not this chain\'s validators';
	return '';
}
/** a Solana program-derived address (as find_program_address works it out) */
export async function solPda(seeds: Uint8Array[], program: string): Promise<string> {
	const pb = fromBase58(program), tag = enc.encode('ProgramDerivedAddress');
	for (let bump = 255; bump >= 0; bump--) {
		const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...seeds.flatMap((x) => [...x]), bump, ...pb, ...tag])));
		if (!onCurve(h)) return toBase58(hex(h));
	}
	throw new Error('no address');
}
