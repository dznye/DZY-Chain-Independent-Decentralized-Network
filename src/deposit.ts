/* Personal deposit addresses: buying DZY by simply SENDING dollars, from anywhere.

   Every Dznye account has its own address on Solana and on the Ethereum-style chains, worked out from its Dznye
   address by a public rule (below). Nobody holds a key to any of them, not the buyer, not the validators, not the
   owner: whatever arrives there can never move again, so it is burned exactly like a purchase sent to the burn
   address with a memo. The address itself names the buyer, so no memo is needed: an exchange, a card app or any
   wallet can pay it with an ordinary transfer.

   Why nobody can spend from them:
   - Ethereum-style: an address is the last 20 bytes of the hash of a public key. These are the last 20 bytes of a
     SHA-256 of a public text instead; spending would need a key whose public key hashes to them (about 2^160 tries).
   - Solana: an address IS a public key (a point on the Ed25519 curve). These are hashes of a public text that happen
     to be valid points, so wallets and exchanges accept them, but nobody knows the secret number behind such a point
     (finding it is the discrete-logarithm problem the whole curve's safety rests on).

   What counts: USDC or USDT on Solana; USDC on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Avalanche
   (the chain's own SUN_DOLLARS). Anything else sent there (another coin, an NFT) is lost and buys nothing. At least $1
   per transaction. The validators find deposits themselves (node.ts: once a minute, for addresses the wallet has
   asked them to watch) and confirm them with sun.attest, exactly like any other purchase. */
import { hex, toBase58 } from './crypto.ts';
import { EVM, isEvmAddress } from './evm.ts';
import { associatedTokenAccount, MEMO_PROGRAM, onCurve, SOL_TOKENS, SOLANA_TX_VERSION } from './solana.ts';

export const DEPOSIT_TAG = 'dzy-sun-deposit';
const sha = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const isDznye = (a: unknown): a is string => typeof a === 'string' && /^[0-9a-f]{64}$/.test(a);

/** this account's deposit address on every Ethereum-style chain (the same on all of them), lower case */
export async function depositEvm(address: string): Promise<string> {
	if (!isDznye(address)) throw new Error('Not a Dznye address');
	return '0x' + hex((await sha(`${DEPOSIT_TAG}:evm:${address}`)).slice(12));
}
/** this account's deposit address on Solana: the first of sha256(tag:sol:address:n), n = 0, 1, 2 ..., on the curve */
export async function depositSol(address: string): Promise<string> {
	if (!isDznye(address)) throw new Error('Not a Dznye address');
	for (let n = 0; n < 256; n++) {
		const h = await sha(`${DEPOSIT_TAG}:sol:${address}:${n}`);
		if (onCurve(h)) return toBase58(hex(h));
	}
	throw new Error('No address found'); // half of all hashes are points: this never happens
}

const word = (v: string) => v.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const TRANSFER = 'a9059cbb'; // transfer(address,uint256)
export const TRANSFER_EVENT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const memoHex = (memo: string) => hex(new TextEncoder().encode(memo));
type Rpc = (method: string, params: unknown[]) => Promise<any>;

/** How much USDC ONE Ethereum-style transaction paid into `payTo`, in millionths of a dollar: 0 unless it succeeded,
    is FINAL (at or below the chain's finalized block) and is on the right chain. With `memo`: only a direct call to
    USDC's transfer whose data carries exactly that memo counts (the burn address route). Without: every USDC Transfer
    event to `payTo` in it counts, however it was sent (an exchange, a contract, a batch). */
export async function evmPaidIn(rpc: Rpc, net: string, payTo: string, hash: string, memo: string | null = null): Promise<number> {
	const c = EVM[net];
	if (!c || !/^0x[0-9a-fA-F]{64}$/.test(hash) || !isEvmAddress(payTo)) return 0;
	const [tx, receipt, fin] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash]), rpc('eth_getBlockByNumber', ['finalized', false])]);
	if (!tx || !receipt || !fin || receipt.status !== '0x1') return 0;
	if (BigInt(receipt.blockNumber) > BigInt(fin.number)) return 0; // not final yet
	if (tx.chainId !== undefined && tx.chainId !== null && BigInt(tx.chainId) !== BigInt(c.id)) return 0;
	if (memo !== null) {
		const input = String(tx.input ?? '').toLowerCase();
		if (String(tx.to).toLowerCase() !== c.usdc || !input.startsWith('0x' + TRANSFER) || input.slice(2 + 8 + 128) !== memoHex(memo)) return 0;
	}
	const paid = (receipt.logs ?? []).filter((l: any) => String(l.address).toLowerCase() === c.usdc && l.topics?.[0] === TRANSFER_EVENT && String(l.topics?.[2] ?? '').toLowerCase() === '0x' + word(payTo))
		.reduce((n: bigint, l: any) => n + BigInt(l.data), 0n);
	return Number(paid / 10n ** BigInt(c.usdcDecimals - 6));
}

/** How much of `token` (USDC or USDT) ONE Solana transaction paid to the wallet `owner`, in millionths: 0 unless it is
    final and succeeded. With `memo`: only if it carries exactly that memo as a real memo instruction. */
export async function solPaidIn(rpc: Rpc, owner: string, token: string, signature: string, memo: string | null = null): Promise<number> {
	const t = SOL_TOKENS[token];
	if (!t?.mint || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(signature)) return 0;
	const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: SOLANA_TX_VERSION }]);
	if (!tx || tx.meta?.err) return 0;
	if (memo !== null) {
		const ixs: any[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions ?? [])];
		if (!ixs.some((i) => (i.programId === MEMO_PROGRAM || i.program === 'spl-memo') && i.parsed === memo)) return 0;
	}
	const sum = (list: any[]) => (list ?? []).filter((b) => b.mint === t.mint && b.owner === owner).reduce((n, b) => n + Number(b.uiTokenAmount?.amount ?? 0), 0);
	return Math.max(0, sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances));
}

/** the chain's newest finalized block number */
export async function evmFinalized(rpc: Rpc): Promise<number> {
	const fin = await rpc('eth_getBlockByNumber', ['finalized', false]);
	if (!fin || typeof fin.number !== 'string') throw new Error('No finalized block');
	return Number(BigInt(fin.number));
}
/** USDC sent to any of `payTos` in blocks from..to (inclusive): one entry per transaction and address, summed, in
    millionths. Only a list of candidates: each is checked again (final, succeeded) before it is confirmed. */
export async function evmDepositsIn(rpc: Rpc, net: string, payTos: string[], from: number, to: number): Promise<{ tx: string; payTo: string; amount: number }[]> {
	const c = EVM[net];
	if (!c || !payTos.length || to < from) return [];
	const logs: any[] = (await rpc('eth_getLogs', [{ address: c.usdc, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_EVENT, null, payTos.map((a) => '0x' + word(a))] }])) ?? [];
	const out = new Map<string, { tx: string; payTo: string; amount: bigint }>();
	for (const l of logs) {
		if (String(l.address).toLowerCase() !== c.usdc || l.removed) continue;
		const payTo = '0x' + String(l.topics?.[2] ?? '').slice(-40).toLowerCase(), tx = String(l.transactionHash ?? '').toLowerCase();
		if (!/^0x[0-9a-f]{64}$/.test(tx)) continue;
		const k = tx + payTo, x = out.get(k) ?? { tx, payTo, amount: 0n };
		x.amount += BigInt(l.data ?? '0x0'); out.set(k, x);
	}
	return [...out.values()].map((x) => ({ tx: x.tx, payTo: x.payTo, amount: Number(x.amount / 10n ** BigInt(c.usdcDecimals - 6)) }));
}
/** the newest final transactions touching `owner`'s token account for `token` (USDC or USDT): candidates only */
export async function solDepositSignatures(rpc: Rpc, owner: string, token: string, limit = 10): Promise<string[]> {
	const t = SOL_TOKENS[token];
	if (!t?.mint) return [];
	const sigs: { signature: string; err: unknown }[] = (await rpc('getSignaturesForAddress', [await associatedTokenAccount(owner, t.mint), { limit, commitment: 'finalized' }])) ?? [];
	return sigs.filter((s) => !s.err && typeof s.signature === 'string').map((s) => s.signature);
}
