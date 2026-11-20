#!/usr/bin/env node
// A copy of the whole chain as plain files, to keep anywhere: a folder, a USB stick, a git repository, a web server,
// Cloudflare R2, IPFS. Nothing in it needs to be trusted: a node that starts from an archive checks every block,
// exactly as if it came from a node. The more places hold one, the harder the chain is to lose or to rewrite.
//
//   node chain/archive.mjs update --node https://chain.dznye.com/api --out ./dznye-archive
//        make or bring up to date (only new blocks are fetched; finished files never change)
//   node chain/node/server.mjs --follow ./dznye-archive,https://chain.dznye.com/api --data ./dznye-data
//        a node that starts from the archive (folder or URL) and carries on from live nodes
//
// Layout:  index.json                       what is here: the chain, its genesis, the height, every file and its sha-256
//          blocks/000000001-000001000.json  blocks 1 to 1000, as a JSON list (the last file may be partial)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { blockHash } from './src/block.ts';

export const FORMAT = 'dznye-archive-1';
export const CHUNK = 1000;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const pad = (n) => String(n).padStart(9, '0');
const nameOf = (from, to) => `blocks/${pad(from)}-${pad(to)}.json`;
const json = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${url} answered ${r.status}`); return r.json(); };

/** Bring the archive in `dir` up to date from a node. Returns the new index. */
export async function updateArchive(node, dir, { chunk = CHUNK } = {}) {
	node = node.replace(/\/+$/, '');
	mkdirSync(join(dir, 'blocks'), { recursive: true });
	const genesis = await json(node + '/genesis');
	const file = join(dir, 'index.json');
	let index = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
	if (index && (index.format !== FORMAT || index.genesisHash !== genesis.last)) throw new Error('That folder holds an archive of a different chain');
	index ??= { format: FORMAT, chain: genesis.chain, genesisHash: genesis.last, genesis, chunk, height: 0, last: genesis.last, files: [] };
	// the last file may be partial: start again from its first block so it is rewritten whole
	let from = index.height + 1;
	const tail = index.files.at(-1);
	let carried = [];
	if (tail && tail.to - tail.from + 1 < index.chunk) {
		carried = JSON.parse(readFileSync(join(dir, tail.file), 'utf8'));
		index.files.pop(); rmSync(join(dir, tail.file), { force: true });
	}
	const top = (await json(node + '/')).height;
	// files cover fixed ranges (1-1000, 1001-2000, ...): a finished file never changes, so copies of it stay valid for ever
	let batch = carried, newest = null;
	const flush = () => {
		if (!batch.length) return;
		const text = JSON.stringify(batch), f = { file: nameOf(batch[0].height, batch.at(-1).height), from: batch[0].height, to: batch.at(-1).height, sha256: sha(text) };
		writeFileSync(join(dir, f.file), text);
		index.files.push(f); index.height = f.to;
		batch = [];
	};
	while (from <= top) {
		const page = await json(`${node}/blocks?from=${from}&limit=100`);
		if (!page.blocks?.length) break;
		for (const b of page.blocks) {
			if (b.height !== from) throw new Error(`The node sent block ${b.height} when ${from} was expected`);
			batch.push(b); newest = b; from++;
			if (b.height % index.chunk === 0) flush();
		}
	}
	flush();
	// the hash of the newest block, so a node reading the archive can tell whether it holds the same history
	if (newest) index.last = await blockHash(index.chain, newest);
	index.updated = new Date().toISOString();
	writeFileSync(file, JSON.stringify(index, null, '\t') + '\n');
	return index;
}

/** Read an archive (a folder, or a URL where one is served) the way a node is read: GET /, /genesis, /blocks.
    Each file is checked against the sha-256 in the index before use. Then the node checks every block as usual. */
export function archiveSource(where) {
	const remote = /^https?:\/\//.test(where), base = remote ? where.replace(/\/+$/, '').replace(/\/index\.json$/, '') : resolve(where.replace(/[\\/]index\.json$/, ''));
	const read = async (name) => (remote ? (await (await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(20_000) })).text()) : readFileSync(join(base, name), 'utf8'));
	let index = null;
	const cache = new Map();
	const load = async () => (index = JSON.parse(await read('index.json')));
	const blocks = async (from, limit) => {
		if (!index) await load();
		const out = [];
		for (const f of index.files) {
			if (f.to < from || out.length >= limit) continue;
			let list = cache.get(f.file);
			if (!list) {
				const text = await read(f.file);
				if (sha(text) !== f.sha256) throw new Error(`${f.file} does not match the archive's index`);
				list = JSON.parse(text); cache.clear(); cache.set(f.file, list);
			}
			for (const b of list) if (b.height >= from && out.length < limit) out.push(b);
		}
		return out;
	};
	const get = async (path) => {
		const u = new URL(path, 'http://archive');
		if (u.pathname === '/') { await load(); return { chain: index.chain, height: index.height, last: index.last, archive: true }; }
		if (u.pathname === '/genesis') { if (!index) await load(); return index.genesis; }
		if (u.pathname === '/blocks') return { blocks: await blocks(Number(u.searchParams.get('from')) || 1, Math.min(100, Number(u.searchParams.get('limit')) || 100)) };
		throw new Error('An archive has no ' + u.pathname);
	};
	get.label = 'archive ' + where;
	get.archive = true;
	return get;
}

// from the command line
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2), flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
	if (args[0] !== 'update' || !flag('node') || !flag('out')) {
		console.error('Usage: node chain/archive.mjs update --node <node url> --out <folder>');
		process.exitCode = 1;
	} else {
		try {
			const i = await updateArchive(flag('node'), flag('out'));
			console.log(`Archive of ${i.chain} up to block ${i.height}: ${i.files.length} file${i.files.length === 1 ? '' : 's'} in ${resolve(flag('out'))}`);
		} catch (e) { console.error(e.message); process.exitCode = 1; }
	}
}
