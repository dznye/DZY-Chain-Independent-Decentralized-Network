/* Ethereum and the chains that work like it (EVM): Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche.
   Everything Dznye needs to be paid on them, with no library: which coins and contracts, how a payment carries its
   memo (the memo bytes ride along in the transaction's data: after a token transfer's arguments, where token
   contracts ignore them, or as the whole data of a plain coin transfer), and how a validator checks that a payment
   really happened and is final. It never holds a key: payers use their own wallet (MetaMask, Rabby, Coinbase Wallet,
   Phantom...). Contract addresses were checked on each chain itself: name "USD Coin", symbol USDC, and the supply. */

/** One EVM chain: its id, its own coin, USDC on it (contract, decimals there), public nodes, and how long it takes
    to be final (for people: the wallet says "about N minutes"). */
export interface EvmChain { name: string; id: number; coin: string; usdc: string; usdcDecimals: number; rpc: string[]; finalMinutes: number; explorer: string }
export const EVM: Readonly<Record<string, EvmChain>> = Object.freeze({
	eth: { name: 'Ethereum', id: 1, coin: 'ETH', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', usdcDecimals: 6, rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.mevblocker.io'], finalMinutes: 18, explorer: 'https://etherscan.io/tx/' },
	base: { name: 'Base', id: 8453, coin: 'ETH', usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', usdcDecimals: 6, rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'], finalMinutes: 25, explorer: 'https://basescan.org/tx/' },
	arb: { name: 'Arbitrum', id: 42161, coin: 'ETH', usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', usdcDecimals: 6, rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org', 'https://1rpc.io/arb'], finalMinutes: 22, explorer: 'https://arbiscan.io/tx/' },
	op: { name: 'Optimism', id: 10, coin: 'ETH', usdc: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', usdcDecimals: 6, rpc: ['https://mainnet.optimism.io', 'https://optimism.drpc.org'], finalMinutes: 22, explorer: 'https://optimistic.etherscan.io/tx/' },
	polygon: { name: 'Polygon', id: 137, coin: 'POL', usdc: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', usdcDecimals: 6, rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'], finalMinutes: 1, explorer: 'https://polygonscan.com/tx/' },
	bsc: { name: 'BNB Chain', id: 56, coin: 'BNB', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', usdcDecimals: 18, rpc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://rpc-bsc.48.club'], finalMinutes: 1, explorer: 'https://bscscan.com/tx/' },
	avax: { name: 'Avalanche', id: 43114, coin: 'AVAX', usdc: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', usdcDecimals: 6, rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com', 'https://avalanche.drpc.org'], finalMinutes: 1, explorer: 'https://snowtrace.io/tx/' }
});
/* The node lists were checked on 2026-11-15 with the exact calls a validator makes (dip.ts `probe`): a node is listed
   only if it gave a finalized block AND a transaction and receipt from it. Dropped then: publicnode's Arbitrum and
   Optimism nodes (they refuse transaction lookups without a token) and 1rpc's Ethereum and Optimism nodes (rate
   limits). Each chain's own official node comes first where one exists. */
/* Amounts on Dznye are whole numbers that must stay exact, so a coin with 18 decimals is counted on Dznye in units
   of 10^-9 (gwei) and USDC in millionths. `scale` turns a Dznye amount into the chain's own smallest unit. */
export const evmScale = (net: string, token: string) => (token === 'USDC' ? EVM[net].usdcDecimals - 6 : 18 - 9);
export const isEvmAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
/** the memo, as the hex the transaction's data carries */
export const memoHex = (memo: string) => hexOf(new TextEncoder().encode(memo));
const word = (v: bigint | string) => (typeof v === 'string' ? v.toLowerCase().replace(/^0x/, '') : v.toString(16)).padStart(64, '0');
const TRANSFER = 'a9059cbb'; // transfer(address,uint256)
const TRANSFER_EVENT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)

/** What a wallet sends (eth_sendTransaction) to pay `amount` (in Dznye units) of `token` on chain `net` to `to`,
    carrying `memo`. */
export function paymentRequest(net: string, token: string, to: string, amount: number, memo: string): { to: string; value: string; data: string; chainId: string } {
	const c = EVM[net];
	if (!c) throw new Error('Unknown chain');
	if (!isEvmAddress(to)) throw new Error('Bad address');
	const units = BigInt(amount) * 10n ** BigInt(evmScale(net, token)), chainId = '0x' + c.id.toString(16);
	if (token === 'USDC') return { to: c.usdc, value: '0x0', data: '0x' + TRANSFER + word(to) + word(units) + memoHex(memo), chainId };
	if (token !== c.coin) throw new Error(`On ${c.name} you can pay in ${c.coin} or USDC`);
	return { to: to.toLowerCase(), value: '0x' + units.toString(16), data: '0x' + memoHex(memo), chainId };
}

export type Rpc = (method: string, params: unknown[]) => Promise<any>;
export const rpcOf = (url: string): Rpc => async (method, params) => {
	const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
	const d = (await r.json().catch(() => ({}))) as any;
	if (d.error) throw new Error(d.error.message ?? 'refused');
	if (!r.ok) throw new Error(`The node answered ${r.status}`);
	return d.result;
};
export const anyRpc = (urls: string[]): Rpc => async (method, params) => {
	let last: unknown = new Error('No node is set');
	for (const u of urls) { try { return await rpcOf(u)(method, params); } catch (e) { last = e; } }
	throw last;
};

/** Is this node fit for a validator to ask? It must be on the right chain, give a finalized block, and hand back a
    transaction and its receipt from that block: the three calls `checkEvmPayment` makes. Returns the finalized block's
    number and its age in seconds; throws with the reason when the node is not fit. */
export async function probeEvm(rpc: Rpc, net: string, now = Date.now()): Promise<{ block: number; age: number }> {
	const c = EVM[net];
	if (!c) throw new Error('Unknown chain');
	const id = await rpc('eth_chainId', []);
	if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(id) || BigInt(id) !== BigInt(c.id)) throw new Error('This node is on another chain');
	const fin = await rpc('eth_getBlockByNumber', ['finalized', false]);
	if (!fin || typeof fin.number !== 'string') throw new Error('No finalized block');
	const hash = Array.isArray(fin.transactions) ? fin.transactions[0] : undefined;
	if (typeof hash === 'string') {
		const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
		if (!tx || !receipt || receipt.blockNumber !== fin.number) throw new Error('It does not give transactions from its finalized block');
	}
	return { block: Number(BigInt(fin.number)), age: Math.round(now / 1000 - Number(BigInt(fin.timestamp ?? '0x0'))) };
}

/** Check ONE NFT delivery (the filler says which transaction) on chain `net`: it succeeded, it is FINAL, it is on the right
    chain, its block is no older than `after` (ms: when the filler's hold began, so an old delivery cannot be passed off as
    new), and the NFT's own contract logged the transfer of exactly token `id` to `payTo` (ERC-721 Transfer: four topics).
    How it got there (a marketplace purchase, or a plain transfer) does not matter. Returns the hash when all hold. */
export async function checkEvmNft(rpc: Rpc, net: string, want: { payTo: string; nft: { contract: string; id: string }; after: number }, hash: string): Promise<string | null> {
	const c = EVM[net];
	if (!c || !/^0x[0-9a-fA-F]{64}$/.test(hash) || !isEvmAddress(want.payTo) || !isEvmAddress(want.nft.contract) || !/^\d{1,78}$/.test(want.nft.id)) return null;
	const [tx, receipt, fin] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash]), rpc('eth_getBlockByNumber', ['finalized', false])]);
	if (!tx || !receipt || !fin || receipt.status !== '0x1') return null;
	if (BigInt(receipt.blockNumber) > BigInt(fin.number)) return null; // not final yet
	if (tx.chainId !== undefined && tx.chainId !== null && BigInt(tx.chainId) !== BigInt(c.id)) return null;
	const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
	if (!block || BigInt(block.timestamp ?? '0x0') * 1000n < BigInt(Math.floor(want.after))) return null; // made before the hold
	const contract = want.nft.contract.toLowerCase(), to = '0x' + word(want.payTo.toLowerCase()), id = BigInt(want.nft.id);
	const delivered = (receipt.logs ?? []).some((l: any) => String(l.address).toLowerCase() === contract && Array.isArray(l.topics) && l.topics.length === 4
		&& l.topics[0] === TRANSFER_EVENT && String(l.topics[2]).toLowerCase() === to && BigInt(l.topics[3]) === id);
	return delivered ? hash : null;
}

/** Check ONE transaction (the payer says which) on chain `net`: it succeeded, it is FINAL (at or below the chain's
    "finalized" block), it is on the right chain, it pays at least `amount` (Dznye units) of `token` to `payTo`, and its
    data carries exactly `memo`. Returns the transaction's hash when all hold, else null. The memo is unique to one
    hold, so one payment can never settle two. */
export async function checkEvmPayment(rpc: Rpc, net: string, want: { payTo: string; token: string; amount: number; memo: string }, hash: string): Promise<string | null> {
	const c = EVM[net];
	if (!c || !/^0x[0-9a-fA-F]{64}$/.test(hash) || !isEvmAddress(want.payTo)) return null;
	const [tx, receipt, fin] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash]), rpc('eth_getBlockByNumber', ['finalized', false])]);
	if (!tx || !receipt || !fin || receipt.status !== '0x1') return null;
	if (BigInt(receipt.blockNumber) > BigInt(fin.number)) return null; // not final yet
	if (tx.chainId !== undefined && tx.chainId !== null && BigInt(tx.chainId) !== BigInt(c.id)) return null;
	const need = BigInt(want.amount) * 10n ** BigInt(evmScale(net, want.token)), payTo = want.payTo.toLowerCase(), input = String(tx.input ?? '').toLowerCase();
	const memo = memoHex(want.memo);
	if (want.token === 'USDC') {
		// a call to USDC's transfer, the memo after its two arguments, and a Transfer event from USDC to the payee
		if (String(tx.to).toLowerCase() !== c.usdc || !input.startsWith('0x' + TRANSFER) || input.slice(2 + 8 + 128) !== memo) return null;
		const paid = (receipt.logs ?? []).filter((l: any) => String(l.address).toLowerCase() === c.usdc && l.topics?.[0] === TRANSFER_EVENT && String(l.topics?.[2] ?? '').toLowerCase() === '0x' + word(payTo))
			.reduce((n: bigint, l: any) => n + BigInt(l.data), 0n);
		return paid >= need ? hash : null;
	}
	if (want.token !== c.coin) return null;
	// a plain coin transfer straight to the payee, its whole data the memo
	if (String(tx.to).toLowerCase() !== payTo || input !== '0x' + memo || BigInt(tx.value) < need) return null;
	return hash;
}
