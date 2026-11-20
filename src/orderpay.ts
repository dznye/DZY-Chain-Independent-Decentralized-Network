// Checkout from any wallet or exchange: what ONE payment brought a creator, read by a validator on that chain itself
// (ledger.ts, order.*). Nothing is taken on the buyer's word: the transaction must be final, succeeded, on the right
// chain, made after the checkout opened, and it is counted only for what reached the creator's address in that coin
// (an exchange that sends from a batch contract still counts: on the 0x chains every Transfer event to the creator
// counts, on Solana the creator's balance change does). The chain then decides if it is enough (order.attest).
import { EVM } from './evm.ts';
import { evmTokenOf, ZERO_TOKEN } from './xtokens.ts';
import { SOL_TOKENS, SOLANA_TX_VERSION } from './solana.ts';
import type { Order } from './ledger.ts';

type Rpc = (method: string, params: unknown[]) => Promise<any>;
const TRANSFER_EVENT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word = (a: string) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
/** payments made a little before the checkout opened (clocks differ) still count; older ones never do */
export const ORDER_SLACK_MS = 10 * 60 * 1000;

/** what this transaction paid the order's creator, in the coin's Dznye units, or null (not final, failed, too old, not
    a payment in that coin to them) */
export async function orderReceived(rpc: Rpc, o: Pick<Order, 'net' | 'coin' | 'payTo' | 'at'>, tx: string): Promise<number | null> {
	return o.net === 'sol' ? solReceived(rpc, o, tx) : evmReceived(rpc, o, tx);
}
async function evmReceived(rpc: Rpc, o: Pick<Order, 'net' | 'coin' | 'payTo' | 'at'>, hash: string): Promise<number | null> {
	const c = EVM[o.net], tok = evmTokenOf(o.net, o.coin);
	if (!c || !tok || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
	const [tx, receipt, fin] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash]), rpc('eth_getBlockByNumber', ['finalized', false])]);
	if (!tx || !receipt || !fin || receipt.status !== '0x1') return null;
	if (BigInt(receipt.blockNumber) > BigInt(fin.number)) return null; // not final yet
	if (tx.chainId !== undefined && tx.chainId !== null && BigInt(tx.chainId) !== BigInt(c.id)) return null;
	const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
	if (!block || Number(BigInt(block.timestamp)) * 1000 < o.at - ORDER_SLACK_MS) return null; // paid before the checkout: not for it
	const payTo = o.payTo.toLowerCase();
	let units: bigint;
	if (tok.token === ZERO_TOKEN) { // the network's own coin: a plain transfer straight to the creator
		if (String(tx.to ?? '').toLowerCase() !== payTo) return null;
		units = BigInt(tx.value);
	} else {
		units = (receipt.logs ?? []).filter((l: any) => String(l.address).toLowerCase() === tok.token && l.topics?.[0] === TRANSFER_EVENT && String(l.topics?.[2] ?? '').toLowerCase() === word(payTo))
			.reduce((n: bigint, l: any) => n + BigInt(l.data), 0n);
	}
	const n = units / 10n ** BigInt(tok.scale);
	return n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
}
async function solReceived(rpc: Rpc, o: Pick<Order, 'coin' | 'payTo' | 'at'>, sig: string): Promise<number | null> {
	const t = SOL_TOKENS[o.coin];
	if (!t || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(sig)) return null;
	const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: SOLANA_TX_VERSION }]);
	if (!tx || tx.meta?.err !== null || tx.meta === undefined) return null;
	if (!tx.blockTime || tx.blockTime * 1000 < o.at - ORDER_SLACK_MS) return null;
	let got = 0;
	if (t.mint) {
		const sum = (list: any[]) => (list ?? []).filter((b) => b.mint === t.mint && b.owner === o.payTo).reduce((n, b) => n + Number(b.uiTokenAmount?.amount ?? 0), 0);
		got = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
	} else {
		const keys: any[] = tx.transaction?.message?.accountKeys ?? [], i = keys.findIndex((k) => (k.pubkey ?? k) === o.payTo);
		if (i >= 0) got = Number(tx.meta.postBalances[i]) - Number(tx.meta.preBalances[i]);
	}
	return got > 0 ? got : null;
}
/** the same test the chain makes (ledger.ts order.attest): the exact amount or more, or at least 99% of the price */
export const orderEnough = (o: Pick<Order, 'due' | 'base'>, got: number) => got >= o.due || got >= Math.floor((o.base * 99) / 100);
