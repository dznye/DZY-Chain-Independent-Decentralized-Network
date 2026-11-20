// The state on disk one entry at a time (src/statestore.ts): after any blocks of random changes, the state read back
// is the same, key order included; a restart puts the fingerprint tree back (no re-hashing) and the chain carries on
// with the same fingerprints; a tree that does not fit is never used.
// Run: node chain/statestore.test.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { commit, fork, plain, seal } from './src/layer.ts';
import { RootCache, stateRootOf } from './src/root.ts';
import { loadState, loadTree, saveState, stateTables } from './src/statestore.ts';
import { stateRoot, sunGenesis } from './src/ledger.ts';
import { canon, newKey } from './src/crypto.ts';

globalThis.DZNYE_ROOT_CHECK = true; // every incremental fingerprint is checked against one computed from nothing
let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const V = await newKey(), A = await newKey();
const genesis = () => sunGenesis({ chain: 'dznye-store-test', time: Date.UTC(2026, 10, 17), validators: [V.address], seedWait: 0, sales: [{ to: A.address, units: 1_000 * 1e8, paid: 200 * 1e6, proof: 'test', lockYears: 2 }] });
let seed = 3; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
const KEYS = ['a1', 'b2', 'c3', '7', '42', '0', '100', 'zz', 'd4', '3', 'e5', 'f6'];
function op(s) {
	const k = KEYS[rnd(KEYS.length)], n = rnd(1000);
	switch (rnd(11)) {
		case 0: s.accounts[k] = { nonce: n, bal: { DZY: n * 10 } }; break;
		case 1: if (s.accounts[k]) s.accounts[k].bal.DZY = n; break;
		case 2: delete s.accounts[k]; break;
		case 3: (s.names ??= {})[k] = 'x' + n; break;
		case 4: if (s.names) { delete s.names[k]; if (!Object.keys(s.names).length) delete s.names; } break;
		case 5: (s.sun.events[String(n % 7)] ??= []).push({ k: 'x', a: k }); break;
		case 6: delete s.sun.events[String(n % 7)]; break;
		case 7: s.sun.credit.out[k] = { used: n, paid: 0, at: 0, due: 1, rate: 500 }; break;
		case 8: s.sun.minute += 1; break;
		case 9: (s.stakes ??= {})[k] = { bond: n }; break;
		default: if (s.stakes) delete s.stakes[k]; break;
	}
}
const order = (s) => ['accounts', 'names', 'stakes'].map((c) => c + ':' + Object.keys(s[c] ?? {}).join(',')).join(' | ') + ' | events:' + Object.keys(s.sun.events).join(',') + ' | credit:' + Object.keys(s.sun.credit.out).join(',');
const open = () => { const db = new DatabaseSync(':memory:'), q = (sql, ...a) => db.prepare(sql).all(...a); stateTables(q); return { db, q }; };

await test('300 blocks of random changes, saved row by row: what is read back is the same state, key order included, after every block', async () => {
	const { q } = open(); let rest = null;
	const base = plain(await genesis()); seal(base);
	for (let b = 1; b <= 300; b++) {
		const l = fork(base);
		for (let i = 0; i < 1 + rnd(8); i++) op(l);
		l.height = b;
		const root = await stateRoot(l);
		commit(l);
		saveState(q, base, root, (t) => { rest = t; });
		const back = loadState(q, () => rest);
		assert.equal(canon(back), canon(base), `block ${b}: the state read back differs`);
		assert.equal(order(back), order(base), `block ${b}: the key order read back differs`);
	}
});
await test('a restart: the saved tree is put back (no re-hashing), and the next blocks have the same fingerprints as without a restart', async () => {
	const { q } = open(); let rest = null;
	let base = plain(await genesis()); seal(base);
	const roots = [];
	for (let b = 1; b <= 120; b++) {
		if (b % 40 === 0) { // the node restarts here: everything comes from the database
			const back = loadState(q, () => rest);
			seal(back);
			assert.equal(await loadTree(q, back, roots[roots.length - 1]), true, `block ${b}: the saved tree was not put back`);
			base = back;
		}
		const l = fork(base);
		for (let i = 0; i < 1 + rnd(8); i++) op(l);
		l.height = b;
		const root = await stateRoot(l);
		assert.equal(root, await stateRootOf(plain(l), new RootCache()));
		roots.push(root);
		commit(l);
		saveState(q, base, root, (t) => { rest = t; });
	}
});
await test('a saved tree that does not give the last block\'s fingerprint is never used', async () => {
	const { q } = open(); let rest = null;
	const base = plain(await genesis()); seal(base);
	const l = fork(base); op(l); op(l); l.height = 1;
	const root = await stateRoot(l); commit(l); saveState(q, base, root, (t) => { rest = t; });
	q("UPDATE tree SET h = ? WHERE p = ''", 'f'.repeat(64)); // the top of the saved tree changed on disk
	const back = loadState(q, () => rest); seal(back);
	assert.equal(await loadTree(q, back, root), false);
	assert.equal(await stateRoot(back), root, 'computed from nothing, it is still right');
});
console.log(`\n${pass} tests passed`);
