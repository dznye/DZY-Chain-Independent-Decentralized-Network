// Layers (zones.ts), written as attacks: an operator that invents money, spends what is not its own, hides its work, skips
// someone, or disappears; a user who takes out twice or lies about a balance. Through all of it a layer never pays out more
// than went in, and everyone gets their own coins back. Run: node zones.test.mjs
import assert from 'node:assert/strict';
import { newKey, sign } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';
import * as Z from './src/zones.ts';

let pass = 0, failed = 0;
const test = async (name, fn) => { const t = Date.now(); try { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : '', `(${Date.now() - t} ms)`); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 5).join(' | ')); } };
const DZY = 100_000_000, dzy = (n) => Math.round(n * DZY), SUPPLY = 12_000_000 * DZY, WAIT = 3_600_000;
const [F, OP, A, B, C, WATCH] = await Promise.all(Array.from({ length: 6 }, () => newKey()));
let chains = 0;
const send = async (s, k, type, data = {}) => { s.time += 1000; return L.applyTx(s, await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data }), s.time, F.address); };
const refused = async (s, k, type, data, why) => { const before = JSON.stringify(s); const t = s.time; await assert.rejects(() => send(s, k, type, data), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, w) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${w}: ${id} created or destroyed`); assert.equal(h.DZY, SUPPLY, w); };
const bal = (s, k, a = 'DZY') => L.balanceOf(s, k.address, a);
async function chain() {
	const name = `dznye-zones-t${++chains}`; L.testCrewFrom(name, 1); H.testHeartFrom(name, 2);
	const s = await L.sunGenesis({ chain: name, time: 1_800_000_000_000, validators: [F.address], seedWait: 0, sales: [F, OP, A, B, C, WATCH].map((k) => ({ to: k.address, units: dzy(1_000), paid: dzy(1_000) / 100, proof: 'test' })) });
	L.endBlock(s, 1, 0, F.address, s.time + 1000); s.height = 1; assert.ok(s.heart);
	return s;
}
async function layer(s, bond = 25) { await send(s, OP, 'layer.open', { name: 'Fast lane', kind: 'pay', ops: [OP.address], wait: WAIT, asset: 'DZY', bond: dzy(bond) }); return Object.keys(s.layers).at(-1); }
const signed = async (s, id, k, op) => ({ ...op, sig: await sign(k.secret, Z.opMessage(s.chain, id, { ...op, sig: '' })) });
const put = async (s, id, bk, k, n) => { await send(s, k, 'layer.deposit', { id, amount: dzy(n) }); bk.deposit({ to: k.address, amount: dzy(n) }); };
const pay = async (s, id, bk, from, to, n) => { const f = bk.where.get(from.address); bk.apply(await signed(s, id, from, { k: 't', f, t: bk.spotFor(to.address), a: dzy(n), n: bk.accts.get(f).nonce, to: to.address })); };
const take = async (s, id, bk, from, n) => { const f = bk.where.get(from.address); bk.apply(await signed(s, id, from, { k: 'w', f, a: dzy(n), n: bk.accts.get(f).nonce, to: from.address })); };
const post = async (s, id, bk, change = (x) => x) => { const b = bk.seal(); s.time += 20_000; await send(s, OP, 'layer.anchor', { id, ...change(b) }); return b.n; };

await test('A coin layer\'s whole life: deposits, hundreds of payments, withdrawals out after the wait, every coin accounted for', async () => {
	const s = await chain(), id = await layer(s), bk = new Z.ZoneBooks();
	await put(s, id, bk, A, 100); await put(s, id, bk, B, 50);
	for (let i = 0; i < 200; i++) await pay(s, id, bk, i % 2 ? B : A, i % 2 ? A : B, 0.1);
	await post(s, id, bk);
	await take(s, id, bk, A, 60); await pay(s, id, bk, B, C, 20); await take(s, id, bk, C, 20);
	const n = await post(s, id, bk);
	await refused(s, WATCH, 'layer.claim', { id, ...bk.claim(n, 0) }, /does not count yet/);
	s.time += WAIT + 1;
	const a0 = bal(s, A), c0 = bal(s, C);
	await send(s, WATCH, 'layer.claim', { id, ...bk.claim(n, 0) }); await send(s, WATCH, 'layer.claim', { id, ...bk.claim(n, 2) });
	assert.equal(bal(s, A) - a0, dzy(60)); assert.equal(bal(s, C) - c0, dzy(20));
	await refused(s, WATCH, 'layer.claim', { id, ...bk.claim(n, 0) }, /already paid/);
	await refused(s, WATCH, 'layer.claim', { id, ...bk.claim(n, 1) }, /takes nothing out/);
	assert.equal(s.layers[id].held, dzy(70)); whole(s, 'life');
	return '200 payments cost the main chain one transaction';
});
await test('Every kind of step can be proved, first, middle and last; proving pays the prover the asker\'s deposit', async () => {
	const s = await chain(), id = await layer(s), bk = new Z.ZoneBooks();
	await put(s, id, bk, A, 10); await put(s, id, bk, B, 10); await pay(s, id, bk, A, B, 1); await pay(s, id, bk, B, C, 2); await take(s, id, bk, C, 1);
	const n = await post(s, id, bk);
	let longest = 0;
	for (let i = 0; i < 5; i++) { await send(s, WATCH, 'layer.ask', { id, n, i }); const d = { id, ...bk.proof(n, i) }; longest = Math.max(longest, JSON.stringify(d).length); const b0 = bal(s, OP); await send(s, OP, 'layer.prove', d); assert.ok(bal(s, OP) - b0 > Z.ZONE.askDeposit - 100); }
	assert.equal(s.layers[id].asks, 0); whole(s, 'proved');
	await refused(s, OP, 'layer.prove', { id, ...bk.proof(n, 0) }, /nobody asked/);
	return `the longest proof is ${longest} characters`;
});

/** an operator's lie, put into a batch by hand */
async function lie(what, make) {
	await test(`An operator that ${what}: cannot prove it, loses its bond, and everyone gets their own coins back`, async () => {
		const s = await chain(), id = await layer(s, 30), bk = new Z.ZoneBooks();
		await put(s, id, bk, A, 100); await put(s, id, bk, B, 50); await post(s, id, bk);
		const good = { a: bk.exit(A.address), b: bk.exit(B.address) };
		const { b, proofs, count } = await make(s, id, bk);
		s.time += 20_000; await send(s, OP, 'layer.anchor', { id, n: 2, prev: bk.batches[0].root, ...b, count });
		await send(s, WATCH, 'layer.ask', { id, n: 2, i: 0 });
		for (const p of proofs) await refused(s, OP, 'layer.prove', { id, n: 2, i: 0, ...p }, /./);
		s.time += WAIT + 1; // its time runs out; and the batch would have counted by now
		for (const p of proofs) await refused(s, OP, 'layer.prove', { id, n: 2, i: 0, ...p }, /time to prove/);
		const w0 = bal(s, WATCH); await send(s, WATCH, 'layer.fail', { id, n: 2, i: 0 });
		assert.ok(bal(s, WATCH) - w0 >= dzy(15) + Z.ZONE.askDeposit - 100, 'the asker was not paid');
		await refused(s, OP, 'layer.anchor', { id, n: 2, prev: bk.batches[0].root, root: 'a'.repeat(64), steps: 'a'.repeat(64), count: 1 }, /stopped/);
		const a0 = bal(s, A), b0 = bal(s, B);
		await send(s, A, 'layer.exit', { id, ...good.a }); await send(s, B, 'layer.exit', { id, ...good.b });
		assert.ok(bal(s, A) - a0 > dzy(100) - 1000 && bal(s, B) - b0 > dzy(50) - 1000);
		await refused(s, A, 'layer.exit', { id, ...good.a }, /already/);
		assert.equal(s.layers[id].held, 0); whole(s, what);
	});
}
const forged = (op, prev, root, seen) => { const tree = Z.stepTree([Z.stepLeaf(0, op, root)]); return { b: { root, steps: tree.root }, proofs: [{ op, prev, root, path: tree.path(0), seen }], count: 1 }; };
await lie('gives itself coins nobody put in', async (s, id, bk) => { const prev = bk.root, seen = { mp: bk.unused().path, te: true, tp: bk.tree.path(3) }; return forged({ k: 'd', q: 2, i: 3 }, prev, 'e'.repeat(64), seen); });
await lie('uses the same deposit twice', async (s, id, bk) => { const prev = bk.root, x = bk.accts.get(1); return forged({ k: 'd', q: 0, i: 1 }, prev, 'e'.repeat(64), { mp: bk.unused().path, tb: x.bal, tn: x.nonce, tp: bk.tree.path(1) }); });
await lie('spends someone else\'s coins (a signature that is not theirs)', async (s, id, bk) => { const prev = bk.root, f = bk.where.get(A.address); bk.apply(await signed(s, id, OP, { k: 'w', f, a: dzy(100), n: 0, to: OP.address })); const st = bk.steps[0]; return forged(st.op, prev, st.root, st.seen); });
await lie('takes out more than an account holds', async (s, id, bk) => { const prev = bk.root, f = bk.where.get(B.address), op = await signed(s, id, B, { k: 'w', f, a: dzy(5_000), n: 0, to: B.address }); const x = bk.accts.get(f); return forged(op, prev, 'd'.repeat(64), { fo: x.owner, fb: dzy(9_000), fn: 0, fp: bk.tree.path(f) }); });
await lie('writes a state the step does not give', async (s, id, bk) => { const prev = bk.root, f = bk.where.get(A.address), op = await signed(s, id, A, { k: 't', f, t: 2, a: dzy(1), n: 0, to: B.address }); bk.apply(op); const st = bk.steps[0]; return forged(op, prev, 'c'.repeat(64), st.seen); });
await lie('repeats an old payment its owner signed once', async (s, id, bk) => { const f = bk.where.get(A.address), op = await signed(s, id, A, { k: 't', f, t: 2, a: dzy(1), n: 0, to: B.address }); bk.apply(op); const before = bk.steps[0]; void before; const prev = bk.batches[0].root; return { ...forged(op, bk.root, 'b'.repeat(64), bk.steps[0].seen), prev }; });
await lie('hides its work completely', async () => ({ b: { root: '1'.repeat(64), steps: '2'.repeat(64) }, proofs: [], count: 1 }));
await lie('lets one person pay themselves', async (s, id, bk) => { const f = bk.where.get(A.address), x = bk.accts.get(f), op = await signed(s, id, A, { k: 't', f, t: f, a: dzy(1), n: 0, to: A.address }); return forged(op, bk.root, '9'.repeat(64), { fo: x.owner, fb: x.bal, fn: 0, fp: bk.tree.path(f), tb: x.bal, tn: 0, tp: bk.tree.path(f) }); });

await lie('writes honest steps but a different state after them', async (s, id, bk) => { const op = await signed(s, id, A, { k: 't', f: bk.where.get(A.address), t: 2, a: dzy(1), n: 0, to: B.address }); bk.apply(op); const x = bk.seal(), p = bk.proof(2, 0); return { b: { root: '7'.repeat(64), steps: x.steps }, proofs: [p], count: 1 }; });
await test('Each rule of a step on its own, with everything else exactly right: only that rule can be what refuses it', async () => {
	const bk = new Z.ZoneBooks(), sig = 'f'.repeat(128);
	bk.deposit({ to: A.address, amount: 100 }); bk.deposit({ to: B.address, amount: 50 });
	const f = 1, x = bk.accts.get(f), prev = bk.root, fp = bk.tree.path(f), me = { fo: x.owner, fb: x.bal, fn: x.nonce, fp };
	const w = (o) => ({ k: 'w', f, a: 10, n: 0, to: A.address, sig, ...o });
	assert.equal(Z.applyStep(prev, w(), me, true, null), Z.rootFrom(Z.acctLeaf(x.owner, 90, 1), f, fp));
	assert.throws(() => Z.applyStep(prev, w(), me, false, null), /did not sign/);
	assert.throws(() => Z.applyStep(prev, w({ n: 1 }), me, true, null), /next step/);
	bk.apply(w()); const y = bk.accts.get(f), later = { fo: y.owner, fb: y.bal, fn: y.nonce, fp: bk.tree.path(f) };
	assert.throws(() => Z.applyStep(bk.root, w(), later, true, null), /next step/, 'an old signed step can be played again');
	assert.throws(() => Z.applyStep(prev, w({ a: 101 }), me, true, null), /hold that much/);
	assert.throws(() => Z.applyStep(prev, w(), { ...me, fb: 1_000 }, true, null), /not what it was/);
	const mid = Z.rootFrom(Z.acctLeaf(x.owner, 90, 1), f, fp); void mid;
	assert.throws(() => Z.applyStep(prev, { ...w(), k: 't', t: f }, { ...me, tb: 90, tn: 1, tp: fp }, true, null), /pay itself/);
	const b2 = new Z.ZoneBooks(); b2.deposit({ to: A.address, amount: 100 });
	const mp = b2.unused().path, acc = b2.accts.get(1), seen = { mp, tb: acc.bal, tn: acc.nonce, tp: null };
	seen.tp = (() => { const t = new Z.ZoneBooks(); t.deposit({ to: A.address, amount: 100 }); t.tree.set(0, Z.metaLeaf(1)); return t.tree.path(1); })();
	assert.throws(() => Z.applyStep(b2.root, { k: 'd', q: 0, i: 1 }, seen, false, { to: A.address, amount: 100 }), /in order, once each/, 'a deposit can be used twice');
	assert.throws(() => Z.applyStep(b2.root, { k: 'd', q: 1, i: 1 }, { ...seen, mp }, false, null), /no such deposit/);
});
await test('Nobody but its operators writes a layer\'s batches; none can be skipped, repeated or rewritten', async () => {
	const s = await chain(), id = await layer(s), bk = new Z.ZoneBooks(); await put(s, id, bk, A, 1);
	const b = bk.seal(); s.time += 20_000;
	await refused(s, A, 'layer.anchor', { id, ...b }, /only its operators/);
	await refused(s, OP, 'layer.anchor', { id, ...b, n: 2 }, /follows/); await refused(s, OP, 'layer.anchor', { id, ...b, prev: 'a'.repeat(64) }, /follows/);
	await refused(s, OP, 'layer.anchor', { id, ...b, count: 1_025 }, /count/);
	await send(s, OP, 'layer.anchor', { id, ...b }); await refused(s, OP, 'layer.anchor', { id, ...b }, /follows/);
});
await test('A forced withdrawal: an operator that leaves one person out must serve them or the layer stops', async () => {
	for (const serves of [true, false]) {
		const s = await chain(), id = await layer(s, 30), bk = new Z.ZoneBooks();
		await put(s, id, bk, A, 100); await put(s, id, bk, B, 50); await post(s, id, bk); s.time += WAIT + 1;
		const x = bk.exit(A.address), op = await signed(s, id, A, { k: 'w', f: x.at, a: dzy(100), n: x.nonce, to: A.address });
		await refused(s, A, 'layer.force', { id, op: await signed(s, id, B, { k: 'w', f: x.at, a: dzy(1), n: 0, to: A.address }), bal: x.bal, path: x.path }, /not signed/);
		await refused(s, B, 'layer.force', { id, op, bal: x.bal, path: x.path }, /not signed|not your account/);
		await send(s, A, 'layer.force', { id, op, bal: x.bal, path: x.path });
		await refused(s, WATCH, 'layer.fail', { id, at: x.at }, /still time/);
		if (serves) {
			bk.apply(op); const n = await post(s, id, bk); s.time += WAIT + 1;
			const y = bk.exit(A.address);
			await send(s, OP, 'layer.served', { id, at: y.at, bal: y.bal, nonce: y.nonce, path: y.path });
			const a0 = bal(s, A); await send(s, OP, 'layer.claim', { id, ...bk.claim(n, 0) }); assert.equal(bal(s, A) - a0, dzy(100));
			assert.equal(s.layers[id].dead, undefined);
		} else {
			await pay(s, id, bk, B, C, 1); await post(s, id, bk); s.time += 3 * WAIT + 1;
			await refused(s, OP, 'layer.served', { id, at: x.at, bal: x.bal, nonce: x.nonce, path: bk.exit(A.address).path }, /not moved/);
			const a0 = bal(s, A); await send(s, WATCH, 'layer.fail', { id, at: x.at }); assert.ok(bal(s, A) - a0 >= dzy(10), 'half the bond');
			const z = bk.exit(A.address); await send(s, A, 'layer.exit', { id, at: z.at, bal: z.bal, nonce: z.nonce, path: z.path });
			await send(s, B, 'layer.exit', { id, ...bk.exit(B.address) }); await send(s, C, 'layer.exit', { id, ...bk.exit(C.address) });
			assert.equal(s.layers[id].held, 0);
		}
		whole(s, 'force');
	}
});
await test('An operator that disappears: after 7 silent days anyone stops the layer; unused deposits go straight back', async () => {
	const s = await chain(), id = await layer(s), bk = new Z.ZoneBooks();
	await put(s, id, bk, A, 30); await post(s, id, bk); s.time += WAIT + 1;
	await send(s, B, 'layer.deposit', { id, amount: dzy(7) }); // never used
	await refused(s, WATCH, 'layer.freeze', { id }, /silent/); s.time += Z.ZONE.quiet;
	await send(s, WATCH, 'layer.freeze', { id });
	await refused(s, A, 'layer.refund', { id, q: 0, ...bk.unused() }, /was used/);
	const b0 = bal(s, B); await send(s, B, 'layer.refund', { id, q: 1, ...bk.unused() }); assert.ok(bal(s, B) - b0 > dzy(7) - 1000);
	await refused(s, B, 'layer.refund', { id, q: 1, ...bk.unused() }, /already/);
	const x = bk.exit(A.address);
	await refused(s, B, 'layer.exit', { id, ...x }, /not your account/); await refused(s, A, 'layer.exit', { id, ...x, bal: dzy(31) }, /not your account/);
	await send(s, A, 'layer.exit', { id, ...x }); assert.equal(s.layers[id].held, 0); whole(s, 'silent');
});
await test('A layer of any token, and app layers of anything: an app layer holds no coins; contracts read its newest state once it counts', async () => {
	const s = await chain();
	await send(s, A, 'asset.create', { symbol: 'GOLD', name: 'Gold', supply: 1_000, mintable: false, decimals: 0 }).catch(async () => send(s, A, 'asset.create', { symbol: 'GOLD', name: 'Gold', supply: 1_000 }));
	const gold = Object.keys(s.assets).find((k) => s.assets[k].symbol === 'GOLD');
	await send(s, OP, 'layer.open', { name: 'Gold lane', kind: 'pay', ops: [OP.address], wait: WAIT, asset: gold, bond: dzy(25) });
	const g = Object.keys(s.layers)[0]; await send(s, A, 'layer.deposit', { id: g, amount: 400 }); assert.equal(s.layers[g].held, 400); whole(s, 'gold');
	await refused(s, OP, 'layer.open', { name: 'App', kind: 'app', ops: [OP.address], wait: WAIT, asset: 'DZY' }, /holds no coins/);
	await send(s, OP, 'layer.open', { name: 'My game', kind: 'app', ops: [OP.address], wait: WAIT }); const id = Object.keys(s.layers)[1];
	await refused(s, A, 'layer.deposit', { id, amount: 5 }, /holds no coins/);
	await send(s, A, 'contract.deploy', { code: { functions: { r: { view: true, args: ['l'], body: ['layerroot', ['arg', 'l']] } } } }); const at = Object.keys(s.contracts)[0];
	const read = () => L.viewContract(s, at, 'r', [id], s.time).value, first = read(), root = 'ab'.repeat(32);
	await send(s, OP, 'layer.anchor', { id, n: 1, prev: s.layers[id].proot, root });
	assert.equal(read(), first, 'it counts before its wait is over'); s.time += WAIT + 1; assert.equal(read(), root);
	assert.equal(L.viewContract(s, at, 'r', ['nope'], s.time).value, null); whole(s, 'app');
});
await test('1,500 random actions, honest and hostile, on three layers at once: never a coin too many, never a layer below zero', async () => {
	const s = await chain(); let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
	const ids = [], books = [];
	for (let i = 0; i < 3; i++) { ids.push(await layer(s)); books.push(new Z.ZoneBooks()); }
	const P = [A, B, C], done = new Map(); let ok = 0, no = 0;
	for (let i = 0; i < 1_500; i++) {
		const j = rnd(3), id = ids[j], bk = books[j], x = P[rnd(3)], y = P[rnd(3)];
		try {
			switch (rnd(9)) {
				case 0: await put(s, id, bk, x, 1 + rnd(3)); break;
				case 1: case 2: if (x !== y && bk.where.has(x.address) && bk.waiting < 250) await pay(s, id, bk, x, y, 1 + rnd(2)); break;
				case 3: if (bk.where.has(x.address) && bk.waiting < 250) await take(s, id, bk, x, 1); break;
				case 4: if (bk.waiting) await post(s, id, bk); break;
				case 5: s.time += rnd(WAIT); break;
				case 6: { const n = 1 + rnd(Math.max(1, bk.n)), b = bk.batches[n - 1]; if (b) await send(s, WATCH, 'layer.claim', { id, ...bk.claim(n, rnd(b.steps.length)) }); break; }
				case 7: { const n = bk.n; if (n) { await send(s, WATCH, 'layer.ask', { id, n, i: 0 }); await send(s, OP, 'layer.prove', { id, ...bk.proof(n, 0) }); } break; }
				case 8: await send(s, x, 'layer.exit', { id, at: 1 + rnd(3), bal: dzy(1 + rnd(5)), nonce: rnd(3), path: bk.unused().path }); break;
			}
			ok++;
		} catch { no++; }
		if (i % 50 === 0) whole(s, 'step ' + i);
		for (const l of Object.values(s.layers)) assert.ok(l.held >= 0);
	}
	whole(s, 'random'); void done;
	return `${ok} done, ${no} refused`;
});
console.log(`\n${pass} tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
