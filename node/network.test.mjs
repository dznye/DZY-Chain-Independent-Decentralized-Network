// A real network of four validators on this computer, talking over HTTP. No single one of them can make a block:
// each block needs three signatures. The test stops validators, restarts them, and checks that the chain keeps
// going when it should, waits when it must, and never splits. Run: node chain/node/network.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newKey } from '../src/crypto.ts';
import { balanceOf, DZY, RULES, signTx } from '../src/ledger.ts';
import { quorum, replay, signVote, verifyBlock } from '../src/block.ts';
import { startNode } from './server.mjs';

const CHAIN = 'dznye-net-test-1';
const auth = await newKey(), alice = await newKey(), bob = await newKey();
const keys = [await newKey(), await newKey(), await newKey(), await newKey()];
const validators = keys.map((k) => k.address);
const root = mkdtempSync(join(tmpdir(), 'dznye-net-'));
const timeouts = { propose: 500, vote: 250, grow: 150, gossip: 300, sync: 400 };
const nodes = [null, null, null, null], ports = [0, 0, 0, 0];
const boot = async (i) => {
	const n = await startNode({ port: ports[i], dataDir: join(root, 'v' + i), chain: CHAIN, authority: auth.address, validators, validator: keys[i], timeouts });
	ports[i] = n.port; nodes[i] = n; return n;
};
const wire = () => nodes.forEach((n, i) => { if (n) { n.net.peers.length = 0; ports.forEach((p, j) => { if (j !== i) n.net.peers.push('http://127.0.0.1:' + p); }); } });
const up = () => nodes.filter(Boolean);
const get = async (n, p) => (await fetch(n.url + p)).json();
const send = async (n, who, type, data) => {
	const r = await fetch(n.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(who.secret, { chain: CHAIN, from: who.address, nonce: (await get(n, '/account/' + who.address)).nextNonce, type, data }) }) });
	return { status: r.status, ...(await r.json()) };
};
const until = async (what, cond, ms = 15_000) => { const end = Date.now() + ms; for (;;) { if (await cond()) return; if (Date.now() > end) throw new Error('timed out waiting for: ' + what); await new Promise((r) => setTimeout(r, 60)); } };
const heights = () => Promise.all(up().map(async (n) => (await get(n, '/')).height));
const agreed = async (h) => { const infos = await Promise.all(up().map((n) => get(n, '/'))); return infos.every((i) => i.height >= h) && new Set(infos.filter((i) => i.height === infos[0].height).map((i) => i.last)).size === 1 && infos.every((i) => i.height === infos[0].height); };

let pass = 0;
const test = async (name, fn) => { const t = Date.now(); await fn(); pass++; console.log('ok  ', name, `(${((Date.now() - t) / 1000).toFixed(1)}s)`); };

try {
	for (let i = 0; i < 4; i++) await boot(i);
	wire();

	await test('four validators start; none of them is in charge', async () => {
		for (const n of up()) { const i = await get(n, '/'); assert.equal(i.role, 'validator'); assert.equal(i.needed, 3); assert.equal(i.height, 0); assert.deepEqual(i.validators, [...validators].sort()); }
		assert.equal(quorum(4), 3);
	});
	await test('a transaction sent to one validator ends up in a block that three or more signed, on all four', async () => {
		assert.equal((await send(nodes[2], auth, 'mint', { asset: 'DZY', to: alice.address, amount: 50 * DZY, reason: 'test grant' })).ok, true);
		await until('block 1 everywhere', () => agreed(1));
		for (const n of up()) {
			const b = await get(n, '/block/1');
			assert.ok(b.commit.sigs.length >= 3, 'block 1 has too few signatures');
			assert.ok(b.commit.sigs.every((s) => validators.includes(s.validator)));
			assert.equal((await get(n, '/account/' + alice.address)).balances.DZY, 50 * DZY);
		}
	});
	await test('transactions sent to different validators all land, in one agreed order', async () => {
		assert.equal((await send(nodes[0], alice, 'transfer', { asset: 'DZY', to: bob.address, amount: 20 * DZY })).ok, true);
		await until('alice\'s payment', async () => (await get(nodes[3], '/account/' + bob.address)).balances.DZY === 20 * DZY);
		assert.equal((await send(nodes[3], bob, 'transfer', { asset: 'DZY', to: alice.address, amount: 5 * DZY })).ok, true);
		assert.equal((await send(nodes[1], auth, 'mint', { asset: 'DZY', to: bob.address, amount: 1 * DZY, reason: 'second grant' })).ok, true);
		await until('everything settled', async () => (await Promise.all(up().map((n) => get(n, '/')))).every((i) => i.waiting === 0) && (await get(nodes[2], '/account/' + bob.address)).balances.DZY === 16 * DZY);
		await until('all four agree', async () => agreed((await heights())[0]));
	});
	await test('an outsider can replay the chain and check every validator signature', async () => {
		const genesis = await get(nodes[1], '/genesis'), blocks = (await get(nodes[1], '/blocks?from=1&limit=100')).blocks;
		const end = await replay(genesis, blocks);
		assert.equal(balanceOf(end, alice.address), 35 * DZY); assert.equal(balanceOf(end, bob.address), 16 * DZY);
		// a block with only one validator's signature is worth nothing
		const last = blocks.at(-1), before = await replay(genesis, blocks.slice(0, -1));
		await assert.rejects(verifyBlock(before, { ...last, commit: { round: last.commit.round, sigs: last.commit.sigs.slice(0, 1) } }), /not enough validators signed: 1 of the 3 needed/);
		await assert.rejects(verifyBlock(before, { ...last, commit: { round: last.commit.round, sigs: last.commit.sigs.slice(0, 2) } }), /2 of the 3 needed/);
	});
	let before;
	await test('one validator goes down: the other three carry on', async () => {
		before = (await heights())[0];
		await nodes[1].stop(); nodes[1] = null;
		for (let k = 0; k < 4; k++) { // enough blocks that the missing validator's turn to propose comes up and is skipped
			assert.equal((await send(nodes[0], alice, 'transfer', { asset: 'DZY', to: bob.address, amount: 1 * DZY })).ok, true);
			await until('a block without validator 1', async () => (await get(nodes[0], '/account/' + alice.address)).balances.DZY === (34 - k) * DZY, 20_000);
		}
		await until('the three agree', async () => agreed(before + 4));
	});
	await test('two down: the chain waits. It does not split, and nothing is lost', async () => {
		await nodes[3].stop(); nodes[3] = null;
		const h = (await heights())[0];
		assert.equal((await send(nodes[0], alice, 'transfer', { asset: 'DZY', to: bob.address, amount: 7 * DZY })).ok, true); // accepted, but it cannot be decided
		await new Promise((r) => setTimeout(r, 3500));
		const infos = await Promise.all(up().map((n) => get(n, '/')));
		assert.deepEqual(infos.map((i) => i.height), [h, h]); // two of four is not enough for a block
		assert.equal(new Set(infos.map((i) => i.last)).size, 1);
		assert.equal((await get(nodes[2], '/account/' + alice.address)).balances.DZY, 31 * DZY);
	});
	await test('one comes back: the chain resumes and the waiting payment goes through', async () => {
		const h = (await heights())[0];
		await boot(3); wire();
		await until('the waiting payment', async () => (await get(nodes[0], '/account/' + alice.address)).balances.DZY === 24 * DZY, 25_000);
		await until('three agree again', async () => agreed(h + 1));
	});
	await test('a validator that was away catches up from the others, checking every block', async () => {
		await boot(1); wire();
		await until('validator 1 caught up', async () => agreed((await get(nodes[0], '/')).height), 20_000);
		assert.equal((await get(nodes[1], '/account/' + bob.address)).balances.DZY, 27 * DZY);
		assert.equal((await send(nodes[1], bob, 'transfer', { asset: 'DZY', to: alice.address, amount: 2 * DZY })).ok, true); // and takes part again
		await until('all four settle', async () => (await get(nodes[2], '/account/' + bob.address)).balances.DZY === 25 * DZY && (await agreed(1)));
	});
	await test('a follower with no key copies the chain from any validator and verifies it', async () => {
		const f = await startNode({ port: 0, follow: nodes[2].url, followMs: 0 });
		try {
			const info = await get(nodes[2], '/');
			assert.equal(await f.sync(), info.height);
			assert.equal(f.core.state.last, info.last); assert.equal(f.core.alert, '');
			assert.equal((await get(f, '/')).role, 'follower');
			assert.equal((await fetch(f.url + '/consensus', { method: 'POST', body: '{}' })).status, 405); // it has no say in what gets decided
		} finally { await f.stop(); }
	});
	await test('messages from outsiders and forged votes change nothing', async () => {
		const h = (await get(nodes[0], '/')).height, eve = await newKey();
		const junk = [{ kind: 'vote', type: 'precommit', height: h + 1, round: 0, block: 'f'.repeat(64), from: eve.address, sig: 'ab'.repeat(64) }, { kind: 'vote', type: 'precommit', height: h + 1, round: 0, block: 'f'.repeat(64), from: validators[0], sig: 'ab'.repeat(64) }, { kind: 'proposal', height: h + 1, round: 0, validRound: -1, block: { height: h + 1 }, from: validators[1], sig: 'cd'.repeat(64) }, null, 'x', { kind: 'vote', height: -1 }];
		for (const msg of junk) for (const n of up()) assert.equal((await fetch(n.url + '/consensus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg }) })).status, 200);
		await new Promise((r) => setTimeout(r, 1500));
		assert.deepEqual(await heights(), [h, h, h, h]);
		assert.equal((await send(nodes[3], alice, 'transfer', { asset: 'DZY', to: bob.address, amount: 1 * DZY })).ok, true); // and the chain still works afterwards
		await until('one more block', () => agreed(h + 1));
	});
	await test('staking: the validators stake and take over; a fifth validator stakes in from standby; the chain carries on', async () => {
		const STAKE = RULES.minStake;
		for (const k of keys) assert.equal((await send(nodes[0], auth, 'mint', { asset: 'DZY', to: k.address, amount: 2 * STAKE, reason: 'stake grant' })).ok, true);
		await until('grants', async () => (await get(nodes[3], '/account/' + keys[3].address)).balances.DZY === 2 * STAKE, 30_000);
		for (let i = 0; i < 4; i++) assert.equal((await send(nodes[i], keys[i], 'stake.bond', { amount: STAKE })).ok, true);
		await until('staking takes over', async () => (await Promise.all(up().map((n) => get(n, '/')))).every((i) => i.staked), 30_000);
		// a fifth validator: its node knows the chain (the starting validators) and its peers, and waits on standby
		const k5 = await newKey(); keys.push(k5); ports.push(0); nodes.push(null);
		await boot(4); wire();
		assert.equal((await get(nodes[4], '/')).role, 'standby');
		await until('the newcomer has caught up', async () => (await get(nodes[4], '/')).height === (await get(nodes[0], '/')).height, 30_000);
		assert.equal((await send(nodes[1], auth, 'mint', { asset: 'DZY', to: k5.address, amount: 2 * STAKE, reason: 'stake grant' })).ok, true);
		await until('its grant', async () => (await get(nodes[4], '/account/' + k5.address)).balances.DZY === 2 * STAKE, 30_000);
		assert.equal((await send(nodes[4], k5, 'stake.bond', { amount: STAKE })).ok, true);
		await until('five validators, four needed', async () => (await Promise.all(up().map((n) => get(n, '/')))).every((i) => i.validators.length === 5 && i.needed === 4), 30_000);
		await until('the newcomer votes', async () => (await get(nodes[4], '/')).role === 'validator', 30_000);
		// with one of the five stopped, the other four (exactly enough) keep going, the newcomer among them
		await nodes[2].stop(); nodes[2] = null;
		const h = (await get(nodes[0], '/')).height;
		assert.equal((await send(nodes[4], alice, 'transfer', { asset: 'DZY', to: bob.address, amount: 1 * DZY })).ok, true);
		await until('a block made with the newcomer\'s signature', () => agreed(h + 1), 30_000);
		const b = await get(nodes[0], '/block/' + (h + 1));
		assert.ok(b.commit.sigs.some((s) => s.validator === k5.address), 'the newcomer signed');
		// the stopped validator restarts (its stored chain began from the same genesis, though the set has changed) and catches up
		await boot(2); wire();
		await until('validator 2 is back', async () => agreed((await get(nodes[0], '/')).height), 30_000);
		// a follower started now still checks everything from block 1, through every change of validators
		const f = await startNode({ port: 0, follow: nodes[4].url, followMs: 0 });
		try { assert.ok((await f.sync()) > 0); assert.equal(f.core.alert, ''); assert.equal(f.core.state.last, (await get(nodes[4], '/')).last); } finally { await f.stop(); }
	});
	await test('a validator that signs two different votes is caught by the others, punished on the chain, and loses its seat', async () => {
		const cheat = keys[0], h = (await get(nodes[1], '/')).height + 1;
		const before = (await get(nodes[1], '/validators')).stakes[cheat.address].bond;
		const vote = async (block) => ({ kind: 'vote', type: 'precommit', height: h, round: 0, block, from: cheat.address, sig: await signVote(CHAIN, 'precommit', h, 0, block, cheat) });
		for (const msg of [await vote('a'.repeat(64)), await vote('b'.repeat(64))]) await fetch(nodes[1].url + '/consensus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg }) });
		await until('the cheater is punished everywhere', async () => (await Promise.all(up().map((n) => get(n, '/validators')))).every((v) => v.stakes[cheat.address]?.tomb && !v.validators.includes(cheat.address)), 30_000);
		const after = (await get(nodes[1], '/validators')).stakes[cheat.address].bond;
		assert.equal(after, before - (before * RULES.slashPct) / 100);
		assert.equal((await get(nodes[0], '/')).role, 'standby'); // its own node sees it has no seat any more
		const h2 = (await get(nodes[1], '/')).height; // and the other four carry on
		assert.equal((await send(nodes[3], bob, 'transfer', { asset: 'DZY', to: alice.address, amount: 1 * DZY })).ok, true);
		await until('the chain goes on without it', async () => (await get(nodes[3], '/')).height > h2, 30_000);
	});
	console.log(`\n${pass} tests passed`);
} finally {
	for (const n of up()) await n.stop().catch(() => {});
	try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold the files for a moment */ }
}
