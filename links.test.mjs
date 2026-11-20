// One @name, every chain: an account links its own Ethereum-style and Bitcoin addresses, each proved by that
// address's own signature, made the way the wallet makes it (evmsign.ts). Run: node chain/links.test.mjs
import assert from 'node:assert/strict';
import { canon, newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import { evmAddressOf, signBtcMessage, signPersonal } from './src/evmsign.ts';
import { btcAddressesOf, pubBytes } from './src/btc.ts';
import { publicPoint } from './src/secp.ts';

const [V, A] = await Promise.all([newKey(), newKey()]), CHAIN = 'dznye-links-test', DZY = 1_000_000;
const s = await L.sunGenesis({ chain: CHAIN, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: [{ to: A.address, units: 100 * DZY, paid: 20 * DZY, proof: 'test' }] });
const send = async (type, data) => L.applyTx(s, await L.signTx(A.secret, { chain: CHAIN, from: A.address, nonce: L.nonceOf(s, A.address) + 1, type, data }), s.time, V.address);
const ethKey = 0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffffn, btcKey = 0x2222333344445555666677778888999900001111aaaabbbbccccddddeeeeffffn, other = 0x3333n;
const eth = evmAddressOf(ethKey), btc = btcAddressesOf(pubBytes(publicPoint(btcKey), true))[2];
await send('name.set', { name: 'ada' });
await send('name.link', { net: 'eth', address: eth, sig: signPersonal(ethKey, L.linkMessage(CHAIN, A.address, 'eth', eth)) });
await send('name.link', { net: 'btc', address: btc, sig: signBtcMessage(btcKey, L.linkMessage(CHAIN, A.address, 'btc', btc)) });
assert.deepEqual(s.accounts[A.address].links, { eth, btc });
console.log(`ok   @ada now receives on Ethereum-style chains (${eth.slice(0, 10)}…) and Bitcoin (${btc.slice(0, 12)}…), each proved by its own key`);
const before = canon(s);
for (const [net, address, sig] of [['eth', eth, signPersonal(other, L.linkMessage(CHAIN, A.address, 'eth', eth))], ['btc', btc, signBtcMessage(other, L.linkMessage(CHAIN, A.address, 'btc', btc))], ['eth', eth, signPersonal(ethKey, L.linkMessage('another-chain', A.address, 'eth', eth))]])
	await assert.rejects(() => send('name.link', { net, address, sig }), /sign/);
assert.equal(canon(s), before, 'a refused link changed the state');
console.log('ok   a link signed by another key, or for another chain, is refused and leaves no trace');
console.log('2 tests passed');
