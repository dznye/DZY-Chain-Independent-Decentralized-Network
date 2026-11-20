// State layers (src/layer.ts): a layer behaves exactly like a plain copy, key order included; its base is untouched
// until commit; commit makes the base equal to the layer; sibling layers do not see each other; and the fingerprint of
// a layer, computed incrementally, is always the one computed from nothing.
// Run: node chain/layer.test.mjs
import assert from 'node:assert/strict';
import { changes, commit, fork, plain, seal } from './src/layer.ts';
import { RootCache, stateRootOf } from './src/root.ts';
import { sunGenesis } from './src/ledger.ts';
import { canon, newKey } from './src/crypto.ts';

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const V = await newKey(), A = await newKey();
const genesis = () => sunGenesis({ chain: 'dznye-layer-test', time: Date.UTC(2026, 10, 17), validators: [V.address], seedWait: 0, sales: [{ to: A.address, units: 1_000 * 1e8, paid: 200 * 1e6, proof: 'test', lockYears: 2 }] });
let seed = 1; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
const KEYS = ['a1', 'b2', 'c3', '7', '42', '0', '100', 'zz', 'd4', '3'];
// one random change, made the same way on any state (plain or layer); returns what a read saw, to compare
function op(s) {
	const k = KEYS[rnd(KEYS.length)], n = rnd(1000);
	switch (rnd(14)) {
		case 0: s.accounts[k] = { nonce: n, bal: { DZY: n * 10 } }; return 'set';
		case 1: if (s.accounts[k]) s.accounts[k].bal.DZY = n; return 'nested';
		case 2: delete s.accounts[k]; return 'del';
		case 3: return JSON.stringify(s.accounts[k] ?? null);
		case 4: return Object.keys(s.accounts).join(',');
		case 5: (s.names ??= {})[k] = 'x' + n; return 'name';
		case 6: if (s.names) { delete s.names[k]; if (!Object.keys(s.names).length) delete s.names; } return 'unname';
		case 7: (s.sun.events[String(n % 7)] ??= []).push({ k: 'x', a: k }); return 'event';
		case 8: delete s.sun.events[String(n % 7)]; return 'unevent';
		case 9: s.sun.credit.out[k] = { used: n, paid: 0, at: 0, due: 1, rate: 500 }; return 'credit';
		case 10: s.sun.minute += 1; s.sun.credit.day = n; return 'rest';
		case 11: s.fee = 1 + (n % 5); return 'fee';
		case 12: return Object.entries(s.sun.events).map(([a, b]) => a + ':' + b.length).join(',');
		default: return 'in:' + (k in s.accounts) + Object.hasOwn(s.accounts, k);
	}
}
const same = (a, b, at) => {
	assert.equal(canon(a), canon(b), at); // the same contents (the state's own field order does not matter: nothing walks it)
	for (const p of [['accounts'], ['names'], ['sun', 'events'], ['sun', 'credit', 'out'], ['sun', 'locks']]) { // the order inside every collection must match
		const x = p.reduce((o, q) => o?.[q], a), y = p.reduce((o, q) => o?.[q], b);
		assert.deepEqual(x && Object.keys(x), y && Object.keys(y), at + ' keys of ' + p.join('.'));
		if (x) for (const k of Object.keys(x)) assert.equal(JSON.stringify(x[k]), JSON.stringify(y[k]), at + ' ' + p.join('.') + '.' + k);
	}
};

await test('a layer behaves exactly like a plain copy (contents and key order), over 40 runs of 150 random changes; commit makes the base the same', async () => {
	for (let run = 0; run < 40; run++) {
		const base = await genesis();
		for (let i = 0; i < 20; i++) op(base);
		const before = JSON.stringify(base), ref = structuredClone(base), layer = fork(base);
		for (let i = 0; i < 150; i++) { const s0 = seed, a = op(ref); seed = s0; const b = op(layer); assert.equal(b, a, `run ${run} step ${i}: a read differs`); }
		same(plain(layer), ref, `run ${run}: layer`);
		assert.equal(JSON.stringify(base), before, `run ${run}: the base changed before commit`);
		const done = commit(layer);
		assert.equal(done, base);
		same(base, ref, `run ${run}: after commit`);
	}
});
await test('siblings do not see each other; a layer of a layer works; only one of two siblings can be committed', async () => {
	const base = await genesis(); seal(base);
	const x = fork(base), y = fork(base);
	x.accounts.k1 = { nonce: 1, bal: {} }; y.accounts.k2 = { nonce: 2, bal: {} };
	assert.ok(!('k2' in x.accounts) && !('k1' in y.accounts));
	const z = fork(x); z.accounts.k3 = { nonce: 3, bal: {} }; delete z.accounts.k1;
	assert.deepEqual(Object.keys(plain(z).accounts).filter((k) => k.startsWith('k')), ['k3']);
	assert.ok('k1' in x.accounts, 'a layer of a layer changed the layer under it');
	commit(x);
	assert.throws(() => commit(y), /older version/);
	assert.ok('k1' in base.accounts && !('k2' in base.accounts));
});
await test('changes() lists only content changes: a read, or writing back the same value, is not a change', async () => {
	const base = await genesis(), l = fork(base);
	void l.accounts[A.address]; l.accounts[A.address].nonce = l.accounts[A.address].nonce; // read and written back the same
	l.accounts.n1 = { nonce: 0, bal: {} };
	delete l.sun.locks[A.address];
	assert.deepEqual(changes(l).map(([c, k]) => c + ':' + k).sort(), ['account:n1', 'sun.lock:' + A.address].sort());
});
await test('the incremental fingerprint always equals the full one: 60 blocks, each a layer over a sealed base, with sibling candidates', async () => {
	const base = await genesis(); seal(base);
	for (let i = 0; i < 30; i++) op(base);
	const warm = new RootCache();
	await stateRootOf(base, warm);
	for (let b = 0; b < 60; b++) {
		const cands = [fork(base), fork(base), fork(base)];
		for (const c of cands) { for (let i = 0; i < 1 + rnd(12); i++) op(c); assert.equal(await stateRootOf(c, warm), await stateRootOf(plain(c)), `block ${b}`); }
		const win = cands[rnd(3)];
		commit(win);
		assert.equal(await stateRootOf(base, warm), await stateRootOf(plain(base)), `block ${b} after commit`);
	}
});
console.log(`\n${pass} tests passed`);
