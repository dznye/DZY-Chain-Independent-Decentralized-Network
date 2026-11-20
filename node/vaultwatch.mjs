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
import { eachInTurn, scanEvmVault } from '../src/xwatch.ts';

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

/** run it: a look every minute, the place reached kept in `dataDir`/vaultwatch.json so a restart goes on from there */
export function watchVaults({ api, dataDir, say = console.log, every = 60_000 }) {
	mkdirSync(dataDir, { recursive: true });
	const file = join(dataDir, 'vaultwatch.json');
	let state = {};
	try { if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { state = {}; }
	let busy = false;
	const tick = async () => {
		if (busy) return; busy = true;
		try { await lookOnce({ api, state, say }); writeFileSync(file, JSON.stringify(state) + '\n'); }
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
