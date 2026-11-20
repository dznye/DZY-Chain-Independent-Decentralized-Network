/* The Dznye Interchain Protocol (DIP), in code: how Dznye sits in the middle of other chains.

   Dznye is the hub. Every outside chain it works with has ONE adapter here, and an adapter answers one question for a
   validator: "did this exact payment become final on your chain, and what did it say?" Nothing else about the other
   chain reaches the rules in ledger.ts. Adding a chain to the web means adding an adapter (and its tokens to XTOKENS);
   the rules, the wallet and the market then work with it unchanged. The written spec is chain/DIP.md.

   What an adapter may trust: only what its nodes say about FINAL history, and never one node's "no". A node that is
   down, behind, rate-limited or has dropped old data must not hide a payment another node can show, so a validator
   asks its nodes in turn until one confirms (`confirm`). A "yes" still has to pass every check in the adapter.
   Different validators should ask different nodes: that, and the two-thirds rule on the chain, is what makes a report
   more than one company's word. */
import { XTOKENS } from './ledger.ts';
import { checkEvmNft, checkEvmPayment, EVM, probeEvm, rpcOf as evmNode } from './evm.ts';
import { checkPayment, findPayment, probeSolana, rpcOf as solanaNode, SOLANA_NODES } from './solana.ts';
import { BTC_NODES, checkBtcPayment, probeBtc, rpcOf as btcNode } from './btc.ts';

export type Rpc = (method: string, params: unknown[]) => Promise<any>;
/** the payment a hold is waiting for: at least `amount` (Dznye units) of `token` to `payTo`, carrying exactly `memo` */
export interface Want { payTo: string; token: string; amount: number; memo: string; /** token NFT: this ERC-721, delivered after `after` (ms) */ nft?: { contract: string; id: string }; after?: number }

export interface Adapter {
	/** the short name the chain's rules use (`want.net`): sol, eth, base ... */
	net: string;
	name: string;
	family: 'solana' | 'evm' | 'bitcoin';
	/** what can be paid there, and the decimals Dznye counts it in (from the rules: XTOKENS) */
	tokens: Readonly<Record<string, number>>;
	/** about how long a payment takes to be final there, in minutes (for people, and for how late a node may be) */
	finalMinutes: number;
	/** where a person can look a payment up */
	explorer: string;
	/** the payer must say which transaction paid (`xoffer.paid`); otherwise validators find it by its memo */
	needsTx: boolean;
	/** free public nodes used when a validator sets none of its own */
	nodes: readonly string[];
	/** one node, as something to ask */
	rpc(url: string): Rpc;
	/** THE question. The payment's id when a final payment matching `want` exists (`tx`: the one the payer named), else null. */
	check(rpc: Rpc, want: Want, tx?: string, test?: { floor?: bigint }): Promise<string | null>;
	/** is this node fit to ask? Its newest final block and that block's age in seconds; throws with the reason if not. */
	probe(rpc: Rpc, now?: number): Promise<{ block: number; age: number }>;
}

const solana: Adapter = {
	net: 'sol', name: 'Solana', family: 'solana', tokens: XTOKENS.sol, finalMinutes: 1, explorer: 'https://solscan.io/tx/', needsTx: false,
	nodes: SOLANA_NODES, rpc: solanaNode,
	// the payment the payer named, if any; otherwise (or if that one does not count) the newest ones carrying the memo
	check: async (rpc, want, tx) => (want.nft ? null : (tx ? await checkPayment(rpc, want, tx) : null) ?? (await findPayment(rpc, want))),
	probe: (rpc, now) => probeSolana(rpc, now)
};
const evm = (net: string): Adapter => {
	const c = EVM[net];
	return {
		net, name: c.name, family: 'evm', tokens: XTOKENS[net], finalMinutes: c.finalMinutes, explorer: c.explorer, needsTx: true,
		nodes: c.rpc, rpc: evmNode,
		check: async (rpc, want, tx) => (!tx ? null : want.nft ? checkEvmNft(rpc, net, { payTo: want.payTo, nft: want.nft, after: want.after ?? Infinity }, tx) : checkEvmPayment(rpc, net, want, tx)),
		probe: (rpc, now) => probeEvm(rpc, net, now)
	};
};

/* Bitcoin: the strongest check of all. The validator does not take the node's word that a payment is final: it checks
   the proof of work of the block and the five after it, and the proof that the payment is inside that block (btc.ts). */
const bitcoin: Adapter = {
	net: 'btc', name: 'Bitcoin', family: 'bitcoin', tokens: XTOKENS.btc, finalMinutes: 60, explorer: 'https://mempool.space/tx/', needsTx: true,
	nodes: BTC_NODES, rpc: btcNode,
	check: async (rpc, want, tx, test) => (tx && !want.nft ? checkBtcPayment(rpc, want, tx, test?.floor) : null),
	probe: (rpc, now) => probeBtc(rpc, now)
};

/** every chain in the web, by its short name */
export const ADAPTERS: Readonly<Record<string, Adapter>> = Object.freeze(Object.fromEntries([solana, bitcoin, ...Object.keys(EVM).map(evm)].map((a) => [a.net, Object.freeze(a)])));

/** Ask each node in turn until one confirms. A node that fails or says "nothing here" never ends the search; only
    when EVERY node failed is that an error (so the caller knows it learned nothing, and looks again later). */
export async function confirm(nodes: Rpc[], ask: (rpc: Rpc) => Promise<string | null>): Promise<string | null> {
	let failed: unknown, answered = false;
	for (const rpc of nodes) {
		try { const found = await ask(rpc); answered = true; if (found) return found; } catch (e) { failed = e; }
	}
	if (!answered) throw failed ?? new Error('No node is set');
	return null;
}

/** how a node is shown in public: its host only. A node's address can carry its owner's paid key in the path or the
    query, and that must never be printed. */
export const nodeLabel = (url: string) => { try { return new URL(url).host; } catch { return 'unknown'; } };

export interface NodeReport { node: string; ok: boolean; ms: number; block?: number; age?: number; late?: boolean; error?: string }
/** One node's health for one chain, measured with the calls a validator really makes. `late`: it answers, but its
    final block is much older than the chain's own finality, so payments would be seen late (never wrongly). */
export async function probeNode(a: Adapter, label: string, rpc: Rpc, now: () => number = Date.now): Promise<NodeReport> {
	const t = now();
	try {
		const { block, age } = await a.probe(rpc, t);
		const r: NodeReport = { node: label, ok: true, ms: now() - t, block, age };
		if (age > a.finalMinutes * 120 + 900) r.late = true;
		return r;
	} catch (e) {
		// the reason, shortened, and with anything that looks like an address removed (it could hold a key)
		return { node: label, ok: false, ms: now() - t, error: String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, '(address)').slice(0, 120) };
	}
}

/** A validator's own nodes, from its settings: SOLANA_RPC, BTC_RPC (Esplora API addresses), and EVM_RPC_<NET> (EVM_RPC_ETH, EVM_RPC_BASE, EVM_RPC_ARB,
    EVM_RPC_OP, EVM_RPC_POLYGON, EVM_RPC_BSC, EVM_RPC_AVAX), each a comma-separated list. A chain with no setting uses
    the public nodes. Only http(s) addresses are kept. */
export function nodesFromEnv(env: Record<string, unknown>): { solana?: string[]; btc?: string[]; evm?: Record<string, string[]> } {
	const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((u) => u.trim()).filter((u) => /^https?:\/\/[^\s]+$/.test(u)) : []);
	const out: { solana?: string[]; btc?: string[]; evm?: Record<string, string[]> } = {};
	const sol = list(env.SOLANA_RPC), btc = list(env.BTC_RPC);
	if (sol.length) out.solana = sol;
	if (btc.length) out.btc = btc;
	for (const net of Object.keys(EVM)) {
		const urls = list(env['EVM_RPC_' + net.toUpperCase()]);
		if (urls.length) (out.evm ??= {})[net] = urls;
	}
	return out;
}
