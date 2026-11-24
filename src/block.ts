import { canon, merkleRoot, sha256, sign, verify } from './crypto.ts';
import { commit, fork, plain, seal, unseal } from './layer.ts';
import { decodeTogether, EVM_RULES, keepReceipts } from './evmledger.ts';
import { BLOB } from './blobs.ts';
import { HEART, maxTx, roomOf, turnFor } from './heart.ts';
import { applyTx, endBlock, gasLimitOf, powers, RULES, stateRoot, sunBlock, txMessage, voteMessage, type State, type Tx } from './ledger.ts';
export { voteMessage };

/* Blocks: a batch of transactions, chained to the block before it by hash.
   No single key decides a block. A block counts only when more than two thirds of the chain's validators have
   signed it (its "commit"). Anyone holding the genesis and the blocks can replay them, check every signature,
   and must arrive at the same state root. */

export interface Signer { address: string; secret: string }
export interface Commit { round: number; sigs: { validator: string; sig: string }[] }
export interface Block {
	height: number;
	prev: string; // hash of the block before
	time: number; // milliseconds; never goes backwards
	proposer: string; // the validator that put this block together: the one whose turn it was in `round`
	round?: number; // the round of agreement in which it was put together (absent = 0)
	txs: Tx[];
	txRoot: string;
	stateRoot: string; // fingerprint of everything after these transactions
	commit: Commit; // the validators' signatures that make it final
}
/** a block that has been put together but not yet agreed on */
export type Proposed = Omit<Block, 'commit'>;
export type VoteType = 'prevote' | 'precommit';

/** how much of a total say `n` must agree: more than two thirds. Two different blocks can then never both be signed
    unless validators holding more than a third of the say signed both, which is provable cheating. With one vote
    each it is a count of validators: 3 of 4, 5 of 7. */
export const quorum = (n: number) => Math.floor((2 * n) / 3) + 1;
/** the say of every validator for the next block, the total, and how much of it must sign */
export function weights(state: State) {
	const power = powers(state), total = Object.values(power).reduce((n, p) => n + p, 0);
	return { power, total, need: quorum(total) };
}
/** the fewest validators that could reach agreement (the ones with the most say), for people to read */
export function fewestSigners(state: State) {
	const { power, need } = weights(state);
	let n = 0, got = 0;
	for (const p of Object.values(power).sort((a, b) => b - a)) { if (got >= need) break; got += p; n++; }
	return n;
}

const headerMessage = (chain: string, b: Proposed) =>
	'dzy-block:' + canon({ chain, height: b.height, prev: b.prev, time: b.time, txRoot: b.txRoot, stateRoot: b.stateRoot, proposer: b.proposer, round: b.round || undefined });
export const blockHash = (chain: string, b: Proposed) => sha256(headerMessage(chain, b));
export const signVote = (chain: string, type: VoteType, height: number, round: number, block: string | null, by: Signer) =>
	sign(by.secret, voteMessage(chain, type, height, round, block));
// a fee payer's signature is part of the block too (added only when there is one, so older blocks keep their roots)
// a fee payer's and co-signers' signatures are part of the block too (added only when present, so older blocks keep their roots)
const txRootOf = (txs: Tx[]) => merkleRoot(txs.map((t) => txMessage(t) + ':' + t.sig + (t.payerSig === undefined ? '' : ':' + t.payerSig) + (t.cosigs === undefined ? '' : ':' + canon(t.cosigs))));

/** whose turn it is to put block `height` together in `round`: validators take turns in their agreed order */
export const proposerFor = (state: State, height: number, round: number) => turns(state, height)(round);
/** whose turn each round of a height is, as the state stands now (the Heart upgrade draws it: heart.ts) */
export function turns(state: State, height: number): (round: number) => string {
	const vs = state.validators;
	if (!state.heart) return (round) => vs[(height + round) % vs.length];
	const power = { ...powers(state) }, seed = state.crew?.seed ?? '', list = vs.slice();
	return (round) => turnFor(list, power, seed, height, round);
}

/** Put the next block together, in agreement round `round`. Every transaction must be valid, in order. The given state is not changed. */
export async function makeBlock(state: State, txs: Tx[], time: number, proposer: string, round = 0, skip = false): Promise<{ block: Proposed; state: State }> {
	if (txs.length > maxTx(state)) throw new Error('too many transactions for one block');
	if (state.heart && (fits(txs, txs.length, roomOf(state)) < txs.length || !cargoFits(txs, roomOf(state).bytes))) throw new Error('too big for one block');
	if (!Number.isSafeInteger(time) || time < state.time) throw new Error('block time cannot go backwards');
	if (!Number.isSafeInteger(round) || round < 0) throw new Error('bad round');
	if (!state.validators.includes(proposer)) throw new Error('this key is not a validator');
	if (proposerFor(state, state.height + 1, round) !== proposer) throw new Error("it is not this key's turn to make a block");
	const s = fork(state); // a layer: the given state is never changed, and nothing is copied that the block does not touch
	if (!s.started) s.started = time; // block 1 starts the clock for the pools
	if (state.heart && sidesMissing(txs)) { if (!skip) throw new Error('a file\'s bytes are missing'); txs = txs.filter((t) => t.type !== 'blob.part' || t.side !== undefined); }
	await together(txs);
	if (skip) { const ok: Tx[] = []; for (const tx of txs) { try { await applyTx(s, tx, time, proposer); ok.push(tx); } catch { /* it waits for a block that fits it */ } } txs = ok; } // a refused one leaves no trace
	else for (const tx of txs) await applyTx(s, tx, time, proposer);
	endBlock(s, state.height + 1, round, proposer, time);
	await sunBlock(s, time, txs.length, proposer, bytesOf(txs)); // a chain with the Sun: the fee formula, the proposer's turn, and a chain minute when the clock reaches one
	const block: Proposed = { height: state.height + 1, prev: state.last, time, proposer, ...(round ? { round } : {}), txs, txRoot: await txRootOf(txs), stateRoot: await stateRoot(s) };
	s.height = block.height; s.time = time; s.last = await blockHash(state.chain, block);
	keepReceipts(block, s);
	return { block, state: s };
}

/** Check these transactions' main signatures side by side (on every core the machine has), so that applying them one by one
    afterwards finds each already checked. It decides nothing: applyTx still asks for every one. */
export async function together(txs: readonly Tx[]): Promise<void> {
	const evm = txs.filter((tx) => tx?.type === 'evm.run').map((tx) => tx.data?.raw);
	if (evm.length) await decodeTogether(evm);
	await Promise.all(txs.map(async (tx) => { try { if (tx && typeof tx === 'object' && typeof tx.sig === 'string') await verify((tx.signer ?? tx.from) as string, txMessage(tx), tx.sig); } catch { /* applyTx says why */ } }));
}

/** Check everything about a block except who signed it. Returns the state after it, or throws with the reason.
    `now`: the checking node's own clock. A live node passes it, and refuses a block dated in its future: time decides
    when pools unlock, stakes come out and recoveries finish, so a validator must not be able to move it forward.
    (Replaying old history passes nothing: those blocks were checked against the clock when they were new.) */
export async function checkBlock(state: State, block: Proposed, now?: number): Promise<State> {
	if (!block || typeof block !== 'object' || !Array.isArray(block.txs)) throw new Error('bad block');
	if (block.height !== state.height + 1) throw new Error('wrong height');
	if (block.prev !== state.last) throw new Error('does not follow the last block');
	const round = block.round ?? 0;
	if (!Number.isSafeInteger(round) || round < 0 || block.round === 0) throw new Error('bad round');
	if (!state.validators.includes(block.proposer)) throw new Error('the proposer is not a validator');
	if (proposerFor(state, block.height, round) !== block.proposer) throw new Error("it was not that validator's turn to make this block");
	if (!Number.isSafeInteger(block.time) || block.time < state.time) throw new Error('block time went backwards');
	if (now !== undefined && block.time > now + RULES.clockSlack) throw new Error('the block is dated in the future');
	if (block.txs.length > maxTx(state)) throw new Error('too many transactions');
	if (state.heart && (fits(block.txs, block.txs.length, roomOf(state)) < block.txs.length || !cargoFits(block.txs, roomOf(state).bytes))) throw new Error('the block is too big');
	if (state.heart && now !== undefined && block.time > now - BLOB.freshMs && sidesMissing(block.txs)) throw new Error('a file\'s bytes are missing');
	const s = fork(state);
	await together(block.txs);
	if (!s.started) s.started = block.time;
	for (const tx of block.txs) await applyTx(s, tx, block.time, block.proposer);
	endBlock(s, block.height, round, block.proposer, block.time);
	await sunBlock(s, block.time, block.txs.length, block.proposer, bytesOf(block.txs));
	if ((await txRootOf(block.txs)) !== block.txRoot) throw new Error('transactions do not match the block');
	if ((await stateRoot(s)) !== block.stateRoot) throw new Error('state does not match the block');
	s.height = block.height; s.time = block.time; s.last = await blockHash(state.chain, block);
	keepReceipts(block, s);
	return s;
}

/** Check that enough of the validators (as they stood before this block) signed exactly this block. */
export async function verifyCommit(state: State, block: Block): Promise<void> {
	const c = block?.commit;
	if (!c || typeof c !== 'object' || !Number.isSafeInteger(c.round) || c.round < 0 || !Array.isArray(c.sigs)) throw new Error('the block is not signed');
	if (c.sigs.length > state.validators.length) throw new Error('too many signatures');
	const message = voteMessage(state.chain, 'precommit', block.height, c.round, await blockHash(state.chain, block));
	const seen = new Set<string>();
	for (const s of c.sigs) {
		if (!s || !state.validators.includes(s.validator)) throw new Error('signed by someone who is not a validator');
		if (seen.has(s.validator)) throw new Error('the same validator signed twice');
		if (typeof s.sig !== 'string' || !(await verify(s.validator, message, s.sig))) throw new Error('bad validator signature');
		seen.add(s.validator);
	}
	const { power, need } = weights(state);
	let got = 0; for (const v of seen) got += power[v];
	if (got < need) throw new Error(`not enough validators signed: ${got} of the ${need} needed`);
}

/** Check a block fully against the state before it. Returns the state after it, or throws with the reason. */
export async function verifyBlock(state: State, block: Block, now?: number): Promise<State> {
	const next = await checkBlock(state, block, now);
	await verifyCommit(state, block);
	return next;
}

/** Make a block and sign it with one validator. Final by itself only on a chain with a single validator;
    with more, the other signatures come from the agreement between validators (consensus.ts). */
export async function produceBlock(state: State, txs: Tx[], time: number, by: Signer, round = 0, skip = false): Promise<{ block: Block; state: State }> {
	const made = await makeBlock(state, txs, time, by.address, round, skip);
	const sig = await signVote(state.chain, 'precommit', made.block.height, round, made.state.last, by);
	if (!(await verify(by.address, voteMessage(state.chain, 'precommit', made.block.height, round, made.state.last), sig))) throw new Error('that secret does not belong to that validator');
	const block: Block = { ...made.block, commit: { round, sigs: [{ validator: by.address, sig }] } };
	keepReceipts(block, made.state);
	return { block, state: made.state };
}
/** the first round in which it is this validator's turn to make block `height` (-1: none within a few thousand) */
export function roundOf(state: State, height: number, who: string): number {
	if (!state.validators.includes(who)) return -1;
	const turn = turns(state, height);
	for (let r = 0; r < 4096; r++) if (turn(r) === who) return r;
	return -1;
}

/* A block travels whole between nodes, and is stored whole. So a validator fills it by size as well as by count: never
   past MAX_BLOCK_BYTES, which every node accepts (2,000,000) and every host can store, with room for the signatures. */
export const MAX_BLOCK_BYTES = HEART.sizeStart;
const SIZES = new WeakMap<object, number>(), utf8 = new TextEncoder();
export function txBytes(tx: Tx): number {
	let n = SIZES.get(tx);
	if (n === undefined) { const { side: _side, ...rest } = tx; SIZES.set(tx, (n = utf8.encode(JSON.stringify(rest)).length + 1 + (tx.type === 'blob.part' && Number.isSafeInteger(tx.data?.len) && (tx.data.len as number) > 0 ? Math.min(tx.data.len as number, RULES.maxPartChars) : 0))); } // a part weighs what its bytes do, whether or not they are here
	return n;
}
/** how many of these transactions, from the first, fit in one block: by count, size, and the gas their contract calls may use */
export function fits(txs: readonly Tx[], most: number, room: { bytes: number; gas: number; evm?: number } = { bytes: MAX_BLOCK_BYTES, gas: Infinity }): number {
	let n = 0, size = 0, gas = 0, evm = 0;
	for (const tx of txs) {
		if (n >= most) break;
		size += txBytes(tx);
		if (tx.type === 'contract.call' || tx.type === 'contract.deploy') { try { gas += gasLimitOf(tx.data); } catch { /* refused when applied */ } }
		if (tx.type === 'evm.run') evm += Number.isSafeInteger(tx.data?.gas) && (tx.data.gas as number) > 0 ? (tx.data.gas as number) : 0;
		if (size > room.bytes || gas > room.gas || (room.gas !== Infinity && evm > (room.evm ?? EVM_RULES.blockGas))) break;
		n++;
	}
	return n;
}
/** files travel in the cargo lane: never more than half of a block */
/** must these transactions' file bytes be here? Those of a block made lately (an old one may come without them) */
export const sidesMissing = (txs: readonly Tx[]) => txs.some((tx) => tx.type === 'blob.part' && tx.side === undefined);
/** a block without its files' bytes: it checks the same (nothing signed or fingerprinted is gone) */
export const bare = <T extends { txs: Tx[] }>(block: T): T => (block.txs.some((t) => t.side !== undefined) ? { ...block, txs: block.txs.map((t) => { if (t.side === undefined) return t; const { side: _s, ...rest } = t; return rest as Tx; }) } : block);
export const isCargo = (tx: Tx) => tx.type === 'blob.part';
export const cargoFits = (txs: readonly Tx[], bytes: number) => txs.reduce((n, tx) => n + (isCargo(tx) ? txBytes(tx) : 0), 0) * 2 <= bytes;
/** What a block takes from the waiting room: everyone else first, in the order they came, then files with what is left, at
    most half of the block. (An action left out for now simply waits; one that depended on it is skipped when the block is
    put together, and waits too.) */
/** the first that fit, and whatever later ones still fit in the room that is left (one too big for now waits, with all its
    account's later ones; it does not keep the others out) */
function pack(txs: readonly Tx[], most: number, room: { bytes: number; gas: number; evm?: number }): Tx[] {
	const n = fits(txs, most, room); if (n === txs.length) return txs.slice();
	const out = txs.slice(0, n), late = new Set<string>(), full = { bytes: room.bytes - bytesOf(out), gas: room.gas, evm: room.evm }; let looked = 0;
	for (const tx of txs.slice(n)) {
		if (out.length >= most || full.bytes < 200 || ++looked > 2_000) break;
		if (late.has(tx.from) || txBytes(tx) > full.bytes || tx.type === 'contract.call' || tx.type === 'contract.deploy' || tx.type === 'evm.run') { late.add(tx.from); continue; } // (computing is bounded by `fits`, at the front)
		out.push(tx); full.bytes -= txBytes(tx);
	}
	return out;
}
/** When not everything fits: who tips more for the room it takes goes first; the rest as they came. One account's own stay in order. */
function byTip(txs: readonly Tx[], room: { bytes: number; evm?: number }): Tx[] {
	const least = new Map<string, number>();
	return txs.map((tx, i): [Tx, number, number] => { const work = tx.type === 'evm.run' && room.evm ? (Number(tx.data?.gas) || 0) * (room.bytes / room.evm) : 0, own = (tx.tip ?? 0) / (txBytes(tx) + work), r = Math.min(own, least.get(tx.from) ?? Infinity); least.set(tx.from, r); return [tx, r, i]; }).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([tx]) => tx);
}
export function choose(txs: readonly Tx[], most: number, room: { bytes: number; gas: number; evm?: number }): Tx[] {
	const line = txs.filter((tx) => !isCargo(tx)), cargo = txs.filter(isCargo), first = fits(line, most, room) < line.length && line.some((tx) => tx.tip) ? byTip(line, room) : line;
	const out = pack(first, most, cargo.length ? { ...room, bytes: Math.max(room.bytes - Math.min(cargo.reduce((n, tx) => n + txBytes(tx), 0), Math.floor(room.bytes / 8)), 0) } : room); // files always get an eighth: a flood of payments never shuts them out
	let size = bytesOf(out), c = 0;
	for (const tx of cargo) { const n = txBytes(tx); if (out.length >= most || size + n > room.bytes || (c + n) * 2 > room.bytes) break; out.push(tx); size += n; c += n; }
	return out;
}
export const bytesOf = (txs: readonly Tx[]) => txs.reduce((n, tx) => n + txBytes(tx), 0);

/** Replay a whole chain from its genesis. Throws at the first block that breaks a rule. */
export async function replay(genesis: State, blocks: Block[]): Promise<State> {
	let s = plain(genesis); // a copy, changed only by committing each block into it: its fingerprint can be kept up to date
	seal(s);
	for (const b of blocks) {
		try { s = commit(await verifyBlock(s, b)); } catch (e) { unseal(s); throw new Error(`block ${b?.height}: ${(e as Error).message}`); }
	}
	unseal(s); // the caller may change it directly from here on
	return s;
}
