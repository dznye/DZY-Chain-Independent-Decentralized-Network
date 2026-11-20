// Delegation (holders back a validator with their DZY) and the treasury by vote (stake decides payouts).
// Written as attacks: backing yourself or a non-validator, taking delegated DZY back early, a cheating validator's
// backers escaping its penalty, voting twice with the same stake, passing a payout with a third, paying from an empty
// treasury. After every step, nothing is created or lost.   Run: node chain/governance.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey, sign } from './src/crypto.ts';
import { applyTx, balanceOf, DZY, genesis, holdings, nextValidators, nonceOf, powers, RULES, signTx, stateRoot, totalVoteWeight, voteMessage, voteWeight, weightOf } from './src/ledger.ts';

const CHAIN = 'dznye-test-1', T0 = 1_000_000;
const auth = await newKey(), v1 = await newKey(), v2 = await newKey(), v3 = await newKey(), v4 = await newKey(), ann = await newKey(), ben = await newKey(), cat = await newKey();
const tx = (s, who, type, data) => signTx(who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data });
const send = async (s, who, type, data, time = T0) => applyTx(s, await tx(s, who, type, data), time);
const refuses = async (s, t, why, time = T0) => { const before = canon(s); await assert.rejects(applyTx(s, await t, time), why); assert.equal(canon(s), before, 'a refused transaction must change nothing'); };
const balanced = (s) => { const h = holdings(s); assert.equal(h.DZY, s.assets.DZY.supply, 'DZY adds up'); assert.equal(s.assets.DZY.supply, s.assets.DZY.minted, 'no DZY destroyed'); };

/** four validators with 2,000 DZY staked each, and three holders with 5,000 DZY each */
async function fresh() {
	const s = await genesis(CHAIN, auth.address, T0, [v1.address, v2.address, v3.address, v4.address]);
	for (const k of [v1, v2, v3, v4]) { await send(s, auth, 'mint', { asset: 'DZY', amount: 3000 * DZY, to: k.address }); await send(s, k, 'stake.bond', { amount: 2000 * DZY }); }
	for (const k of [ann, ben, cat]) await send(s, auth, 'mint', { asset: 'DZY', amount: 5000 * DZY, to: k.address });
	Object.assign(s, nextValidators(s));
	balanced(s);
	return s;
}

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };

await test('delegating: only to a staked validator, never to yourself; it adds to the validator\'s weight and say, and is part of the fingerprint', async () => {
	const s = await fresh();
	assert.equal(s.validators.length, 4);
	await refuses(s, tx(s, ann, 'stake.delegate', { validator: ann.address, amount: DZY }), /not yourself/);
	await refuses(s, tx(s, ann, 'stake.delegate', { validator: ben.address, amount: DZY }), /not a staked validator/);
	await refuses(s, tx(s, ann, 'stake.delegate', { validator: v1.address, amount: 6000 * DZY }), /not enough/);
	await refuses(s, tx(s, ann, 'stake.delegate', { validator: 'nope', amount: DZY }), /name the validator/);
	const root = await stateRoot(s);
	await send(s, ann, 'stake.delegate', { validator: v1.address, amount: 3000 * DZY });
	assert.notEqual(await stateRoot(s), root);
	assert.equal(weightOf(s, v1.address), 5000 * DZY);
	Object.assign(s, nextValidators(s));
	assert.equal(powers(s)[v1.address], 5000, 'its say counts what backs it');
	assert.equal(powers(s)[v2.address], 2000);
	assert.equal(balanceOf(s, ann.address), 2000 * DZY);
	balanced(s);
});

await test('delegation decides who holds a seat: backing an outsider with stake can lift it past a validator with less', async () => {
	const s = await fresh();
	const out = await newKey();
	await send(s, auth, 'mint', { asset: 'DZY', amount: 1500 * DZY, to: out.address });
	await send(s, out, 'stake.bond', { amount: 1000 * DZY });
	const before = nextValidators(s);
	assert.ok(before.validators.includes(out.address), 'with seats to spare it joins');
	await send(s, ann, 'stake.delegate', { validator: out.address, amount: 4000 * DZY });
	assert.equal(weightOf(s, out.address), 5000 * DZY);
	// the order of the seats is by weight (own stake and what backs it); the set is kept in address order
	const ranked = Object.keys(s.stakes).sort((x, y) => weightOf(s, y) - weightOf(s, x));
	assert.equal(ranked[0], out.address);
	balanced(s);
});

await test('taking delegated DZY back waits as long as a validator\'s own stake; early claims, other people\'s and over-taking are refused', async () => {
	const s = await fresh();
	await send(s, ann, 'stake.delegate', { validator: v2.address, amount: 1000 * DZY });
	await refuses(s, tx(s, ben, 'stake.undelegate', { validator: v2.address, amount: DZY }), /not backing/);
	await refuses(s, tx(s, ann, 'stake.undelegate', { validator: v2.address, amount: 1001 * DZY }), /more than you back/);
	await send(s, ann, 'stake.undelegate', { validator: v2.address, amount: 400 * DZY });
	assert.equal(weightOf(s, v2.address), 2600 * DZY);
	await refuses(s, tx(s, ann, 'stake.claim', {}), /nothing has finished/, T0 + RULES.unbondDelay - 1);
	await send(s, ann, 'stake.claim', {}, T0 + RULES.unbondDelay);
	assert.equal(balanceOf(s, ann.address), 4400 * DZY);
	await refuses(s, tx(s, ann, 'stake.claim', {}), /nothing is on its way/, T0 + RULES.unbondDelay);
	for (let i = 0; i < RULES.maxUnbonding; i++) await send(s, ann, 'stake.undelegate', { validator: v2.address, amount: 10 * DZY });
	await refuses(s, tx(s, ann, 'stake.undelegate', { validator: v2.address, amount: 10 * DZY }), /at most/);
	balanced(s);
});

await test('backing at most 16 validators at once', async () => {
	const s = await genesis(CHAIN, auth.address, T0);
	const vs = [];
	for (let i = 0; i < RULES.maxDelegations + 1; i++) { const k = await newKey(); vs.push(k); await send(s, auth, 'mint', { asset: 'DZY', amount: 1100 * DZY, to: k.address }); await send(s, k, 'stake.bond', { amount: 1000 * DZY }); }
	await send(s, auth, 'mint', { asset: 'DZY', amount: 100 * DZY, to: ann.address });
	for (let i = 0; i < RULES.maxDelegations; i++) await send(s, ann, 'stake.delegate', { validator: vs[i].address, amount: DZY });
	await refuses(s, tx(s, ann, 'stake.delegate', { validator: vs[RULES.maxDelegations].address, amount: DZY }), /at most 16/);
	await send(s, ann, 'stake.delegate', { validator: vs[0].address, amount: DZY }); // adding to one already backed is fine
	balanced(s);
});

await test('a validator caught cheating: those who back it lose the same share, including DZY already on its way back; it all goes to the treasury', async () => {
	const s = await fresh();
	await send(s, ann, 'stake.delegate', { validator: v3.address, amount: 2000 * DZY });
	await send(s, ben, 'stake.delegate', { validator: v3.address, amount: 1000 * DZY });
	await send(s, ben, 'stake.undelegate', { validator: v3.address, amount: 500 * DZY }); // trying to slip out first
	const vote = async (block) => ({ type: 'prevote', height: 1, round: 0, block, validator: v3.address, sig: await sign(v3.secret, voteMessage(CHAIN, 'prevote', 1, 0, block)) });
	const t0 = s.treasury ?? 0;
	await send(s, cat, 'evidence', { a: await vote('aa'.repeat(32)), b: await vote('bb'.repeat(32)) });
	assert.equal(s.delegations[v3.address][ann.address], 1900 * DZY, '5% gone');
	assert.equal(s.delegations[v3.address][ben.address], 475 * DZY);
	assert.equal(s.undelegating[ben.address][0].amount, 475 * DZY, 'leaving did not escape it');
	const own = 100 * DZY, backers = 100 * DZY + 25 * DZY + 25 * DZY, reward = Math.floor(own * RULES.reporterPct / 100);
	assert.equal(s.treasury - t0, own - reward + backers);
	assert.equal(balanceOf(s, cat.address), 5000 * DZY + reward);
	// its backers can leave; it can never be a validator again, so nobody new can back it
	await refuses(s, tx(s, cat, 'stake.delegate', { validator: v3.address, amount: DZY }), /not a staked validator/);
	await send(s, ann, 'stake.undelegate', { validator: v3.address, amount: 1900 * DZY });
	balanced(s);
});

await test('the treasury by vote: only stake proposes and votes; more than two thirds pays; a vote counts at the voter\'s stake when counted', async () => {
	const s = await fresh();
	s.treasury = 1000 * DZY; s.assets.DZY.supply += 1000 * DZY; s.assets.DZY.minted += 1000 * DZY; // the treasury holds 1,000 DZY
	const prop = (who, d = {}) => tx(s, who, 'treasury.propose', { to: cat.address, amount: 300 * DZY, reason: 'a grant for the first wallet translation', ...d });
	await refuses(s, prop(cat), /staked or delegated/);
	await refuses(s, prop(v1, { reason: 'x' }), /say what/);
	const id = 'p' + (await applyTx(s, await prop(v1), T0)).slice(0, 16);
	await refuses(s, tx(s, cat, 'treasury.vote', { id, yes: true }), /staked or delegated/);
	await refuses(s, tx(s, v1, 'treasury.vote', { id, yes: 'yes' }), /yes: true/);
	assert.equal(totalVoteWeight(s), 8000 * DZY);
	await send(s, v1, 'treasury.vote', { id, yes: true });
	await send(s, v2, 'treasury.vote', { id, yes: true });
	assert.equal(balanceOf(s, cat.address), 5000 * DZY, 'half is not enough');
	// v2 changes its mind, then back: one account, one vote, counted once
	await send(s, v2, 'treasury.vote', { id, yes: false });
	await send(s, v2, 'treasury.vote', { id, yes: true });
	assert.equal(balanceOf(s, cat.address), 5000 * DZY);
	// ann backs v3 and votes too: 2,000 + 2,000 + 1,000 of 9,000 is not over two thirds
	await send(s, ann, 'stake.delegate', { validator: v3.address, amount: 1000 * DZY });
	await send(s, ann, 'treasury.vote', { id, yes: true });
	assert.equal(balanceOf(s, cat.address), 5000 * DZY);
	await send(s, v3, 'treasury.vote', { id, yes: true }); // 7,000 of 9,000: passes and pays at once
	assert.equal(balanceOf(s, cat.address), 5300 * DZY);
	assert.equal(s.treasury, 700 * DZY);
	assert.equal(s.proposals, undefined);
	balanced(s);
});

await test('votes cannot be counted twice by moving stake; a passing vote never pays more than the treasury holds; ended proposals close', async () => {
	const s = await fresh();
	s.treasury = 100 * DZY; s.assets.DZY.supply += 100 * DZY; s.assets.DZY.minted += 100 * DZY;
	await send(s, ann, 'stake.delegate', { validator: v1.address, amount: 2000 * DZY });
	const id = 'p' + (await applyTx(s, await tx(s, ann, 'treasury.propose', { to: cat.address, amount: 500 * DZY, reason: 'more than the treasury holds' }), T0)).slice(0, 16);
	await send(s, ann, 'treasury.vote', { id, yes: true });
	// ann takes her backing away: her vote now weighs nothing (the DZY is unlocking, and unlocking DZY has no say)
	await send(s, ann, 'stake.undelegate', { validator: v1.address, amount: 2000 * DZY });
	assert.equal(voteWeight(s, ann.address), 0);
	for (const v of [v1, v2, v3, v4]) await send(s, v, 'treasury.vote', { id, yes: true });
	assert.equal(balanceOf(s, cat.address), 5000 * DZY, 'everyone says yes, but the treasury cannot pay 500: nothing moves');
	await refuses(s, tx(s, v1, 'treasury.vote', { id, yes: true }), /ended/, T0 + RULES.voteDays + 1);
	await refuses(s, tx(s, cat, 'treasury.close', { id }), /not ended/);
	await send(s, cat, 'treasury.close', { id }, T0 + RULES.voteDays + 1);
	assert.equal(s.proposals, undefined);
	assert.equal(s.treasury, 100 * DZY);
	balanced(s);
});

console.log(`\n${pass} tests passed`);
