// The state's fingerprint (src/root.ts): a warm cache and a cold one always agree; any change anywhere changes it; the
// order things were added in does not; a block costs work in proportion to what it changed.
// Run: node chain/root.test.mjs
import assert from 'node:assert/strict';
import { RootCache, stateRootOf } from './src/root.ts';
import { commit, fork, plain, seal } from './src/layer.ts';
import { sunGenesis } from './src/ledger.ts';
import { newKey } from './src/crypto.ts';
import { createHash } from 'node:crypto';

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const V = await newKey(), A = await newKey();
const base = () => sunGenesis({ chain: 'dznye-root-test', time: Date.UTC(2026, 10, 17), validators: [V.address], seedWait: 0, sales: [{ to: A.address, units: 1_000 * 1e8, paid: 200 * 1e6, proof: 'test', lockYears: 2 }] });
const addr = (i) => createHash('sha256').update('a' + i).digest('hex'); // spread like real addresses
let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };

await test('a warm cache and a cold one give the same root after every one of 300 random changes', async () => {
	const s = await base(), warm = new RootCache();
	for (let i = 0; i < 40; i++) s.accounts[addr(i)] = { nonce: 0, bal: { DZY: 1_000 + i } };
	for (let step = 0; step < 300; step++) {
		const k = rnd(9), a = addr(rnd(60));
		if (k === 0) s.accounts[a] = { nonce: rnd(5), bal: { DZY: rnd(1e6) } };
		else if (k === 1) delete s.accounts[a];
		else if (k === 2 && s.accounts[a]) s.accounts[a].bal.DZY = rnd(1e6);
		else if (k === 3) (s.names ??= {})['n' + rnd(30)] = a;
		else if (k === 4 && s.names) delete s.names['n' + rnd(30)];
		else if (k === 5) s.sun.worked[a] = rnd(1e5);
		else if (k === 6) s.sun.credit.out[a] = { used: rnd(1e5), paid: 0, at: 0, due: 1, rate: 500 };
		else if (k === 7) s.sun.minute += 1;           // the rest of the state
		else s.fee = 1 + rnd(5);
		assert.equal(await stateRootOf(s, warm), await stateRootOf(s), `step ${step}`);
	}
});
await test('any change anywhere changes the root, and undoing it brings the same root back', async () => {
	const s = await base(), r0 = await stateRootOf(s);
	const flips = [
		() => { s.accounts[A.address].nonce += 1; }, () => { s.accounts[A.address].nonce -= 1; },
		() => { s.sun.minute += 1; }, () => { s.sun.minute -= 1; },
		() => { s.sun.credit.bad[A.address] = 1; }, () => { delete s.sun.credit.bad[A.address]; },
		() => { s.sun.credit.day += 1; }, () => { s.sun.credit.day -= 1; },
		() => { s.validators.push(A.address); }, () => { s.validators.pop(); },
	];
	const warm = new RootCache(); await stateRootOf(s, warm);
	for (let i = 0; i < flips.length; i += 2) {
		flips[i](); const r = await stateRootOf(s, warm);
		assert.notEqual(r, r0, `change ${i / 2} did not change the root`); assert.equal(r, await stateRootOf(s));
		flips[i + 1](); assert.equal(await stateRootOf(s, warm), r0, `undoing change ${i / 2} did not restore the root`);
	}
});
await test('the same key in two collections are two different leaves; the order of adding does not matter', async () => {
	const s1 = await base(), s2 = await base(), k = addr(5);
	s1.sun.worked[k] = 3; const one = await stateRootOf(s1);
	s2.sun.free[k] = 3; assert.notEqual(await stateRootOf(s2), one);
	const a = await base(), b = await base();
	for (let i = 0; i < 50; i++) a.accounts[addr(i)] = { nonce: i, bal: {} };
	for (let i = 49; i >= 0; i--) b.accounts[addr(i)] = { nonce: i, bal: {} };
	assert.equal(await stateRootOf(a), await stateRootOf(b));
});
await test('with 200,000 accounts, a block (a layer over the sealed live state) that changes 500 of them re-hashes only those', async () => {
	const s = await base(), warm = new RootCache();
	for (let i = 0; i < 200_000; i++) s.accounts[addr(i)] = { nonce: 1, bal: { DZY: 5_000 } };
	seal(s);
	let t = performance.now(); await stateRootOf(s, warm); const cold = performance.now() - t;
	const ms = [];
	for (let b = 0; b < 3; b++) {
		const l = fork(s);
		for (let i = 0; i < 500; i++) l.accounts[addr(rnd(200_000))].bal.DZY += 1;
		t = performance.now(); const r = await stateRootOf(l, warm); ms.push(Math.round(performance.now() - t));
		assert.equal(r, await stateRootOf(plain(l)));
		commit(l);
	}
	assert.ok(Math.max(...ms) < cold / 20, `a block took ${ms} ms; from nothing ${cold} ms`);
	return `from nothing ${Math.round(cold)} ms; blocks of 500 changes ${ms.join(', ')} ms`;
});
