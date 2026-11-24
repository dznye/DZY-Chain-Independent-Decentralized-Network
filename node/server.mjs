// A Dznye node for any computer: your PC, a home server, a cheap VPS. Needs only Node 24 (no installs).
// It is the same node as the Cloudflare one (src/node.ts); only the storage (a SQLite file) and the timer differ.
//
// Follow and check another node (holds no keys, cannot create or move anything):
//   node chain/node/server.mjs --follow https://<the main node> --data ./chain-data
// Run a chain as its validator (holds a validator key; read chain/README.md first):
//   node chain/node/server.mjs --env chain/worker/.dev.vars --data ./chain-data
//
// Options: --port 8787   --host 127.0.0.1 (use 0.0.0.0 to let other computers reach it)   --data <folder>
//          --follow <url>   --env <file of NAME=value lines>   Settings also come from the environment:
//          CHAIN, AUTHORITY_ADDRESS, VALIDATOR_ADDRESS, VALIDATOR_SECRET, VALIDATORS, PEERS, BLOCK_MS,
//          FEE (DZY parts paid per transaction, fixed when the chain starts; default 0),
//          SOLANA_RPC, BTC_RPC (Esplora API addresses) and EVM_RPC_ETH, _BASE, _ARB, _OP, _POLYGON, _BSC, _AVAX (validators: this node's own nodes for
//          other chains, comma-separated; unset = free public nodes. See GET /status/links for what it can reach),
//          SNAPSHOT_EVERY (keep a snapshot every this many blocks; default 1000),
//          SNAPSHOT_FROM + TRUST_HASH (an empty node starts from another node's snapshot, if its block has that hash),
//          GENESIS (a genesis file from `cli.mjs genesis new`: sets CHAIN, AUTHORITY_ADDRESS, VALIDATORS and FEE, and
//          checks its hash), HALT_HEIGHT (stop at that block for a planned upgrade),
//          PUBLIC_URL (this node's public address: other nodes learn of it and can copy the chain from it),
//          CHECKER_ADDRESS, CHECKER_SECRET (a follower only: a key with 1 DZY or more staked; the node checks in with it
//          a few times an hour and earns a checker's share of the validators' wage on days it stayed active),
//          OPERATOR + OPERATOR_SIG (a volunteer node: the staked account vouching for it, and its signature of the
//          PUBLIC_URL; `node chain/cli.mjs volunteer sign` makes them; the account needs 1% of a seat staked)
// --follow takes several sources, comma-separated: nodes (http addresses) and archives (folders, or addresses ending in
// /index.json; see chain/archive.mjs). It copies from all of them, checks everything, and finds more through /peers.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { lendSha256 } from '../src/crypto.ts';
import { mediaKeeper } from './media.mjs';
import { blobKeeper } from './blobs.mjs';
import { decoderPool } from './evmpool.mjs';
import { fingerprint, sealed } from '../launch/seal.mjs';
import { lendDecoder } from '../src/evmledger.ts';
import { fileKeeper } from './files.mjs';
import { RULES } from '../src/ledger.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { NodeCore } from '../src/node.ts';
import { loadState as loadRows, loadTree, saveState, stateTables } from '../src/statestore.ts';
import { nodesFromEnv } from '../src/dip.ts';
import { genesis, sunGenesis } from '../src/ledger.ts';
import { archiveSource } from '../archive.mjs';

const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'x-content-type-options': 'nosniff' };

function openStore(dataDir) {
	if (dataDir) mkdirSync(dataDir, { recursive: true });
	const db = new DatabaseSync(dataDir ? join(dataDir, 'chain.sqlite') : ':memory:');
	// One node per data folder: two nodes writing the same chain would split it. The lock lasts until this node stops.
	try { db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;'); } catch { db.close(); throw new Error('Another node is already using this data folder'); }
	db.exec(`CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, json TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS mempool (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);`);
	const meta = (k) => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
	// the state, one row per entry (src/statestore.ts): a block writes what it changed, not the whole state
	const q = (sql, ...a) => db.prepare(sql).all(...a);
	stateTables(q);
	const store = {
		loadState() { const rows = loadRows(q, () => meta('state-rest')); if (rows) return rows; const v = meta('state'); return v ? JSON.parse(v) : null; },
		loadTree(state, root) { return loadTree(q, state, root); },
		commit(block, state, taken) {
			db.exec('BEGIN');
			try {
				db.prepare('INSERT INTO blocks (height, json) VALUES (?, ?)').run(block.height, JSON.stringify(block));
				saveState(q, state, block.stateRoot, (text) => db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('state-rest', ?)").run(text));
				db.prepare("DELETE FROM meta WHERE k = 'state'").run();
				if (taken > 0) db.prepare('DELETE FROM mempool WHERE seq IN (SELECT seq FROM mempool ORDER BY seq LIMIT ?)').run(taken);
				db.exec('COMMIT');
			} catch (e) { db.exec('ROLLBACK'); throw e; }
		},
		queueAdd(tx) { db.prepare('INSERT INTO mempool (json) VALUES (?)').run(JSON.stringify(tx)); },
		queueList() { return db.prepare('SELECT seq, json FROM mempool ORDER BY seq').all().map((r) => ({ seq: r.seq, tx: JSON.parse(r.json) })); },
		queueDrop(seq) { db.prepare('DELETE FROM mempool WHERE seq = ?').run(seq); },
		block(height) { const r = db.prepare('SELECT json FROM blocks WHERE height = ?').get(height); return r ? JSON.parse(r.json) : null; },
		blocks(from, limit) { return db.prepare('SELECT json FROM blocks WHERE height >= ? ORDER BY height LIMIT ?').all(from, limit).map((r) => JSON.parse(r.json)); },
		rewrite(block) { db.prepare('UPDATE blocks SET json = ? WHERE height = ?').run(JSON.stringify(block), block.height); },
		noteGet(key) { return meta('note:' + key); },
		noteSet(key, value) { db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('note:' + key, value); }
	};
	return { db, store, meta, setMeta: (k, v) => db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v) };
}

const getJson = (base) => async (path) => {
	const r = await fetch(base.replace(/\/+$/, '') + path, { signal: AbortSignal.timeout(15_000) });
	if (!r.ok) throw new Error(`${path}: ${r.status}`);
	return r.json();
};
/** where a follower can copy the chain from: a node (an http address), or an archive (a folder, or an address
    ending in /index.json). Several, comma-separated, make a swarm: each is checked, none is trusted. */
const MAX_SOURCES = 32;
const isArchive = (where) => !/^https?:\/\//.test(where) || /\/index\.json$/.test(where);
function sourceOf(where) {
	const url = where.replace(/\/+$/, '');
	if (isArchive(url)) return { where: url, archive: true, get: archiveSource(url) };
	const get = getJson(url); get.label = url;
	return { where: url, archive: false, get };
}

/** Start a node. Returns { url, core, sync, stop }.
    follow: copy and check that node (holds no key).
    validator ({ address, secret }): this node's validator key. With no `validators` list the chain has one validator,
      the authority address, and this node makes the blocks.
    validators + peers (the other validators' URLs): be one of several validators.
    snapshotFrom + trust: an empty node starts from that node's latest snapshot instead of block 1, if the snapshot's
      block has exactly the hash `trust` (get it from several nodes' GET /). snapshotEvery: how often to keep one. */
const SEAL = { seal: fingerprint().seal, sealed: sealed()?.seal ?? null };
const pool = decoderPool(); lendDecoder((raws, chainId) => pool.decode(raws, chainId));
await lendSha256((s) => createHash('sha256').update(s, 'utf8').digest('hex'));
export async function startNode({ dataDir = null, port = 8787, host = '127.0.0.1', sun, chain, authority, blockMs, blockBytes = 8_000_000, blobMb = 0, blobRefuse = null, follow, followMs = 2000, validators, validator, checker, peers = [], timeouts, fee, snapshotEvery, snapshotFrom, trust, genesisFile, haltHeight, publicUrl, operator, allowLocalPeers, solana, solanaRpc, evm, evmRpc, btc, btcRpc, btcTestFloor, priceRead, xFinalDepth, watchMs = 5000, mediaFrom = 'https://wallet.dznye.com', mediaMs = 10 * 60_000 } = {}) {
	const sources = String(follow ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(sourceOf);
	const firstNode = sources.find((s) => !s.archive)?.where;
	if (genesisFile) { // one file every operator of a chain shares: the chain is exactly this, or the node does not start
		const g = JSON.parse(readFileSync(genesisFile, 'utf8'));
		if (g?.sun) { // a chain with the Sun: the file is its genesis settings and the hash they must give
			if (typeof g.hash !== 'string' || (await sunGenesis(g.sun)).last !== g.hash) throw new Error('The genesis file\'s hash does not match its own settings: it was changed, or made by different software');
			sun = g.sun;
		} else {
			if (!g || typeof g.chain !== 'string' || !Array.isArray(g.validators) || typeof g.hash !== 'string') throw new Error('That is not a genesis file');
			chain = g.chain; authority = g.authority; validators = g.validators; fee = g.fee ?? 0;
			// checked before anything starts: a refused node must leave nothing running
			if ((await genesis(chain, authority, 0, validators, fee)).last !== g.hash) throw new Error('The genesis file\'s hash does not match its own settings: it was changed, or made by different software');
		}
	}
	if (follow && validator) throw new Error('A node either follows or leads, not both');
	if (validator && !validators) validators = [validator.address]; // a chain run by this one validator
	const { db, store, meta, setMeta } = openStore(dataDir);
	if (follow && !sun) {
		// a chain with the Sun: its own genesis settings come with /genesis
		for (const s of sources) { if (sun) break; try { const g = await s.get('/genesis'); if (g?.sunGenesis) sun = g.sunGenesis; else break; } catch { /* try the next one */ } }
	}
	if (follow && !sun) {
		// Which chain is this? Use what we were told, else what we wrote down last time, else ask once and write it down.
		const pinned = JSON.parse(meta('follows') ?? 'null');
		if (!chain || !authority || !validators || fee === undefined) {
			// the STARTING settings (/genesis), not today's validators: the set can change through staking
			let info = pinned;
			for (const s of sources) { if (info) break; try { info = await s.get('/genesis'); } catch { /* try the next one */ } }
			if (!info) { db.close(); throw new Error('None of the sources answered'); }
			chain ??= info.chain; authority ??= info.authority; validators ??= info.validators; fee ??= info.fee ?? 0;
		}
		const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
		if (pinned && (pinned.chain !== chain || pinned.authority !== authority || !same(pinned.validators, validators) || (pinned.fee ?? 0) !== fee)) { db.close(); throw new Error('This data folder belongs to a different chain'); }
		if (!pinned) setMeta('follows', JSON.stringify({ chain, authority, validators, fee }));
	}
	let timer = null, timerAt = 0, loop = null, stopped = false;
	const timers = new Set(), inFlight = new Map();
	const net = { // how this validator reaches the others
		peers: peers.map((p) => p.replace(/\/+$/, '')),
		post(peer, path, body) { // at most 64 messages on their way to one node: a slow or dead one never piles up memory here
			const n = inFlight.get(peer) ?? 0;
			if (stopped || n >= 64) return;
			inFlight.set(peer, n + 1);
			fetch(peer + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(4000) }).then((r) => r.arrayBuffer()).catch(() => {}).finally(() => { const left = (inFlight.get(peer) ?? 1) - 1; if (left > 0) inFlight.set(peer, left); else inFlight.delete(peer); });
		},
		get: (peer, path) => getJson(peer)(path),
		timer(ms, run) { if (stopped) return; const t = setTimeout(() => { timers.delete(t); if (!stopped) run(); }, ms); timers.add(t); }
	};
	const wake = (ms) => { // the earliest wake-up asked for wins: a payment must not wait for a later, idle one
		if (timer && timerAt <= Date.now() + ms) return;
		if (timer) clearTimeout(timer);
		timerAt = Date.now() + ms;
		timer = setTimeout(async () => {
			timer = null;
			try { await core.tick(); } catch (e) { console.error('Could not store a block; stopping so nothing runs ahead of the disk.', e); process.exitCode = 1; await stop(); }
		}, ms);
	};
	let snapshot;
	if (snapshotFrom && !meta('state')) {
		if (!trust) { db.close(); throw new Error('Starting from a snapshot needs the hash of its block to trust (TRUST_HASH)'); }
		try { snapshot = { ...(await getJson(snapshotFrom)('/snapshot')), trust }; } catch (e) { db.close(); throw new Error('Could not fetch the snapshot: ' + e.message); }
	}
	const core = new NodeCore({ sun, chain, authority, blockMs, blockBytes, leader: firstNode, validators, validator, checker: follow ? checker : undefined, timeouts, fee, snapshotEvery, snapshot, haltHeight, selfUrl: publicUrl, operator, allowLocalPeers, solana, solanaRpc, evm, evmRpc, btc, btcRpc, btcTestFloor, priceRead, xFinalDepth }, store, wake, net);
	await core.start();
	if (core.broken) { db.close(); throw new Error(core.broken); }

	/* Creators' pictures (media.mjs): a node with a data folder keeps every public picture the chain points at, copied once
	   from other nodes first and the wallet's site last, each checked against its fingerprint. */
	const mediaSources = () => [...(sources ?? []).filter((x) => !x.archive).map((x) => x.where), ...(mediaFrom ? [mediaFrom] : [])];
	const media = dataDir ? mediaKeeper({ dir: join(dataDir, 'media'), sources: mediaSources }) : null;
	/* Files that last (blobs.mjs): small ones rebuilt from this node's blocks; pieces of big ones kept up to blobMb megabytes */
	const blobs = blobKeeper({ dir: dataDir && blobMb ? join(dataDir, 'blobs') : null, budget: blobMb * 1_000_000, refuseFile: blobRefuse, state: () => core.state, block: (h) => store.block(h), sources: () => [...new Set([...net.peers, ...core.peers().filter((u) => u !== publicUrl)])] });
	// creators' files, encrypted (files.mjs): only where the owner gives them room (FILES_MB, 0 by default)
	const fileRoom = Math.max(0, Math.floor(Number(process.env.FILES_MB ?? 0) || 0)) * 1_000_000;
	const files = dataDir ? fileKeeper({ dir: join(dataDir, 'files'), budget: fileRoom, sources: mediaSources, founder: RULES.saleFeeTo }) : null;
	/* the live price stream's listeners: told after a block only when DZY's price moved 0.1% or more since the last word */
	const listeners = new Set(), MAX_LISTENERS = 5_000; let lastSaid = null;
	const priceNow = async () => (await core.handle({ method: 'GET', path: '/price', query: new URLSearchParams(), body: '', auth: '', ip: 'self' })).body;
	core.onBlock = () => {
		if (!listeners.size) return; // nobody listening: nothing to work out
		priceNow().then((p) => {
			if (!p?.price || (lastSaid && Math.abs(p.price - lastSaid) * 1000 < lastSaid)) return; // under 0.1%: nothing to say
			lastSaid = p.price; const line = `data: ${JSON.stringify(p)}\n\n`;
			for (const res of listeners) { try { res.write(line); } catch { listeners.delete(res); } }
		}).catch(() => {});
	};
	const keepAlive = setInterval(() => { for (const res of listeners) { try { res.write(': still here\n\n'); } catch { listeners.delete(res); } } }, 50_000); keepAlive.unref?.();
	const server = createServer(async (req, res) => {
		try {
			if (req.method === 'GET' && req.url === '/seal') { res.writeHead(200, HEADERS).end(JSON.stringify({ ...SEAL })); return; } // which rules this node runs (launch/seal.mjs)
			if (req.url?.startsWith('/blob/') && (req.method === 'GET' || req.method === 'POST')) {
				const list = []; let n = 0; if (req.method === 'POST') for await (const c of req) { n += c.length; if (n > 66_000_000) break; list.push(c); }
				const r = n > 66_000_000 ? { status: 413, text: 'Too big' } : await blobs.handle(req.method, new URL(req.url, 'http://n').pathname, Buffer.concat(list), req.headers.range);
				if (r) { res.writeHead(r.status, r.head ?? { ...HEADERS, 'content-type': 'text/plain' }).end(r.bytes ? Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length) : r.text); return; }
			}
			if (req.method === 'OPTIONS') { res.writeHead(204, HEADERS).end(); return; }
			let body = '';
			const cap = (req.url ?? '').startsWith('/consensus') ? 10_600_000 : (req.url ?? '').startsWith('/evm') ? 420_000 : 140_000; // a proposal carries a whole block; a deploy carries a program
			if (req.method === 'POST') for await (const chunk of req) { body += chunk; if (body.length > cap) break; }
			if (body.length > cap) { res.writeHead(413, { ...HEADERS, connection: 'close' }).end(JSON.stringify({ error: 'Too big' })); return; } // (the rest of it is not read)
			const url = new URL(req.url ?? '/', 'http://node');
			// creators' pictures this node keeps (media.mjs): served at the same address the chain's records use
			if (req.method === 'GET' && url.pathname.startsWith('/media/') && media) {
				const m = media.serve(url.pathname);
				if (m) { res.writeHead(200, { ...HEADERS, 'content-type': m.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }).end(m.body); return; }
				res.writeHead(404, HEADERS).end(JSON.stringify({ error: 'This node does not keep that picture' })); return;
			}
			if (req.method === 'GET' && url.pathname.startsWith('/file/') && files) {
				const m = files.serve(url.pathname);
				if (m) { res.writeHead(200, { ...HEADERS, 'content-type': m.type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" }).end(m.body); return; }
				res.writeHead(404, HEADERS).end(JSON.stringify({ error: 'This node does not keep that file' })); return;
			}
			// the live price (GET /price/stream): the connection stays open and hears DZY's price only when a block moved it
			// 0.1% or more (a buy, a sell, a coin in the reserve moving); while nothing moves, nothing is sent but a few
			// bytes every 50 seconds so the line is not dropped. The wallet uses it only when switched on (exchange.js)
			if (req.method === 'GET' && url.pathname === '/price/stream') {
				if (listeners.size >= MAX_LISTENERS) { res.writeHead(503, HEADERS).end(JSON.stringify({ error: 'Too many listening: ask GET /price instead' })); return; }
				res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
				const now = await priceNow(); if (lastSaid === null && now?.price) lastSaid = now.price; // the price just told is the one to move from
				res.write(`data: ${JSON.stringify(now)}\n\n`); listeners.add(res); req.on('close', () => listeners.delete(res)); return;
			}
			const out = await core.handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, auth: req.headers.authorization ?? '', ip: req.socket.remoteAddress ?? 'unknown' });
			res.writeHead(out.status, HEADERS).end(JSON.stringify(out.body));
		} catch (e) { if (e?.code === 'ECONNRESET' || req.destroyed || res.headersSent) { res.destroy(); return; } res.writeHead(500, HEADERS).end(JSON.stringify({ error: 'The node hit an error' })); console.error(e); } // (a caller that hung up is nobody's error: not a line in the log)
	});
	// slow or endless requests, and crowds of open connections, cannot tie this node up
	server.headersTimeout = 10_000; server.requestTimeout = 20_000; server.keepAliveTimeout = 5_000; server.maxConnections = 2_000; server.maxHeadersCount = 64;
	await new Promise((ok, bad) => server.once('error', bad).listen(port, host, ok));

	/* Following a swarm: every round, copy from every source (a lying one raises an alert; a dead one is skipped), then
	   learn of more nodes from the nodes' /peers lists, keeping only those that hold this very chain. A node with a
	   public address tells the others about itself, so the swarm grows by itself. */
	const known = new Set(sources.map((s) => s.where));
	const swarm = sources.length > 1;
	let announced = false, round = 0, peersAsked = 0;
	const LIGHT = followMs >= 10_000, PEERS_EVERY = LIGHT ? 30 * 60_000 : 0, QUIET_MS = 100_000; // LIGHT: a home node (runner.mjs), which need not be there the same second
	async function sync() {
		let added = 0, reached = 0;
		// other nodes first, in a new order each time; the first source (the live node, on Cloudflare) only now and then, when
		// the others are behind, or when there are no others: a thousand nodes keep each other up to date, not a thousand times it
		const rest = sources.slice(1).filter((s) => !s.archive).sort(() => Math.random() - 0.5), fresh = () => Date.now() - core.state.time < QUIET_MS;
		const list0 = LIGHT && rest.length ? [...sources.filter((s) => s.archive && !fresh()), ...rest.slice(0, 4), ...(sources[0] && !sources[0].archive ? [sources[0]] : [])] : [...sources];
		round++;
		for (const s of list0) {
			if (LIGHT && s === sources[0] && !s.archive && rest.length && reached >= 2 && fresh() && round % 15 !== 1) break;
			try { added += await core.follow(s.get, { behindOk: swarm || s.archive, label: s.archive ? 'archive ' + s.where : s.where }); reached++; } catch { /* unreachable: try the others */ }
		}
		if (!reached && sources.length) throw new Error('No source answered');
		if (Date.now() - peersAsked < PEERS_EVERY && !(publicUrl && !announced)) return added; // who else there is changes slowly
		peersAsked = Date.now();
		for (const s of sources.filter((x) => !x.archive)) {
			if (publicUrl && !announced) fetch(s.where + '/peers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: publicUrl }), signal: AbortSignal.timeout(5000) }).catch(() => {});
			if (sources.length >= MAX_SOURCES) continue;
			let list = [];
			try { list = (await s.get('/peers')).peers ?? []; } catch { continue; }
			for (const url of list) {
				if (typeof url !== 'string' || known.has(url.replace(/\/+$/, '')) || url === publicUrl || sources.length >= MAX_SOURCES) continue;
				known.add(url.replace(/\/+$/, ''));
				try { if ((await getJson(url)('/genesis')).last === core.genesis.last) { sources.push(sourceOf(url)); await core.addPeer(url).catch(() => {}); } } catch { /* not answering: forget it */ }
			}
		}
		announced = true;
		return added;
	}
	if (follow && followMs > 0) {
		const again = async () => {
			if (stopped) return;
			try { await sync(); } catch { /* the leader is unreachable: keep what we have and try again */ }
			if (core.alert) console.error('ALERT:', core.alert);
			// a checker: a few times an hour, the block it checked, sent to the first live node it follows
			try {
				const tx = checker ? await core.checkerTx(Date.now()) : null, to = sources.find((x) => !x.archive);
				if (tx && to) {
					const r = await fetch(to.where + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }), signal: AbortSignal.timeout(5000) });
					if (!r.ok) console.error('Check-in refused:', (await r.json().catch(() => ({}))).error ?? r.status);
				}
			} catch (e) { console.error('Check-in not sent:', e.message); }
			// a block comes about once a minute when nothing happens: a follower that has the newest waits for the next one
			const since = Date.now() - core.state.time, wait = LIGHT && round > 5 && since >= 0 && since < 50_000 ? Math.max(followMs, 58_000 - since + Math.random() * 8_000) : followMs;
			if (!stopped) loop = setTimeout(again, wait);
		};
		again();
	}
	// a validator looks on Solana for payments of cross-chain offers every few seconds (when it has a Solana node to ask)
	const watcher = validator ? setInterval(() => { core.watch().catch(() => {}); }, watchMs) : null;
	// files: copy a piece too few keep, and show once a chain day the ones this validator keeps
	const blobRound = async () => {
		if (stopped || !blobMb) return;
		try { await blobs.round(); if (validator && core.seq) for (const data of blobs.proofs(validator.address)) await core.sendOwn('blob.prove', data); } catch { /* next time */ }
	};
	const blobTimer = blobMb ? setInterval(blobRound, Math.max(2_000, watchMs * 12)) : null;
	// the pictures: a first round a little after start, then every mediaMs (gentle: at most 40 new pictures a round)
	const mediaRound = () => { if (!stopped && media) media.round(core.state).then((n) => { if (n) console.log(`Kept ${n} more creator picture${n > 1 ? 's' : ''}`); }).catch(() => {}); if (!stopped && files) files.round(core.state).then((n) => { if (n) console.log('Kept one more creator file (encrypted)'); }).catch(() => {}); };
	const mediaFirst = media && mediaMs > 0 ? setTimeout(mediaRound, 30_000) : null, mediaTimer = media && mediaMs > 0 ? setInterval(mediaRound, mediaMs) : null;
	async function stop() {
		if (stopped) return; stopped = true;
		core.stop();
		clearTimeout(timer); clearTimeout(loop); clearInterval(watcher); clearInterval(blobTimer); clearTimeout(mediaFirst); clearInterval(mediaTimer); for (const t of timers) clearTimeout(t);
		clearInterval(keepAlive); for (const res of listeners) { try { res.end(); } catch { /* gone */ } } listeners.clear(); // the live price stream
		await new Promise((ok) => { server.close(ok); server.closeAllConnections(); });
		try { db.close(); } catch { /* already closed */ }
	}
	return { url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`, core, sync, stop, net, port: server.address().port, sources: () => sources.map((s) => s.where), media, blobs, blobRound };
}

// run from the command line
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
	const env = { ...process.env };
	if (arg('env')) for (const line of readFileSync(arg('env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; }
	const follow = arg('follow');
	const node = await startNode({
		dataDir: arg('data') ?? './chain-data', port: Number(arg('port') ?? 8787), host: arg('host') ?? '127.0.0.1', follow,
		chain: env.CHAIN ?? (follow ? undefined : 'dznye-dev-1'), authority: env.AUTHORITY_ADDRESS, blockMs: Number(env.BLOCK_MS) || undefined,
		fee: env.FEE !== undefined ? Number(env.FEE) : follow ? undefined : 0,
		snapshotEvery: env.SNAPSHOT_EVERY !== undefined ? Number(env.SNAPSHOT_EVERY) : undefined,
		snapshotFrom: env.SNAPSHOT_FROM || arg('snapshot-from'), trust: env.TRUST_HASH || arg('trust'),
		genesisFile: env.GENESIS || arg('genesis'), haltHeight: Number(env.HALT_HEIGHT || arg('halt-height')) || undefined,
		publicUrl: env.PUBLIC_URL || arg('public-url'),
		// a volunteer node: the staked account vouching for it (cli.mjs volunteer sign prints these three)
		operator: env.OPERATOR ? { address: env.OPERATOR, sig: env.OPERATOR_SIG, ...(env.OPERATOR_SIGNER ? { signer: env.OPERATOR_SIGNER } : {}) } : undefined,
		...nodesFromEnv(env),
		// VALIDATOR_ADDRESS / VALIDATOR_SECRET = this node's validator key.
		// Several validators: VALIDATORS = every validator's address, PEERS = the other validators' URLs (comma-separated).
		validators: env.VALIDATORS ? env.VALIDATORS.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
		validator: !follow && env.VALIDATOR_SECRET ? { address: env.VALIDATOR_ADDRESS, secret: env.VALIDATOR_SECRET } : undefined,
		// CHECKER_ADDRESS / CHECKER_SECRET = a follower's checker key (1 DZY or more staked): it checks in and earns a checker's share
		checker: follow && env.CHECKER_SECRET ? { address: env.CHECKER_ADDRESS, secret: env.CHECKER_SECRET } : undefined,
		peers: env.PEERS ? env.PEERS.split(',').map((v) => v.trim()).filter(Boolean) : []
	});
	const s = node.core.state;
	console.log(`Dznye node (${node.core.leads ? (s.validators.length > 1 ? 'one of ' + s.validators.length + ' validators' : 'the only validator') : follow ? 'follower of ' + follow : 'read-only'}) on ${node.url}`);
	console.log(`chain ${s.chain}, block ${s.height}, authority ${s.authority}`);
	for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => node.stop().then(() => process.exit(0)));
}
