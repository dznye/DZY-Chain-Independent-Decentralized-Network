// ONLINE: a validator on a chain with the Sun fetches Bitcoin's newest real headers by itself and posts them, so the
// raffle can be drawn from the next Bitcoin block. Asks the public Bitcoin nodes (btc.ts). Run: node chain/node/btcseed.test.mjs
import assert from 'node:assert/strict';
import { newKey } from '../src/crypto.ts';
import { startNode } from './server.mjs';

const V = await newKey();
const node = await startNode({ port: 0, validator: V, blockMs: 100, watchMs: 2_000, sun: { chain: 'dznye-btc-test', time: Date.now(), validators: [V.address], seedWait: 60, sales: [
	{ to: V.address, units: 8_500_000_000, paid: 1_000_000_000, proof: 'test', lockYears: 10 }] } });
const get = async (p) => (await fetch(node.url + p)).json();
let pass = 0;
try {
	let btc = null;
	for (let i = 0; i < 90 && !btc; i++) { btc = (await get('/sun')).btc; if (!btc) await new Promise((r) => setTimeout(r, 1_000)); }
	assert.ok(btc, 'the validator posted no Bitcoin header in 90 seconds');
	assert.ok(btc.height > 976_000 && /^0{8}[0-9a-f]{56}$/.test(btc.hash), `not a believable Bitcoin tip: ${JSON.stringify(btc)}`);
	assert.ok(Math.abs(btc.time * 1000 - Date.now()) < 3 * 3_600_000, 'the posted header is not recent');
	assert.equal((await get('/account/' + V.address)).balances?.DZY ?? 0, 0, 'the validator paid a fee to post it'); // its DZY are all locked: posting is free
	pass++; console.log(`ok   ONLINE: the validator posted Bitcoin's tip itself — block ${btc.height} (${btc.hash.slice(0, 20)}…), ${Math.round((Date.now() - btc.time * 1000) / 60_000)} minutes old`);
} finally { await node.stop(); }
console.log(`${pass} tests passed`);
