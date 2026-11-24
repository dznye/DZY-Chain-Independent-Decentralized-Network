import { choose, fits, makeBlock, together, produceBlock, type Block, type Proposed, type Signer } from './block.ts';
import { maxTx, roomOf } from './heart.ts';
import { applyTx, isAddr, nonceOf, RULES, type State, type Tx } from './ledger.ts';
import { commit, fork, isLayer, parentOf, plain } from './layer.ts';

/* A validator's waiting room: it takes signed transactions, refuses invalid ones at the door, puts candidate blocks
   together, and moves on when a block is decided (its own or another validator's).
   It keeps nothing on disk; whoever runs it stores the blocks. One job runs at a time.

   Some rules depend on time (a pool's timetable, an agent key's end, a recovery's delay). So each batch gets one
   time, fixed when its first transaction arrives; every transaction in the batch is checked against that time and
   the block carries that same time. What was accepted at the door is then valid in the block, exactly. */
export class Sequencer {
	state: State; // after the newest decided block
	private pending: State; // the state plus everything waiting in the queue
	private queue: Tx[] = [];
	private batch = 0; // the time of the batch being gathered
	private by: Signer;
	private busy: Promise<unknown> = Promise.resolve();

	constructor(state: State, by: Signer) {
		this.state = isLayer(state) ? plain(state) : state; // a block state never committed (a test): start from a copy of it
		this.pending = fork(this.state);
		this.by = by;
	}

	private one<T>(job: () => Promise<T>): Promise<T> {
		const run = this.busy.then(job, job);
		this.busy = run.catch(() => {});
		return run;
	}

	get waiting() { return this.queue.length; }
	/** the state with everything waiting in it: for reading only */
	get ahead(): State { return this.pending; }
	/** the transactions still waiting, oldest first */
	get waitingTxs(): readonly Tx[] { return this.queue; }
	/** the last nonce this account has used, counting transactions still waiting for a block */
	pendingNonce(addr: string) { return nonceOf(this.pending, addr); }

	/** Accept a transaction for a coming block. Returns its id, or throws with the reason. */
	async submit(tx: Tx, now: number = Date.now()): Promise<string> {
		await together([tx]); // its signature first, beside others' (outside the line): a bad one is refused below, as before
		return this.one(async () => {
			// a full waiting room turns new arrivals away, so nobody can fill a validator's memory or disk
			if (this.queue.length >= (this.state.heart ? (tx?.tip ? 20_000 : 15_000) : RULES.maxWaiting)) throw new Error('This validator is busy. Try again in a moment.');
			if (tx?.type === 'blob.part' && typeof tx.side !== 'string') throw new Error('A file\'s part comes with its bytes (side)');
			const from = tx && typeof tx === 'object' && isAddr(tx.from) ? tx.from : '';
			if (from && nonceOf(this.pending, from) - nonceOf(this.state, from) >= RULES.maxWaitingPerSender) throw new Error(`At most ${RULES.maxWaitingPerSender} transactions from one account can wait for a block`);
			if (!this.queue.length) this.batch = Math.max(Math.floor(now), this.state.time);
			const id = await applyTx(this.pending, tx, this.batch);
			this.queue.push(tx);
			return id;
		});
	}

	/** what the next block takes from the waiting room: the oldest, as many as fit (by count and by size) */
	private next() { return this.state.heart ? choose(this.queue, maxTx(this.state), roomOf(this.state)) : this.queue.slice(0, fits(this.queue, maxTx(this.state), roomOf(this.state))); }
	/** A candidate for the next block, from what is waiting (possibly nothing). Changes nothing here. */
	propose(now: number = Date.now(), round = 0): Promise<{ block: Proposed; state: State }> {
		return this.one(() => makeBlock(this.state, this.next(), this.queue.length ? this.batch : Math.max(Math.floor(now), this.state.time), this.by.address, round, !!this.state.heart));
	}

	/** A block has been decided (ours or another validator's): it becomes the state. Waiting transactions that
	    are in it, or that it made invalid, are dropped; the rest start the next batch. */
	adopt(next: State, now: number = Date.now()): Promise<void> {
		return this.one(() => this.move(next, now));
	}
	private async move(next: State, now: number) {
		const rest = this.queue;
		const under = parentOf(next);
		next = under && isLayer(under) ? plain(next) : commit(next); // a block's state is a layer over ours: written into it, it becomes the state (layer.ts)
		this.state = next; this.pending = fork(next); this.queue = [];
		this.batch = Math.max(Math.floor(now), next.time);
		for (const tx of rest) {
			try { await applyTx(this.pending, tx, this.batch); this.queue.push(tx); } catch { /* already in a block, or no longer valid: drop it */ }
		}
	}

	/** On a chain with one validator: pack what is waiting into the next block, signed and final. Null when nothing waits
	    (on a chain with the Sun, an empty block is still made once the clock reaches a new minute: its minutes, and
	    everything they pay, pass only with a block). */
	produce(now: number = Date.now(), round = 0): Promise<Block | null> {
		return this.one(async () => {
			const newMinute = !!this.state.sun && Math.floor(now / 60_000) > this.state.sun.stamp;
			if (!this.queue.length && !newMinute) return null;
			const time = this.queue.length ? this.batch : Math.max(Math.floor(now), this.state.time);
			const { block, state } = await produceBlock(this.state, this.next(), time, this.by, round, !!this.state.heart);
			await this.move(state, now);
			return block;
		});
	}
}
