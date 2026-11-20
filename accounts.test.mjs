// Names (@alex instead of an address) and accounts that need several keys to agree, written as attacks.
// Run: node chain/accounts.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import { applyTx, balanceOf, DZY, genesis, holdings, nonceOf, RULES, signPayer, signTx, txMessage, whoIs } from './src/ledger.ts';
import { produceBlock, replay } from './src/block.ts';
import { Client } from './src/client.ts';

const CHAIN = 'dznye-accounts-test';
const auth = await newKey(), alice = await newKey(), bob = await newKey(), eve = await newKey();
const k1 = await newKey(), k2 = await newKey(), k3 = await newKey();
const tx = (s, who, type, data, o = {}) => signTx(o.secret ?? who.secret, { chain: CHAIN, from: who.address, nonce: nonceOf(s, who.address) + 1, type, data, ...(o.payer ? { payer: o.payer } : {}) });
const refuses = async (s, t, why) => { const before = canon(s); await assert.rejects(applyTx(s, await t), why); assert.equal(canon(s), before, 'a refused transaction must change nothing'); };
const balanced = (s) => { const h = holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply); assert.equal(s.assets.DZY.supply, s.assets.DZY.minted); };
const world = async (fee = 0) => {
	const s = await genesis(CHAIN, auth.address, 1000, [auth.address], fee);
	for (const k of [alice, bob]) await applyTx(s, await tx(s, auth, 'mint', { asset: 'DZY', to: k.address, amount: 10 * DZY }));
	return s;
};
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };

await test('names: one per account, first come first served, 0.1 DZY to the treasury', async () => {
	const s = await world();
	for (const bad of ['ab', 'Alice', 'al ice', '-alice', 'alice-', 'a--b', 'x'.repeat(21), 'élan', '', 7]) await refuses(s, tx(s, alice, 'name.set', { name: bad }), /a name is/);
	await refuses(s, tx(s, alice, 'name.set', { name: 'dznye' }), /kept for the chain/);
	await refuses(s, tx(s, alice, 'name.set', { name: 'admin' }), /kept for the chain/);
	await applyTx(s, await tx(s, alice, 'name.set', { name: 'alice' }));
	assert.equal(whoIs(s, 'alice'), alice.address); assert.equal(s.accounts[alice.address].name, 'alice');
	assert.equal(balanceOf(s, alice.address), 10 * DZY - RULES.nameFee); assert.equal(s.treasury, RULES.nameFee);
	await refuses(s, tx(s, bob, 'name.set', { name: 'alice' }), /taken/);
	await refuses(s, tx(s, alice, 'name.set', { name: 'alice' }), /already has that name/);
	await applyTx(s, await tx(s, alice, 'name.set', { name: 'alice-2' })); // choosing another frees the old one
	assert.equal(whoIs(s, 'alice'), null); assert.equal(whoIs(s, 'alice-2'), alice.address);
	await applyTx(s, await tx(s, bob, 'name.set', { name: 'alice' })); // and someone else may take it
	await applyTx(s, await tx(s, alice, 'name.release', {}));
	assert.equal(whoIs(s, 'alice-2'), null); assert.equal(s.accounts[alice.address].name, undefined);
	await refuses(s, tx(s, alice, 'name.release', {}), /no name/);
	await applyTx(s, await tx(s, auth, 'mint', { asset: 'DZY', to: auth.address, amount: DZY }));
	await applyTx(s, await tx(s, auth, 'name.set', { name: 'dznye' })); // the chain's own key may hold a kept name
	const broke = await newKey();
	await refuses(s, tx(s, broke, 'name.set', { name: 'broke' }), /costs 0.1 DZY/);
	balanced(s);
});

await test('names: someone with no DZY gets one when an app pays, and the app pays the name too', async () => {
	const s = await world(1000), fresh = await newKey(), app = alice;
	const t = await signPayer(app.secret, await tx(s, fresh, 'name.set', { name: 'newcomer' }, { payer: app.address }));
	await applyTx(s, t);
	assert.equal(whoIs(s, 'newcomer'), fresh.address);
	assert.equal(balanceOf(s, fresh.address), 0);
	assert.equal(balanceOf(s, app.address), 10 * DZY - RULES.nameFee - 1000);
	balanced(s);
});

await test('several keys: 2 of 3 must sign everything; one key alone, a forged or borrowed co-signature, all fail', async () => {
	const s = await world(), vault = alice; // alice turns her account into one that needs 2 of 3 keys
	await applyTx(s, await tx(s, vault, 'account.multisig', { keys: [vault.address, k2.address, k3.address], need: 2 }));
	const pay = (amount, o = {}) => tx(s, vault, 'transfer', { asset: 'DZY', to: bob.address, amount }, o);
	await refuses(s, pay(1), /needs 2 of its 3 keys to sign; 1 did/);
	const t = await pay(DZY);
	await refuses(s, { ...t, cosigs: [{ key: k2.address, sig: t.sig }] }, /co-signature does not match/); // alice's signature passed off as k2's
	await refuses(s, Client.cosign(eve, t), /needs 2 of its 3 keys to sign; 1 did/); // eve is not one of the keys
	await refuses(s, { ...t, cosigs: [{ key: vault.address, sig: t.sig }] }, /1 did/); // the same key twice counts once
	await refuses(s, { ...(await Client.cosign(k2, t)), data: { ...t.data, amount: 9 * DZY } }, /bad signature/); // changed after signing
	await refuses(s, { ...t, cosigs: 'x' }, /bad co-signatures/);
	await applyTx(s, await Client.cosign(k2, t));
	assert.equal(balanceOf(s, bob.address), 11 * DZY);
	// changing or removing the rule needs the same agreement
	await refuses(s, tx(s, vault, 'account.multisig', { keys: null }), /needs 2/);
	await applyTx(s, await Client.cosign(k3, await tx(s, vault, 'account.multisig', { keys: null })));
	assert.equal(s.accounts[vault.address].multi, undefined);
	await applyTx(s, await pay(1)); // back to one key
	balanced(s);
});

await test('several keys: the keys can all be other people; a lost device key alone cannot move anything', async () => {
	const s = await world(), safe = bob, phone = await newKey();
	await applyTx(s, await tx(s, safe, 'key.add', { key: phone.address }));
	await applyTx(s, await tx(s, safe, 'account.multisig', { keys: [k1.address, k2.address, k3.address], need: 2 }));
	const send = () => signTx(phone.secret, { chain: CHAIN, from: safe.address, nonce: nonceOf(s, safe.address) + 1, type: 'transfer', data: { asset: 'DZY', to: eve.address, amount: DZY }, signer: phone.address });
	await refuses(s, send(), /0 did/); // a stolen phone signs, but none of the three agreed
	await refuses(s, Client.cosign(k1, await send()), /1 did/);
	await applyTx(s, await Client.cosign(k3, await Client.cosign(k1, await send())));
	assert.equal(balanceOf(s, eve.address), DZY);
	for (const bad of [{ keys: [k1.address], need: 1 }, { keys: [k1.address, k1.address], need: 1 }, { keys: [k1.address, k2.address], need: 3 }, { keys: [k1.address, 'x'], need: 1 }])
		await refuses(s, Client.cosign(k2, await Client.cosign(k1, await tx(s, safe, 'account.multisig', bad))), /give 2 to 8|need must be/);
	await refuses(s, signPayer(safe.secret, await tx(s, alice, 'transfer', { asset: 'DZY', to: eve.address, amount: 1 }, { payer: safe.address })), /cannot pay others' fees/);
	balanced(s);
});

await test('names and co-signatures are part of the blocks, and replay exactly', async () => {
	let s = await genesis(CHAIN, auth.address, 1000, [auth.address]); const g = s, blocks = [];
	const step = async (txs, t) => { const r = await produceBlock(s, txs, t, auth); blocks.push(r.block); s = r.state; };
	await step([await tx(s, auth, 'mint', { asset: 'DZY', to: alice.address, amount: 5 * DZY })], 2000);
	await step([await tx(s, alice, 'name.set', { name: 'alice' })], 3000);
	await step([await tx(s, alice, 'account.multisig', { keys: [alice.address, k1.address], need: 2 })], 4000);
	const t = await Client.cosign(k1, await tx(s, alice, 'transfer', { asset: 'DZY', to: bob.address, amount: DZY }));
	await step([t], 5000);
	const again = await replay(g, blocks);
	assert.equal(again.last, s.last); assert.equal(whoIs(again, 'alice'), alice.address);
	const bad = structuredClone(blocks); bad[3].txs[0].cosigs = [{ key: k1.address, sig: (await Client.cosign(k1, { ...t, nonce: 99, cosigs: undefined })).cosigs[0].sig }]; // k1's signature of a different transaction
	await assert.rejects(replay(g, bad), /block 4/); // a swapped co-signature breaks the block
	assert.equal(txMessage(t), txMessage({ ...t, cosigs: undefined })); // co-signatures are not part of what is signed
});

console.log(`\n${pass} tests passed`);
