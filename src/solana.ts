/* Solana, as Dznye sees it. A Dznye address is a raw Ed25519 public key, exactly what a Solana address is, so one key
   holds an account on both chains. This file is everything needed to work with Solana without any library:
   addresses, where a wallet's tokens live, building payments (SOL or a token, with a memo), and checking that a
   payment really happened (what validators do before releasing coins on Dznye). It never holds a key: signing is
   done by whoever calls it. Runs in a browser, a Cloudflare Worker and Node. */
import { fromSolana, hex, toBase58, unhex } from './crypto.ts';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Circle's USDC on Solana
/** Tether's USDT on Solana: checked on Solana itself on 2026-11-15 (an SPL token mint, 6 decimals, about 3.84 billion issued) */
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const LAMPORTS = 1_000_000_000; // 1 SOL
/** Solana's own first block hash: how a node proves it is on Solana's main network */
export const SOLANA_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
/** Free public nodes a validator asks when it sets none of its own (checked 2026-11-15 with the calls below; the
    second one refuses Cloudflare's addresses, so a Cloudflare validator leans on the first: set SOLANA_RPC to add more). */
export const SOLANA_NODES: readonly string[] = Object.freeze(['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com']);
/** The newest transaction format we read. Solana now carries version 1 transactions; a node asked with a lower number
    refuses to show them at all, which would hide a real payment. What we rely on (the result, the memo instruction, the
    balances before and after) is in every version. */
export const SOLANA_TX_VERSION = 1;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** what can be paid on Solana for coins on Dznye: its smallest unit's decimals, and its mint (none for SOL itself) */
export const SOL_TOKENS: Readonly<Record<string, { decimals: number; mint: string | null }>> = Object.freeze({ SOL: { decimals: 9, mint: null }, USDC: { decimals: 6, mint: USDC_MINT }, USDT: { decimals: 6, mint: USDT_MINT } });

export const solanaOf = (address: string) => toBase58(address);
const bytesOf = (b58: string): number[] => { const h = fromSolana(b58); if (!h) throw new Error('That is not a Solana address'); return [...unhex(h)]; };

/* ---- where a wallet's tokens live: its "associated token account" ----
   A program-derived address: SHA-256 of [owner, token program, mint, bump] + the associated-token program id +
   "ProgramDerivedAddress", using the first bump from 255 down whose result is NOT a point on the Ed25519 curve (so no
   private key can exist for it). */
const P = 2n ** 255n - 19n;
const pow = (b: bigint, e: bigint) => { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = ((P - 121665n) * pow(121666n, P - 2n)) % P;
/** is this 32-byte encoding a point on the Ed25519 curve? (x² = (y² − 1) / (d·y² + 1) must have a square root) */
export function onCurve(bytes: Uint8Array): boolean {
	let y = 0n;
	for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
	if (y >= P) return false;
	const y2 = (y * y) % P, x2 = ((y2 - 1n + P) * pow((D * y2 + 1n) % P, P - 2n)) % P;
	return x2 === 0n ? (bytes[31] & 0x80) === 0 : pow(x2, (P - 1n) / 2n) === 1n;
}
export async function associatedTokenAccount(owner: string, mint: string = USDC_MINT): Promise<string> {
	const seeds = [...bytesOf(owner), ...bytesOf(TOKEN_PROGRAM), ...bytesOf(mint)], tail = [...bytesOf(ATA_PROGRAM), ...new TextEncoder().encode('ProgramDerivedAddress')];
	for (let bump = 255; bump >= 0; bump--) {
		const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...seeds, bump, ...tail])));
		if (!onCurve(h)) return toBase58(hex(h));
	}
	throw new Error('No address found');
}

/** A token account's balance from its raw data (layout: mint 32 bytes, owner 32, amount u64 little-endian), or null
    when the data is not a token account of that mint and owner. */
export function tokenAmount(account: { owner: string; data: [string, string] } | null, mint: string, owner: string): number | null {
	if (!account || account.owner !== TOKEN_PROGRAM) return null;
	const raw = Uint8Array.from(atob(account.data[0]), (ch) => ch.charCodeAt(0));
	if (raw.length < 72 || hex(raw.slice(0, 32)) !== fromSolana(mint) || hex(raw.slice(32, 64)) !== fromSolana(owner)) return null;
	let n = 0n;
	for (let i = 71; i >= 64; i--) n = (n << 8n) | BigInt(raw[i]);
	return Number(n);
}

/** A Solana Pay transfer request (the open standard Solana wallets scan): pay `to`, optionally an amount (text, in
    whole units), an SPL token (its mint; SOL when empty), a label and a memo. */
export function solanaPay(to: string, { amount = '', token = '', label = '', memo = '' } = {}): string {
	const q = new URLSearchParams();
	if (amount) q.set('amount', amount);
	if (token) q.set('spl-token', token);
	if (label) q.set('label', label);
	if (memo) q.set('memo', memo);
	const s = q.toString().replace(/\+/g, '%20');
	return `solana:${to}${s ? '?' + s : ''}`;
}

/* ---- building a transaction (the legacy message format) ---- */
const compact = (n: number) => { const out: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); return out; } } };
const u64 = (n: number) => { const out: number[] = []; let v = BigInt(n); for (let i = 0; i < 8; i++) { out.push(Number(v & 255n)); v >>= 8n; } return out; };
export interface Instruction { program: string; keys: { key: string; signer?: boolean; writable?: boolean }[]; data: number[] }

/** The bytes a transaction's signer signs: `payer` pays the fee and is the only signer. Accounts are listed the way
    Solana requires: the signer, then writable accounts, then read-only ones (programs last among them is not needed). */
export function buildMessage(payer: string, instructions: Instruction[], blockhash: string): Uint8Array {
	const writable = new Set<string>(), readonly = new Set<string>();
	for (const ix of instructions) for (const k of ix.keys) { if (k.signer && k.key !== payer) throw new Error('only the payer may sign'); if (k.key !== payer) (k.writable ? writable : readonly).add(k.key); }
	for (const ix of instructions) if (ix.program !== payer) readonly.add(ix.program);
	for (const k of writable) readonly.delete(k);
	const keys = [payer, ...writable, ...readonly], at = (k: string) => keys.indexOf(k);
	const body: number[] = [1, 0, readonly.size, ...compact(keys.length)];
	for (const k of keys) body.push(...bytesOf(k));
	body.push(...bytesOf(blockhash), ...compact(instructions.length));
	for (const ix of instructions) body.push(at(ix.program), ...compact(ix.keys.length), ...ix.keys.map((k) => at(k.key)), ...compact(ix.data.length), ...ix.data);
	return new Uint8Array(body);
}
const memoIx = (memo: string): Instruction => ({ program: MEMO_PROGRAM, keys: [], data: [...new TextEncoder().encode(memo)] });
const amountOk = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Bad amount'); };

/** send SOL: from → to, `lamports`, with an optional memo */
export function transferMessage(from: string, to: string, lamports: number, blockhash: string, memo = ''): Uint8Array {
	if (from === to) throw new Error('That is this account');
	amountOk(lamports);
	return buildMessage(from, [
		{ program: SYSTEM_PROGRAM, keys: [{ key: from, signer: true, writable: true }, { key: to, writable: true }], data: [2, 0, 0, 0, ...u64(lamports)] },
		...(memo ? [memoIx(memo)] : [])
	], blockhash);
}
/** Send a token (USDC by default): from the sender's token account to the receiver's, making the receiver's account
    first if it does not exist yet (the sender pays its small rent), with an optional memo. `amount` in the smallest unit. */
export async function tokenTransferMessage(from: string, to: string, amount: number, blockhash: string, memo = '', mint: string = USDC_MINT, decimals = 6): Promise<Uint8Array> {
	if (from === to) throw new Error('That is this account');
	amountOk(amount);
	const [src, dst] = await Promise.all([associatedTokenAccount(from, mint), associatedTokenAccount(to, mint)]);
	return buildMessage(from, [
		{ program: ATA_PROGRAM, keys: [{ key: from, signer: true, writable: true }, { key: dst, writable: true }, { key: to }, { key: mint }, { key: SYSTEM_PROGRAM }, { key: TOKEN_PROGRAM }], data: [1] }, // create the receiver's account if missing
		{ program: TOKEN_PROGRAM, keys: [{ key: src, writable: true }, { key: mint }, { key: dst, writable: true }, { key: from, signer: true }], data: [12, ...u64(amount), decimals] }, // TransferChecked
		...(memo ? [memoIx(memo)] : [])
	], blockhash);
}
/** A creator lets one address (the fee account, which collects the creators' fee) take up to `amount` of a token from their
    token account: SPL ApproveChecked, after making that account if it is missing (the owner pays its small rent). The
    owner can see it in any Solana wallet and take it back any time (revokeMessage). */
export async function approveMessage(owner: string, delegate: string, amount: number, blockhash: string, mint: string = USDC_MINT, decimals = 6): Promise<Uint8Array> {
	if (owner === delegate) throw new Error('That is this account');
	amountOk(amount);
	const src = await associatedTokenAccount(owner, mint);
	return buildMessage(owner, [
		{ program: ATA_PROGRAM, keys: [{ key: owner, signer: true, writable: true }, { key: src, writable: true }, { key: owner }, { key: mint }, { key: SYSTEM_PROGRAM }, { key: TOKEN_PROGRAM }], data: [1] },
		{ program: TOKEN_PROGRAM, keys: [{ key: src, writable: true }, { key: mint }, { key: delegate }, { key: owner, signer: true }], data: [13, ...u64(amount), decimals] }, // ApproveChecked
	], blockhash);
}
/** take back a permission given with approveMessage (SPL Revoke) */
export async function revokeMessage(owner: string, blockhash: string, mint: string = USDC_MINT): Promise<Uint8Array> {
	const src = await associatedTokenAccount(owner, mint);
	return buildMessage(owner, [{ program: TOKEN_PROGRAM, keys: [{ key: src, writable: true }, { key: owner, signer: true }], data: [5] }], blockhash);
}
/** the permitted address takes `amount` from `owner`'s token account into its own (made if missing, it pays the rent and
    the fee): SPL TransferChecked signed by the delegate */
export async function delegatePullMessage(delegate: string, owner: string, amount: number, blockhash: string, memo = '', mint: string = USDC_MINT, decimals = 6): Promise<Uint8Array> {
	amountOk(amount);
	const [src, dst] = await Promise.all([associatedTokenAccount(owner, mint), associatedTokenAccount(delegate, mint)]);
	return buildMessage(delegate, [
		{ program: ATA_PROGRAM, keys: [{ key: delegate, signer: true, writable: true }, { key: dst, writable: true }, { key: delegate }, { key: mint }, { key: SYSTEM_PROGRAM }, { key: TOKEN_PROGRAM }], data: [1] },
		{ program: TOKEN_PROGRAM, keys: [{ key: src, writable: true }, { key: mint }, { key: dst, writable: true }, { key: delegate, signer: true }], data: [12, ...u64(amount), decimals] },
		...(memo ? [memoIx(memo)] : [])
	], blockhash);
}
/** what one token account allows a delegate to take: { delegate, amount } (null when none), from its raw bytes (base64) */
export function delegationOf(data: string): { delegate: string; amount: number } | null {
	const b = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
	if (b.length < 165) return null;
	const has = b[72] === 1 && b[73] === 0 && b[74] === 0 && b[75] === 0; // COption<Pubkey> tag
	if (!has) return null;
	let amt = 0n; for (let i = 7; i >= 0; i--) amt = (amt << 8n) | BigInt(b[121 + i]);
	return { delegate: toBase58(hex(b.slice(76, 108))), amount: Number(amt) };
}
/** a signed transaction, ready to send: one signature, then the message; base64 */
export function wire(signature: Uint8Array, message: Uint8Array): string {
	if (signature.length !== 64) throw new Error('Bad signature');
	let bin = '';
	for (const b of [1, ...signature, ...message]) bin += String.fromCharCode(b);
	return btoa(bin);
}

/* ---- checking that a payment happened ---- */
export type Rpc = (method: string, params: unknown[]) => Promise<any>;
/** one Solana node as an Rpc; throws with the node's reason */
export const rpcOf = (url: string): Rpc => async (method, params) => {
	const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) });
	const d = (await r.json().catch(() => ({}))) as any;
	if (d.error) throw new Error('Solana: ' + (d.error.message ?? 'refused'));
	if (!r.ok) throw new Error(`Solana answered ${r.status}`);
	return d.result;
};
/** several nodes as one: ask the next when one fails */
export const anyRpc = (urls: string[]): Rpc => async (method, params) => {
	let last: unknown = new Error('No Solana node is set');
	for (const u of urls) { try { return await rpcOf(u)(method, params); } catch (e) { last = e; } }
	throw last;
};

/** Is this node fit for a validator to ask? It must be on Solana's main network, list an account's final
    transactions, and hand one back in full: the calls `findPayment` and `checkPayment` make. Returns that
    transaction's slot and its age in seconds; throws with the reason when the node is not fit. */
export async function probeSolana(rpc: Rpc, now = Date.now()): Promise<{ block: number; age: number }> {
	if ((await rpc('getGenesisHash', [])) !== SOLANA_GENESIS) throw new Error('This node is on another chain');
	const sigs = await rpc('getSignaturesForAddress', [USDC_MINT, { limit: 1, commitment: 'finalized' }]);
	const signature = sigs?.[0]?.signature;
	if (typeof signature !== 'string') throw new Error('It does not list transactions');
	const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: SOLANA_TX_VERSION }]);
	if (!tx || typeof tx.slot !== 'number') throw new Error('It does not give transactions');
	return { block: tx.slot, age: Math.round(now / 1000 - Number(tx.blockTime ?? 0)) };
}

/** Find a FINAL Solana payment of at least `amount` of `token` to `payTo` that carries exactly `memo`. Returns its
    signature, or null. Looks at the receiving account's newest transactions, picks those whose memo matches, and then
    reads the transaction itself: it must have succeeded, hold that memo as a real memo instruction, and the
    receiver's balance must have gone up by at least the amount. Nothing here is taken on anyone's word but the node's;
    several validators asking different nodes is what makes it trustworthy. */
export async function findPayment(rpc: Rpc, want: { payTo: string; token: string; amount: number; memo: string }): Promise<string | null> {
	const t = SOL_TOKENS[want.token];
	if (!t) return null;
	const account = t.mint ? await associatedTokenAccount(want.payTo, t.mint) : want.payTo;
	const sigs: { signature: string; err: unknown; memo: string | null }[] = (await rpc('getSignaturesForAddress', [account, { limit: 40, commitment: 'finalized' }])) ?? [];
	for (const s of sigs) {
		if (s.err || !s.memo || !s.memo.includes(want.memo)) continue;
		try { if (await checkPayment(rpc, want, s.signature)) return s.signature; } catch { /* one unreadable transaction must not hide the next */ }
	}
	return null;
}
/** Check ONE Solana transaction (the payer says which): final, succeeded, carries exactly `memo` as a real memo
    instruction, and the payee's balance went up by at least the amount. Returns the signature when all hold. */
export async function checkPayment(rpc: Rpc, want: { payTo: string; token: string; amount: number; memo: string }, signature: string): Promise<string | null> {
	const t = SOL_TOKENS[want.token];
	if (!t || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(signature)) return null;
	const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: SOLANA_TX_VERSION }]);
	if (!tx || tx.meta?.err) return null;
	const ixs: any[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions ?? [])];
	if (!ixs.some((i) => (i.programId === MEMO_PROGRAM || i.program === 'spl-memo') && i.parsed === want.memo)) return null;
	let got = 0;
	if (t.mint) {
		const sum = (list: any[]) => (list ?? []).filter((b) => b.mint === t.mint && b.owner === want.payTo).reduce((n, b) => n + Number(b.uiTokenAmount?.amount ?? 0), 0);
		got = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
	} else {
		const keys: any[] = tx.transaction.message.accountKeys ?? [], i = keys.findIndex((k) => (k.pubkey ?? k) === want.payTo);
		if (i >= 0) got = Number(tx.meta.postBalances[i]) - Number(tx.meta.preBalances[i]);
	}
	return got >= want.amount ? signature : null;
}
