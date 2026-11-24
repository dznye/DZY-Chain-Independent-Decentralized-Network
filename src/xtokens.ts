/* What each Ethereum-style vault holds, network by network: the network's own coin, and the dollar coins, each with its
   token address and decimals (every address checked on its own chain: symbol() and decimals(), 2026-11-19). The chain
   counts the networks' own coins in billionths (ETH in gwei: 18 decimals on its chain, 9 here) and the dollar coins in
   millionths, so a payment is scaled down by the decimals beyond those. One table, used by the validators' watcher (what
   a Deposit was), by payouts (which token to send), and by the wallets (what to pay with). */
import { EVM } from './evm.ts';

export const ZERO_TOKEN = '0x' + '0'.repeat(40);
/** each network's own coin */
export const NATIVE: Readonly<Record<string, string>> = Object.freeze({ eth: 'ETH', base: 'ETH', arb: 'ETH', op: 'ETH', polygon: 'POL', bsc: 'BNB', avax: 'AVAX' });
/** Tether on each network that has an official one (on Arbitrum and Polygon it is USDT0, Tether's own upgrade); not on Base */
export const USDT: Readonly<Record<string, { address: string; decimals: number }>> = Object.freeze({
	eth: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
	arb: { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 },
	op: { address: '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', decimals: 6 },
	polygon: { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 },
	bsc: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
	avax: { address: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', decimals: 6 },
});
/** tokenized gold on Ethereum, an ounce each (checked on the chain 2026-11-24: symbol PAXG, 18 decimals; XAUt, 6 decimals) */
export const GOLD_TOKENS: Readonly<Record<string, Readonly<Record<string, { address: string; decimals: number }>>>> = Object.freeze({
	eth: Object.freeze({ PAXG: { address: '0x45804880de22913dafe09f4980848ece6ecbaf78', decimals: 18 }, XAUT: { address: '0x68749665ff8d2d112fa859aa293f07a622782f38', decimals: 6 } }),
});
/** the networks' own coins are counted in billionths on Dznye; the dollar coins in millionths; PAXG in billionths of an ounce, XAUT in millionths */
export const CHAIN_DECIMALS: Readonly<Record<string, number>> = Object.freeze({ ETH: 9, POL: 9, BNB: 9, AVAX: 9, USDC: 6, USDT: 6, PAXG: 9, XAUT: 6 });

/** which coin a vault Deposit of `token` on `net` is, and the decimals to drop to count it on Dznye; null: not one the
    exchange takes (it stays in the vault for good) */
export function evmCoinOf(net: string, token: string): { coin: string; scale: number } | null {
	const t = String(token).toLowerCase(), c = EVM[net];
	if (!c) return null;
	if (t === ZERO_TOKEN) return NATIVE[net] ? { coin: NATIVE[net], scale: 18 - CHAIN_DECIMALS[NATIVE[net]] } : null;
	if (t === c.usdc.toLowerCase()) return { coin: 'USDC', scale: c.usdcDecimals - 6 };
	if (USDT[net] && t === USDT[net].address) return { coin: 'USDT', scale: USDT[net].decimals - 6 };
	for (const [coin, g] of Object.entries(GOLD_TOKENS[net] ?? {})) if (t === g.address) return { coin, scale: g.decimals - CHAIN_DECIMALS[coin] };
	return null;
}
/** the token to pay `coin` with on `net` (the zero address: the network's own coin), and its decimals beyond Dznye's */
export function evmTokenOf(net: string, coin: string): { token: string; decimals: number; scale: number } | null {
	const c = EVM[net];
	if (!c) return null;
	if (NATIVE[net] === coin) return { token: ZERO_TOKEN, decimals: 18, scale: 18 - CHAIN_DECIMALS[coin] };
	if (coin === 'USDC') return { token: c.usdc.toLowerCase(), decimals: c.usdcDecimals, scale: c.usdcDecimals - 6 };
	if (coin === 'USDT' && USDT[net]) return { token: USDT[net].address, decimals: USDT[net].decimals, scale: USDT[net].decimals - 6 };
	const g = GOLD_TOKENS[net]?.[coin];
	if (g) return { token: g.address, decimals: g.decimals, scale: g.decimals - CHAIN_DECIMALS[coin] };
	return null;
}
