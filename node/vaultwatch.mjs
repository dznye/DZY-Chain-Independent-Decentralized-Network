// The vault helper: from this computer's own internet connection, it reads every exchange vault's payments straight
// from the chains' public nodes and tells the validators which payments to count (POST /exchange/paid). That is all.
//
// Why it helps: public nodes often refuse a validator hosted in a data centre the long log searches this needs, but they
// answer an ordinary home connection. Why it is safe: it holds no key and cannot count anything itself. It only names
// transactions; each validator then reads that one payment's receipt on its own chain and counts it only when the chain
// itself shows a final deposit into the vault. A wrong, made-up or repeated name gives nothing.
//
//   import { watchVaults } from './vaultwatch.mjs'; watchVaults({ api, dataDir, say })   (the node runner starts it)
//   node chain/node/vaultwatch.mjs                                                      (on its own, once a minute)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EVM, rpcOf } from '../src/evm.ts';
import { eachInTurn, paymentThere, scanEvmVault } from '../src/xwatch.ts';

const SPAN = 2_000; // blocks a search: public nodes refuse wider ranges
const BACK = 5_000; // on a first start, how far back to look

/** every Ethereum-style vault the chain lists: { net: address } */
export function vaultsOf(exchange) {
	const out = {};
	for (const c of Object.values(exchange?.coins ?? {})) for (const [net, a] of Object.entries(c.vaults ?? {})) if (EVM[net] && /^0x[0-9a-fA-F]{40}$/.test(a)) out[net] = a.toLowerCase();
	return out;
}

/** One look: for each vault, the new blocks since the last look (a few thousand at most), and every payment found named
    to the chain. `state` ({ net: next block }) is updated in place; returns how many payments were named. */
export async function lookOnce({ api, state, rpcFor = (net) => eachInTurn(EVM[net].rpc.map(rpcOf)), post = postPaid, say = () => {} }) {
	const ex = await (await fetch(api + '/exchange', { signal: AbortSignal.timeout(15_000) })).json();
	let named = 0;
	for (const [net, vault] of Object.entries(vaultsOf(ex))) {
		const rpc = rpcFor(net);
		if (!rpc) continue;
		try {
			const head = Number(BigInt(await rpc('eth_blockNumber', [])));
			const from = state[net] ?? Math.max(0, head - BACK);
			if (from > head) continue;
			const to = Math.min(head, from + SPAN);
			const { deposits } = await scanEvmVault(rpc, vault, net, from, to);
			const txs = [...new Set(deposits.map((d) => d.tx.split('l')[0]))]; // "0x…l3" is a payment and its place in it
			for (const tx of txs) { if (await post(api, net, tx)) named++; }
			state[net] = to + 1;
			if (txs.length) say(`${EVM[net].name}: named ${txs.length} payment${txs.length === 1 ? '' : 's'} into the vault to the chain`);
		} catch (e) { say(`${EVM[net].name}: could not read the vault this time (${String(e.message ?? e).slice(0, 80)}); trying again next look`); }
	}
	return named;
}

/** name one payment to the chain; true when the validator took it */
export async function postPaid(api, net, tx) {
	const r = await fetch(api + '/exchange/paid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ net, tx }), signal: AbortSignal.timeout(15_000) });
	return r.ok;
}

/** The guardian's part: every payment that waits to be counted is looked for on its own chain, from this computer, through
    two or more different nodes. One that none of them shows is objected to (x.doubt, with this guardian's key), so it is
    looked at again before it can count. A node that cannot be asked says nothing either way. Returns the ids objected to. */
export async function guardOnce({ api, me, doubt, rpcsFor = (net) => EVM[net].rpc.map(rpcOf), said = new Set(), say = () => {}, depth }) {
	const x = await (await fetch(api + '/exchange/waiting', { signal: AbortSignal.timeout(15_000) })).json(), out = [];
	for (const [id, w] of Object.entries(x.waiting ?? {})) {
		if (w.by !== undefined || w.block || said.has(id) || !EVM[w.net] || !x.vaults?.[w.net] || x.now > w.until || x.now - w.at < 600_000) continue; // (ten minutes first: this computer's nodes may be a little behind)
		const answers = await Promise.all(rpcsFor(w.net).slice(0, 5).map(async (rpc) => { try { return await paymentThere(rpc, x.vaults[w.net], w, id.slice(w.net.length + 1), depth); } catch { return null; } }));
		if (answers.includes(true)) { said.add(id); continue; }
		if (answers.filter((a) => a === false).length < 2) continue; // not sure: ask again next look
		try { await doubt(id); said.add(id); out.push(id); say(`objected to a payment of ${w.amount} ${w.coin} that is not on ${EVM[w.net].name}`); } catch (e) { if (/no such|already|too late|guardian/.test(e.message)) said.add(id); }
	}
	return out;
}

/** run it: a look every minute, the place reached kept in `dataDir`/vaultwatch.json so a restart goes on from there */
export function watchVaults({ api, dataDir, say = console.log, every = 60_000, doubt = null }) {
	mkdirSync(dataDir, { recursive: true });
	const file = join(dataDir, 'vaultwatch.json');
	let state = {};
	try { if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { state = {}; }
	let busy = false; const guarded = new Set();
	const tick = async () => {
		if (busy) return; busy = true;
		try { if (doubt) await guardOnce({ api, doubt, said: guarded, say }).catch(() => {}); await lookOnce({ api, state, say }); writeFileSync(file, JSON.stringify(state) + '\n'); }
		catch (e) { say(`vault helper: the chain did not answer (${String(e.message ?? e).slice(0, 60)})`); }
		finally { busy = false; }
	};
	tick();
	const t = setInterval(tick, every);
	return { stop: () => clearInterval(t) };
}

// on its own: node chain/node/vaultwatch.mjs
if (import.meta.url === new URL(process.argv[1] ?? '', 'file://').href || process.argv[1]?.endsWith('vaultwatch.mjs')) {
	const api = (process.env.DZNYE_API ?? 'https://api.dznye.com').replace(/\/+$/, '');
	const dataDir = join(homedir(), '.dznye-node');
	console.log(`Vault helper: reading the exchange vaults from this connection and naming payments to ${api}. No key; nothing else.`);
	watchVaults({ api, dataDir, say: (t) => console.log(`${new Date().toISOString().slice(0, 16).replace('T', ' ')}  ${t}`) });
}
