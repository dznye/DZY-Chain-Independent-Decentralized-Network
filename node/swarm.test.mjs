// Copies of the chain everywhere: archives (plain files, kept anywhere) and a swarm of nodes that find each other.
// Nothing copied is trusted: every block is checked again. Run: node chain/node/swarm.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newKey } from '../src/crypto.ts';
import { Client } from '../src/client.ts';
import { updateArchive } from '../archive.mjs';
import { startNode } from './server.mjs';

const CHAIN = 'dznye-swarm-test';
const auth = await newKey(), alice = await newKey();
const dir = mkdtempSync(join(tmpdir(), 'dznye-swarm-'));
const open = [];
const track = async (p) => { const n = await p; open.push(n); return n; };
const get = async (n, p) => (await fetch(n.url + p)).json();
const grant = (c, n) => c.send(auth, 'mint', { asset: 'DZY', to: alice.address, amount: n });
const sha = (t) => createHash('sha256').update(t).digest('hex');
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!(await cond())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };
let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };

try {
	const leader = await track(startNode({ port: 0, chain: CHAIN, authority: auth.address, validator: auth, blockMs: 30, allowLocalPeers: true }));
	const c = new Client(leader.url);
	for (let i = 1; i <= 7; i++) await grant(c, i); // blocks 1..7
	const arch = join(dir, 'archive');

	await test('an archive: plain files in fixed ranges; finished files never change when it is brought up to date', async () => {
		let idx = await updateArchive(leader.url, arch, { chunk: 3 });
		assert.deepEqual(idx.files.map((f) => [f.from, f.to]), [[1, 3], [4, 6], [7, 7]]);
		assert.equal(idx.height, 7); assert.equal(idx.last, (await get(leader, '/')).last);
		const first = readFileSync(join(arch, idx.files[0].file), 'utf8');
		for (let i = 8; i <= 10; i++) await grant(c, i); // blocks 8..10
		idx = await updateArchive(leader.url, arch, { chunk: 3 });
		assert.deepEqual(idx.files.map((f) => [f.from, f.to]), [[1, 3], [4, 6], [7, 9], [10, 10]]);
		assert.equal(readFileSync(join(arch, idx.files[0].file), 'utf8'), first); // untouched: any copy of it stays good
		const other = await track(startNode({ port: 0, chain: 'dznye-other-x', authority: auth.address, validator: auth, blockMs: 30 }));
		await assert.rejects(updateArchive(other.url, arch), /different chain/);
	});

	await test('a node starts from an archive alone, checking every block, then carries on from a live node', async () => {
		const f = await track(startNode({ port: 0, follow: arch, followMs: 0 }));
		await f.sync();
		assert.equal(f.core.state.height, 10); assert.equal(f.core.alert, '');
		await grant(c, 11); // block 11: the archive does not have it
		const g = await track(startNode({ port: 0, follow: `${arch},${leader.url}`, followMs: 0 }));
		await g.sync();
		assert.equal(g.core.state.height, 11); assert.equal(g.core.alert, ''); // an archive that is behind is not suspicious
		assert.equal(g.core.state.last, (await get(leader, '/')).last);
	});

	await test('a damaged archive is refused; a doctored one (index changed to match) raises an alert', async () => {
		const bad = join(dir, 'damaged'); await updateArchive(leader.url, bad, { chunk: 3 });
		const idx = JSON.parse(readFileSync(join(bad, 'index.json'), 'utf8'));
		const f0 = join(bad, idx.files[1].file), blocks = JSON.parse(readFileSync(f0, 'utf8'));
		blocks[0].txs[0].data.amount = 999_999; // someone gives alice more
		writeFileSync(f0, JSON.stringify(blocks));
		const n1 = await track(startNode({ port: 0, follow: bad, followMs: 0, chain: CHAIN, authority: auth.address, validators: [auth.address], fee: 0 }));
		await assert.rejects(n1.sync(), /No source answered/); // the file does not match its index: not used at all
		assert.equal(n1.core.state.height, 0);
		idx.files[1].sha256 = sha(JSON.stringify(blocks)); writeFileSync(join(bad, 'index.json'), JSON.stringify(idx)); // and hides it in the index too
		const n2 = await track(startNode({ port: 0, follow: bad, followMs: 0, chain: CHAIN, authority: auth.address, validators: [auth.address], fee: 0 }));
		await n2.sync();
		assert.equal(n2.core.state.height, 3); // keeps the good blocks before it
		assert.match(n2.core.alert, /Block 4 from archive .* breaks the rules/);
	});

	await test('the swarm: a node finds others it was never told about, and carries on when its only source dies', async () => {
		// A follows the leader and has a public address: it tells the leader about itself, and learns the leader's list
		const port = await freePort(), Aurl = `http://127.0.0.1:${port}`;
		const A = await track(startNode({ port, follow: leader.url, followMs: 0, allowLocalPeers: true, publicUrl: Aurl }));
		await A.sync();
		await until(async () => (await get(leader, '/peers')).peers.includes(Aurl)); // the leader checked A and keeps it
		assert.ok((await get(A, '/peers')).peers.includes(Aurl), 'A lists itself');
		// B is told only about A; it learns of the leader through A (A passed it on after checking it)
		await A.core.addPeer(leader.url);
		const B = await track(startNode({ port: 0, follow: Aurl, followMs: 0, allowLocalPeers: true }));
		await B.sync();
		assert.ok(B.sources().includes(leader.url), 'B found the leader through A');
		// A goes away; B keeps up from the leader it found
		await A.stop(); open.splice(open.indexOf(A), 1);
		await grant(c, 12);
		await B.sync();
		assert.equal(B.core.state.height, (await get(leader, '/')).height); assert.equal(B.core.alert, '');
	});

	await test('a lying node in the swarm raises an alert; the true chain is kept', async () => {
		const g = await get(leader, '/genesis'), info = await get(leader, '/');
		const liar = createServer((q, r) => {
			r.setHeader('content-type', 'application/json');
			if (q.url === '/genesis') return r.end(JSON.stringify(g));
			if (q.url.startsWith('/blocks')) return r.end(JSON.stringify({ blocks: [] }));
			if (q.url === '/peers') return r.end(JSON.stringify({ peers: [] }));
			r.end(JSON.stringify({ ...info, last: 'f'.repeat(64) })); // claims a different newest block at the same height
		});
		await new Promise((ok) => liar.listen(0, '127.0.0.1', ok));
		try {
			const L = `http://127.0.0.1:${liar.address().port}`;
			const n = await track(startNode({ port: 0, follow: `${leader.url},${L}`, followMs: 0, allowLocalPeers: true }));
			await n.sync();
			assert.equal(n.core.state.last, info.last); // the true chain
			assert.match(n.core.alert, new RegExp(`${L.replace(/[.]/g, '\\.')} shows a different block`));
		} finally { liar.closeAllConnections(); liar.close(); }
	});

	await test('announcements are checked: private addresses, other chains and junk are refused', async () => {
		const strict = await track(startNode({ port: 0, chain: CHAIN, authority: auth.address, validator: auth, blockMs: 30 })); // a public node: no private peers
		const say = async (n, url) => { const r = await fetch(n.url + '/peers', { method: 'POST', body: JSON.stringify({ url }) }); return { status: r.status, ...(await r.json()) }; };
		assert.match((await say(strict, leader.url)).error, /private address/);
		for (const bad of ['ftp://x', 'not a url', 'http://' + 'a'.repeat(300), 7, null]) assert.equal((await say(strict, bad)).status, 400);
		const other = await track(startNode({ port: 0, chain: 'dznye-other-y', authority: auth.address, validator: auth, blockMs: 30 }));
		assert.match((await say(leader, other.url)).error, /does not hold this chain/);
		assert.equal((await say(leader, 'http://127.0.0.1:9')).error, 'That address did not answer');
		const twin = await track(startNode({ port: 0, follow: leader.url, followMs: 0 }));
		assert.equal((await say(leader, twin.url)).ok, true);
		assert.ok((await get(leader, '/peers')).peers.includes(twin.url));
	});
	console.log(`\n${pass} tests passed`);
} finally {
	for (const n of open) await n.stop().catch(() => {});
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the files for a moment */ }
}
