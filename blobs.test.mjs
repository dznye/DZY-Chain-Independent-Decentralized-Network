// Files that last and NFTs that burn back to DZY (blobs.ts), written as attacks: swapped bytes, unpaid room, pieces nobody
// keeps, proofs copied from others, pay taken twice, files that shut out payments, DZY taken out of an NFT that is not
// there. Run: node blobs.test.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { newKey } from './src/crypto.ts';
import * as L from './src/ledger.ts';
import * as H from './src/heart.ts';
import * as F from './src/blobs.ts';
import { bare, bytesOf, cargoFits, choose, isCargo, makeBlock, produceBlock, replay, verifyBlock } from './src/block.ts';
import { commit, seal } from './src/layer.ts';
import { Sequencer } from './src/sequencer.ts';

let pass = 0, failed = 0;
const test = async (name, fn) => { const t = Date.now(); try { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : '', `(${Date.now() - t} ms)`); } catch (e) { failed++; console.log('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 5).join(' | ')); } };
const DZY = 1e8, dzy = (n) => Math.round(n * DZY), SUPPLY = 12_000_000 * DZY;
const K = await Promise.all(Array.from({ length: 12 }, () => newKey())), [V, A, B, C, N1, N2, N3, N4] = K;
let chains = 0;
async function chain() {
	const name = 'dznye-blobs-t' + ++chains; L.testCrewFrom(name, 1); H.testHeartFrom(name, 2, [V.address]);
	const s = await L.sunGenesis({ chain: name, time: 1_800_000_000_000, validators: [V.address], seedWait: 0, sales: K.map((k) => ({ to: k.address, units: dzy(5_000), paid: dzy(5_000) / 50, proof: 't' })) });
	return s;
}
const started = async () => { const s = await chain(); L.endBlock(s, 1, 0, V.address, s.time + 1000); s.height = 1; assert.ok(s.heart); return s; };
const Y = 2; // years
const send = async (s, k, type, data = {}, side) => { s.time += 1000; const tx = await L.signTx(k.secret, { chain: s.chain, from: k.address, nonce: L.nonceOf(s, k.address) + 1, type, data: type === 'blob.in' || type === 'blob.out' ? { years: Y, ...data } : data }); return L.applyTx(s, side === undefined ? tx : { ...tx, side }, s.time, V.address); };
const refused = async (s, k, type, data, why, side) => { const before = JSON.stringify(s), t = s.time; await assert.rejects(() => send(s, k, type, data, side), why); s.time = t; assert.equal(JSON.stringify(s), before, 'a refused transaction changed the state'); };
const whole = (s, w) => { const h = L.holdings(s); for (const [id, a] of Object.entries(s.assets)) assert.equal(h[id], a.supply, `${w}: ${id}`); assert.equal(h.DZY, SUPPLY, w); };
const bal = (s, k, a = 'DZY') => L.balanceOf(s, k.address, a);
const put = async (s, k, file, type = 'image/png') => { const p = F.parts(file, type); await send(s, k, 'blob.in', p.open); for (const x of p.parts) { s.height++; await send(s, k, 'blob.part', x.data, x.side); } return p.id; };
const day = (s, n = 1) => { s.sun.minute += 1440 * n; s.heart.day = H.dayOf(s); s.heart.day[1] = createHash('sha256').update('seed' + s.heart.day[0]).digest('hex'); };

await test('A real chain keeps a picture in its blocks: another program rebuilds it from the blocks alone, byte for byte', async () => {
	const s0 = await chain(); let a = structuredClone(s0), b = structuredClone(s0); seal(a); seal(b); const blocks = [];
	const block = async (txs) => { const m = await produceBlock(a, txs, a.time + 1000, V); blocks.push(m.block); a = commit(m.state); b = commit(await verifyBlock(b, JSON.parse(JSON.stringify(m.block)))); assert.equal(a.last, b.last); };
	const tx = async (type, x, plus = 1) => { const t = await L.signTx(A.secret, { chain: a.chain, from: A.address, nonce: L.nonceOf(a, A.address) + plus, type, data: x.data ?? { years: Y, ...x } }); return x.side ? { ...t, side: x.side } : t; };
	await block([]); const file = randomBytes(150_000), p = F.parts(file, 'image/webp');
	await block([await tx('blob.in', p.open)]); await block([await tx('blob.part', p.parts[0]), await tx('blob.part', p.parts[1], 2)]); await block([await tx('blob.part', p.parts[2]), await tx('blob.part', p.parts[3], 2)]);
	const copy = JSON.parse(JSON.stringify(blocks)), got = F.fromBlocks(p.id, a.blobs[p.id], (h) => copy[h - 1]);
	assert.ok(Buffer.from(got).equals(file)); const end = await replay(s0, blocks); assert.equal(end.last, a.last); whole(end, 'replayed');
	const bad = structuredClone(copy); const t = bad.flatMap((x) => x.txs).find((x) => x.type === 'blob.part' && x.data.n === 1); t.side = p.parts[0].side;
	assert.throws(() => F.fromBlocks(p.id, a.blobs[p.id], (h) => bad[h - 1]), /not the one the chain names/);
	assert.ok(!JSON.stringify(a.blobs).includes(p.parts[0].side.slice(0, 40)), 'the bytes are in the state too');
});
await test('A file in the blocks: only its owner, in order, exactly the bytes it named, paid for part by part; too big, unknown kinds and lies are refused', async () => {
	const s = await started(), file = randomBytes(100_000), p = F.parts(file, 'image/png');
	await refused(s, A, 'blob.in', { ...p.open, type: 'text/html' }, /kind of file/); await refused(s, A, 'blob.in', { ...p.open, size: 400_000 }, /size/); await refused(s, A, 'blob.in', { ...p.open, hashes: p.open.hashes.slice(1) }, /fingerprints/);
	const o0 = bal(s, A), pot0 = s.sun.feePot; await send(s, A, 'blob.in', p.open); const o1 = bal(s, A), pot1 = s.sun.feePot; await refused(s, B, 'blob.in', p.open, /already/);
	await refused(s, A, 'nft.make', { blob: p.id, symbol: 'ART', name: 'x', copies: 1 }, /not all written/);
	const [q0, q1] = p.parts; await refused(s, A, 'blob.part', q1.data, /next part is 0/, q1.side);
	await refused(s, A, 'blob.part', q0.data, /not the part/, q1.side); await refused(s, A, 'blob.part', q0.data, /base64/, q0.side.slice(0, -4)); await refused(s, A, 'blob.part', q0.data, /not the part/, 'A' + q0.side.slice(1)); await refused(s, A, 'blob.part', { ...q0.data, len: 4 }, /len/, q0.side); await refused(s, A, 'transfer', { asset: 'DZY', to: B.address, amount: 1 }, /beside/, 'AAAA');
	for (const x of p.parts) { s.height++; await send(s, A, 'blob.part', x.data, x.side); }
	await refused(s, A, 'blob.part', { ...q0.data, n: 3 }, /next part/, q0.side);
	const want = L.usdCost(s, 'DZY', F.usdFor('in', 100_000, Y)); assert.ok(o0 - o1 >= want + F.BLOB.bond && o0 - o1 < want + F.BLOB.bond + 1_000); assert.ok(pot1 - pot0 >= want, 'the price did not become a fee (40% validators, 30% backing, ...)');
	whole(s, 'in'); return `100 KB for ${Y} years cost ${(want / DZY).toFixed(3)} DZY ($${(F.usdFor('in', 100_000, Y) / 1e6).toFixed(3)})`;
});
await test('Any 8 of the 16 pieces rebuild a file, whichever are lost; 7 do not; a changed piece is never used', async () => {
	let seed = 3; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 8) % n; };
	for (const size of [1, 7, 1_000, 8_191, 100_003]) {
		const file = randomBytes(size), c = F.cut(file, 'application/pdf'), blob = c.data;
		for (let t = 0; t < 25; t++) { const ids = Array.from({ length: 16 }, (_, i) => i); for (let i = 15; i > 0; i--) { const j = rnd(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; } assert.ok(Buffer.from(F.rebuild(blob, new Map(ids.slice(0, 8).map((i) => [i, c.pieces[i]])))).equals(file), `${size}: ${ids.slice(0, 8)}`); }
		assert.throws(() => F.rebuild(blob, new Map([0, 1, 2, 3, 4, 5, 6].map((i) => [i, c.pieces[i]]))), /takes 8/);
		const bad = new Uint8Array(c.pieces[15]); bad[0] ^= 1; assert.throws(() => F.rebuild(blob, new Map([[15, bad], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [i, c.pieces[i]])])), /7/);
		assert.ok(Buffer.from(F.rebuild(blob, new Map([[15, bad], ...[1, 2, 3, 4, 5, 6, 7, 9].map((i) => [i, c.pieces[i]])]))).equals(file));
	}
});
await test('Keeping pieces: proofs of today\'s spot are paid once a day; wrong bytes, other people\'s proofs, yesterday\'s, unstaked keys and a fourth keeper are not', async () => {
	const s = await started(), file = randomBytes(2_000_000), c = F.cut(file, 'video/mp4');
	const b0 = bal(s, A); await send(s, A, 'blob.out', c.data); const id = c.id, fund0 = s.blobs[id].fund, price = L.usdCost(s, 'DZY', F.usdFor('out', 2_000_000, Y)); assert.ok(b0 - bal(s, A) - price - F.BLOB.bond < 5_000 && b0 - bal(s, A) >= price + F.BLOB.bond); assert.equal(fund0, price - Math.ceil(price / 10)); whole(s, 'out');
	await refused(s, A, 'blob.out', c.data, /already/); s.heart.day = [0, 'a'.repeat(64)];
	const proof = (k, p = 0) => F.proofOf(id, p, c.pieces[p], s.heart.day[1], k.address);
	await refused(s, N1, 'blob.prove', proof(N1), /staked/); for (const k of [N1, N2, N3, N4]) await send(s, k, 'stake.bond', { amount: dzy(10) });
	const x = proof(N1); await refused(s, N2, 'blob.prove', x, /today's spot/); // copied from someone else: another spot
	await refused(s, N1, 'blob.prove', { ...x, p: 1 }, /today's spot/); await refused(s, N1, 'blob.prove', { ...x, b: Buffer.alloc(1024).toString('base64') }, /today's spot/); await refused(s, N1, 'blob.prove', { ...x, path: [...x.path].reverse() }, /today's spot/); await refused(s, N1, 'blob.prove', { ...x, path: x.path.slice(1) }, /today's spot/);
	const n0 = bal(s, N1); await send(s, N1, 'blob.prove', x); assert.ok(bal(s, N1) <= n0, 'paid for the first day'); await refused(s, N1, 'blob.prove', x, /already shown/);
	await send(s, N2, 'blob.prove', proof(N2)); await send(s, N3, 'blob.prove', proof(N3)); await refused(s, N4, 'blob.prove', proof(N4), /kept by enough/); await send(s, N4, 'blob.prove', proof(N4, 5));
	day(s); await refused(s, N1, 'blob.prove', x, /today's spot/);
	const f1 = s.blobs[id].fund; await send(s, N1, 'blob.prove', proof(N1)); const due = F.payOf(f1, F.daysLeft(s.blobs[id], s.time)); assert.equal(f1 - s.blobs[id].fund, due); assert.ok(due > 0); await refused(s, N1, 'blob.prove', proof(N1), /already shown/);
	day(s, 5); // N2 and N3 have gone silent: N4 may take a place; who was away long is not paid for it
	await send(s, N4, 'blob.prove', proof(N4)); assert.equal(s.blobs[id].holders['0:' + N2.address], undefined); const f2 = s.blobs[id].fund; await send(s, N1, 'blob.prove', proof(N1)); assert.equal(s.blobs[id].fund, f2);
	whole(s, 'proved'); return `a 2 MB file costs ${(price / DZY).toFixed(3)} DZY; a proof is ${JSON.stringify(x).length} characters`;
});
await test('A fund lasts exactly its time: 48 keepers proving every day are paid evenly, and it is never overdrawn', async () => {
	let fund = dzy(3); const first = F.payOf(fund, 730); for (let left = 730; left > 0; left--) { const p = F.payOf(fund, left) * 48; fund -= p; assert.ok(fund >= 0); if (left === 400) assert.ok(Math.abs(F.payOf(fund, left - 1) / first - 1) < 0.01); } assert.equal(F.payOf(fund, 0), 0); assert.ok(fund < dzy(0.01));
});
await test('NFTs with DZY in them: burning a copy gives exactly its part; nothing else can take it out; files stay while a copy exists', async () => {
	const s = await started(), id = await put(s, A, randomBytes(30_000));
	await refused(s, B, 'nft.make', { blob: id, symbol: 'ART', name: 'x', copies: 1 }, /owner/);
	const b0 = bal(s, A); await send(s, A, 'nft.make', { blob: id, symbol: 'ART', name: 'Sunrise', desc: 'the first', copies: 10, inside: dzy(5) }); const key = Object.keys(s.assets).find((k) => s.assets[k].nft);
	assert.ok(b0 - bal(s, A) >= dzy(51)); assert.equal(bal(s, A, key), 10); whole(s, 'made');
	await refused(s, A, 'burn', { asset: key, amount: 1 }, /nft\.burn/); await refused(s, A, 'points.redeem', { asset: key, amount: 1 }, /not points/); await refused(s, A, 'points.mint', { asset: key, amount: 1 }, /not points/); await refused(s, A, 'mint', { asset: key, to: A.address, amount: 1 }, /./);
	await send(s, A, 'transfer', { asset: key, to: B.address, amount: 3 }); await refused(s, B, 'nft.burn', { asset: key, copies: 4 }, /not hold/); await refused(s, C, 'nft.burn', { asset: key }, /not hold/);
	const c0 = bal(s, B); await send(s, B, 'nft.burn', { asset: key, copies: 1 }); assert.ok(bal(s, B) - c0 > dzy(5) - 1_000 && bal(s, B) - c0 <= dzy(5)); assert.equal(s.assets[key].supply, 9);
	await send(s, C, 'nft.fill', { asset: key, each: dzy(2) }); assert.equal(s.assets[key].backed.per, dzy(7)); assert.equal(s.assets[key].backed.reserve, dzy(63)); whole(s, 'filled');
	await send(s, B, 'offer.create', { give: { asset: key, amount: 1 }, want: { asset: 'DZY', amount: dzy(9) } }); await send(s, C, 'offer.take', { id: Object.keys(s.offers)[0] }); assert.equal(bal(s, C, key), 1); // it trades like any token
	await refused(s, A, 'blob.close', { id }, /still shows/); for (const [k, n] of [[A, 7], [B, 1], [C, 1]]) await send(s, k, 'nft.burn', { asset: key, copies: n });
	assert.equal(s.assets[key].supply, 0); assert.equal(s.assets[key].backed.reserve, 0); await refused(s, C, 'nft.fill', { asset: key, each: 5 }, /burned/); await refused(s, B, 'blob.close', { id }, /only its owner/); await send(s, A, 'blob.close', { id }); assert.equal(s.blobs, undefined); whole(s, 'closed');
});
await test('Closing a file in pieces gives back exactly the rest of its fund, once, to its owner', async () => {
	const s = await started(), c = F.cut(randomBytes(500_000), 'application/pdf'); await send(s, A, 'blob.out', c.data); await send(s, C, 'blob.fund', { id: c.id, amount: dzy(1) });
	await send(s, A, 'blob.give', { id: c.id, to: B.address }); await refused(s, A, 'blob.close', { id: c.id }, /only its owner/); const f = s.blobs[c.id].fund, b0 = bal(s, B); await send(s, B, 'blob.close', { id: c.id }); assert.ok(bal(s, B) - b0 > f + F.BLOB.bond - 1_000 && bal(s, B) - b0 <= f + F.BLOB.bond); await refused(s, B, 'blob.close', { id: c.id }, /no such file/); whole(s, 'close');
});
await test('Versions: a newer one is a new file; the old one stays as it was and points to it', async () => {
	const s = await started(), a = await put(s, A, randomBytes(5_000)), b = await put(s, A, randomBytes(5_000)), was = JSON.stringify(s.blobs[a].hashes);
	await refused(s, B, 'blob.next', { id: a, next: b }, /only its owner/); await refused(s, A, 'blob.next', { id: a, next: a }, /itself/); await send(s, A, 'blob.next', { id: a, next: b }); assert.equal(s.blobs[a].next, b); assert.equal(JSON.stringify(s.blobs[a].hashes), was);
});
await test('Prices are in dollars, by the year: when DZY is worth more, a file costs fewer DZY; 25 cents a MB a year in the blocks, half a cent in pieces', async () => {
	assert.equal(F.usdFor('in', 1_000_000), 250_000); assert.equal(F.usdFor('in', 1_000_000, 4), 1_000_000); assert.equal(F.usdFor('out', 10_000_000, 2), 100_000); assert.equal(F.usdFor('out', 10), 5_000);
	const s = await started(), a = L.usdCost(s, 'DZY', 1_000_000); s.sun.sold += dzy(85_000); s.sun.salePot -= dzy(85_000); s.heart.avg = H.spotPrice(s) * 1000; const b = L.usdCost(s, 'DZY', 1_000_000); assert.ok(Math.abs(a / b - 2) < 0.01, `${a} ${b}`);
});
await test('The cargo lane: payments go first; files never take more than half a block, and always get an eighth; every node refuses a block with more', async () => {
	const s0 = await chain(); let a = structuredClone(s0); seal(a); a = commit((await produceBlock(a, [], a.time + 1000, V)).state); a.heart.size = 400_000;
	const p = F.parts(randomBytes(270_000), 'image/png'); let n = 0; const tx = async (type, x) => { const t = await L.signTx(A.secret, { chain: a.chain, from: A.address, nonce: ++n, type, data: x.data ?? { years: Y, ...x } }); return x.side ? { ...t, side: x.side } : t; };
	const open = await tx('blob.in', p.open), files = []; for (const x of p.parts) files.push(await tx('blob.part', x));
	const pays = await Promise.all(K.slice(4).flatMap((k) => Array.from({ length: 60 }, (_, i) => L.signTx(k.secret, { chain: a.chain, from: k.address, nonce: i + 1, type: 'transfer', data: { asset: 'DZY', to: V.address, amount: 5 } }))));
	const room = H.roomOf(a), got = choose([open, ...files, ...pays], 10_000, room); // files arrived first
	assert.ok(got.filter((t) => t.type === 'transfer').length === pays.length, 'payments wait behind a file'); assert.ok(cargoFits(got, room.bytes)); const cargo = got.filter(isCargo).length; assert.ok(cargo >= 1 && cargo < 6); assert.ok(got.findIndex(isCargo) > got.findLastIndex((t) => !isCargo(t)));
	const flood = Array.from({ length: 4_000 }, (_, i) => ({ ...pays[0], nonce: i })), f2 = choose([...files, ...flood], 10_000, { bytes: 1_000_000, gas: 1e9 }); assert.ok(f2.filter(isCargo).length >= 1, 'a flood of payments shuts files out'); assert.ok(bytesOf(f2) <= 1_000_000);
	await assert.rejects(produceBlock(a, [open, ...files.slice(0, 4)], a.time + 1000, V), /too big/);
	return `a 400 KB block: ${pays.length} payments first, then ${cargo} of 6 parts`;
});
await test('A validator\'s waiting room: a file, payments, and a payment that needs an earlier one: everything gets into blocks, nothing stops the chain', async () => {
	const s0 = await chain(); let a = structuredClone(s0); seal(a); a = commit((await produceBlock(a, [], a.time + 1000, V)).state); a.heart.size = 300_000; seal(a);
	const seq = new Sequencer(a, V), poor = await newKey(), p = F.parts(randomBytes(200_000), 'image/png'); let t = a.time + 2_000;
	const go = async (k, type, data, side) => { const x = await L.signTx(k.secret, { chain: a.chain, from: k.address, nonce: seq.pendingNonce(k.address) + 1, type, data }); return seq.submit(side ? { ...x, side } : x, t); };
	await go(A, 'blob.in', { years: Y, ...p.open }); await assert.rejects(() => go(A, 'blob.part', p.parts[0].data), /comes with its bytes/); for (const x of p.parts) await go(A, 'blob.part', x.data, x.side); await go(A, 'transfer', { asset: 'DZY', to: poor.address, amount: dzy(2) }); await go(poor, 'transfer', { asset: 'DZY', to: B.address, amount: dzy(1) });
	for (let i = 0; i < 30; i++) await go(C, 'transfer', { asset: 'DZY', to: B.address, amount: 1 });
	const blocks = []; for (let i = 0; i < 12 && seq.waiting; i++) { const b = await seq.produce(t += 1000); blocks.push(b); assert.ok(b, 'no block'); }
	assert.equal(seq.waiting, 0); assert.equal(seq.state.blobs[p.id].heights.length, 5); assert.equal(L.balanceOf(seq.state, poor.address) < dzy(1) + 1, true);
	assert.ok(Buffer.from(F.fromBlocks(p.id, seq.state.blobs[p.id], (h) => blocks.find((x) => x.height === h))).length === 200_000); assert.ok(blocks[0].txs.filter((x) => x.from === C.address).length === 30, 'payments waited for the file'); whole(seq.state, 'seq');
	return `${blocks.length} blocks`;
});
await test('The bytes are beside the blocks, not in them: a block without its files\' bytes checks the same when old, and is refused when new; nobody can swap them', async () => {
	const s0 = await chain(); let a = structuredClone(s0); seal(a); const blocks = []; const block = async (txs) => { const m = await produceBlock(a, txs, a.time + 1000, V); blocks.push(m.block); a = commit(m.state); };
	const tx = async (type, x, plus = 1) => { const t = await L.signTx(A.secret, { chain: a.chain, from: A.address, nonce: L.nonceOf(a, A.address) + plus, type, data: x.data ?? { years: Y, ...x } }); return x.side ? { ...t, side: x.side } : t; };
	await block([]); const p = F.parts(randomBytes(80_000), 'image/png'); await block([await tx('blob.in', p.open)]); await block([await tx('blob.part', p.parts[0]), await tx('blob.part', p.parts[1], 2)]);
	const dry = blocks.map((b) => bare(JSON.parse(JSON.stringify(b)))); assert.ok(JSON.stringify(dry).length < JSON.stringify(blocks).length / 10); const end = await replay(s0, dry); assert.equal(end.last, a.last, 'a chain without the bytes is another chain');
	assert.equal(bytesOf(JSON.parse(JSON.stringify(dry[2])).txs), bytesOf(JSON.parse(JSON.stringify(blocks[2])).txs), 'a block weighs less without the bytes: nodes would disagree on the fee');
	let c = structuredClone(s0); seal(c); c = commit(await verifyBlock(c, blocks[0])); c = commit(await verifyBlock(c, blocks[1])); const now = blocks[2].time + 60_000;
	await assert.rejects(verifyBlock(c, dry[2], now), /bytes are missing/); await verifyBlock(c, dry[2], now + 3 * 86_400_000);
	const swapped = JSON.parse(JSON.stringify(blocks[2])); [swapped.txs[0].side, swapped.txs[1].side] = [swapped.txs[1].side, swapped.txs[0].side]; await assert.rejects(verifyBlock(c, swapped, now), /base64|not the part/); await verifyBlock(c, blocks[2], now);
	return `${(JSON.stringify(blocks).length / 1e3).toFixed(0)} KB with the bytes, ${(JSON.stringify(dry).length / 1e3).toFixed(1)} KB without: the same chain`;
});
await test('Rent: a file nobody renews sleeps, its bytes go, a few hundred bytes stay; whoever has it wakes it exactly; another file never passes for it; its NFT lives on', async () => {
	const s = await started(), file = randomBytes(120_000), p = F.parts(file, 'image/png'), id = await put(s, A, file); await send(s, A, 'nft.make', { blob: id, symbol: 'ART', name: 'Sunrise', copies: 2, inside: dzy(4) }); const key = Object.keys(s.assets).find((k) => s.assets[k].nft);
	await refused(s, C, 'blob.sleep', { id }, /paid for/); await send(s, B, 'blob.renew', { id, years: 1 }); s.time += Math.floor(3 * F.BLOB.yearMs); await refused(s, C, 'blob.sleep', { id }, /paid for/); s.time += F.BLOB.graceMs + 10_000;
	const big = JSON.stringify(s.blobs[id]).length, c0 = bal(s, C); await send(s, C, 'blob.sleep', { id }); assert.ok(bal(s, C) - c0 > F.BLOB.bond - 1_000); assert.ok(JSON.stringify(s.blobs[id]).length < 330 && JSON.stringify(s.blobs[id]).length < big); assert.equal(F.metadata(s, key, '').attributes[2].value, 'asleep'); whole(s, 'asleep');
	await refused(s, C, 'blob.sleep', { id }, /sleeps already/); await refused(s, A, 'blob.part', p.parts[0].data, /no parts now/, p.parts[0].side); await refused(s, A, 'blob.renew', { id, years: 1 }, /asleep/); assert.throws(() => F.fromBlocks(id, s.blobs[id], () => null), /asleep/);
	await refused(s, B, 'blob.wake', { id, hashes: F.parts(randomBytes(120_000), 'image/png').open.hashes, years: 1 }, /not its fingerprints/);
	await send(s, B, 'blob.wake', { id, hashes: p.open.hashes, years: 1 }); assert.equal(s.blobs[id].by, A.address, 'waking took the file from its owner'); for (const x of p.parts) { s.height++; await send(s, C, 'blob.part', x.data, x.side); } assert.equal(s.blobs[id].heights.length, 3); whole(s, 'awake');
	const b0 = bal(s, A); await send(s, A, 'nft.burn', { asset: key, copies: 2 }); assert.ok(bal(s, A) - b0 > dzy(8) - 1_000); await send(s, A, 'blob.close', { id }); whole(s, 'done');
	const c = F.cut(randomBytes(300_000), 'video/mp4'); await send(s, A, 'blob.out', c.data); await send(s, N1, 'stake.bond', { amount: dzy(5) }); s.time += Math.floor(Y * F.BLOB.yearMs) + 1000; await refused(s, N1, 'blob.prove', F.proofOf(c.id, 0, c.pieces[0], s.heart.day[1], N1.address), /time is over/); s.time += F.BLOB.graceMs; const pot = s.sun.feePot, f = s.blobs[c.id].fund; await send(s, C, 'blob.sleep', { id: c.id }); assert.ok(s.sun.feePot - pot >= f); whole(s, 'piece file asleep');
	await send(s, C, 'blob.wake', { id: c.id, hashes: c.data.hashes, years: 1 }); await send(s, N1, 'blob.prove', F.proofOf(c.id, 0, c.pieces[0], s.heart.day[1], N1.address)); await refused(s, A, 'blob.renew', { id: c.id, years: 101 }, /years/); await refused(s, A, 'blob.in', { ...p.open, years: 0 }, /years/); whole(s, 'woken');
	return `${big} characters awake, ${330} at most asleep`;
});
await test('Royalties: taken by the chain from every sale on its market, both ways round, in any coin; whole sales, part sales, one-tap swaps; not in pools', async () => {
	const s = await started(), id = await put(s, A, randomBytes(3_000)); await send(s, A, 'col.make', { symbol: 'SUN', name: 'Suns', royalty: 500 }); const col = Object.keys(s.cols)[0]; await refused(s, B, 'nft.make', { blob: id, symbol: 'ART', name: 'x', copies: 1, col }, /yours|owner/); await refused(s, A, 'col.make', { symbol: 'X1', name: 'x', royalty: 1_001 }, /royalty/);
	await send(s, A, 'nft.make', { blob: id, symbol: 'ART', name: 'Sunrise', copies: 10, col, traits: [['sky', 'red']] }); const key = Object.keys(s.assets).find((k) => s.assets[k].nft); assert.equal(s.cols[col].items, 1); await send(s, A, 'transfer', { asset: key, to: B.address, amount: 6 });
	let a0 = bal(s, A), b0 = bal(s, B); await send(s, B, 'offer.create', { give: { asset: key, amount: 2 }, want: { asset: 'DZY', amount: dzy(20) } }); await send(s, C, 'offer.take', { id: Object.keys(s.offers)[0] }); assert.equal(bal(s, A) - a0, dzy(1)); assert.ok(bal(s, B) - b0 > dzy(19) - 2_000 && bal(s, B) - b0 <= dzy(19)); whole(s, 'sold');
	a0 = bal(s, A); await send(s, C, 'offer.create', { give: { asset: 'DZY', amount: dzy(10) }, want: { asset: key, amount: 1 } }); b0 = bal(s, B); await send(s, B, 'offer.take', { id: Object.keys(s.offers)[0] }); assert.equal(bal(s, A) - a0, dzy(0.5)); assert.ok(bal(s, B) - b0 > dzy(9.5) - 2_000 && bal(s, B) - b0 <= dzy(9.5)); whole(s, 'sold to an offer');
	a0 = bal(s, A); await send(s, C, 'offer.create', { give: { asset: 'DZY', amount: dzy(30) }, want: { asset: key, amount: 3 } }); b0 = bal(s, B); await refused(s, B, 'swap', { give: key, want: 'DZY', amount: 1, min: dzy(10) }, /minimum/); await send(s, B, 'swap', { give: key, want: 'DZY', amount: 1, min: dzy(9.5) }); assert.equal(bal(s, A) - a0, dzy(0.5)); whole(s, 'one tap');
	await send(s, A, 'asset.create', { symbol: 'GOLD', name: 'Gold', supply: 1_000, mintable: false, decimals: 0 }); const g = Object.keys(s.assets).find((k) => s.assets[k].symbol === 'GOLD'); await send(s, A, 'transfer', { asset: g, to: C.address, amount: 500 }); const g0 = bal(s, A, g); await send(s, B, 'offer.create', { give: { asset: key, amount: 1 }, want: { asset: g, amount: 99 } }); const oid = Object.keys(s.offers).find((k) => s.offers[k].want.asset === g); await send(s, C, 'offer.take', { id: oid }); assert.equal(bal(s, A, g) - g0, 5); assert.equal(bal(s, B, g), 94); whole(s, 'in gold');
	await refused(s, B, 'pool.open', { asset: key, dzy: dzy(10), token: 1 }, /not in pools/); const md = F.metadata(s, key, ''); assert.equal(md.seller_fee_basis_points, 500); assert.equal(md.attributes.find((x) => x.trait_type === 'sky').value, 'red'); assert.equal(md.collection.name, 'Suns');
});
await test('A drop of 10,000 NFTs is ONE action; each is made when claimed, once, by whom the list names, exactly as listed, at the price, in time', async () => {
	const s = await started(), id = await put(s, A, randomBytes(3_000)); await send(s, A, 'col.make', { symbol: 'SUN', name: 'Suns', royalty: 250 }); const col = Object.keys(s.cols)[0], items = Array.from({ length: 10_000 }, (_, i) => ({ to: i % 2 ? '' : B.address, blob: id, name: 'Sun #' + i, traits: [['n', String(i)]] })), t = F.dropTree(items);
	const n0 = JSON.stringify(s).length; await send(s, A, 'drop.make', { col, root: t.root, count: 10_000, price: dzy(1), until: s.time + 86_400_000 }); const grew = JSON.stringify(s).length - n0, did = Object.keys(s.drops)[0], claim = (i) => ({ id: did, i, ...items[i], path: t.path(i) });
	const a0 = bal(s, A); await send(s, B, 'drop.claim', claim(4)); assert.equal(bal(s, A) - a0, dzy(1)); const key = Object.keys(s.assets).find((k) => s.assets[k].name === 'Sun #4'); assert.equal(bal(s, B, key), 1); assert.equal(s.assets[key].nft.royalty, 250); whole(s, 'claimed');
	await refused(s, B, 'drop.claim', claim(4), /already claimed/); await refused(s, C, 'drop.claim', claim(6), /someone else/); await refused(s, C, 'drop.claim', { ...claim(6), to: C.address }, /not item/); await refused(s, C, 'drop.claim', { ...claim(7), i: 9 }, /not item/); await refused(s, C, 'drop.claim', { ...claim(7), name: 'Sun #1' }, /not item/); await refused(s, C, 'drop.claim', { ...claim(7), traits: [['n', '1']] }, /not item/); await refused(s, C, 'drop.claim', { ...claim(7), path: t.path(9) }, /not item/); await refused(s, C, 'drop.claim', { ...claim(7), i: 10_000 }, /which item/);
	await send(s, C, 'drop.claim', claim(7)); await send(s, C, 'drop.claim', claim(9_999)); assert.equal(s.drops[did].claimed, 3); await refused(s, B, 'drop.make', { col, root: t.root, count: 5, until: s.time + 5_000 }, /yours/); await refused(s, A, 'blob.close', { id }, /still shows/); s.time += 86_400_000; await refused(s, B, 'drop.claim', claim(8), /over/); whole(s, 'drop'); return `10,000 NFTs added ${grew} characters to the chain; a claim is ${JSON.stringify(claim(7)).length} characters`;
});
await test('What marketplaces read: the ERC-721 form, with the picture, the facts to check it, and the DZY inside', async () => {
	const s = await started(), pic = await put(s, A, randomBytes(20_000)), c = F.cut(randomBytes(900_000), 'video/mp4'); await send(s, A, 'blob.out', c.data);
	await send(s, A, 'nft.make', { blob: pic, symbol: 'ART', name: 'Sunrise', desc: 'the first', copies: 5, inside: dzy(3) }); await send(s, A, 'nft.make', { blob: c.id, symbol: 'VID', name: 'Film', copies: 1, cover: pic });
	const [k1, k2] = Object.keys(s.assets).filter((k) => s.assets[k].nft), m1 = F.metadata(s, k1, 'https://n.example'), m2 = F.metadata(s, k2, 'https://n.example');
	assert.equal(m1.image, 'https://n.example/blob/' + pic); assert.equal(m1.name, 'Sunrise'); assert.equal(m1.attributes[1].value, 3); assert.equal(m2.animation_url, 'https://n.example/blob/' + c.id); assert.equal(m2.image, 'https://n.example/blob/' + pic); assert.equal(F.metadata(s, 'DZY', ''), null); assert.equal(F.blobId('in', s.blobs[pic].size, s.blobs[pic].type, m1.properties.fingerprints), pic, 'nobody can check the file from what is shown');
});
await test('800 random actions with files, NFTs and proofs, honest and hostile: every DZY and every copy accounted for', async () => {
	let seed = 9; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 8) % n; };
	const s = await started(), P = [A, B, C], outs = [], nfts = () => Object.keys(s.assets).filter((k) => s.assets[k].nft); let ok = 0; for (const k of [N1, N2]) await send(s, k, 'stake.bond', { amount: dzy(10) });
	for (let i = 0; i < 800; i++) { const k = P[rnd(3)], q = P[rnd(3)];
		try { switch (rnd(9)) {
			case 0: await put(s, k, randomBytes(200 + rnd(3_000))); break;
			case 1: { const c = F.cut(randomBytes(1_000 + rnd(20_000)), 'application/pdf'); await send(s, k, 'blob.out', c.data); outs.push(c); break; }
			case 2: { const id = Object.keys(s.blobs ?? {})[rnd(Object.keys(s.blobs ?? {}).length || 1)]; await send(s, k, 'nft.make', { blob: id, symbol: 'X' + rnd(99), name: 'n', copies: 1 + rnd(5), inside: rnd(3) * dzy(1) }); break; }
			case 3: { const n = nfts(); await send(s, k, 'nft.burn', { asset: n[rnd(n.length)], copies: 1 + rnd(3) }); break; }
			case 4: { const n = nfts(); await send(s, k, 'nft.fill', { asset: n[rnd(n.length)], each: 1 + rnd(1e6) }); break; }
			case 5: { const n = nfts(); await send(s, k, 'transfer', { asset: n[rnd(n.length)], to: q.address, amount: 1 }); break; }
			case 6: { const c = outs[rnd(outs.length)], h = [N1, N2][rnd(2)], p = rnd(16); await send(s, h, 'blob.prove', F.proofOf(c.id, p, c.pieces[rnd(8) ? p : rnd(16)], s.heart.day[1], h.address)); break; }
			case 7: await send(s, k, 'blob.close', { id: Object.keys(s.blobs ?? {})[rnd(Object.keys(s.blobs ?? {}).length || 1)] }); break;
			case 8: day(s); if (!rnd(4)) s.time += Math.floor(F.BLOB.yearMs); { const id = Object.keys(s.blobs ?? {})[rnd(Object.keys(s.blobs ?? {}).length || 1)]; if (rnd(2)) await send(s, k, 'blob.sleep', { id }); else await send(s, k, 'blob.renew', { id, years: 1 + rnd(3) }); } break;
		} ok++; } catch { /* refused */ }
		if (i % 20 === 0) whole(s, 'step ' + i); }
	whole(s, 'random'); assert.ok(ok > 200); return `${ok} done`;
});
console.log(`\n${pass} tests passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
