// Stress test for the agreement engine (src/consensus.ts). It runs thousands of simulated networks with random
// message delays and reordering, crashed validators, and a lying validator that tells different nodes different
// things. Two promises are checked on every run:
//   AGREEMENT    two honest validators never decide different blocks (must hold always)
//   TERMINATION  while fewer than a third are faulty, every honest validator that is still up decides
// Run: node chain/consensus.test.mjs
import assert from 'node:assert/strict';
import { Engine } from './src/consensus.ts';

const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** one simulated height. crash: Map(node → time it dies). liars: Set(node). calm: the time after which messages arrive quickly. */
function simulate({ n, seed, crash = new Map(), liars = new Set(), calm = 400, limit = 60_000, weights }) {
	const rnd = rng(seed), pick = (k) => Math.floor(rnd() * k);
	const names = Array.from({ length: n }, (_, i) => 'v' + String(i).padStart(2, '0'));
	const events = []; let now = 0, seq = 0; // a min-heap ordered by time, then by arrival
	const before = (a, b) => a.t < b.t || (a.t === b.t && a.seq < b.seq);
	const at = (t, e) => { let i = events.push({ t, seq: seq++, ...e }) - 1; while (i > 0) { const up = (i - 1) >> 1; if (!before(events[i], events[up])) break; [events[i], events[up]] = [events[up], events[i]]; i = up; } };
	const next = () => { const top = events[0], last = events.pop(); if (events.length) { events[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < events.length && before(events[l], events[m])) m = l; if (r < events.length && before(events[r], events[m])) m = r; if (m === i) break; [events[i], events[m]] = [events[m], events[i]]; i = m; } } return top; };
	const delay = () => (now < calm ? pick(calm * 2) : 1 + pick(25)); // chaos first, then a network that behaves
	const decided = new Map(), ids = new Set(['nothing']);
	const send = (from, to, m) => at(now + (from === to ? 0 : delay()), { to, m: { ...m, from: names[from] } });
	const dead = (i) => crash.has(i) && now >= crash.get(i);

	const power = weights ? Object.fromEntries(names.map((v, i) => [v, weights[i]])) : undefined; // each validator's say (its stake)
	const engines = names.map((me, i) => liars.has(i) ? null : new Engine(me, names, 1, {
		propose(round, id, vr) { const b = id ?? `block-by-${i}-round-${round}`; ids.add(b); for (let j = 0; j < n; j++) send(i, j, { k: 'p', round, id: b, vr }); },
		vote(type, round, id) { for (let j = 0; j < n; j++) if (j !== i) send(i, j, { k: 'v', type, round, id }); },
		timeout(step, round) { at(now + 80 + 60 * round, { to: i, timer: { step, round } }); },
		decide(id) { decided.set(i, id); for (let j = 0; j < n; j++) if (j !== i) at(now + delay(), { to: j, learn: id }); } // others can fetch a decided block with its proof
	}, undefined, power));

	// a liar reacts to whatever it hears by telling each honest node something different, once per round and kind
	const lied = new Set(), heard = new Set();
	const lie = (b, round) => {
		const list = [...ids];
		for (let j = 0; j < n; j++) {
			if (liars.has(j)) continue;
			const mark = (k) => { const key = `${b}:${j}:${round}:${k}`; if (lied.has(key)) return false; lied.add(key); return true; };
			if (mark('p')) { const id = `lie-${b}-${round}-${j % 2}`; ids.add(id); send(b, j, { k: 'p', round, id, vr: rnd() < 0.5 ? -1 : pick(round + 1) - 1 }); }
			for (const type of ['prevote', 'precommit']) if (mark(type)) { const id = list[pick(list.length)]; send(b, j, { k: 'v', type, round, id: id === 'nothing' ? null : id }); }
		}
	};

	engines.forEach((e) => e?.start(0));
	let steps = 0;
	while (events.length && steps++ < 3_000_000) {
		const e = next();
		now = Math.max(now, e.t);
		if (now > limit) break;
		if (dead(e.to)) continue;
		if (liars.has(e.to)) { if (e.m && !liars.has(names.indexOf(e.m.from))) for (let r = Math.max(0, e.m.round - 1); r <= e.m.round + 1; r++) lie(e.to, r); continue; } // liars react to honest nodes, not to each other
		const eng = engines[e.to];
		// honest nodes pass on every message the first time they see it (gossip), so all of them end up with the same evidence
		if (e.m) { const key = `${e.to}|${e.m.k}|${e.m.type}|${e.m.round}|${e.m.id}|${e.m.from}`; if (!heard.has(key)) { heard.add(key); for (let j = 0; j < n; j++) if (j !== e.to && names[j] !== e.m.from) at(now + delay(), { to: j, m: e.m }); } }
		if (e.learn) { if (!decided.has(e.to)) decided.set(e.to, e.learn); else assert.equal(decided.get(e.to), e.learn, 'a node learned a different decision than its own'); continue; }
		if (decided.has(e.to)) continue;
		if (e.timer) eng.onTimeout(e.timer.step, e.timer.round);
		else if (e.m.k === 'p') eng.onProposal(e.m.round, e.m.id, e.m.vr, e.m.from, true);
		else eng.onVote(e.m.type, e.m.round, e.m.id, e.m.from);
		const up = [...Array(n).keys()].filter((i) => !liars.has(i) && !dead(i));
		if (up.length && up.every((i) => decided.has(i))) break;
	}
	const honest = [...Array(n).keys()].filter((i) => !liars.has(i));
	return { values: new Set(honest.filter((i) => decided.has(i)).map((i) => decided.get(i))), everyoneUpDecided: honest.filter((i) => !crash.has(i)).every((i) => decided.has(i)), now };
}

let pass = 0;
const test = (name, fn) => { const t = Date.now(); fn(); pass++; console.log('ok  ', name, `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const runs = (count, make) => { let slowest = 0; for (let seed = 1; seed <= count; seed++) { const o = make(seed), r = simulate(o); assert.ok(r.values.size <= 1, `seed ${seed}: honest validators decided different blocks: ${[...r.values]}`); if (o.mustFinish) assert.ok(r.everyoneUpDecided && r.values.size === 1, `seed ${seed}: not every honest validator decided`); slowest = Math.max(slowest, r.now); } return slowest; };

test('4 validators, all honest, chaotic network: always one decision', () => { runs(400, (seed) => ({ n: 4, seed, mustFinish: true })); });
test('1 validator: decides alone at once', () => { const r = simulate({ n: 1, seed: 1 }); assert.equal(r.values.size, 1); assert.ok(r.everyoneUpDecided); });
test('4 validators, 1 crashes at a random moment: the other three still decide, and agree', () => {
	runs(600, (seed) => ({ n: 4, seed, crash: new Map([[seed % 4, (seed * 37) % 700]]), mustFinish: true }));
});
test('4 validators, 1 dead from the start (including when it is the first proposer)', () => {
	runs(200, (seed) => ({ n: 4, seed, crash: new Map([[seed % 4, 0]]), mustFinish: true }));
});
test('4 validators, 1 lying to everyone differently: the honest three still decide, and agree', () => {
	runs(800, (seed) => ({ n: 4, seed, liars: new Set([seed % 4]), mustFinish: true }));
});
test('7 validators, 2 faulty (one crashed, one lying): the honest ones decide, and agree', () => {
	runs(400, (seed) => ({ n: 7, seed, liars: new Set([seed % 7]), crash: new Map([[(seed + 3) % 7, (seed * 53) % 900]]), mustFinish: true }));
});
test('10 validators, 3 faulty: the honest ones decide, and agree', () => {
	runs(60, (seed) => ({ n: 10, seed, liars: new Set([seed % 10, (seed + 4) % 10]), crash: new Map([[(seed + 7) % 10, (seed * 29) % 900]]), mustFinish: true }));
});
test('too many down (2 of 4): the chain waits; it never forks', () => {
	for (let seed = 1; seed <= 300; seed++) {
		const r = simulate({ n: 4, seed, crash: new Map([[seed % 4, (seed * 11) % 300], [(seed + 1) % 4, (seed * 17) % 300]]), limit: 8000 });
		assert.ok(r.values.size <= 1, `seed ${seed}: fork`);
	}
});
test('a network that stays chaotic for a long time still ends in one decision once it calms down', () => {
	runs(150, (seed) => ({ n: 4, seed, calm: 3000, liars: new Set([seed % 4]), mustFinish: true }));
});
// votes weighted by stake: what matters is the share of the stake that is faulty, not the number of validators
test('weighted: one big validator (5 of 9) and four small; a small one lying or two small ones down: the rest decide, and agree', () => {
	const weights = [5, 1, 1, 1, 1]; // 9 in all: 7 must agree; faults up to 2 are tolerated
	runs(400, (seed) => ({ n: 5, seed, weights, liars: new Set([1 + (seed % 4)]), mustFinish: true }));
	runs(300, (seed) => ({ n: 5, seed, weights, crash: new Map([[1 + (seed % 4), (seed * 13) % 500], [1 + ((seed + 1) % 4), (seed * 7) % 500]]), mustFinish: true }));
});
test('weighted: three small validators down is three of five heads, but only 3 of 10 in stake: still decides', () => {
	runs(300, (seed) => ({ n: 5, seed, weights: [6, 1, 1, 1, 1], crash: new Map([[1, 0], [2, (seed * 3) % 400], [3, (seed * 7) % 400]]), mustFinish: true }));
});
test('weighted: the big validator down is one head but most of the stake: the chain waits, and never forks', () => {
	for (let seed = 1; seed <= 300; seed++) {
		const r = simulate({ n: 5, seed, weights: [5, 1, 1, 1, 1], crash: new Map([[0, (seed * 11) % 300]]), limit: 8000 });
		assert.ok(r.values.size <= 1, `seed ${seed}: fork`);
	}
});
test('weighted: 7 validators with uneven stakes, faulty ones holding under a third of the stake: they decide, and agree', () => {
	const weights = [9, 7, 5, 4, 3, 2, 2]; // 32 in all; faulty 2 + 3 = 5, under a third
	runs(300, (seed) => ({ n: 7, seed, weights, liars: new Set([5]), crash: new Map([[4, (seed * 19) % 700]]), mustFinish: true }));
});
test('a validator that restarts remembers its lock and its votes', () => {
	const sent = [];
	const out = { propose() {}, vote: (type, round, id) => sent.push([type, round, id]), timeout() {}, decide() {} };
	const names = ['v00', 'v01', 'v02', 'v03'];
	const a = new Engine('v03', names, 1, out); // height 1: round 0 proposer is v01, round 1 is v02
	a.start(0); a.onProposal(0, 'A', -1, 'v01', true);
	a.onVote('prevote', 0, 'A', 'v00'); a.onVote('prevote', 0, 'A', 'v01');
	assert.deepEqual(sent, [['prevote', 0, 'A'], ['precommit', 0, 'A']]); assert.equal(a.lockedId, 'A');
	// it restarts in round 1 and is offered a different block B: it must refuse, because it is locked on A
	sent.length = 0;
	const b = new Engine('v03', names, 1, out, a.memory);
	b.recall('prevote', 0, 'A'); b.recall('precommit', 0, 'A');
	b.start(1); b.onProposal(1, 'B', -1, 'v02', true);
	assert.deepEqual(sent, [['prevote', 1, null]]);
	// and it never votes twice in a place where it already voted
	b.onProposal(0, 'B', -1, 'v01', true);
	assert.equal(sent.length, 1);
});

console.log(`\n${pass} tests passed`);
