import { canon, merkleRoot, sha256, sign, verify } from './crypto.ts';
import { commit, fork, plain, seal, unseal } from './layer.ts';
import { applyTx, endBlock, powers, RULES, stateRoot, sunBlock, txMessage, voteMessage, type State, type Tx } from './ledger.ts';
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
export const proposerFor = (state: State, height: number, round: number) => state.validators[(height + round) % state.validators.length];

/** Put the next block together, in agreement round `round`. Every transaction must be valid, in order. The given state is not changed. */
export async function makeBlock(state: State, txs: Tx[], time: number, proposer: string, round = 0): Promise<{ block: Proposed; state: State }> {
	if (txs.length > RULES.maxTxPerBlock) throw new Error('too many transactions for one block');
	if (!Number.isSafeInteger(time) || time < state.time) throw new Error('block time cannot go backwards');
	if (!Number.isSafeInteger(round) || round < 0) throw new Error('bad round');
	if (!state.validators.includes(proposer)) throw new Error('this key is not a validator');
	if (proposerFor(state, state.height + 1, round) !== proposer) throw new Error("it is not this key's turn to make a block");
	const s = fork(state); // a layer: the given state is never changed, and nothing is copied that the block does not touch
	if (!s.started) s.started = time; // block 1 starts the clock for the pools
	for (const tx of txs) await applyTx(s, tx, time, proposer);
	endBlock(s, state.height + 1, round, proposer, time);
	await sunBlock(s, time, txs.length, proposer); // a chain with the Sun: the fee formula, the proposer's turn, and a chain minute when the clock reaches one
	const block: Proposed = { height: state.height + 1, prev: state.last, time, proposer, ...(round ? { round } : {}), txs, txRoot: await txRootOf(txs), stateRoot: await stateRoot(s) };
	s.height = block.height; s.time = time; s.last = await blockHash(state.chain, block);
	return { block, state: s };
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
	if (block.txs.length > RULES.maxTxPerBlock) throw new Error('too many transactions');
	const s = fork(state);
	if (!s.started) s.started = block.time;
	for (const tx of block.txs) await applyTx(s, tx, block.time, block.proposer);
	endBlock(s, block.height, round, block.proposer, block.time);
	await sunBlock(s, block.time, block.txs.length, block.proposer);
	if ((await txRootOf(block.txs)) !== block.txRoot) throw new Error('transactions do not match the block');
	if ((await stateRoot(s)) !== block.stateRoot) throw new Error('state does not match the block');
	s.height = block.height; s.time = block.time; s.last = await blockHash(state.chain, block);
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
export async function produceBlock(state: State, txs: Tx[], time: number, by: Signer): Promise<{ block: Block; state: State }> {
	const made = await makeBlock(state, txs, time, by.address);
	const sig = await signVote(state.chain, 'precommit', made.block.height, 0, made.state.last, by);
	if (!(await verify(by.address, voteMessage(state.chain, 'precommit', made.block.height, 0, made.state.last), sig))) throw new Error('that secret does not belong to that validator');
	return { block: { ...made.block, commit: { round: 0, sigs: [{ validator: by.address, sig }] } }, state: made.state };
}

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
