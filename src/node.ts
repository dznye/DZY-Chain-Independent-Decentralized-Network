import { blockHash, checkBlock, fewestSigners, signVote, weights, verifyBlock, voteMessage, type Block, type Proposed, type Signer, type VoteType } from './block.ts';
import { Engine, type Memory, type Step } from './consensus.ts';
import { canon, sign, solanaAddress, verify } from './crypto.ts';
import { namesV2On, premiumNameUsd } from './ledger.ts';
import { creditView, economyView, MIN_BUY, openTickets, SUN_BURN, SUN_DOLLARS, sunBuyProblem, sunGenesis, sunMemo, sunPayment, sunSupply, sunView } from './ledger.ts';
import { depositEvm, depositSol, evmDepositsIn, evmFinalized, evmPaidIn, solDepositSignatures, solPaidIn } from './deposit.ts';
import type { SunGenesis } from './sun.ts';
// @ts-ignore: plain JavaScript shared with the tested model
import { rulesJson } from '../v2/rules.mjs';
import { itemOf, usdCost, xLive, applyTx, nonceOf, loansOf, exchangeOn, exchangeVaults, exchangeVaultFrom, exchangeView, X_COINS, balanceOf, crewFrom, crewOn, genesis, isAddr, isCandidate, NATIVE, RULES, seatPrice, volunteerMessage, streamView, recordOf, recordsOf, spaceRecords, signTx, xMemo, stateRoot, viewContract, type TxReport, supplyOf, type Account, type SignedVote, type State, type Tx, poolQuote, swapPlan, poolAverage, positionHealth, totalVoteWeight, voteWeight, partnerFreeLeft } from './ledger.ts';
import { Sequencer } from './sequencer.ts';
import { evmSignerOf, payoutId32, releaseFor, signRelease, signSolRelease, solReleaseFor } from './xrelease.ts';
import { checkEvmVault, checkSolVault, depositsInTx, eachInTurn, finalBlock, pricesWorthPosting, readChainPrices, solPda, scanEvmVault, scanSolVault, type FoundDeposit } from './xwatch.ts';
import { EVM } from './evm.ts';
import { USDC_MINT } from './solana.ts';
import { commit, fork, seal } from './layer.ts';
import { ADAPTERS, confirm, nodeLabel, probeNode, type NodeReport, type Rpc } from './dip.ts';
import { orderReceived, orderEnough } from './orderpay.ts';
/** the public nodes of a chain that answer eth_getLogs over a vault's range (checked 2026-11-19: on BNB Chain publicnode and
    48 Club's; bsc-dataseed.bnbchain.org and bsc-dataseed1.defibit.io refuse it with "limit exceeded", and publicnode also
    refused the live node's calls from Cloudflare, so 48 Club's is there too) */
export const LOG_NODES: Readonly<Record<string, readonly string[]>> = Object.freeze({ bsc: Object.freeze(['publicnode.com', '48.club']) });
type EvmRpc = Rpc;

/* A Dznye node, with no ties to any host. It needs only a place to keep things (Store), a way to be woken up, and,
   to be one of several validators, a way to talk to the others (Net). Cloudflare (worker/), a home computer or any
   server (node/) are thin shells around this one class.

   The node gives nobody special treatment. Issuing DZY, creating a token, paying, trading: each is a signed
   transaction sent to POST /tx, by whoever holds the key for it.

   A node is one of:
     a VALIDATOR  it holds a validator key. Together the validators agree on each block (consensus.ts); a block
                  counts once more than two thirds of them have signed it. On a chain with a single validator that
                  one node simply makes the blocks. The set of validators can change from one block to the next
                  (staking, see ledger.ts): a node with a validator key that is not in the set right now waits on
                  STANDBY, copying blocks from its peers, and takes part again as soon as it is back in the set.
     a FOLLOWER   it holds no key. It copies blocks from another node, re-checks every rule and every validator
                  signature, serves the same read API, and raises an alert if the history it is shown is wrong. */

export interface Store {
	loadState(): State | null;
	/** after loadState: put back the saved fingerprint tree if it gives exactly `root` (statestore.ts); optional */
	loadTree?(state: State, root: string): Promise<boolean>;
	/** save a block, the state after it, and drop the first `taken` waiting transactions: all together or not at all */
	commit(block: Block, state: State, taken: number): void;
	queueAdd(tx: Tx): void;
	queueList(): { seq: number; tx: Tx }[];
	queueDrop(seq: number): void;
	block(height: number): Block | null;
	blocks(from: number, limit: number): Block[];
	/** small named notes that must survive a restart (a validator's own votes) */
	noteGet(key: string): string | null;
	noteSet(key: string, value: string): void;
}
/** how a validator reaches the others; only needed on a chain with more than one validator */
export interface Net {
	peers: string[]; // the other validators' addresses on the network (URLs)
	post(peer: string, path: string, body: unknown): void; // send and forget
	get(peer: string, path: string): Promise<any>;
	timer(ms: number, run: () => void): void;
}
export interface NodeConfig {
	/** a chain with the Sun (its own economy, see sun.ts): when given, chain, authority, validators and fee all come from it */
	sun?: SunGenesis;
	chain: string;
	authority: string; // the address that issues DZY from the pools; it does not decide blocks
	validators?: string[]; // who agrees on blocks (default: the authority alone)
	fee?: number; // DZY parts every transaction pays, fixed at genesis (default 0: no fee)
	validator?: Signer; // this node's validator key, when it is a validator
	blockMs?: number; // single validator: how long to gather transactions before a block
	leader?: string; // on a follower: where to send people who want to submit
	timeouts?: Partial<{ propose: number; vote: number; grow: number; gossip: number; sync: number }>;
	/** keep a snapshot (the state and its block) every this many blocks, for new nodes to start from (default 1000; 0 = never) */
	snapshotEvery?: number;
	/** Start an EMPTY node from a snapshot instead of block 1. `trust` is the hash of the snapshot's block, which the
	    operator got from sources it trusts (several nodes' GET / show it). Everything after it is checked as usual. */
	snapshot?: { block: Block; state: State; trust: string };
	/** a volunteer node: the staked account that vouches for it (on a chain with the Sun no node lists a volunteer without
	    one). sig: that account's signature of volunteerMessage(chain, selfUrl); signer: a device key of that account, if
	    it signed with one. Only public values: the node holds no key for this. */
	operator?: { address: string; sig: string; signer?: string };
	/** Solana nodes this validator asks about payments for cross-chain offers (several: each is asked in turn until one
	    confirms). Validators should not all use the same one. None set: the public ones in solana.ts; an empty list:
	    this validator does not look at Solana. `solanaRpc` replaces them (tests). */
	solana?: string[];
	solanaRpc?: Rpc;
	/** the exchange: how prices are read (tests); by default from the chains' own markets (xwatch.ts readChainPrices) */
	priceRead?: () => Promise<Record<string, number>>;
	/** the exchange: blocks behind the newest that count as final on Ethereum-style chains, instead of their own finalized block (tests only) */
	xFinalDepth?: number;
	/** EVM nodes to ask, per chain (eth, base, arb, op, polygon, bsc, avax); missing chains use the public ones in evm.ts.
	    `evmRpc` replaces them all (tests). */
	evm?: Record<string, string[]>;
	evmRpc?: (net: string) => EvmRpc;
	/** Bitcoin nodes to ask (Esplora API addresses); none set: the public ones in btc.ts. `btcRpc` replaces them (tests). */
	btc?: string[];
	btcRpc?: Rpc;
	/** tests only, and honoured only together with `btcRpc`: the least proof of work a made-up Bitcoin must carry */
	btcTestFloor?: bigint;
	/** Stop at this block for a planned upgrade: make, accept and copy nothing past it. Every validator sets the same
	    height, all stop there together, the software is changed, and they start again without it. */
	haltHeight?: number;
	/** this node's own public address, if it has one: shared with others so they can copy the chain from it too */
	selfUrl?: string;
	/** checkers: on a follower, a staked key (1 DZY or more) it checks in with, so it earns a checker's share */
	checker?: { address: string; secret: string };
	/** accept peers on private addresses (tests and private networks only) */
	allowLocalPeers?: boolean;
}
/** a copy of the whole state at one block, with that block: what a new node can start from */
export interface Snapshot { block: Block; state: State }
export interface Req { method: string; path: string; query: URLSearchParams; body: string; auth: string; ip: string }
export interface Res { status: number; body: unknown }

interface ProposalMsg { kind: 'proposal'; height: number; round: number; validRound: number; block: Proposed; from: string; sig: string }
interface VoteMsg { kind: 'vote'; type: VoteType; height: number; round: number; block: string | null; from: string; sig: string }
type Msg = ProposalMsg | VoteMsg;
const proposalMessage = (chain: string, height: number, round: number, validRound: number, id: string) => 'dzy-proposal:' + canon({ chain, height, round, validRound, block: id });

const MAX_PEERS = 200, PEER_PER_MINUTE = 10, VIEW_PER_MINUTE = 120, LINKS_FRESH_MS = 5 * 60_000, LINKS_PER_LOOK = 3, MAX_BODY = 20_000, MAX_CONSENSUS_BODY = 2_000_000, TX_PER_MINUTE = 60, RELAY_PER_MINUTE = 600, CONSENSUS_PER_MINUTE = 1200, ROUNDS_AHEAD = 50;
const HINT_PER_MINUTE = 10, MAX_HINTS = 1_000, HINT_LIFE = 24 * 3_600_000, SUN_LOOKS = 10; // purchases told to this node: per address a minute, kept at once, kept for, looked at per wake-up
// personal deposit addresses (deposit.ts) this node watches: asks per address a minute, kept at once, kept for (from the
// last ask), Ethereum-style chains looked at per minute, blocks per look (halved when a node refuses, regrown after),
// Solana addresses per minute, Solana payments read per minute, named payments waiting to be read
const WATCH_PER_MINUTE = 10, MAX_WATCH = 1_000, WATCH_LIFE = 30 * 24 * 3_600_000, DEP_CHAINS = 4, DEP_RANGE = 1_000, DEP_SOL = 3, DEP_SOL_READS = 6, MAX_DEP_TX = 200;
type Buy = { net: string; token: string; amount: number; tx: string; to: string };
const isPayId = (net: string, v: unknown): v is string => typeof v === 'string' && (net === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(v) : /^0x[0-9a-fA-F]{64}$/.test(v));

export class NodeCore {
	broken = ''; // why this node cannot run, if it cannot
	alert = ''; // on a follower: proof-worthy trouble seen in the history it was shown
	private cfg: NodeConfig;
	private store: Store;
	private wake: (ms: number) => void | Promise<void>;
	private net: Net | null;
	private seq: Sequencer | null = null;
	private by: Signer | null = null;
	private followed!: State;
	private first!: State;
	private busy: Promise<unknown> = Promise.resolve();
	private hits = new Map<string, { n: number; reset: number }>();
	private stopped = false;
	// several validators: the agreement for the height being decided
	private engine: Engine | null = null;
	private cands = new Map<string, { block: Proposed; next: State }>(); // blocks we checked ourselves, by hash
	private heard = new Map<string, Msg>(); // every valid message of this height (to pass on, and to prove the decision)
	private mine: Record<string, string | null> = {}; // our own votes this height: "round:kind" → block hash
	private syncing = false;
	/** other nodes and archives that hold this chain, as announced to us and checked (the swarm) */
	private known: string[] = [];
	private ops = new Map<string, string>(); // volunteer url -> the staked account that vouched for it

	constructor(cfg: NodeConfig, store: Store, wake: (ms: number) => void | Promise<void>, net?: Net) {
		this.cfg = cfg; this.store = store; this.wake = wake; this.net = net ?? null;
	}

	/** this node takes part in making blocks */
	get leads() { return !!this.seq; }
	get state(): State { return this.seq ? this.seq.state : this.followed; }
	get genesis(): State { return this.first; }
	/** stopped at the planned height (see haltHeight) */
	get halted() { const h = this.cfg.haltHeight; return !!h && this.state.height >= h; }
	/** this node is the only validator: it makes the blocks by itself */
	private get alone() { const v = this.state.validators; return v.length === 1 && v[0] === this.by?.address; }
	private get blockMs() { const n = Number(this.cfg.blockMs); return Number.isFinite(n) && n >= 20 && n <= 60_000 ? n : 1000; }
	private ms(k: 'propose' | 'vote' | 'grow' | 'gossip' | 'sync') { return this.cfg.timeouts?.[k] ?? { propose: 3000, vote: 1000, grow: 500, gossip: 1000, sync: 2000 }[k]; }

	/** one job at a time: a submit, a vote, a block and a sync can never interleave, in memory or on disk */
	private one<T>(job: () => Promise<T>): Promise<T> {
		const run = this.busy.then(job, job);
		this.busy = run.catch(() => {});
		return run;
	}
	/** a job nobody waits for (a timer, a message): its failure is recorded by whatever failed, never thrown into the void */
	private go(job: () => Promise<unknown>) { this.one(job).catch(() => {}); }
	/** stop for good (the host is shutting down): pending timers do nothing afterwards */
	stop() { this.stopped = true; }

	async start() {
		const sun = this.cfg.sun;
		if (sun) { // everything about the chain comes from its genesis: nobody issues DZY on it
			if (!sun || typeof sun.chain !== 'string' || !Array.isArray(sun.validators)) { this.broken = 'The node is not set up (its genesis)'; return; }
			Object.assign(this.cfg, { chain: sun.chain, authority: '0'.repeat(64), validators: sun.validators.slice().sort() });
		}
		const { chain, authority } = this.cfg;
		if (!chain || !isAddr(authority)) { this.broken = 'The node is not set up (chain name and authority address)'; return; }
		try { this.first = sun ? await sunGenesis(sun) : await genesis(chain, authority, 0, this.cfg.validators?.length ? this.cfg.validators : [authority], this.cfg.fee ?? 0); } catch (e) { this.broken = (e as Error).message; return; }
		// a validator's node vouches for itself with its own key, so volunteers list it too
		if (!this.cfg.operator && this.cfg.validator && this.cfg.selfUrl) this.cfg.operator = { address: this.cfg.validator.address, sig: await sign(this.cfg.validator.secret, volunteerMessage(chain, this.cfg.selfUrl.replace(/\/+$/, ''))) };
		if (!this.store.loadState() && this.cfg.snapshot) {
			const why = await this.takeSnapshot(this.cfg.snapshot);
			if (why) { this.broken = 'The snapshot was not used: ' + why; return; }
		}
		const state = this.store.loadState() ?? structuredClone(this.first); // never the genesis itself: the live state is changed in place
		seal(state); // it changes only by committing blocks into it, so the fingerprint can be kept up to date
		if (state.height > 0 && this.store.loadTree) { const b = this.store.block(state.height); if (b) await this.store.loadTree(state, b.stateRoot).catch(() => false); }
		try {
			const p = JSON.parse(this.store.noteGet('peers') ?? '[]');
			if (Array.isArray(p)) for (const e of p.slice(0, MAX_PEERS)) {
				if (typeof e === 'string') this.known.push(e);
				else if (typeof e?.url === 'string' && typeof e?.op === 'string') { this.known.push(e.url); this.ops.set(e.url, e.op); }
			}
		} catch { /* none */ }
		try { const w = JSON.parse(this.store.noteGet('sun-watch') ?? '[]'); if (Array.isArray(w)) for (const [a, at] of w.slice(-MAX_WATCH)) if (typeof a === 'string' && /^[0-9a-f]{64}$/.test(a) && typeof at === 'number') this.watched.set(a, at); } catch { /* none */ }
		try { const c = JSON.parse(this.store.noteGet('sun-cursor') ?? '{}'); for (const [n, b] of Object.entries(c ?? {})) if (typeof b === 'number' && Object.hasOwn(SUN_DOLLARS, n)) this.depCursor[n] = b; } catch { /* none */ }
		// the stored chain must grow from this very genesis (its validators may have changed since, through staking),
		// or from a snapshot whose block hash the operator said to trust
		let trusted: { height: number; hash: string } | null = null;
		try { trusted = JSON.parse(this.store.noteGet('trusted') ?? 'null'); } catch { /* none */ }
		const from = trusted ? this.store.block(trusted.height) : null;
		const startsHere = state.height === 0 ? canon(state.validators ?? null) === canon(this.first.validators) && (state.fee ?? 0) === (this.first.fee ?? 0)
			: trusted ? !!from && (await blockHash(chain, from)) === trusted.hash
			: this.store.block(1)?.prev === this.first.last;
		if (state.chain !== chain || state.authority !== authority || !startsHere) { this.broken = 'The settings do not match the chain already stored here'; return; }
		const by = this.cfg.validator ?? null;
		// a key that is in the set, or on a host that can reach other validators (to wait for a seat); anything else just follows
		if (!by || !(state.validators.includes(by.address) || this.net)) { this.followed = state; return; }
		try {
			if (!(await verify(by.address, 'dzy-key-check', await sign(by.secret, 'dzy-key-check')))) throw new Error();
		} catch { this.broken = 'The secret is not the key of that validator address'; return; }
		this.by = by;
		this.seq = new Sequencer(state, by);
		// transactions that were accepted but not yet in a block when the node last stopped
		for (const row of this.store.queueList()) {
			try { await this.seq.submit(row.tx); } catch { this.store.queueDrop(row.seq); }
		}
		if (this.net) {
			this.net.timer(this.ms('gossip'), () => this.gossipLoop());
			this.net.timer(this.ms('sync'), () => this.syncLoop());
		}
		await this.after();
	}

	/** Check a snapshot against the block hash the operator trusts, and store it as where this chain starts here. */
	private async takeSnapshot(snap: { block: Block; state: State; trust: string }): Promise<string> {
		const { block, state, trust } = snap;
		if (!block || !state || typeof trust !== 'string' || !/^[0-9a-f]{64}$/.test(trust)) return 'it needs a block, a state and the hash to trust';
		if (state.chain !== this.cfg.chain || state.authority !== this.cfg.authority) return 'it is from another chain';
		if (state.height !== block.height || state.height < 1) return 'the state and the block do not match';
		if ((await blockHash(state.chain, block)) !== trust) return 'its block is not the one you trust';
		if (state.last !== trust) return 'the state does not follow that block';
		if ((await stateRoot(state)) !== block.stateRoot) return 'the state is not the one that block fingerprints';
		this.store.commit(block, state, 0);
		this.store.noteSet('trusted', JSON.stringify({ height: block.height, hash: trust }));
		return '';
	}
	/* ------------------------------ the swarm ------------------------------ */

	/** every place known to hold this chain, this node first: anyone can copy and check the chain from any of them.
	    On a chain with the Sun, a volunteer is listed only while the account that vouched for it has at least 1% of a
	    seat staked (and is not benched or barred): volunteers earn nothing, but their stake makes a fake one costly. */
	peers(): string[] {
		const ok = (u: string) => !this.state?.sun || (this.ops.has(u) && this.vouches(this.ops.get(u)!));
		return [...new Set([...(this.cfg.selfUrl ? [this.cfg.selfUrl] : []), ...this.known.filter(ok)])];
	}
	/** may this account vouch for a node: a validator now, or at least 1% of a seat staked (not benched or barred) */
	private vouches(addr: string) { return this.state.validators.includes(addr) || isCandidate(this.state, addr); }
	/** why a volunteer's vouch does not hold, or '' (its own GET / shows the account, the signature and the URL signed) */
	private async vouchProblem(url: string, op: unknown): Promise<string> {
		const o = op as { address?: unknown; sig?: unknown; signer?: unknown } | undefined;
		if (!o || typeof o.address !== 'string' || !isAddr(o.address) || typeof o.sig !== 'string') return 'That node has no staked account vouching for it (OPERATOR and OPERATOR_SIG)';
		const key = o.signer === undefined ? o.address : typeof o.signer === 'string' && isAddr(o.signer) ? o.signer : '';
		const a = Object.hasOwn(this.state.accounts, o.address) ? this.state.accounts[o.address] : undefined;
		if (!key || (key === o.address ? a?.off : !a?.keys?.includes(key))) return 'That key cannot sign for that account';
		if (!(await verify(key, volunteerMessage(this.state.chain, url), o.sig))) return 'The vouch is not signed for that address on this chain';
		if (!this.vouches(o.address)) return `The account vouching for it needs at least 1% of a seat staked (${(Math.ceil(seatPrice(this.state) / 100) / 1e8).toLocaleString('en-US')} DZY)`;
		return '';
	}
	/** Someone says `url` holds this chain. Keep it only if it really does: it must answer with exactly our genesis.
	    Returns why not, or '' when it was kept. */
	async addPeer(url: unknown): Promise<string> {
		if (typeof url !== 'string' || url.length > 200 || !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(url)) return 'Give an http(s) address';
		const clean = url.replace(/\/+$/, '');
		let host: string;
		try { host = new URL(clean).hostname; } catch { return 'Give an http(s) address'; }
		// never let a public node be used to reach into someone's private network
		if (!this.cfg.allowLocalPeers && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(host)) return 'That is a private address';
		if (this.peers().includes(clean)) return '';
		try {
			const r = await fetch(clean + '/genesis', { signal: AbortSignal.timeout(5000) });
			const g = r.ok ? await r.json() : null;
			if (g?.last !== this.first.last) return 'That address does not hold this chain';
			if (this.state.sun) {
				const r2 = await fetch(clean + '/', { signal: AbortSignal.timeout(5000) }), info = r2.ok ? await r2.json() : null;
				const why = await this.vouchProblem(clean, info?.operator);
				if (why) return why;
				this.ops.set(clean, info.operator.address);
			}
		} catch { return 'That address did not answer'; }
		this.known = [clean, ...this.known.filter((u) => u !== clean)].slice(0, MAX_PEERS);
		for (const u of [...this.ops.keys()]) if (!this.known.includes(u)) this.ops.delete(u);
		this.store.noteSet('peers', JSON.stringify(this.known.map((u) => (this.ops.has(u) ? { url: u, op: this.ops.get(u) } : u))));
		return '';
	}

	/** keep a snapshot now and then, for new nodes to start from */
	private keepSnapshot(block: Block, state: State) {
		const every = this.cfg.snapshotEvery ?? 1000;
		if (every > 0 && block.height % every === 0) this.store.noteSet('snapshot', JSON.stringify({ block, state }));
	}
	/** the latest snapshot this node kept, if any */
	snapshot(): Snapshot | null { try { return JSON.parse(this.store.noteGet('snapshot') ?? 'null'); } catch { return null; } }

	/** After every block (and at the start): take the part the current set of validators gives this node. */
	private async after() {
		if (this.halted) { this.engine = null; return; }
		if (this.alone) {
			this.engine = null;
			if (this.state.sun) await this.collect();
			if (this.seq!.waiting) await this.wake(this.blockMs);
			else if (this.state.sun) await this.wake(60_000 - (Date.now() % 60_000) + 50); // the next chain minute
			return;
		}
		if (!this.net) { this.broken = 'The chain now has other validators, and this host cannot talk to them. Run this validator as a PC node with PEERS set.'; return; }
		this.crewPeers(); // the crew may have just changed: talk to its nodes from this height on, not after the next look
		this.newHeight();
		if (this.engine && this.seq!.waiting) this.engine.start(0);
	}

	/** A chain with the Sun: running a node gets paid. Collect the raffle tickets this validator won (free transactions;
	    one already waiting, or already collected, is simply refused). Must be called inside `one`. */
	private async collect() {
		const by = this.by!;
		for (const t of openTickets(this.seq!.state, by.address)) {
			const tx = await signTx(by.secret, { chain: this.state.chain, from: by.address, nonce: this.seq!.pendingNonce(by.address) + 1, type: 'ticket.answer', data: t });
			try { await this.seq!.submit(tx); this.store.queueAdd(tx); } catch { /* already waiting or collected */ }
		}
	}

	/** take a transaction for a coming block; must be called inside `one` */
	private async accept(tx: Tx, relayed = false): Promise<string> {
		if (this.halted) throw new Error(`This node stopped at block ${this.cfg.haltHeight} for a planned upgrade`);
		const id = await this.seq!.submit(tx);
		this.store.queueAdd(tx);
		if (this.alone) { await this.wake(this.blockMs); return id; }
		if (!relayed) for (const p of this.net!.peers) this.net!.post(p, '/tx?relay=1', { tx }); // every validator should know it: any of them may be the next proposer
		this.engine?.start(0);
		return id;
	}

	/** Single validator: the host calls this when the wake-up fires. Pack what is waiting into a block and store it.
	    If storing fails the node marks itself broken and throws; the host must restart it from what is stored. */
	async tick() {
		if (this.broken || !this.seq || !this.alone || this.halted) return;
		const seq = this.seq;
		await this.one(async () => {
			if (!this.alone || this.halted) return;
			const block = await seq.produce(Date.now());
			if (!block) return;
			try { this.store.commit(block, seq.state, block.txs.length); } catch (e) {
				this.broken = 'Could not store a block'; // memory must never run ahead of what is stored
				throw e;
			}
			this.keepSnapshot(block, seq.state);
			await this.after(); // the block may have changed who the validators are
		});
	}

	/* ------------------------------ several validators ------------------------------ */

	/** get ready to agree on the next height (remembering our own votes if we restarted in the middle of it) */
	private heightAt = 0; private resentAt = 0;
	private newHeight() {
		const h = this.state.height + 1, me = this.by!.address, vs = this.state.validators;
		this.cands.clear(); this.heard.clear(); this.heightAt = Date.now();
		if (!vs.includes(me)) { this.engine = null; return; } // standby: not in the set for this block
		let saved: { height: number; votes: Record<string, string | null>; memory: Memory } | null = null;
		try { saved = JSON.parse(this.store.noteGet('consensus') ?? 'null'); } catch { /* start clean */ }
		const mem = saved?.height === h ? saved : null;
		this.mine = mem?.votes ?? {};
		const live = () => !this.stopped && !this.broken && this.engine === eng;
		const eng: Engine = new Engine(me, vs, h, {
			propose: (round, id, validRound) => { this.go(async () => { if (live()) await this.sendProposal(eng, round, id, validRound); }); },
			vote: (type, round, id) => { this.go(async () => { if (live()) await this.sendVote(eng, type, round, id); }); },
			timeout: (step: Step, round) => this.net!.timer((step === 'propose' ? this.ms('propose') : this.ms('vote')) + round * this.ms('grow'), () => { this.go(async () => { if (live()) eng.onTimeout(step, round); }); }),
			decide: (id, round) => { this.go(async () => { if (live()) await this.decided(id, round); }); }
		}, mem?.memory, weights(this.state).power);
		for (const [k, id] of Object.entries(this.mine)) { const [r, type] = k.split(':'); eng.recall(type as VoteType, Number(r), id); }
		this.engine = eng;
	}
	/** Gossip again. A message sent before a peer was known, or lost on the way, is otherwise gone for good, and a height
	    whose votes never arrive waits forever (each node waiting on the others). So while a started height has not been
	    decided for a while, pass on again everything this node holds for it: its own proposal and votes, and the others'.
	    Receivers ignore what they already have. */
	private resend(now: number) {
		const eng = this.engine, wait = Math.max(1_000, this.ms('propose') + 2 * this.ms('vote'));
		if (!eng || !eng.started || eng.decided || !this.net || now - this.heightAt < wait || now - this.resentAt < wait) return;
		this.resentAt = now;
		for (const m of this.heard.values()) this.spread(m);
	}
	private keyOf(m: Msg) { return m.kind === 'proposal' ? `p|${m.round}|${m.from}|${m.sig}` : `v|${m.type}|${m.round}|${m.from}|${m.block}`; }
	private spread(m: Msg) { for (const p of this.net!.peers) this.net!.post(p, '/consensus', { msg: m }); }

	private async sendProposal(eng: Engine, round: number, id: string | null, validRound: number) {
		let c = id ? this.cands.get(id) : undefined;
		if (!c || !id) { // a new block from what is waiting (also when we no longer hold the block we were to repeat)
			const made = await this.seq!.propose(Date.now(), round);
			id = made.state.last; validRound = -1;
			this.cands.set(id, (c = { block: made.block, next: made.state }));
		}
		const m: ProposalMsg = { kind: 'proposal', height: eng.height, round, validRound, block: c.block, from: this.by!.address, sig: await sign(this.by!.secret, proposalMessage(this.first.chain, eng.height, round, validRound, id)) };
		this.heard.set(this.keyOf(m), m);
		this.spread(m);
		eng.onProposal(round, id, validRound, m.from, true);
	}
	private async sendVote(eng: Engine, type: VoteType, round: number, id: string | null) {
		const k = `${round}:${type}`;
		if (k in this.mine && this.mine[k] !== id) return; // never sign two different votes in the same place
		this.mine[k] = id;
		this.store.noteSet('consensus', JSON.stringify({ height: eng.height, votes: this.mine, memory: eng.memory })); // written down before it is sent
		const m: VoteMsg = { kind: 'vote', type, height: eng.height, round, block: id, from: this.by!.address, sig: await signVote(this.first.chain, type, eng.height, round, id, this.by!) };
		this.heard.set(this.keyOf(m), m);
		this.spread(m);
	}
	/** agreement reached: attach the validators' signatures to the block and make it final */
	private async decided(id: string, round: number) {
		const c = this.cands.get(id);
		if (!c) return; // we never saw the block itself; the sync loop fetches it with its signatures
		const sigs = [...this.heard.values()].filter((m): m is VoteMsg => m.kind === 'vote' && m.type === 'precommit' && m.round === round && m.block === id).map((m) => ({ validator: m.from, sig: m.sig }));
		const w = weights(this.state);
		if (sigs.reduce((n, x) => n + (w.power[x.validator] ?? 0), 0) < w.need) return; // we cannot prove it ourselves: take the block, with its proof, from a peer
		await this.finish({ ...c.block, commit: { round, sigs } }, c.next);
	}
	private async finish(block: Block, next: State) {
		next = commit(next); // the block's layer written into the live state (layer.ts)
		try { this.store.commit(block, next, 0); } catch (e) { this.broken = 'Could not store a block'; throw e; }
		this.keepSnapshot(block, next);
		await this.seq!.adopt(next, Date.now());
		const still = new Set(this.seq!.waitingTxs.map((t) => t.from + ':' + t.nonce));
		for (const row of this.store.queueList()) if (!still.has(row.tx.from + ':' + row.tx.nonce)) this.store.queueDrop(row.seq);
		await this.after();
	}

	/** a message from another validator; must be called inside `one` */
	private async onMessage(m: Msg) {
		if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.height) || !Number.isSafeInteger(m.round) || m.round < 0) return;
		if (m.height > this.state.height + 1) { void this.sync(); return; } // we are behind: fetch the blocks we miss
		const eng = this.engine;
		if (!eng) return; // on standby: blocks arrive by sync
		if (m.height < eng.height || m.round > Math.max(eng.round, 0) + ROUNDS_AHEAD) return;
		if (!this.state.validators.includes(m.from) || m.from === this.by!.address || typeof m.sig !== 'string') return;
		const chain = this.first.chain;
		if (m.kind === 'proposal') {
			if (this.heard.has(this.keyOf(m)) || m.from !== eng.proposer(m.round) || !Number.isSafeInteger(m.validRound) || m.validRound < -1 || m.validRound >= m.round) return;
			if (m.validRound === -1 && ((m.block?.round ?? 0) !== m.round || m.block?.proposer !== m.from)) return; // a fresh block is made by its proposer, in its round
			let id: string;
			try { id = await blockHash(chain, m.block); } catch { return; }
			if (!(await verify(m.from, proposalMessage(chain, m.height, m.round, m.validRound, id), m.sig))) return;
			let valid = this.cands.has(id);
			if (!valid) {
				try {
					this.cands.set(id, { block: m.block, next: await checkBlock(this.seq!.state, m.block, Date.now()) });
					valid = true;
				} catch { /* a block that breaks the rules: we will vote against it */ }
			}
			this.heard.set(this.keyOf(m), m); this.spread(m);
			eng.start(0);
			eng.onProposal(m.round, id, m.validRound, m.from, valid);
		} else if (m.kind === 'vote' && (m.type === 'prevote' || m.type === 'precommit') && (m.block === null || typeof m.block === 'string')) {
			if (this.heard.has(this.keyOf(m)) || !(await verify(m.from, voteMessage(chain, m.type, m.height, m.round, m.block), m.sig))) return;
			this.heard.set(this.keyOf(m), m); this.spread(m); // pass it on, so every validator ends up with the same evidence
			this.checkDouble(m);
			eng.start(0);
			eng.onVote(m.type, m.round, m.block, m.from);
		}
	}

	/** Validators only. For every cross-chain offer someone is paying for, look on the other chain for the payment
	    (final, the right amount, to the maker, with the hold's memo) and report it to the chain once. The chain releases
	    the held coins when validators with more than two thirds of the say have reported it (ledger.ts, `xoffer.attest`).
	    Returns how many holds are still waiting, so the host knows to call again soon. */
	private attested = new Set<string>();
	private lastLook = new Map<string, number>();
	/** purchases buyers told this node about (POST /sun/hint): kept in memory only, at most MAX_HINTS, oldest dropped first */
	private hints = new Map<string, { p: { net: string; token: string; amount: number; tx: string; to: string }; at: number }>();
	/** Dznye accounts whose personal deposit addresses this node watches (POST /sun/watch), with when each last asked */
	private watched = new Map<string, number>();
	private depCursor: Record<string, number> = {}; // per Ethereum-style chain: the last block looked at
	private depRange: Record<string, number> = {};
	private depLook = 0; private depTurn = 0; private solTurn = 0; private watchSaved = 0;
	private depTx: { net: string; tx: string; to: string }[] = []; // payments a buyer named, to read
	private depSeen = new Set<string>();
	/** How much a purchase really put in for `p.to`, in millionths of a dollar: sent to the burn address with the memo
	    naming the buyer, or to the buyer's own deposit address (deposit.ts). 0 when neither, or not final yet. */
	private async paidFor(rpc: Rpc, p: Buy): Promise<number> {
		if (p.net === 'sol') return (await solPaidIn(rpc, SUN_BURN.sol, p.token, p.tx, sunMemo(p.to))) || solPaidIn(rpc, await depositSol(p.to), p.token, p.tx);
		if (p.token !== 'USDC') return 0;
		return (await evmPaidIn(rpc, p.net, SUN_BURN[p.net], p.tx, sunMemo(p.to))) || evmPaidIn(rpc, p.net, await depositEvm(p.to), p.tx);
	}
	/** ask each node in turn until one sees the payment; throws only when every node failed (so it is asked again later) */
	private async paidAnywhere(nodes: { rpc: Rpc }[], p: Buy): Promise<number> {
		let failed: unknown, answered = false;
		for (const { rpc } of nodes) { try { const n = await this.paidFor(rpc, p); answered = true; if (n > 0) return n; } catch (e) { failed = e; } }
		if (!answered) throw failed ?? new Error('No node is set');
		return 0;
	}
	/** keep a purchase found on another chain, to be checked and confirmed like any hint */
	private addHint(p: Buy) {
		if (!this.state.sun || p.amount < MIN_BUY || Object.hasOwn(this.state.sun.paid, p.net + ':' + p.tx) || sunBuyProblem(p)) return;
		const key = `${p.net}:${p.tx}:${p.to}:${p.token}:${p.amount}`;
		if (this.hints.has(key)) return;
		if (this.hints.size >= MAX_HINTS) this.hints.delete(this.hints.keys().next().value!);
		this.hints.set(key, { p, at: Date.now() });
	}
	private saveWatch(force = false) {
		if (!force && Date.now() - this.watchSaved < 60_000) return;
		this.watchSaved = Date.now();
		this.store.noteSet('sun-watch', JSON.stringify([...this.watched]));
		this.store.noteSet('sun-cursor', JSON.stringify(this.depCursor));
	}
	/** Validators only, once a minute: find dollars sent to the watched deposit addresses. On the Ethereum-style chains,
	    one search of USDC's Transfer events for all of them at once (a few chains a minute, each from where it stopped);
	    on Solana, the newest payments into a few of them in turn; and any payment a buyer named. Everything found is only
	    a hint: it is checked again, transaction by transaction, before it is confirmed. */
	private async scanDeposits(now: number) {
		for (const [a, at] of this.watched) if (now - at > WATCH_LIFE) this.watched.delete(a);
		const list = [...this.watched.keys()];
		// payments named by buyers ("I sent it, here is the id")
		let reads = 0;
		while (this.depTx.length && reads < DEP_SOL_READS) {
			const d = this.depTx.shift()!, nodes = this.nodesOf(d.net);
			for (const token of d.net === 'sol' ? SUN_DOLLARS.sol : ['USDC']) {
				reads++;
				try { const amount = await this.paidAnywhere(nodes, { net: d.net, token, amount: 0, tx: d.tx, to: d.to }); if (amount) { this.addHint({ net: d.net, token, amount, tx: d.tx, to: d.to }); break; } } catch { /* not final yet, or no node: the buyer can ask again */ }
			}
		}
		if (!list.length) return;
		const evmTo = new Map<string, string>();
		for (const a of list) evmTo.set(await depositEvm(a), a);
		const nets = Object.keys(SUN_DOLLARS).filter((n) => n !== 'sol' && ADAPTERS[n]);
		for (let i = 0; i < Math.min(DEP_CHAINS, nets.length); i++) {
			const net = nets[this.depTurn++ % nets.length];
			for (const { rpc } of this.nodesOf(net)) {
				const range = this.depRange[net] ?? DEP_RANGE;
				try {
					const fin = await evmFinalized(rpc);
					const from = Math.max(this.depCursor[net] !== undefined ? this.depCursor[net] + 1 : fin - range + 1, fin - 50 * DEP_RANGE), to = Math.min(fin, from + range - 1);
					if (to < from) break;
					const tos = [...evmTo.keys()], found: { tx: string; payTo: string; amount: number }[] = [];
					for (let k = 0; k < tos.length; k += 100) found.push(...await evmDepositsIn(rpc, net, tos.slice(k, k + 100), from, to));
					for (const x of found) { const who = evmTo.get(x.payTo); if (who) this.addHint({ net, token: 'USDC', amount: x.amount, tx: x.tx, to: who }); }
					this.depCursor[net] = to; this.depRange[net] = Math.min(DEP_RANGE, range * 2);
					break;
				} catch { this.depRange[net] = Math.max(50, Math.floor(range / 2)); /* this node refused (often: too many blocks at once): the next one, a smaller step */ }
			}
		}
		// Solana: a few watched addresses a minute, each token's newest final payments
		const sol = this.nodesOf('sol');
		if (sol.length) {
			let solReads = 0;
			for (let i = 0; i < Math.min(DEP_SOL, list.length); i++) {
				const who = list[this.solTurn++ % list.length], owner = await depositSol(who);
				for (const token of SUN_DOLLARS.sol) {
					try {
						for (const sig of await solDepositSignatures(sol[0].rpc, owner, token, 5)) {
							if (this.depSeen.has(sig) || Object.hasOwn(this.state.sun!.paid, 'sol:' + sig) || solReads >= DEP_SOL_READS) continue;
							solReads++; this.depSeen.add(sig); if (this.depSeen.size > 5000) this.depSeen.clear();
							const amount = await solPaidIn(sol[0].rpc, owner, token, sig);
							if (amount) this.addHint({ net: 'sol', token, amount, tx: sig, to: who });
						}
					} catch { /* the node did not answer: next minute */ }
				}
			}
		}
		this.saveWatch();
	}
	async watch(): Promise<number> {
		await this.checkIn(Date.now()).catch(() => {}); // the crew upgrade: also while on standby, so it can be drawn
		this.crewPeers();
		this.resend(Date.now());
		const by = this.by, seq = this.seq;
		if (!by || !seq || this.broken || this.halted || !this.state.validators.includes(by.address)) return 0;
		const now = Date.now();
		let waiting = 0, btcLooks = 0;
		for (const [id, o] of Object.entries(this.state.xoffers ?? {})) {
			const h = o.hold;
			if (!h || h.votes?.includes(by.address) || this.attested.has(h.key)) continue;
			if (now <= h.until + RULES.xGrace) waiting++;
			const want = { payTo: o.payTo, token: o.want.token, amount: h.pay, memo: xMemo(h.key), ...(o.want.nft ? { nft: o.want.nft, after: h.from ?? Infinity } : {}) }, net = o.want.net;
			const a = ADAPTERS[net], nodes = a ? this.nodesOf(net) : [];
			if (!a || !nodes.length) continue;
			// chains where the taker names the payment: only that transaction, and not more than every 20 seconds (finality takes minutes)
			if (a.needsTx && (!h.tx || now - (this.lastLook.get(h.key) ?? 0) < (this.cfg.evmRpc || this.cfg.btcRpc ? 0 : 20_000))) continue;
			// a full Bitcoin check asks its node about 15 times, and Cloudflare caps outside calls per wake-up: at most two
			// Bitcoin payments per look; the rest wait for the next one (seconds later). Delayed, never wrongly accepted.
			if (net === 'btc' && ++btcLooks > 2) continue;
			this.lastLook.set(h.key, now);
			if (this.lastLook.size > 5000) this.lastLook.clear();
			try {
				// every node is asked in turn until one confirms: a node that is down or behind never hides a payment (dip.ts)
				const sig = await confirm(nodes.map((n) => n.rpc), (rpc) => a.check(rpc, want, h.tx, net === 'btc' && this.cfg.btcRpc && this.cfg.btcTestFloor ? { floor: this.cfg.btcTestFloor } : undefined));
				if (!sig) continue;
				this.attested.add(h.key);
				if (this.attested.size > 5000) this.attested.clear();
				const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type: 'xoffer.attest', data: { id, key: h.key, tx: sig } });
				await this.one(() => this.accept(tx));
			} catch { this.attested.delete(h.key); /* the other chain did not answer, or the hold just ended: try again next time */ }
		}
		// checkouts paid on another chain (order.*): each named payment, read on its own chain, reported once it is final
		// and enough. At most every 20 s per checkout (finality takes minutes), a few per look.
		let orderLooks = 0;
		for (const [id, o] of Object.entries(this.state.orders ?? {})) {
			if (!o.tx || o.votes?.includes(by.address) || this.attested.has('order:' + id + ':' + o.tx)) continue;
			waiting++;
			const nodes = ADAPTERS[o.net] ? this.nodesOf(o.net) : [];
			if (!nodes.length || now - (this.lastLook.get('order:' + id) ?? 0) < (this.cfg.evmRpc || this.cfg.solanaRpc ? 0 : 20_000) || ++orderLooks > 6) continue;
			this.lastLook.set('order:' + id, now);
			try {
				const got = await confirm(nodes.map((n) => n.rpc), async (rpc) => { const n = await orderReceived(rpc, o, o.tx!); return n !== null && orderEnough(o, n) ? String(n) : null; });
				if (!got) continue;
				this.attested.add('order:' + id + ':' + o.tx);
				const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type: 'order.attest', data: { id, tx: o.tx, amount: Number(got) } });
				await this.one(() => this.accept(tx));
			} catch { this.attested.delete('order:' + id + ':' + o.tx); /* the other chain did not answer: next look */ }
		}
		// a chain with the Sun: once a minute, post Bitcoin's newest headers, the raffle's randomness (failures only wait for the next look)
		if (this.state.sun && now - this.btcLook >= (this.cfg.btcRpc ? 0 : 60_000)) { this.btcLook = now; await this.postBtc(by, seq).catch(() => {}); }
		// the exchange: this validator's price readings, and deposits into and payouts from the vaults on other chains
		if (exchangeOn(this.state)) await this.xWatch(by, seq, now).catch((e) => { this.xStatus.error = { at: now, what: (e as Error).message }; });
		// a chain with the Sun: purchases to find on the other chain. First what other validators already confirmed (on the
		// chain, so every validator sees it), then what buyers told this node (off the chain: POST /sun/hint). At most
		// SUN_LOOKS a wake-up, each purchase at most every 20 s, so made-up hints can only cost this node a little time.
		if (this.state.sun) {
			// personal deposit addresses: once a minute, look for dollars sent to them (deposit.ts)
			if (now - this.depLook >= (this.cfg.evmRpc || this.cfg.solanaRpc ? 0 : 60_000) && (this.watched.size || this.depTx.length)) { this.depLook = now; await this.scanDeposits(now).catch(() => {}); }
			// claim: already on the chain (its details fixed: join it only if at least that much arrived); hint: confirmed at what really arrived
			const todo: { key: string; p: Buy; claim: boolean }[] = [];
			for (const id of Object.keys(this.state.sun.claims)) {
				const c = this.state.sun.claims[id], p = sunPayment(this.state, id);
				if (p && !c.votes.includes(by.address)) todo.push({ key: id, p: { net: p.net, token: p.token, amount: p.amount, tx: p.tx, to: p.to }, claim: true });
			}
			for (const [key, h] of this.hints) {
				if (now - h.at > HINT_LIFE || Object.hasOwn(this.state.sun.paid, h.p.net + ':' + h.p.tx)) { this.hints.delete(key); continue; }
				if (!Object.hasOwn(this.state.sun.claims, key)) todo.push({ key, p: h.p, claim: false });
			}
			let looks = 0;
			for (const { key, p, claim } of todo) {
				if (this.attested.has('sun:' + key)) continue;
				waiting++;
				const a = ADAPTERS[p.net], nodes = a ? this.nodesOf(p.net) : [];
				if (!a || !nodes.length) continue;
				if (now - (this.lastLook.get('sun:' + key) ?? 0) < (this.cfg.evmRpc || this.cfg.solanaRpc ? 0 : 20_000)) continue; // finality takes minutes: look every 20 s at most
				if (++looks > SUN_LOOKS) break;
				this.lastLook.set('sun:' + key, now);
				if (this.lastLook.size > 5000) this.lastLook.clear();
				try {
					// that payment, final: to the burn address with the memo naming the buyer, or to the buyer's own deposit address.
					// A hint is confirmed at what really arrived (a hint naming less cannot shrink a purchase); a claim already on
					// the chain is joined only if at least its amount arrived
					const got = await this.paidAnywhere(nodes, p);
					if (claim ? got < p.amount : got < MIN_BUY) continue;
					const buy: Buy = claim ? p : { ...p, amount: got };
					if (!claim && sunBuyProblem(buy)) { this.hints.delete(key); continue; }
					this.attested.add('sun:' + key);
					if (this.attested.size > 5000) this.attested.clear();
					const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type: 'sun.attest', data: { ...buy } });
					await this.one(() => this.accept(tx));
					this.hints.delete(key);
				} catch { this.attested.delete('sun:' + key); /* the other chain did not answer: try again next time */ }
			}
		}
		return waiting;
	}

	/** Validators only: Bitcoin headers newer than the chain's tip, fetched from Bitcoin nodes and posted (sun.btc, free).
	    The first time, only Bitcoin's tip. After a Bitcoin re-org, from the newest header both agree on. At most 10 a
	    transaction (what fits); a long gap is caught up over several looks. Every header is checked again by the chain. */
	private btcLook = 0;
	/* the exchange's watchers (xwatch.ts): when prices and vaults were last read, how far each vault has been read (an
	   Ethereum-style block, or a Solana transaction), and deposits this node already confirmed but the chain has not counted yet */
	private xPriceLook = 0;
	private xDepLook = 0;
	private xCursor = new Map<string, number | string | undefined>();
	private xSent = new Set<string>();
	/** payments into a vault that a wallet told this node about (POST /exchange/paid): checked by their own receipts each
	    look until final, so a deposit counts even when no public node will search the logs for this node */
	private xPaid = new Map<string, { net: string; tx: string; at: number }>();
	/** tell the node about a payment into a vault: kept for a day at most, a few hundred at a time */
	paid(net: string, tx: string, now: number): string {
		if (!exchangeVaults(this.state)[net] || net === 'sol') return 'No vault on that chain';
		if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return 'Not a transaction id';
		const k = `${net}:${tx.toLowerCase()}`;
		if (this.xPaid.has(k)) return '';
		if (this.xPaid.size >= 500) { const old = [...this.xPaid.entries()].sort((a, b) => a[1].at - b[1].at)[0]; this.xPaid.delete(old[0]); }
		this.xPaid.set(k, { net, tx: tx.toLowerCase(), at: now });
		return '';
	}
	/** what the watchers last did, shown in GET /exchange so anyone can see they are working (prices read, vaults read, the last error) */
	private xStatus: { prices?: { at: number; read: Record<string, number>; posted: boolean }; vaults?: Record<string, { at: number; deposits: number; released: number }>; error?: { at: number; what: string } } = {};
	/** Up or Down marks this node already sent (round key @ moment) */
	private roundMarked = new Set<string>();
	private async xWatch(by: Signer, seq: Sequencer, now: number) {
		const s = this.state, fast = !!(this.cfg.evmRpc || this.cfg.solanaRpc || this.cfg.priceRead);
		const send = async (type: string, data: Record<string, unknown>) => { const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type, data }); await this.one(() => this.accept(tx)); };
		// Up or Down: rounds whose start or end price is due now (in the 10 minutes after that moment)
		const due = Object.entries(s.rounds ?? {}).flatMap(([k, r]) => {
			const [, p, st] = k.split(':'), start = Number(st), at = !r.open ? start : !r.close ? start + Number(p) : null;
			return at !== null && now >= at && now < at + RULES.roundWindow ? [{ k, at }] : [];
		});
		const mineAt = s.x?.prices?.[by.address]?.at ?? 0, fresh = due.some((d) => mineAt < d.at); // a price read after the moment is needed
		// prices: every two minutes, from the chains' own markets, posted when they moved (or every 30 minutes), and
		// right after a round starts or ends
		if (now - this.xPriceLook >= (fast ? 0 : 120_000) || (fresh && now - this.xPriceLook >= 20_000)) {
			this.xPriceLook = now;
			const p: Record<string, number> = await (this.cfg.priceRead ? this.cfg.priceRead() : readChainPrices(eachInTurn(this.nodesOf('eth').map((n) => n.rpc)), eachInTurn(this.nodesOf('sol').map((n) => n.rpc)))).catch((e) => { this.xStatus.error = { at: now, what: 'prices: ' + (e as Error).message }; return {}; });
			for (const c of Object.keys(p)) if (!xLive(s, c)) delete p[c]; // a coin that does not count yet would make the chain refuse the whole reading
			const post = pricesWorthPosting(s.x?.prices?.[by.address], p, s.time) || (fresh && Object.keys(p).length > 0);
			if (post) await send('x.price', { p }).catch((e) => { this.xStatus.error = { at: now, what: 'posting prices: ' + (e as Error).message }; });
			this.xStatus.prices = { at: now, read: p, posted: post };
		}
		// then mark each due round from that fresh agreed price (once)
		for (const d of due) {
			if (mineAt < d.at || this.roundMarked.has(d.k + '@' + d.at)) continue;
			this.roundMarked.add(d.k + '@' + d.at);
			if (this.roundMarked.size > 2000) this.roundMarked.clear();
			const [coin, period, start] = d.k.split(':');
			await send('round.mark', { coin, period: Number(period), start: Number(start) }).catch(() => this.roundMarked.delete(d.k + '@' + d.at));
		}
		// vaults: once a minute, every listed vault, only what is final on its chain
		if (now - this.xDepLook < (fast ? 0 : 60_000)) return;
		this.xDepLook = now;
		// first the payments wallets told this node about: each by its receipt, a few each look, until final (or a day old)
		for (const [k, h] of [...this.xPaid.entries()].slice(0, 20)) {
			const vault = exchangeVaults(s)[h.net], all = eachInTurn(this.nodesOf(h.net).map((n) => n.rpc));
			if (!vault || !all || Date.now() - h.at > 24 * 3_600_000) { this.xPaid.delete(k); continue; }
			try {
				const fin = await finalBlock(all, this.cfg.xFinalDepth ?? 64, this.cfg.xFinalDepth === undefined);
				const found = await depositsInTx(all, vault, h.net, h.tx, fin);
				if (!found) continue; // not final yet
				let ok = true;
				for (const d of found.deposits) {
					const seen = `${h.net}:${d.tx}`;
					if ((s.xseen && Object.hasOwn(s.xseen, seen)) || this.xSent.has(seen)) continue;
					this.xSent.add(seen);
					await send('x.deposit', { net: h.net, coin: d.coin, amount: d.amount, tx: d.tx, to: d.to }).catch(() => { this.xSent.delete(seen); ok = false; });
				}
				if (ok) this.xPaid.delete(k);
			} catch (e) { this.xStatus.error = { at: now, what: `${h.net} payment ${h.tx.slice(0, 10)}…: ${(e as Error).message}` }; }
		}
		for (const [net, vault] of Object.entries(exchangeVaults(s))) {
			// reading a vault's deposits needs eth_getLogs, which some public nodes refuse ("limit exceeded" on every BNB
			// Chain dataseed): only the nodes known to answer it, when any of them is in this validator's list
			const all = this.nodesOf(net), logs = LOG_NODES[net], fit = logs ? all.filter((n) => logs.some((h) => n.label.includes(h))) : [];
			const any = eachInTurn((fit.length ? fit : all).map((n) => n.rpc)), node = any ? { rpc: any } : null;
			if (!node) continue; // this validator does not look at that chain
			try {
				let found: { deposits: FoundDeposit[]; released: { id32: string; tx: string }[] }, cursor: number | string | undefined;
				if (net === 'sol') {
					const r = await scanSolVault(node.rpc, vault, USDC_MINT, this.xCursor.get(net) as string | undefined);
					found = r; cursor = r.next;
				} else {
					const c = EVM[net];
					if (!c) continue;
					const fin = await finalBlock(node.rpc, this.cfg.xFinalDepth ?? 64, this.cfg.xFinalDepth === undefined), from = (this.xCursor.get(net) as number | undefined) ?? exchangeVaultFrom(s, net) ?? Math.max(0, fin - 5_000);
					if (from > fin) continue;
					const to = Math.min(fin, from + 2_000); // a few thousand blocks a look: public nodes refuse wider ranges
					found = await scanEvmVault(node.rpc, vault, net, from, to);
					cursor = to + 1;
				}
				let ok = true;
				for (const d of found.deposits) {
					const seen = `${net}:${d.tx}`;
					if ((s.xseen && Object.hasOwn(s.xseen, seen)) || this.xSent.has(seen)) continue; // counted, or already confirmed by this node
					this.xSent.add(seen);
					if (this.xSent.size > 10_000) this.xSent.clear();
					await send('x.deposit', { net, coin: d.coin, amount: d.amount, tx: d.tx, to: d.to }).catch(() => { this.xSent.delete(seen); ok = false; });
				}
				for (const r of found.released) for (const [id, p] of Object.entries(s.xpays ?? {})) {
					if (!p.tx && p.net === net && payoutId32(s.chain, id) === r.id32) await send('x.done', { id, tx: r.tx }).catch(() => { ok = false; });
				}
				if (ok) this.xCursor.set(net, cursor); // read again next time if anything could not be sent
				(this.xStatus.vaults ??= {})[net] = { at: now, deposits: found.deposits.length, released: found.released.length };
			} catch (e) { this.xStatus.error = { at: now, what: `${net} vault: ${(e as Error).message}` }; /* the next look tries again from the same place */ }
		}
	}
	/** the crew upgrade: the crew's nodes say on the chain where they are (their check-ins): reach them, besides the PEERS given */
	private checkinLook = 0;
	private basePeers: string[] | null = null;
	/** the crew upgrade: while staked, say on the chain a few times an hour that this node is online, and where to reach it */
	private async checkIn(now: number) {
		const by = this.by, seq = this.seq;
		if (!by || !seq || this.broken || this.halted || !crewOn(this.state) || !isCandidate(this.state, by.address) || now - this.checkinLook < 60_000) return;
		const n = this.state.nodes && Object.hasOwn(this.state.nodes, by.address) ? this.state.nodes[by.address] : null;
		if (n && this.state.time - n.at < RULES.checkinWindowMs / 3) return;
		this.checkinLook = now;
		// it quotes the newest block it holds; without a public address it is a checker only (never drawn to make blocks)
		const s = this.state, data = { seen: [s.height, s.last], ...(this.cfg.selfUrl ? { url: this.cfg.selfUrl } : {}) };
		const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type: 'node.checkin', data });
		await this.one(() => this.accept(tx));
	}
	/** checkers: a follower given a staked key (its `checker`) says a few times an hour which block it checked last, by
	    a transaction the caller sends to the node it follows. It gives no public address: a follower makes no blocks.
	    Nothing while it has seen trouble (an alert): it only vouches for a chain it has checked. */
	async checkerTx(now: number): Promise<Tx | null> {
		const k = this.cfg.checker, s = this.followed;
		if (!k || this.seq || !s || this.alert || !crewOn(s) || !isCandidate(s, k.address) || now - this.checkinLook < 60_000) return null;
		const n = s.nodes && Object.hasOwn(s.nodes, k.address) ? s.nodes[k.address] : null;
		if (n && s.time - n.at < RULES.checkinWindowMs / 3) return null;
		this.checkinLook = now;
		return signTx(k.secret, { chain: this.first.chain, from: k.address, nonce: nonceOf(s, k.address) + 1, type: 'node.checkin', data: { seen: [s.height, s.last] } });
	}
	private crewPeers() {
		if (!this.net || !this.state.nodes) return;
		this.basePeers ??= [...this.net.peers];
		const nodes = this.state.nodes, me = this.by?.address;
		const urls = this.state.validators.filter((v) => v !== me && Object.hasOwn(nodes, v) && nodes[v].url).map((v) => nodes[v].url!);
		this.net.peers = [...new Set([...this.basePeers, ...urls])];
	}
	private async postBtc(by: Signer, seq: Sequencer) {
		const tip0 = this.state.sun?.btc;
		for (const { rpc } of this.nodesOf('btc')) {
			try {
				const top = await rpc('tip', []);
				if (!Number.isSafeInteger(top) || (tip0 && top <= tip0.height)) return;
				let from = tip0 ? tip0.height + 1 : top;
				if (tip0 && (await rpc('hashAt', [tip0.height])) !== tip0.hash) { // Bitcoin re-organised: find where both still agree
					from = 0;
					for (const [h, hash] of [...tip0.recent].reverse()) if ((await rpc('hashAt', [h])) === hash) { from = h + 1; break; }
					if (!from) return;
				}
				const headers: string[] = [];
				for (let h = from; h <= Math.min(top, from + 9); h++) headers.push(await rpc('header', [await rpc('hashAt', [h])]));
				const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type: 'sun.btc', data: { height: from, headers } });
				await this.one(() => this.accept(tx));
				return;
			} catch { /* that Bitcoin node did not answer, or the chain refused: the next node */ }
		}
	}
	/** the nodes this validator asks about one outside chain: its own if set, else the public ones (label: host only) */
	private nodesOf(net: string): { label: string; rpc: Rpc }[] {
		const a = ADAPTERS[net];
		if (!a) return [];
		const test = a.family === 'solana' ? this.cfg.solanaRpc : a.family === 'bitcoin' ? this.cfg.btcRpc : this.cfg.evmRpc?.(net);
		if (test) return [{ label: 'test', rpc: test }];
		const set = a.family === 'solana' ? this.cfg.solana : a.family === 'bitcoin' ? this.cfg.btc : this.cfg.evm?.[net];
		return (set ?? a.nodes).map((url) => ({ label: nodeLabel(url), rpc: a.rpc(url) })); // an empty list: this validator does not look at that chain
	}

	/** Can this node reach each outside chain? Every node it would ask is tried with the calls a validator really makes
	    (dip.ts `probeNode`). Results are kept for five minutes, and one look refreshes only a few chains (oldest first),
	    so a caller can never make this node hammer other people's nodes; looks never overlap. */
	private linkSeen = new Map<string, { checked: number; nodes: NodeReport[] }>();
	private linkBusy: Promise<void> | null = null;
	async links(): Promise<{ time: number; chains: Record<string, { name: string; ok: boolean; checked: number; nodes: NodeReport[] }>; pending: string[] }> {
		if (this.linkBusy) await this.linkBusy;
		else {
			const now = Date.now(), nets = Object.keys(ADAPTERS);
			const due = nets.filter((n) => now - (this.linkSeen.get(n)?.checked ?? 0) > LINKS_FRESH_MS).sort((x, y) => (this.linkSeen.get(x)?.checked ?? 0) - (this.linkSeen.get(y)?.checked ?? 0)).slice(0, LINKS_PER_LOOK);
			// Bitcoin's check is heavy (about 18 calls per node): it gets a look of its own, within Cloudflare's per-run limit
			if (due.includes('btc')) due.splice(0, due.length, 'btc');
			this.linkBusy = Promise.all(due.map(async (net) => {
				const nodes = await Promise.all(this.nodesOf(net).map((n) => probeNode(ADAPTERS[net], n.label, n.rpc)));
				this.linkSeen.set(net, { checked: Date.now(), nodes });
			})).then(() => {}, () => {});
			try { await this.linkBusy; } finally { this.linkBusy = null; }
		}
		const chains: Record<string, { name: string; ok: boolean; checked: number; nodes: NodeReport[] }> = {}, pending: string[] = [];
		for (const [net, a] of Object.entries(ADAPTERS)) {
			const seen = this.linkSeen.get(net);
			if (seen) chains[net] = { name: a.name, ok: seen.nodes.some((n) => n.ok), checked: seen.checked, nodes: seen.nodes };
			else pending.push(net);
		}
		return { time: Date.now(), chains, pending };
	}

	/** A validator that signs two different votes in the same place is cheating. Send the proof to the chain: it loses
	    part of its stake and its seat for good (ledger.ts, `evidence`). Sent from this validator's own account, which
	    pays the fee and receives the reporter's share. Once per cheater. */
	private reported = new Set<string>();
	private checkDouble(m: VoteMsg) {
		if (this.reported.has(m.from)) return;
		const other = [...this.heard.values()].find((x): x is VoteMsg => x.kind === 'vote' && x.from === m.from && x.type === m.type && x.round === m.round && x.height === m.height && x.block !== m.block);
		if (!other) return;
		this.reported.add(m.from);
		const vote = (x: VoteMsg): SignedVote => ({ type: x.type, height: x.height, round: x.round, block: x.block, validator: x.from, sig: x.sig });
		this.go(async () => {
			const by = this.by!, s = this.seq!;
			try {
				const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: s.pendingNonce(by.address) + 1, type: 'evidence', data: { a: vote(other), b: vote(m) } });
				await this.accept(tx);
			} catch { /* e.g. this validator's account cannot pay the fee, or the cheater has nothing staked: nothing to do */ }
		});
	}

	/** now and then, repeat what we said this height: a message lost on the way must not stall the chain */
	private gossipLoop() {
		if (this.stopped || this.broken) return;
		this.go(async () => {
			const eng = this.engine;
			if (eng?.started && !eng.decided) for (const m of this.heard.values()) if (m.from === this.by!.address && m.round >= eng.round - 1) this.spread(m);
		});
		this.net!.timer(this.ms('gossip'), () => this.gossipLoop());
	}
	private syncLoop() {
		if (this.stopped || this.broken) return;
		void this.sync();
		this.net!.timer(this.ms('sync'), () => this.syncLoop());
	}
	/** if another validator is ahead, fetch the blocks we miss; each one is checked in full before it is taken */
	private async sync() {
		if (this.syncing || !this.net?.peers.length) return;
		this.syncing = true;
		try {
			const peer = this.net.peers[Math.floor(Math.random() * this.net.peers.length)];
			const info = await this.net.get(peer, '/');
			if (!(Number(info?.height) > this.state.height)) return;
			const page = await this.net.get(peer, `/blocks?from=${this.state.height + 1}&limit=50`);
			for (const b of (Array.isArray(page?.blocks) ? page.blocks : []) as Block[]) {
				await this.one(async () => { if (!this.stopped && !this.halted && b?.height === this.state.height + 1) await this.finish(b, await verifyBlock(this.seq!.state, b, Date.now())); });
			}
		} catch { /* that peer is unreachable or sent something wrong: try another next time */ } finally { this.syncing = false; }
	}

	/* ------------------------------ followers ------------------------------ */

	/** Follower: fetch the blocks we do not have, check each one fully, keep the good ones.
	    `get` fetches a path from a source (a node, or an archive) and returns its JSON. Returns how many blocks were added.
	    `behindOk`: this source is one of several (a swarm) or an archive, so it may simply be behind us. Then a shorter
	    history is not suspicious by itself, but its newest block must be the very block we hold at that height. */
	follow(get: (path: string) => Promise<any>, opts: { behindOk?: boolean; label?: string } = {}): Promise<number> {
		if (this.broken) return Promise.reject(new Error(this.broken));
		if (this.seq) return Promise.reject(new Error('A validator does not follow'));
		const who = opts.label ?? 'the node we follow';
		return this.one(async () => {
			let added = 0;
			for (;;) {
				const page = await get(`/blocks?from=${this.followed.height + 1}&limit=100`);
				const blocks: Block[] = Array.isArray(page?.blocks) ? page.blocks : [];
				if (!blocks.length) break;
				for (const b of blocks) {
					if (this.halted) return added;
					let next: State;
					try { next = await verifyBlock(this.followed, b, Date.now()); } catch (e) {
						this.alert ||= `Block ${Number(b?.height)} from ${who} breaks the rules: ${(e as Error).message}`;
						return added;
					}
					next = commit(next);
					this.store.commit(b, next, 0);
					this.keepSnapshot(b, next);
					this.followed = next; added++;
				}
			}
			const info = await get('/'), h = Number(info?.height);
			if (h === this.followed.height && info?.last !== this.followed.last) this.alert ||= `${who} shows a different block ${h} than the one we hold: history was changed`;
			else if (h < this.followed.height) {
				if (!opts.behindOk) this.alert ||= `${who} is at block ${h} but we hold ${this.followed.height}: history was removed`;
				else if (h > 0 && typeof info?.last === 'string') {
					const ours = this.store.block(h);
					if (ours && (await blockHash(this.first.chain, ours)) !== info.last) this.alert ||= `${who} holds a different block ${h} than ours: history was changed`;
				}
			}
			return added;
		});
	}

	/* ------------------------------ the API ------------------------------ */

	private allow(key: string, max = TX_PER_MINUTE) {
		const t = Date.now(), h = this.hits.get(key);
		if (this.hits.size > 5000) this.hits.clear();
		if (!h || h.reset < t) { this.hits.set(key, { n: 1, reset: t + 60_000 }); return true; }
		return ++h.n <= max;
	}
	async handle(req: Req): Promise<Res> {
		if (this.broken) return { status: 503, body: { error: this.broken } };
		const path = req.path.replace(/\/+$/, '') || '/', s = this.state;

		if (req.method === 'GET') {
			if (path === '/') return { status: 200, body: { name: 'Dznye', chain: s.chain, coin: NATIVE, authority: s.authority, validators: s.validators, needed: fewestSigners(s), power: ((w) => ({ total: w.total, needed: w.need }))(weights(s)), staked: !!s.staked, fee: s.fee ?? 0, height: s.height, last: s.last, time: s.time, snapshot: ((n) => (n ? { height: n.block.height, hash: n.state.last } : undefined))(this.snapshot()), role: this.halted ? 'halted' : this.seq ? (this.alone ? 'leader' : this.engine ? 'validator' : 'standby') : 'follower', haltHeight: this.cfg.haltHeight || undefined, waiting: this.seq?.waiting ?? 0, alert: this.alert || undefined, leader: this.seq ? undefined : this.cfg.leader, sun: s.sun ? true : undefined, operator: this.cfg.operator } };
			// on a chain with the Sun, the genesis settings travel with it, so a follower can build the very same first state
			if (path === '/genesis') return { status: 200, body: this.cfg.sun ? { ...this.first, sunGenesis: this.cfg.sun } : this.first };
			// the Sun: where the 12,000,000 DZY are, every rule and number, and one account's locks, raffle and deposit
			if (path === '/economy') return s.sun ? { status: 200, body: economyView(s) } : { status: 404, body: { error: 'This chain has no Sun' } };
			if (path.startsWith('/credit/')) { const a = path.slice(8); return s.sun && /^[0-9a-f]{64}$/.test(a) ? { status: 200, body: creditView(s, a) } : { status: 404, body: { error: 'Not found' } }; }
			if (path === '/sun') return s.sun ? { status: 200, body: { ...sunSupply(s), rules: rulesJson() } } : { status: 404, body: { error: 'This chain has no Sun' } };
			const sv = path.match(/^\/sun\/([0-9a-f]{64})$/);
			if (sv) return s.sun ? { status: 200, body: { ...sunView(s, sv[1]), tickets: openTickets(s, sv[1]) } } : { status: 404, body: { error: 'This chain has no Sun' } };
			if (path === '/snapshot') { const snap = this.snapshot(); return snap ? { status: 200, body: snap } : { status: 404, body: { error: 'No snapshot kept yet' } }; }
			if (path === '/assets') return { status: 200, body: s.assets };
			const now = Math.max(Date.now(), s.time); // pools unlock with time, block or no block
			if (path === '/supply') return { status: 200, body: { [NATIVE]: supplyOf(s, NATIVE, now), started: s.started } };
			const sup = path.match(/^\/supply\/([A-Za-z0-9]{1,24})$/);
			if (sup) return Object.hasOwn(s.assets, sup[1]) ? { status: 200, body: supplyOf(s, sup[1], now) } : { status: 404, body: { error: 'No such asset' } };
			if (path === '/offers') return { status: 200, body: s.offers };
			// completed trades, newest last; ?a=&b= keeps only trades between those two assets (either way round)
			if (path === '/trades') {
				const a = req.query.get('a'), b = req.query.get('b');
				const list = (s.trades ?? []).filter((t) => !a || !b || (t.sold.asset === a && t.paid.asset === b) || (t.sold.asset === b && t.paid.asset === a));
				return { status: 200, body: { kept: RULES.maxTrades, trades: list } };
			}
			// liquidity pools: every token against DZY. The list leaves out who backs each pool (that is in /liquidity/<token>)
			if (path === '/liquidity') return { status: 200, body: { fee: { pool: RULES.poolBps, hub: RULES.hubBps, per: 10_000 }, pools: Object.fromEntries(Object.entries(s.liquidity ?? {}).map(([k, p]) => [k, { dzy: p.dzy, token: p.token, shares: p.shares, backers: Object.keys(p.lp).length, symbol: s.assets[k]?.symbol, name: s.assets[k]?.name, decimals: s.assets[k]?.decimals, mintable: !!s.assets[k]?.mintable, born: p.born, ...(p.launch ? { launch: { creator: p.launch.creator, virt: p.virt ?? 0, creatorBps: RULES.launchCreatorBps } } : {}) }])) } };
			const lq = path.match(/^\/liquidity\/([A-Za-z0-9]{1,24})$/);
			if (lq) return s.liquidity && Object.hasOwn(s.liquidity, lq[1]) ? { status: 200, body: { asset: lq[1], locked: RULES.poolLock, ...s.liquidity[lq[1]], average: poolAverage(s.liquidity[lq[1]], now), averageOver: RULES.poolAvgWindow } } : { status: 404, body: { error: 'This token has no pool' } };
			// leveraged trading: the vaults, every open position with its health, and the limits (the same for everyone)
			if (path === '/margin') return { status: 200, body: {
				limits: { maxLev: RULES.marginMaxLev / 10, openAtPct: RULES.marginOpenPct, liquidateBelowPct: RULES.marginLiqPct, rewardPct: RULES.marginRewardPct, poolShare: 1 / RULES.marginPoolShare, minPoolAgeHours: RULES.marginMinAge / 3_600_000, yearlyBaseBps: RULES.marginBaseBps, yearlySlopeBps: RULES.marginSlopeBps, treasuryShareOfInterestBps: RULES.marginHubBps },
				vaults: Object.fromEntries(Object.entries(s.vaults ?? {}).map(([k, v]) => [k, { cash: v.cash, lent: v.lent, shares: v.shares, lenders: Object.keys(v.lp).length }])),
				positions: Object.fromEntries(Object.entries(s.positions ?? {}).map(([k, p]) => [k, { ...p, health: positionHealth(s, p, now) }]))
			} };
			const mg = path.match(/^\/margin\/(m[0-9a-f]{16})$/);
			if (mg) return s.positions && Object.hasOwn(s.positions, mg[1]) ? { status: 200, body: { id: mg[1], ...s.positions[mg[1]], health: positionHealth(s, s.positions[mg[1]], now) } } : { status: 404, body: { error: 'No such position (never opened, or closed)' } };
			const vt = path.match(/^\/vault\/([A-Za-z0-9]{1,24}:[LS])$/);
			if (vt) return s.vaults && Object.hasOwn(s.vaults, vt[1]) ? { status: 200, body: { vault: vt[1], locked: RULES.poolLock, ...s.vaults[vt[1]] } } : { status: 404, body: { error: 'No such vault' } };
			// what a swap would give right now: ?from=&to=&amount= (amount in the smallest parts of `from`)
			if (path === '/quote') {
				const from = req.query.get('from') ?? '', to = req.query.get('to') ?? '', amount = Number(req.query.get('amount'));
				// the best price there is: open offers cheapest first while they beat the pool, then the pool (what `swap` does)
				const who = req.query.get('who') ?? '', ok = Number.isSafeInteger(amount) && amount > 0 && from !== to && Object.hasOwn(s.assets, from) && Object.hasOwn(s.assets, to);
				const plan = ok ? swapPlan(s, who, from, to, amount, now) : null, q = ok ? poolQuote(s, from, to, amount) : null;
				return plan && (plan.fills.length || plan.pool) ? { status: 200, body: { from, to, amount, out: plan.out, spent: plan.spent, offers: plan.fills.length, poolOnly: q?.out ?? null, hub: q?.hub ?? 0, via: q?.via ?? [] } } : { status: 404, body: { error: 'No way to swap that right now (no offers or pool, or too small an amount)' } };
			}
			// a shop's cashback rules and reserve (Pay with Dznye)
			const sp = path.match(/^\/shop\/([0-9a-f]{64})$/);
			if (sp) return s.shops && Object.hasOwn(s.shops, sp[1]) ? { status: 200, body: { shop: sp[1], ...s.shops[sp[1]], freeLeft: partnerFreeLeft(s, sp[1], now), partner: partnerFreeLeft(s, sp[1], now) > 0 || (s.shops[sp[1]].reserve.DZY ?? 0) >= RULES.partnerMinReserve } } : { status: 404, body: { error: 'This account has no cashback set' } };
			// creators: what a buyer owns (one item, or the latest 100), an item's sales, a creator's tip box
			const ow = path.match(/^\/owned\/([0-9a-f]{64})(?:\/([0-9a-f]{64})\/([A-Za-z0-9._:-]{1,64}))?$/);
			if (ow) {
				if (ow[2]) {
					const k = `${ow[1]}/${ow[2]}/${ow[3]}`, o = s.owned && Object.hasOwn(s.owned, k) ? s.owned[k] : null;
					if (o && o.until !== undefined && o.until < now) return { status: 404, body: { error: 'The membership has ended: renew it', until: o.until } };
					return o ? { status: 200, body: { buyer: ow[1], seller: ow[2], item: ow[3], ...o } } : { status: 404, body: { error: 'Not owned' } };
				}
				const items = Object.entries(s.owned ?? {}).filter(([k]) => k.startsWith(ow[1] + '/')).map(([k, v]) => { const [, seller, item] = k.split('/'); return { seller, item, ...v }; }).sort((a, b) => b.at - a.at).slice(0, 100);
				return { status: 200, body: { items } };
			}
			const sl = path.match(/^\/sales\/([0-9a-f]{64})\/([A-Za-z0-9._:-]{1,64})$/);
			if (sl) { const k = `${sl[1]}/${sl[2]}`; return { status: 200, body: s.sales && Object.hasOwn(s.sales, k) ? s.sales[k] : { n: 0, total: 0 } }; }
			// what a dollar-priced item (or any dollar amount: /usd?usd=) costs in each coin the chain prices, now
			const iq = path.match(/^\/itemquote\/([0-9a-f]{64})\/([A-Za-z0-9._:-]{1,64})$/);
			if (iq || path === '/usd') {
				let usd = Number(req.query.get('usd'));
				if (iq) { const r = s.records && Object.hasOwn(s.records, `${iq[1]}/items/${iq[2]}`) ? s.records[`${iq[1]}/items/${iq[2]}`] : null, v = itemOf(r?.value); if (!v) return { status: 404, body: { error: 'No such item' } }; usd = v.usd; if (!usd) return { status: 200, body: { usd: 0, pay: { [v.asset]: v.price } } }; }
				if (!Number.isSafeInteger(usd) || usd <= 0) return { status: 400, body: { error: 'usd: whole millionths of a dollar' } };
				const pay: Record<string, number> = {};
				for (const a of Object.keys(s.assets)) { const n = usdCost(s, a, usd, now); if (n !== null) pay[a] = n; }
				return { status: 200, body: { usd, pay } };
			}
			// checkouts paid on another chain: one, a buyer's open ones, what a creator owes in fees
			const od = path.match(/^\/order\/(o[0-9a-f]{16})$/);
			if (od) return s.orders && Object.hasOwn(s.orders, od[1]) ? { status: 200, body: { id: od[1], ...s.orders[od[1]] } } : { status: 404, body: { error: 'No such checkout (done, or ended)' } };
			const ob = path.match(/^\/orders\/([0-9a-f]{64})$/);
			if (ob) return { status: 200, body: { orders: Object.entries(s.orders ?? {}).filter(([, o]) => o.buyer === ob[1] || o.seller === ob[1]).map(([id, o]) => ({ id, ...o })) } };
			const fo = path.match(/^\/feeowed\/([0-9a-f]{64})$/);
			if (fo) return { status: 200, body: { usd: s.feeOwed?.[fo[1]] ?? 0 } };
			const tb = path.match(/^\/tips\/([0-9a-f]{64})$/);
			if (tb) return { status: 200, body: s.tipboxes && Object.hasOwn(s.tipboxes, tb[1]) ? s.tipboxes[tb[1]] : { total: {}, n: 0, last: [] } };
			// tasks sites pay for: all open ones (without who has done them), or one in full
			if (path === '/tasks') return { status: 200, body: Object.fromEntries(Object.entries(s.tasks ?? {}).map(([k, q]) => [k, { by: q.by, asset: q.asset, reward: q.reward, left: q.left, done: Object.keys(q.done).length, until: q.until, note: q.note }])) };
			const tk = path.match(/^\/task\/(q[0-9a-f]{16})$/);
			if (tk) return s.tasks && Object.hasOwn(s.tasks, tk[1]) ? { status: 200, body: { id: tk[1], ...s.tasks[tk[1]] } } : { status: 404, body: { error: 'No such task (never posted, finished, or closed)' } };
			// records: one, a writer's records in a space, or a space across every writer (newest first)
			const rm = path.match(/^\/record\/([0-9a-f]{64})\/([a-z0-9][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,64})$/);
			if (rm) { const r = recordOf(s, rm[1], rm[2], rm[3]); return r ? { status: 200, body: r } : { status: 404, body: { error: 'No such record' } }; }
			const rl = path.match(/^\/records\/([0-9a-f]{64})\/([a-z0-9][a-z0-9-]{0,31})$/);
			if (rl) return { status: 200, body: { records: recordsOf(s, rl[1], rl[2], Math.min(100, Number(req.query.get('limit')) || 100), req.query.get('after') ?? '') } };
			const rs = path.match(/^\/space\/([a-z0-9][a-z0-9-]{0,31})$/);
			if (rs) return { status: 200, body: { records: spaceRecords(s, rs[1], Math.min(100, Number(req.query.get('limit')) || 100), Number(req.query.get('before')) || Infinity) } };
			// a stream, as it stands now: what is owed to the receiver, what is left to flow
			const sm = path.match(/^\/stream\/(s[0-9a-f]{16})$/);
			if (sm) { const v = streamView(s, sm[1], Math.max(Date.now(), s.time)); return v ? { status: 200, body: v } : { status: 404, body: { error: 'No such stream (never opened, finished or stopped)' } }; }
			const sa = path.match(/^\/streams\/([0-9a-f]{64})$/);
			if (sa) { const now = Math.max(Date.now(), s.time); return { status: 200, body: { streams: Object.keys(s.streams ?? {}).filter((k) => s.streams![k].from === sa[1] || s.streams![k].to === sa[1]).map((k) => streamView(s, k, now)) } }; }
			// a gift waiting to be claimed by link (the claim key's secret is never on the chain)
			const gf = path.match(/^\/gift\/(g[0-9a-f]{16})$/);
			if (gf) return s.gifts && Object.hasOwn(s.gifts, gf[1]) ? { status: 200, body: { id: gf[1], ...s.gifts[gf[1]] } } : { status: 404, body: { error: 'No such gift (never made, already claimed, or taken back)' } };
			if (path === '/xoffers') return { status: 200, body: s.xoffers ?? {} };
			// Up or Down rounds: each round's pools and prices, and (with ?who=) that account's stakes in it
			if (path === '/rounds') { const who = req.query.get('who') ?? ''; return { status: 200, body: { feeBps: RULES.roundFeeBps, minBet: RULES.roundMin, windowMs: RULES.roundWindow, rounds: Object.fromEntries(Object.entries(s.rounds ?? {}).map(([k, r]) => [k, { up: r.up, down: r.down, left: r.left, open: r.open ?? null, close: r.close ?? null, bettors: Object.keys(r.bets).length, ...(who && Object.hasOwn(r.bets, who) ? { mine: r.bets[who] } : {}) }])) } }; }
			if (path === '/markets') return { status: 200, body: Object.fromEntries(Object.entries(s.markets ?? {}).map(([k, m]) => [k, { ...m, yes: s.assets[k + 'Y']?.supply ?? 0, no: s.assets[k + 'N']?.supply ?? 0 }])) };
			const xo = path.match(/^\/xoffer\/(x[0-9a-f]{16})$/);
			if (xo) return s.xoffers && Object.hasOwn(s.xoffers, xo[1]) ? { status: 200, body: { id: xo[1], ...s.xoffers[xo[1]] } } : { status: 404, body: { error: 'No such offer (never made, taken, or cancelled)' } };
			if (path === '/swaps') return { status: 200, body: { open: s.swaps ?? {}, done: s.swapLog ?? [] } };
			const sw = path.match(/^\/swap\/(sw[0-9a-f]{16})$/);
			if (sw) {
				if (s.swaps && Object.hasOwn(s.swaps, sw[1])) return { status: 200, body: { id: sw[1], status: 'open', ...s.swaps[sw[1]] } };
				const done = (s.swapLog ?? []).find((x) => x.id === sw[1]);
				return done ? { status: 200, body: { ...done, status: done.refunded ? 'refunded' : 'claimed' } } : { status: 404, body: { error: 'No such lock (never made, or finished long ago)' } };
			}
			if (path === '/peers') return { status: 200, body: { peers: this.peers() } };
			// the web of chains: Dznye in the middle, and every outside chain it has an adapter for (dip.ts, DIP.md)
			if (path === '/chains') return { status: 200, body: { hub: { chain: s.chain, coin: NATIVE, height: s.height, validators: s.validators.length, needed: fewestSigners(s) }, chains: Object.values(ADAPTERS).map((a) => ({ net: a.net, name: a.name, family: a.family, tokens: a.tokens, finalMinutes: a.finalMinutes, explorer: a.explorer, payerNamesPayment: a.needsTx })) } };
			// can this node reach them? (it asks other people's nodes, so it is rate-limited and kept for five minutes)
			if (path === '/status/links') {
				if (!this.allow('v:' + (req.ip || 'unknown'), VIEW_PER_MINUTE)) return { status: 429, body: { error: 'Slow down a little' } };
				return { status: 200, body: await this.links() };
			}
			// premium names (1 to 3 characters): what the next one of each length costs now, in µ$ and in DZY
			if (path === '/names/premium') return { status: 200, body: { open: namesV2On(s), ...Object.fromEntries([1, 2, 3].map((n) => { const usd = premiumNameUsd(s, n); return [n, { taken: s.premiumSold?.[String(n)] ?? 0, usd, dzy: usdCost(s, NATIVE, usd) }]; })) } };
			const nm = path.match(/^\/name\/@?([a-z0-9-]{1,32})$/);
			if (nm) {
				const who = s.names && Object.hasOwn(s.names, nm[1]) ? s.names[nm[1]] : null;
				// one name, every chain: the Dznye address, the same key as a Solana address, and any linked addresses
				return who ? { status: 200, body: { name: nm[1], address: who, solana: solanaAddress(who), links: s.accounts[who]?.links ?? {} } } : { status: 404, body: { error: 'Nobody has that name' } };
			}
			const con = path.match(/^\/contract\/([0-9a-f]{64})(\/view)?$/);
			if (con) {
				const c = s.contracts && Object.hasOwn(s.contracts, con[1]) ? s.contracts[con[1]] : null;
				if (!c) return { status: 404, body: { error: 'No such contract' } };
				if (!con[2]) return { status: 200, body: { address: con[1], creator: c.creator, code: c.code, entries: c.entries, storage: Object.fromEntries(Object.entries(c.storage).slice(0, 500)), events: c.events ?? [], balances: s.accounts[con[1]]?.bal ?? {} } };
				// asking a contract something costs nothing on the chain, but it does use this node: so it is rate-limited
				if (!this.allow('v:' + (req.ip || 'unknown'), VIEW_PER_MINUTE)) return { status: 429, body: { error: 'Slow down a little' } };
				let args: unknown = [];
				try { args = JSON.parse(req.query.get('args') ?? '[]'); } catch { return { status: 400, body: { error: 'args must be a JSON list' } }; }
				try { const r = viewContract(s, con[1], String(req.query.get('fn') ?? ''), args, now); return { status: 200, body: { value: r.value, gasUsed: r.gasUsed } }; }
				catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
			}
			if (path === '/contracts') return { status: 200, body: Object.fromEntries(Object.entries(s.contracts ?? {}).map(([k, c]) => [k, { creator: c.creator, functions: Object.keys(c.code.functions), entries: c.entries }])) };
			const chan = path.match(/^\/channel\/(ch[0-9a-f]{16})$/);
			if (chan) return s.channels && Object.hasOwn(s.channels, chan[1]) ? { status: 200, body: { id: chan[1], ...s.channels[chan[1]] } } : { status: 404, body: { error: 'No such channel (never opened, or settled)' } };
			// the exchange: whether it is open, its coins and limits, what every vault holds against the claims on it, the agreed prices, and the latest payouts
			if (path === '/exchange') return { status: 200, body: { ...exchangeView(s), watcher: this.by ? this.xStatus : undefined } };
			// a validator's part in paying a sell-back from an Ethereum-style vault: its signer address, and its signature on a
			// real, unpaid payout to a listed vault (anyone collects them from more than two thirds of the validators and submits)
			if (path === '/exchange/signer') return this.by ? { status: 200, body: { validator: this.by.address, evm: await evmSignerOf(this.by.secret) } } : { status: 404, body: { error: 'This node holds no validator key' } };
			const xr = path.match(/^\/exchange\/release\/(p[0-9a-f]{16})$/);
			if (xr) {
				if (!this.by || !s.validators.includes(this.by.address)) return { status: 404, body: { error: 'This node is not a validator now' } };
				if (s.xpays && Object.hasOwn(s.xpays, xr[1]) && s.xpays[xr[1]].net === 'sol') { // the Solana vault: an Ed25519 signature by this validator's own key
					const r = solReleaseFor(s, xr[1], Number(req.query?.get('setId')), USDC_MINT);
					if ('error' in r) return { status: 400, body: { error: r.error } };
					return { status: 200, body: { ...r, amount: r.amount.toString(), signer: this.by.address, ...(await signSolRelease(this.by.secret, r)) } };
				}
				const r = releaseFor(s, xr[1], Number(req.query?.get('setId')));
				if ('error' in r) return { status: 400, body: { error: r.error } };
				const { signer, sig } = await signRelease(this.by.secret, r);
				return { status: 200, body: { ...r, amount: r.amount.toString(), signer, sig } };
			}
			const xa = path.match(/^\/exchange\/([0-9a-f]{64})$/);
			if (xa) return { status: 200, body: { claims: Object.fromEntries(Object.keys(X_COINS).map((c) => [c, balanceOf(s, xa[1], 'x' + c)])), locks: Object.fromEntries(Object.keys(X_COINS).map((c) => [c, s.x?.locks?.[xa[1] + ':' + c] ?? 0])), parked: !!s.x?.park?.[xa[1]], loans: loansOf(s, xa[1], Math.max(Date.now(), s.time)), dusd: balanceOf(s, xa[1], 'DUSD'), payouts: Object.entries(s.xpays ?? {}).filter(([, p]) => p.by === xa[1]).slice(-50).map(([id, p]) => ({ id, ...p })) } };
			if (path === '/nodes') return { status: 200, body: { crewFrom: Number.isFinite(crewFrom(s.chain)) ? crewFrom(s.chain) : null, nodes: s.nodes ?? {}, crew: s.crew ?? null } }; // the crew upgrade: who checked in, and the crew
			if (path === '/validators') return { status: 200, body: { validators: s.validators, needed: fewestSigners(s), power: weights(s).power, totalPower: weights(s).total, neededPower: weights(s).need, staked: !!s.staked, minStake: RULES.minStake, seatPrice: seatPrice(s), unbondDays: RULES.unbondDelay / 86_400_000, stakes: s.stakes ?? {}, delegations: s.delegations ?? {}, undelegating: s.undelegating ?? {} } };
			// treasury payouts proposed by stakers, with the votes so far and what passing needs
			if (path === '/proposals') return { status: 200, body: { treasury: s.treasury ?? 0, totalWeight: totalVoteWeight(s), passesAbove: '2/3 of totalWeight', voteDays: RULES.voteDays / 86_400_000, proposals: Object.fromEntries(Object.entries(s.proposals ?? {}).map(([k, p]) => [k, { ...p, yes: Object.entries(p.votes).filter(([, y]) => y).reduce((n, [a]) => n + voteWeight(s, a), 0) }])) } };
			const acct = path.match(/^\/account\/([0-9a-f]{64})$/);
			if (acct) {
				const a: Account = Object.hasOwn(s.accounts, acct[1]) ? s.accounts[acct[1]] : { nonce: 0, bal: {} };
				return { status: 200, body: { address: acct[1], balances: a.bal, nonce: a.nonce, nextNonce: (this.seq ? this.seq.pendingNonce(acct[1]) : a.nonce) + 1, keys: a.keys ?? [], firstKeyOff: !!a.off, agents: a.agents ?? {}, guardian: a.guardian ?? null, recover: a.recover ?? null, name: a.name ?? null, solana: solanaAddress(acct[1]), links: a.links ?? {}, multi: a.multi ?? null, stake: s.stakes && Object.hasOwn(s.stakes, acct[1]) ? s.stakes[acct[1]] : null } };
			}
			const one = path.match(/^\/block\/(\d{1,15})$/);
			if (one) { const b = this.store.block(Number(one[1])); return b ? { status: 200, body: b } : { status: 404, body: { error: 'No such block' } }; }
			if (path === '/blocks') {
				const from = Math.max(1, Math.floor(Number(req.query.get('from'))) || 1), limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.get('limit'))) || 50));
				return { status: 200, body: { height: s.height, blocks: this.store.blocks(from, limit) } };
			}
			return { status: 404, body: { error: 'Not found' } };
		}

		if (req.method !== 'POST') return { status: 405, body: { error: 'Not allowed' } };
		// any node, a follower too, takes announcements of other places that hold the chain
		// try a signed transaction against a copy of the chain: what would happen, and what it would cost. Nothing changes.
		if (path === '/simulate') {
			if (req.body.length > MAX_BODY) return { status: 413, body: { error: 'Too big' } };
			if (!this.allow('v:' + (req.ip || 'unknown'), VIEW_PER_MINUTE)) return { status: 429, body: { error: 'Slow down a little' } };
			let tx: Tx; try { tx = JSON.parse(req.body)?.tx; } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
			const copy = fork(this.state), report: TxReport = {}; // a layer: only what the transaction touches is copied
			try {
				const id = await applyTx(copy, tx, Math.max(Date.now(), copy.time), undefined, report);
				return { status: 200, body: { ok: !report.failed, id, fee: report.fee ?? 0, ...(report.gasUsed !== undefined ? { gasUsed: report.gasUsed } : {}), ...(report.failed ? { failed: report.failed } : {}) } };
			} catch (e) { return { status: 200, body: { ok: false, refused: (e as Error).message } }; }
		}
		if (path === '/peers') {
			if (req.body.length > 1000) return { status: 413, body: { error: 'Too big' } };
			if (!this.allow('p:' + (req.ip || 'unknown'), PEER_PER_MINUTE)) return { status: 429, body: { error: 'Slow down a little' } };
			let url: unknown; try { url = JSON.parse(req.body)?.url; } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
			const why = await this.addPeer(url);
			return why ? { status: 400, body: { error: why } } : { status: 200, body: { ok: true } };
		}
		// a buyer asks the validators to watch their personal deposit addresses (deposit.ts) for 30 days, and may name a payment
		if (path === '/sun/watch') {
			if (req.body.length > 1000) return { status: 413, body: { error: 'Too big' } };
			if (!this.allow('w:' + (req.ip || 'unknown'), WATCH_PER_MINUTE)) return { status: 429, body: { error: 'Slow down a little' } };
			if (!this.state.sun) return { status: 404, body: { error: 'This chain has no Sun' } };
			if (exchangeOn(this.state)) return { status: 410, body: { error: 'Nothing is burned any more: buy DZY through the exchange (GET /exchange for the vault addresses)' } }; // never hand out a burn address once burning no longer buys anything
			let w: Record<string, unknown>; try { w = JSON.parse(req.body); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
			if (!w || typeof w !== 'object' || typeof w.to !== 'string' || !/^[0-9a-f]{64}$/.test(w.to)) return { status: 400, body: { error: 'to is a Dznye address' } };
			if (w.tx !== undefined && (typeof w.net !== 'string' || !Object.hasOwn(SUN_DOLLARS, w.net) || !isPayId(w.net, w.tx))) return { status: 400, body: { error: 'name the payment as { net, tx }: sol, eth, base, arb, op, polygon, bsc or avax, and its id there' } };
			const to = w.to, addresses = { evm: await depositEvm(to), sol: await depositSol(to) };
			if (!this.seq) { // a follower: pass it to the validator it follows
				if (!this.cfg.leader) return { status: 405, body: { error: 'This node only follows. Tell a validator.' } };
				try { const r = await fetch(this.cfg.leader.replace(/\/+$/, '') + '/sun/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
				catch { return { status: 502, body: { error: 'The validator did not answer' } }; }
			}
			const fresh = !this.watched.has(to);
			this.watched.delete(to); this.watched.set(to, Date.now()); // newest last
			while (this.watched.size > MAX_WATCH) this.watched.delete(this.watched.keys().next().value!);
			if (typeof w.tx === 'string' && typeof w.net === 'string') {
				const tx = w.net === 'sol' ? w.tx : w.tx.toLowerCase();
				if (Object.hasOwn(this.state.sun.paid, w.net + ':' + tx)) return { status: 200, body: { ok: true, done: true, ...addresses } };
				if (this.depTx.length < MAX_DEP_TX && !this.depTx.some((d) => d.net === w.net && d.tx === tx)) this.depTx.push({ net: w.net, tx, to });
				this.depLook = 0; // look at once
			}
			this.saveWatch(fresh);
			return { status: 200, body: { ok: true, ...addresses, until: Date.now() + WATCH_LIFE } };
		}
		// a buyer tells the validators about dollars burned for DZY: off the chain, checked by each validator itself
		// the exchange: list a deployed vault. This node checks the contract on its own chain first (code there, first set,
		// signers exactly this chain's validators), then agrees on the chain (x.vault). Anyone may ask; a wrong vault is refused.
		if (path === '/exchange/paid') { // a wallet names its payment into a vault; the node checks it on that chain itself
			if (req.body.length > 500) return { status: 413, body: { error: 'Too big' } };
			if (!this.allow('xp:' + (req.ip || 'unknown'), 20)) return { status: 429, body: { error: 'Slow down a little' } };
			let d: Record<string, unknown>; try { d = JSON.parse(req.body); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
			const why = this.paid(String(d.net ?? ''), String(d.tx ?? ''), Date.now());
			return why ? { status: 400, body: { error: why } } : { status: 200, body: { ok: true } };
		}
		if (path === '/exchange/list') {
			if (req.body.length > 1000) return { status: 413, body: { error: 'Too big' } };
			if (!this.allow('xl:' + (req.ip || 'unknown'), 10)) return { status: 429, body: { error: 'Slow down a little' } };
			const by = this.by, seq = this.seq;
			if (!by || !seq || !this.state.validators.includes(by.address)) return { status: 404, body: { error: 'This node is not a validator now' } };
			if (!exchangeOn(this.state)) return { status: 400, body: { error: 'The exchange is not open' } };
			if (this.state.validators.length !== 1) return { status: 400, body: { error: 'With several validators, a vault is listed by each of them checking it (not built yet)' } };
			let d: Record<string, unknown>; try { d = JSON.parse(req.body); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
			const net = String(d.net ?? ''), address = String(d.address ?? ''), from = d.from === undefined ? undefined : Number(d.from);
			const nodes = eachInTurn(this.nodesOf(net).map((n) => n.rpc));
			if (!nodes) return { status: 400, body: { error: `This node does not look at ${net}` } };
			let why = '';
			try {
				if (net === 'sol') why = await checkSolVault(nodes, address, [by.address], await solPda([new TextEncoder().encode('config')], address));
				else if (EVM[net]) {
					why = await checkEvmVault(nodes, address, [await evmSignerOf(by.secret)]);
					if (!why && from !== undefined && !(Number.isSafeInteger(from) && from >= 0 && from <= Number(BigInt(await nodes('eth_blockNumber', []))))) why = 'bad block';
				} else why = `no vault can be listed on ${net} yet`;
			} catch (e) { why = `could not read ${net}: ${(e as Error).message}`; }
			if (why) return { status: 400, body: { error: why } };
			try {
				const tx = await signTx(by.secret, { chain: this.first.chain, from: by.address, nonce: seq.pendingNonce(by.address) + 1, type: 'x.vault', data: { net, address, ...(from !== undefined ? { from } : {}) } });
				return { status: 200, body: { ok: true, id: await this.one(() => this.accept(tx)) } };
			} catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
		}
		if (path === '/sun/hint') {
			if (req.body.length > 1000) return { status: 413, body: { error: 'Too big' } };
			if (!this.allow('h:' + (req.ip || 'unknown'), HINT_PER_MINUTE)) return { status: 429, body: { error: 'Slow down a little' } };
			if (!this.state.sun) return { status: 404, body: { error: 'This chain has no Sun' } };
			let p: Record<string, unknown>; try { p = JSON.parse(req.body); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
			const why = sunBuyProblem(p);
			if (why) return { status: 400, body: { error: why } };
			const h = p as unknown as { net: string; token: string; amount: number; tx: string; to: string };
			if (Object.hasOwn(this.state.sun.paid, h.net + ':' + h.tx)) return { status: 200, body: { ok: true, done: true } };
			if (!this.seq) { // a follower: pass it to the validator it follows
				if (!this.cfg.leader) return { status: 405, body: { error: 'This node only follows. Tell a validator.' } };
				try { const r = await fetch(this.cfg.leader.replace(/\/+$/, '') + '/sun/hint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(h), signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
				catch { return { status: 502, body: { error: 'The validator did not answer' } }; }
			}
			const key = `${h.net}:${h.tx}:${h.to}:${h.token}:${h.amount}`;
			if (!this.hints.has(key)) {
				if (this.hints.size >= MAX_HINTS) this.hints.delete(this.hints.keys().next().value!);
				this.hints.set(key, { p: { net: h.net, token: h.token, amount: h.amount, tx: h.tx, to: h.to }, at: Date.now() });
			}
			return { status: 200, body: { ok: true } };
		}
		if (!this.seq) return { status: 405, body: { error: 'This node only follows and checks. Send transactions to a validator.', leader: this.cfg.leader } };
		if (req.body.length > (path === '/consensus' ? MAX_CONSENSUS_BODY : MAX_BODY)) return { status: 413, body: { error: 'Too big' } };
		// limits come before any work is done on what was sent. "relayed" (passed on by another validator) is only a hint,
		// and anyone can claim it: it gets a larger allowance, never none
		const ip = req.ip || 'unknown', relayed = req.query.get('relay') === '1';
		const [bucket, max] = path === '/consensus' ? ['c:', CONSENSUS_PER_MINUTE] : relayed ? ['r:', RELAY_PER_MINUTE] : ['t:', TX_PER_MINUTE];
		if ((path === '/consensus' || path === '/tx') && !this.allow(bucket + ip, max)) return { status: 429, body: { error: 'Slow down a little' } };
		let body: Record<string, unknown>;
		try { body = JSON.parse(req.body); } catch { return { status: 400, body: { error: 'Bad JSON' } }; }
		if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Bad JSON' } };

		// validators talking to each other; every message is signed, and unsigned or unknown senders are ignored
		if (path === '/consensus' && !this.alone) { this.go(() => this.onMessage(body.msg as Msg)); return { status: 200, body: { ok: true } }; }
		if (path === '/tx') {
			try { return { status: 200, body: { ok: true, id: await this.one(() => this.accept(body.tx as Tx, relayed)) } }; } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
		}
		return { status: 404, body: { error: 'Not found' } };
	}
}
