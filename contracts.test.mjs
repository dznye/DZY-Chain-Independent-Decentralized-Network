// Contracts and the second layer (payment channels), written as attacks like the other tests.
// Run: node chain/contracts.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canon, newKey, sign } from './src/crypto.ts';
import { applyTx, balanceOf, channelMessage, contractAddress, DZY, genesis, holdings, nonceOf, RULES, signTx, stateRoot, viewContract } from './src/ledger.ts';
import { produceBlock, replay } from './src/block.ts';
import { LIMITS } from './src/contracts.ts';

const CHAIN = 'dznye-contracts-test';
const auth = await newKey(), alice = await newKey(), bob = await newKey(), eve = await newKey();
const prog = (name) => JSON.parse(readFileSync(new URL(`./contracts/${name}.json`, import.meta.url), 'utf8'));
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const refuses = async (s, t, why, time) => { const before = canon(s); await assert.rejects(applyTx(s, await t, time), why); assert.equal(canon(s), before, 'a refused transaction must change nothing'); };
/** a call that fails while running: it is accepted and pays its gas, the failure is recorded on the contract, and
    nothing else changes (only the sender's nonce, any fee, and the contract's list of events) */
const fails = async (s, t, why, time) => {
	const tx = await t, at = tx.data.contract, before = structuredClone(s), rep = {};
	await applyTx(s, tx, time, undefined, rep);
	assert.match(rep.failed ?? '(it did not fail)', why);
	assert.ok(rep.gasUsed > 0, 'a failed call still used gas');
	const after = structuredClone(s);
	after.accounts[tx.from].nonce = before.accounts[tx.from]?.nonce ?? 0;
	if (!before.accounts[tx.from]) delete after.accounts[tx.from];
	assert.equal(after.contracts[at].events.at(-1).failed, rep.failed); assert.equal(after.contracts[at].events.at(-1).by, tx.from);
	after.contracts[at].events = before.contracts[at].events; if (!after.contracts[at].events) delete after.contracts[at].events;
	if (rep.fee) { after.accounts[tx.payer ?? tx.from].bal.DZY = before.accounts[tx.payer ?? tx.from].bal.DZY; after.treasury = before.treasury; if (after.treasury === undefined) delete after.treasury; }
	assert.equal(canon(after), canon(before), 'a call that failed while running must change nothing else');
};
const balanced = (s) => { const h = holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `supply of ${id}`); assert.equal(s.assets.DZY.supply, s.assets.DZY.minted); };
/** a chain where alice, bob and eve hold DZY */
const world = async (fee = 0) => {
	const s = await genesis(CHAIN, auth.address, 1000, [auth.address], fee);
	for (const k of [alice, bob, eve]) await applyTx(s, await tx(s, auth, 'mint', { asset: 'DZY', to: k.address, amount: 100 * DZY }), 1000);
	return s;
};
const deploy = async (s, who, code, time = 1000, gas) => contractAddress(await applyTx(s, await tx(s, who, 'contract.deploy', { code, ...(gas ? { gas } : {}) }), time));
const call = async (s, who, at, fn, args = [], extra = {}, time = 1000) => applyTx(s, await tx(s, who, 'contract.call', { contract: at, fn, args, ...extra }), time);
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };

await test('deploying: a broken or hostile program is refused before it is stored', async () => {
	const s = await world();
	const bad = [
		{}, { functions: {} }, { functions: { 'bad name!': { body: 1 } } }, { functions: { f: { body: ['steal', 1] } } },
		{ functions: { f: { body: ['__proto__'] } } }, { functions: { f: { args: [1], body: 1 } } }, { functions: { f: { view: 'yes', body: 1 } } },
		{ functions: { f: { body: Array.from({ length: 70 }).reduce((e) => ['not', e], true) } } } // nested too deeply
	];
	for (const code of bad) await refuses(s, tx(s, alice, 'contract.deploy', { code }), /program|function|operation|whole numbers|arguments|nests|expression|view/);
	const huge = { functions: { f: { body: ['str', 'x'.repeat(13_000)] } } };
	await refuses(s, tx(s, alice, 'contract.deploy', { code: huge }), /too big|at most/);
	await assert.rejects(tx(s, alice, 'contract.deploy', { code: { functions: { f: { body: 1.5 } } } }), /whole numbers/); // a fraction cannot even be signed
	const broke = await newKey();
	await refuses(s, tx(s, broke, 'contract.deploy', { code: prog('escrow') }), /costs 1 DZY/);
	const at = await deploy(s, alice, prog('escrow'));
	assert.equal(s.contracts[at].creator, alice.address);
	assert.equal(s.treasury, RULES.deployFee); // the charge goes to the treasury: nothing destroyed
	balanced(s);
});

await test('an endless loop runs out of gas, and a failed call changes nothing (including coins it was sent)', async () => {
	const s = await world();
	const at = await deploy(s, alice, { functions: {
		spin: { body: ['for', 'i', 0, 999, ['for', 'j', 0, 999, ['set', 'x', ['var', 'j']]]] },
		picky: { body: ['seq', ['set', 'touched', true], ['transfer', 'DZY', ['caller'], 1], ['require', false, 'no thanks']] }
	} });
	await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'spin', gas: LIMITS.maxGas }), /out of gas/);
	await refuses(s, tx(s, bob, 'contract.call', { contract: at, fn: 'spin', gas: LIMITS.maxGas + 1 }), /gas must be/);
	await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'picky', pay: { asset: 'DZY', amount: 5 * DZY } }), /no thanks/);
	assert.equal(balanceOf(s, at), 0); assert.equal(s.contracts[at].entries, 0);
	await refuses(s, tx(s, bob, 'contract.call', { contract: at, fn: 'nope' }), /no function/);
	await refuses(s, tx(s, bob, 'contract.call', { contract: 'f'.repeat(64), fn: 'spin' }), /no such contract/);
	await refuses(s, tx(s, bob, 'contract.call', { contract: at, fn: 'picky', args: [{ sneaky: 1 }] }), /an argument must be/);
	await refuses(s, tx(s, bob, 'contract.call', { contract: at, fn: 'picky', pay: { asset: 'DZY', amount: 10_000 * DZY } }), /not enough/);
});

await test('escrow: the buyer pays in; only the buyer or the arbiter releases, only the seller or the arbiter refunds', async () => {
	const s = await world(), arbiter = eve;
	const at = await deploy(s, alice, prog('escrow'));
	await fails(s, tx(s, alice, 'contract.call', { contract: at, fn: 'open', args: [bob.address, arbiter.address] }), /send the DZY/);
	await call(s, alice, at, 'open', [bob.address, arbiter.address], { pay: { asset: 'DZY', amount: 10 * DZY } });
	assert.equal(balanceOf(s, at), 10 * DZY); assert.equal(balanceOf(s, alice.address), 89 * DZY); // 100 - 1 to deploy - 10 held
	assert.equal(viewContract(s, at, 'status', []).value, 'held ' + 10 * DZY);
	await fails(s, tx(s, alice, 'contract.call', { contract: at, fn: 'open', args: [bob.address, arbiter.address], pay: { asset: 'DZY', amount: 1 } }), /already open/);
	await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'release' }), /only the buyer or the arbiter/); // the seller cannot pay himself
	await fails(s, tx(s, alice, 'contract.call', { contract: at, fn: 'refund' }), /only the seller or the arbiter/); // nor the buyer take it back alone
	await call(s, arbiter, at, 'release');
	assert.equal(balanceOf(s, bob.address), 110 * DZY); assert.equal(balanceOf(s, at), 0);
	await fails(s, tx(s, arbiter, 'contract.call', { contract: at, fn: 'release' }), /nothing is held/); // not twice
	balanced(s);
});

await test('crowdfund: pledges by a deadline; the creator collects if the goal is met, otherwise everyone takes theirs back', async () => {
	for (const reached of [true, false]) {
		const s = await world(), t0 = 2000, deadline = t0 + 10_000;
		const at = await deploy(s, alice, prog('crowdfund'), t0);
		await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'setup', args: [50 * DZY, deadline] }), /only the creator/, t0);
		await call(s, alice, at, 'setup', [50 * DZY, deadline], {}, t0);
		await call(s, bob, at, 'give', [], { pay: { asset: 'DZY', amount: 30 * DZY } }, t0 + 1);
		await call(s, eve, at, 'give', [], { pay: { asset: 'DZY', amount: (reached ? 25 : 5) * DZY } }, t0 + 2);
		assert.equal(viewContract(s, at, 'pledged', [bob.address]).value, 30 * DZY);
		await fails(s, tx(s, eve, 'contract.call', { contract: at, fn: 'give', pay: { asset: 'DZY', amount: 1 } }), /deadline has passed/, deadline);
		await fails(s, tx(s, alice, 'contract.call', { contract: at, fn: 'claim' }), /wait for the deadline/, deadline - 1);
		if (reached) {
			await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'refund' }), /goal was reached/, deadline);
			await call(s, alice, at, 'claim', [], {}, deadline);
			assert.equal(balanceOf(s, alice.address), (100 - 1 + 55) * DZY); // minus the deploy charge, plus everything given
		} else {
			await fails(s, tx(s, alice, 'contract.call', { contract: at, fn: 'claim' }), /goal was not reached/, deadline);
			await call(s, bob, at, 'refund', [], {}, deadline);
			await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'refund' }), /took it back already/, deadline); // not twice
			await call(s, eve, at, 'refund', [], {}, deadline);
			assert.equal(balanceOf(s, bob.address), 100 * DZY); assert.equal(balanceOf(s, eve.address), 100 * DZY);
		}
		assert.equal(balanceOf(s, at), 0);
		balanced(s);
	}
});

await test('vault: coins locked until a time; nobody, the owner included, takes them out early', async () => {
	const s = await world(), until = 50_000;
	const at = await deploy(s, alice, prog('vault'));
	await call(s, alice, at, 'lock', [until], { pay: { asset: 'DZY', amount: 20 * DZY } });
	await fails(s, tx(s, alice, 'contract.call', { contract: at, fn: 'withdraw' }), /still locked/, until - 1);
	await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'withdraw' }), /only the owner/, until);
	await call(s, alice, at, 'withdraw', [], {}, until);
	assert.equal(balanceOf(s, alice.address), 99 * DZY);
});

await test('views read without changing anything; a view that tries to write is stopped; storage keys are guarded', async () => {
	const s = await world();
	const at = await deploy(s, alice, { functions: {
		peek: { view: true, body: ['get', 'n', 0] }, sneaky: { view: true, body: ['set', 'n', 1] }, bump: { body: ['set', 'n', ['+', ['get', 'n', 0], 1]] },
		proto: { body: ['set', '__proto__', 1] }
	} });
	await call(s, bob, at, 'bump'); await call(s, bob, at, 'bump');
	assert.equal(viewContract(s, at, 'peek', []).value, 2);
	const before = canon(s);
	assert.throws(() => viewContract(s, at, 'sneaky', []), /cannot change/);
	assert.throws(() => viewContract(s, at, 'bump', []), /not a view/);
	assert.equal(canon(s), before);
	await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'proto' }), /not allowed/);
});

await test('gas: a call puts up the fee for its gas limit and gets back what it did not use', async () => {
	const s = await world(1000); // 0.001 DZY a transaction, and 0.001 DZY per 1,000 gas
	const t0 = balanceOf(s, alice.address);
	const at = await deploy(s, alice, prog('vault'), 1000, 5000);
	const spent = t0 - balanceOf(s, alice.address) - RULES.deployFee;
	assert.ok(spent >= 1000 && spent <= 1000 * (1 + 5), `deploy fee ${spent}`); // at most what it put up, at least the base fee
	const b0 = balanceOf(s, bob.address);
	await call(s, bob, at, 'unlocks', [], { gas: 100_000 }); // a cheap call with a big limit
	assert.equal(b0 - balanceOf(s, bob.address), 1000 * 2); // base fee + one block of 1,000 gas: the rest came back
	assert.ok(s.treasury > RULES.deployFee);
	balanced(s);
});

await test('contracts replay exactly: every node gets the same result from the same blocks', async () => {
	let s = await genesis(CHAIN, auth.address, 1000, [auth.address]); const g = s, blocks = [];
	const step = async (txs, t) => { const r = await produceBlock(s, txs, t, auth); blocks.push(r.block); s = r.state; };
	await step([await tx(s, auth, 'mint', { asset: 'DZY', to: alice.address, amount: 50 * DZY })], 2000);
	const d = await tx(s, alice, 'contract.deploy', { code: prog('crowdfund') });
	await step([d], 3000);
	const at = Object.keys(s.contracts)[0];
	await step([await tx(s, alice, 'contract.call', { contract: at, fn: 'setup', args: [10 * DZY, 9_000] }), await signTx(alice.secret, { chain: CHAIN, from: alice.address, nonce: nonceOf(s, alice.address) + 2, type: 'contract.call', data: { contract: at, fn: 'give', pay: { asset: 'DZY', amount: 12 * DZY } } })], 4000);
	await step([await tx(s, alice, 'contract.call', { contract: at, fn: 'claim' })], 9000);
	const again = await replay(g, blocks);
	assert.equal(await stateRoot(again), await stateRoot(s));
	assert.equal(balanceOf(again, at), 0);
});

/* ---- contracts, version 2 ---- */
await test('a failed call pays for the gas it used (so nobody can make validators work for free), and is recorded', async () => {
	const s = await world(1000);
	const at = await deploy(s, alice, prog('vault'));
	const b0 = balanceOf(s, bob.address), t0 = s.treasury;
	await fails(s, tx(s, bob, 'contract.call', { contract: at, fn: 'withdraw', gas: 50_000 }), /only the owner/);
	assert.equal(b0 - balanceOf(s, bob.address), 2000); // the base fee and one block of 1,000 gas, not the 50,000 put up
	assert.equal(s.treasury - t0, 2000);
	assert.deepEqual(Object.keys(s.contracts[at].events.at(-1)).sort(), ['by', 'failed', 'h']);
	balanced(s);
});

await test('contracts call contracts: coins pass along, all or nothing across them, no calling back', async () => {
	const s = await world();
	const bank = await deploy(s, alice, { functions: {
		deposit: { body: ['seq', ['set', ['str', 'b:', ['caller']], ['+', ['get', ['str', 'b:', ['caller']], 0], ['paid', 'DZY']]], ['get', ['str', 'b:', ['caller']]]] },
		of: { view: true, args: ['who'], body: ['get', ['str', 'b:', ['arg', 'who']], 0] },
		poke: { args: ['back'], body: ['call', ['arg', 'back'], 'again', []] }
	} });
	const saver = await deploy(s, alice, { functions: {
		save: { args: ['bank', 'ok'], body: ['seq', ['call', ['arg', 'bank'], 'deposit', [], 'DZY', ['paid', 'DZY']], ['require', ['arg', 'ok'], 'changed my mind']] },
		again: { body: 1 },
		loop: { args: ['bank'], body: ['call', ['arg', 'bank'], 'poke', [['self']]] },
		deep: { args: ['n'], body: ['if', ['>', ['arg', 'n'], 0], ['call', ['self'], 'deep', [['-', ['arg', 'n'], 1]]], 0] }
	} });
	await call(s, bob, saver, 'save', [bank, true], { pay: { asset: 'DZY', amount: 3 * DZY } });
	assert.equal(balanceOf(s, bank), 3 * DZY); assert.equal(viewContract(s, bank, 'of', [saver]).value, 3 * DZY); // the bank saw the saver as its caller
	await fails(s, tx(s, bob, 'contract.call', { contract: saver, fn: 'save', args: [bank, false], pay: { asset: 'DZY', amount: DZY } }), /changed my mind/);
	assert.equal(balanceOf(s, bank), 3 * DZY); // the bank's deposit, made before the failure, was undone with it
	await fails(s, tx(s, bob, 'contract.call', { contract: saver, fn: 'loop', args: [bank] }), /cannot be called back/); // saver -> bank -> saver
	await fails(s, tx(s, bob, 'contract.call', { contract: saver, fn: 'deep', args: [2] }), /cannot be called back/); // itself, also not
	balanced(s);
});

await test('contracts make and issue their own tokens: a shop sells items for DZY; only the shop can issue its item; the limit holds', async () => {
	const s = await world();
	const shop = await deploy(s, alice, prog('shop'));
	await fails(s, tx(s, alice, 'contract.call', { contract: shop, fn: 'open', args: ['SWORD', 'Iron sword', 2, DZY] }), /costs 1 DZY, from the contract's own DZY/);
	await applyTx(s, await tx(s, alice, 'transfer', { asset: 'DZY', to: shop, amount: DZY })); // the owner gives the shop the 1 DZY it needs
	await call(s, alice, shop, 'open', ['SWORD', 'Iron sword', 2, DZY]);
	const item = viewContract(s, shop, 'item', []).value;
	assert.equal(s.assets[item].issuer, shop); assert.equal(s.assets[item].cap, 2); assert.equal(s.treasury, RULES.deployFee + RULES.assetFee);
	await fails(s, tx(s, bob, 'contract.call', { contract: shop, fn: 'buy', pay: { asset: 'DZY', amount: DZY / 2 } }), /at least the price/);
	await call(s, bob, shop, 'buy', [], { pay: { asset: 'DZY', amount: DZY } });
	await call(s, eve, shop, 'buy', [], { pay: { asset: 'DZY', amount: DZY } });
	assert.equal(balanceOf(s, bob.address, item), 1); assert.equal(viewContract(s, shop, 'sold', []).value, 2);
	await fails(s, tx(s, bob, 'contract.call', { contract: shop, fn: 'buy', pay: { asset: 'DZY', amount: DZY } }), /supply limit/); // sold out: only 2 can ever exist
	await refuses(s, tx(s, bob, 'mint', { asset: item, to: bob.address, amount: 5 }), /only the issuer/); // nobody else can make more
	const thief = await deploy(s, bob, { functions: { steal: { args: ['x'], body: ['mint', ['arg', 'x'], ['caller'], 1] } } });
	await fails(s, tx(s, bob, 'contract.call', { contract: thief, fn: 'steal', args: [item] }), /only issue tokens it made itself/);
	const a0 = balanceOf(s, alice.address);
	await call(s, alice, shop, 'collect');
	assert.equal(balanceOf(s, alice.address) - a0, 2 * DZY);
	assert.deepEqual(s.contracts[shop].events.filter((e) => e.v).map((e) => String(e.v).split(' ')[0]), ['open', 'sold', 'sold']);
	balanced(s);
});

await test('events: a contract keeps its newest 50; a view cannot emit', async () => {
	const s = await world();
	const at = await deploy(s, alice, { functions: { many: { body: ['for', 'i', 1, 60, ['emit', ['var', 'i']]] }, quiet: { view: true, body: ['emit', 1] } } });
	await call(s, bob, at, 'many', [], { gas: 50_000 });
	assert.equal(s.contracts[at].events.length, 50); assert.equal(s.contracts[at].events[0].v, 11); assert.equal(s.contracts[at].events.at(-1).v, 60);
	assert.throws(() => viewContract(s, at, 'quiet', []), /cannot change/);
});

/* ---- the second layer ---- */
const signState = async (id, nonce, a, b) => ({ nonce, a, b, sigA: await sign(alice.secret, channelMessage(CHAIN, id, nonce, a, b)), sigB: await sign(bob.secret, channelMessage(CHAIN, id, nonce, a, b)) });
const openChannel = async (s, amountA = 10 * DZY, amountB = 5 * DZY) => {
	const id = 'ch' + (await applyTx(s, await tx(s, alice, 'channel.open', { to: bob.address, asset: 'DZY', amount: amountA }))).slice(0, 16);
	if (amountB) await applyTx(s, await tx(s, bob, 'channel.fund', { id, amount: amountB }));
	return id;
};

await test('a channel: two people lock coins once, pay each other off the chain, and settle once', async () => {
	const s = await world();
	const id = await openChannel(s);
	assert.equal(s.channels[id].total, 15 * DZY); assert.equal(balanceOf(s, alice.address), 90 * DZY);
	balanced(s); // locked coins still count: nothing created, nothing destroyed
	// a hundred payments back and forth, none of them on the chain: just states both sign
	let a = 10 * DZY, b = 5 * DZY, last;
	for (let n = 1; n <= 100; n++) { const x = n % 3 === 0 ? -DZY / 10 : DZY / 20; a -= x; b += x; last = await signState(id, n, a, b); }
	await refuses(s, tx(s, eve, 'channel.close', { id, ...last }), /only the two sides/);
	await applyTx(s, await tx(s, bob, 'channel.close', { id, ...last }));
	assert.equal(balanceOf(s, alice.address), 90 * DZY + a); assert.equal(balanceOf(s, bob.address), 95 * DZY + b);
	assert.equal(s.channels, undefined);
	balanced(s);
});

await test('a channel: closing on an old state fails if the other side shows a newer one in time', async () => {
	const s = await world(), t0 = 10_000;
	const id = await openChannel(s);
	const old = await signState(id, 1, 14 * DZY, 1 * DZY); // early on, alice had most of it
	const newer = await signState(id, 2, 3 * DZY, 12 * DZY); // later she paid bob
	await applyTx(s, await tx(s, alice, 'channel.start', { id, ...old }), t0); // alice tries to close on the old state
	assert.equal(s.channels[id].closing.nonce, 1);
	await refuses(s, tx(s, alice, 'channel.settle', { id }), /not over yet/, t0 + RULES.channelWait - 1);
	await refuses(s, tx(s, alice, 'channel.update', { id, ...old }), /not newer/, t0 + 1);
	await applyTx(s, await tx(s, bob, 'channel.update', { id, ...newer }), t0 + 1000); // bob shows the newer one
	await refuses(s, tx(s, bob, 'channel.update', { id, ...newer }), /not newer/, t0 + 2000);
	await applyTx(s, await tx(s, eve, 'channel.settle', { id }), t0 + RULES.channelWait); // anyone can finish it after the wait
	assert.equal(balanceOf(s, alice.address), 90 * DZY + 3 * DZY); assert.equal(balanceOf(s, bob.address), 95 * DZY + 12 * DZY);
	balanced(s);
});

await test('a channel: forged signatures, amounts that do not add up and late updates are refused', async () => {
	const s = await world(), t0 = 10_000;
	const id = await openChannel(s);
	const good = await signState(id, 3, 7 * DZY, 8 * DZY);
	await refuses(s, tx(s, alice, 'channel.close', { id, ...good, sigB: good.sigA }), /both sides must sign/); // alice signs for bob
	await refuses(s, tx(s, alice, 'channel.close', { id, ...good, b: 9 * DZY }), /add up|both sides/); // changes an amount after signing
	await refuses(s, tx(s, alice, 'channel.close', { id, ...(await signState(id, 4, 7 * DZY, 9 * DZY)) }), /add up/); // more than is in it
	await refuses(s, tx(s, alice, 'channel.close', { id, ...good, sigA: await sign(eve.secret, channelMessage(CHAIN, id, 3, 7 * DZY, 8 * DZY)) }), /both sides must sign/);
	await refuses(s, tx(s, alice, 'channel.close', { id: id, ...(await signState(id.replace(/.$/, (c) => (c === '0' ? '1' : '0')), 3, 7 * DZY, 8 * DZY)) }), /both sides must sign/); // signed for another channel
	// closing with no signed state uses the deposits; a later update must come in time
	await applyTx(s, await tx(s, bob, 'channel.start', { id }), t0);
	assert.deepEqual([s.channels[id].closing.a, s.channels[id].closing.b], [10 * DZY, 5 * DZY]);
	await refuses(s, tx(s, bob, 'channel.fund', { id, amount: 1 }), /closing/);
	await refuses(s, tx(s, alice, 'channel.update', { id, ...good }), /waiting time is over/, t0 + RULES.channelWait);
	await applyTx(s, await tx(s, alice, 'channel.settle', { id }), t0 + RULES.channelWait);
	assert.equal(balanceOf(s, alice.address), 100 * DZY);
	balanced(s);
});

console.log(`\n${pass} tests passed`);
