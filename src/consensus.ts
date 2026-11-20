import { quorum, type VoteType } from './block.ts';

/* How several validators agree on ONE block for one height, even when some are offline, slow, or lying.

   This is the Tendermint algorithm (Buchman, Kwon, Milosevic: "The latest gossip on BFT consensus", Algorithm 1).
   It works in rounds. In each round one validator, taking turns, proposes a block; everyone votes twice:
     prevote    "this block looks right to me"
     precommit  "I saw more than two thirds prevote it, so I am committed to it"
   A block is decided when more than two thirds precommit it. A validator that precommitted a block is LOCKED on
   it: in later rounds it refuses any other block unless it sees that more than two thirds moved on. That lock is
   what makes two different blocks at one height impossible while fewer than a third of the validators cheat.
   If a round fails (proposer offline, votes split), timeouts move everyone to the next round and proposer.

   Votes are counted by SAY, not by head: each validator carries a weight (its stake; 1 each when no weights are given),
   and "more than two thirds" means more than two thirds of the total weight.

   This file is only the decision logic: no network, no clock, no signatures, no blocks (just their ids). The host
   feeds it messages it has already checked and carries out what it asks. That keeps it small enough to test with
   thousands of hostile schedules (consensus.test.mjs). */

export type Step = 'propose' | 'prevote' | 'precommit';
export interface Out {
	/** It is our turn. Propose `id` again (a block we know is valid), or make a new block when `id` is null. */
	propose(round: number, id: string | null, validRound: number): void;
	/** Sign and send this vote. `id` null means "no block this round". */
	vote(type: VoteType, round: number, id: string | null): void;
	/** Call onTimeout(step, round) after the waiting time for that step. */
	timeout(step: Step, round: number): void;
	/** Agreement reached: block `id`, with the precommits of `round` as proof. */
	decide(id: string, round: number): void;
}
/** what a validator must remember across a restart so that it never contradicts itself */
export interface Memory { lockedId: string | null; lockedRound: number; validId: string | null; validRound: number }

interface RoundState {
	proposal?: { id: string; validRound: number; valid: boolean };
	prevotes: Votes;
	precommits: Votes;
	prevoteTimer: boolean;
	precommitTimer: boolean;
	sawPolka: boolean; // rule 36 has run for this round
}
/* Votes of one round and kind: validator → what it voted for. An honest validator votes once. A cheating one may
   send different votes to different nodes; as in the paper, each of its votes is counted for the block it names,
   so every honest node that eventually hears all the votes sees the same support for a block. (Safety does not
   depend on this: any two groups of more than two thirds share an honest validator, who voted only once.) */
type Votes = Map<string, Set<string | null>>;
const MAX_PER_VALIDATOR = 4; // a cheater cannot fill memory with endless different votes
const AHEAD = 50; // nor with votes for rounds far in the future: those are ignored until we get near them (hosts resend)

const put = (m: Votes, who: string, id: string | null) => {
	let v = m.get(who);
	if (!v) m.set(who, (v = new Set()));
	if (v.has(id) || v.size >= MAX_PER_VALIDATOR) return false;
	v.add(id); return true;
};
const named = (m: Votes) => { const ids = new Set<string>(); for (const v of m.values()) for (const id of v) if (id !== null) ids.add(id); return ids; };

export class Engine {
	round = -1;
	step: Step = 'propose';
	decided: string | null = null;
	lockedId: string | null;
	lockedRound: number;
	validId: string | null;
	validRound: number;
	readonly height: number;
	private me: string;
	private validators: string[];
	private out: Out;
	private need: number; // more than two thirds of the total say
	private skip: number; // more than one third of it: enough to know at least one honest validator is ahead
	private weight: (v: string) => number;
	private rounds = new Map<number, RoundState>();
	private validIds = new Set<string>(); // blocks we have checked ourselves and found valid

	constructor(me: string, validators: string[], height: number, out: Out, memory?: Memory, power?: Record<string, number>) {
		this.me = me; this.validators = validators; this.height = height; this.out = out;
		this.weight = (v) => (power && Object.hasOwn(power, v) ? power[v] : 1);
		const total = validators.reduce((n, v) => n + this.weight(v), 0);
		this.need = quorum(total);
		this.skip = Math.floor(total / 3) + 1;
		this.lockedId = memory?.lockedId ?? null; this.lockedRound = memory?.lockedRound ?? -1;
		this.validId = memory?.validId ?? null; this.validRound = memory?.validRound ?? -1;
	}

	/** the say of everyone who voted for `id` */
	private count(m: Votes, id: string | null) { let n = 0; for (const [v, ids] of m) if (ids.has(id)) n += this.weight(v); return n; }
	/** the say of these validators together */
	private weigh(who: Iterable<string>) { let n = 0; for (const v of who) n += this.weight(v); return n; }

	/** whose turn it is to propose in a round: validators take turns, in their agreed order */
	proposer(round: number) { return this.validators[(this.height + round) % this.validators.length]; }
	get memory(): Memory { return { lockedId: this.lockedId, lockedRound: this.lockedRound, validId: this.validId, validRound: this.validRound }; }
	get started() { return this.round >= 0; }

	private rs(round: number): RoundState {
		let s = this.rounds.get(round);
		if (!s) this.rounds.set(round, (s = { prevotes: new Map(), precommits: new Map(), prevoteTimer: false, precommitTimer: false, sawPolka: false }));
		return s;
	}

	start(round = 0) { if (!this.decided && round > this.round) { this.enter(round); this.run(); } }

	private enter(round: number) {
		this.round = round; this.step = 'propose';
		if (this.proposer(round) === this.me) this.out.propose(round, this.validId, this.validRound);
		else this.out.timeout('propose', round);
	}
	/** cast our own vote once per round and kind; a validator never votes twice in the same place */
	private cast(type: VoteType, id: string | null) {
		const mine = type === 'prevote' ? this.rs(this.round).prevotes : this.rs(this.round).precommits;
		if (mine.has(this.me)) return;
		put(mine, this.me, id);
		this.out.vote(type, this.round, id);
	}

	/** A proposal from `from`, already checked by the host: `valid` says whether the block itself follows the rules. */
	onProposal(round: number, id: string, validRound: number, from: string, valid: boolean) {
		if (this.decided || round < 0 || round > Math.max(this.round, 0) + AHEAD || from !== this.proposer(round)) return;
		const s = this.rs(round);
		if (s.proposal) return; // the first proposal of a round counts; a second, different one is cheating and is ignored
		s.proposal = { id, validRound, valid };
		if (valid) this.validIds.add(id);
		this.run();
	}
	/** A vote from validator `from`, signature already checked by the host. */
	onVote(type: VoteType, round: number, id: string | null, from: string) {
		if (this.decided || round < 0 || round > Math.max(this.round, 0) + AHEAD || !this.validators.includes(from)) return;
		const votes = type === 'prevote' ? this.rs(round).prevotes : this.rs(round).precommits;
		if (from === this.me && votes.has(from)) return; // our own vote is whatever we cast, nothing else
		if (put(votes, from, id)) this.run();
	}
	/** we already cast this vote before a restart: remember it so we never cast a different one */
	recall(type: VoteType, round: number, id: string | null) {
		const votes = type === 'prevote' ? this.rs(round).prevotes : this.rs(round).precommits;
		if (!votes.has(this.me)) put(votes, this.me, id);
	}
	onTimeout(step: Step, round: number) {
		if (this.decided || round !== this.round) return;
		if (step === 'propose' && this.step === 'propose') { this.cast('prevote', null); this.step = 'prevote'; }
		else if (step === 'prevote' && this.step === 'prevote') { this.cast('precommit', null); this.step = 'precommit'; }
		else if (step === 'precommit') this.enter(round + 1);
		else return;
		this.run();
	}

	/** apply every rule that now holds, until nothing changes (line numbers are those of the paper's Algorithm 1) */
	private run() {
		for (let guard = 0; guard < 1000; guard++) {
			if (this.decided) return;
			// 49: more than two thirds precommitted a block we know is valid, in any round → decided
			for (const [r, s] of this.rounds) {
				for (const id of named(s.precommits)) {
					if (this.validIds.has(id) && this.count(s.precommits, id) >= this.need) { this.decided = id; this.out.decide(id, r); return; }
				}
			}
			if (this.round < 0) return; // not taking part yet: only watching for a decision
			// 55: more than a third of the validators are already in a later round → join them
			let later = -1;
			for (const [r, s] of this.rounds) {
				if (r <= this.round) continue;
				const who = new Set([...s.prevotes.keys(), ...s.precommits.keys()]);
				if (s.proposal) who.add(this.proposer(r));
				if (this.weigh(who) >= this.skip && (later < 0 || r < later)) later = r;
			}
			if (later >= 0) { this.enter(later); continue; }

			const s = this.rs(this.round), p = s.proposal;
			// 22: a fresh proposal → prevote it if it is valid and we are not locked on something else
			if (this.step === 'propose' && p && p.validRound === -1) {
				this.cast('prevote', p.valid && (this.lockedRound === -1 || this.lockedId === p.id) ? p.id : null);
				this.step = 'prevote'; continue;
			}
			// 28: a re-proposal of a block that more than two thirds prevoted in an earlier round
			if (this.step === 'propose' && p && p.validRound >= 0 && p.validRound < this.round && this.count(this.rs(p.validRound).prevotes, p.id) >= this.need) {
				this.cast('prevote', p.valid && (this.lockedRound <= p.validRound || this.lockedId === p.id) ? p.id : null);
				this.step = 'prevote'; continue;
			}
			// 34: more than two thirds have prevoted something → give the rest a little time, then move on
			if (this.step === 'prevote' && this.weigh(s.prevotes.keys()) >= this.need && !s.prevoteTimer) { s.prevoteTimer = true; this.out.timeout('prevote', this.round); continue; }
			// 36: more than two thirds prevoted this round's valid proposal → lock on it and precommit
			if (p && p.valid && this.step !== 'propose' && !s.sawPolka && this.count(s.prevotes, p.id) >= this.need) {
				s.sawPolka = true;
				if (this.step === 'prevote') { this.lockedId = p.id; this.lockedRound = this.round; this.cast('precommit', p.id); this.step = 'precommit'; }
				this.validId = p.id; this.validRound = this.round;
				continue;
			}
			// 44: more than two thirds prevoted "no block" → precommit no block
			if (this.step === 'prevote' && this.count(s.prevotes, null) >= this.need) { this.cast('precommit', null); this.step = 'precommit'; continue; }
			// 47: more than two thirds have precommitted something → wait a little for a decision, then next round
			if (this.weigh(s.precommits.keys()) >= this.need && !s.precommitTimer) { s.precommitTimer = true; this.out.timeout('precommit', this.round); continue; }
			return;
		}
	}
}
