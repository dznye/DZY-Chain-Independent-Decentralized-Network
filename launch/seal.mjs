// The seal: one fingerprint of every line that decides what is true on the chain. Like Bitcoin Core's consensus code: once
// sealed, it is not touched, and everything new is built on top (contracts, Ethereum contracts, layers, files, apps).
//   node launch/seal.mjs            show the fingerprint now, and whether it is the sealed one
//   node launch/seal.mjs check      the same, and fail (exit 1) when a sealed file was changed (plain.test.mjs does this)
//   node launch/seal.mjs seal       write launch/SEAL.json: ONLY after an outside audit, and a public test that held
//   node launch/seal.mjs peers URL...   ask other nodes which fingerprint they run (GET /seal)
// A sealed file can still be changed by whoever runs a node: that is a different chain, and the fingerprint says so. What
// makes rules lasting is that other people run them too. A serious bug must still be fixed: Bitcoin's were (2010, 2018).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SEALED = ['src/crypto.ts', 'src/btc.ts', 'src/secp.ts', 'src/evm.ts', 'src/contracts.ts', 'src/ledger.ts', 'src/sun.ts', 'src/layer.ts', 'src/root.ts', 'src/block.ts', 'src/consensus.ts', 'src/heart.ts', 'src/zones.ts', 'src/blobs.ts', 'src/evmcore.ts', 'src/curves.ts', 'src/wots.ts', 'src/work.ts', 'src/evmledger.ts', 'v2/rules.mjs', 'v2/sale.mjs', 'launch/dznye-mainnet.genesis.json'];
const here = (f) => new URL('../' + f, import.meta.url), file = here('launch/SEAL.json');
export function fingerprint() {
	const files = Object.fromEntries(SEALED.map((f) => [f, createHash('sha256').update(readFileSync(here(f), 'utf8').replace(/\r\n/g, '\n')).digest('hex')])); // the same whatever a computer does with line ends
	return { seal: createHash('sha256').update(Object.entries(files).map(([f, h]) => f + ':' + h).join('\n')).digest('hex'), files };
}
export const sealed = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
export function changed() { const s = sealed(); if (!s) return null; const now = fingerprint().files; return [...new Set([...Object.keys(s.files), ...Object.keys(now)])].filter((f) => s.files[f] !== now[f]); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const cmd = process.argv[2] ?? '', now = fingerprint(), was = sealed(), diff = changed();
	if (cmd === 'seal') { if (was && diff.length === 0) console.log('Already sealed:', was.seal); else { writeFileSync(file, JSON.stringify({ seal: now.seal, at: new Date().toISOString().slice(0, 10), files: now.files }, null, '\t') + '\n'); console.log('Sealed:', now.seal); } }
	else if (cmd === 'peers') { for (const u of process.argv.slice(3)) { let s = 'did not answer'; try { const r = await fetch(u.replace(/\/+$/, '') + '/seal', { signal: AbortSignal.timeout(8_000) }); s = r.ok ? (await r.json()).seal : 'does not say'; } catch { /* not answering */ } console.log(s === now.seal ? 'the same' : 'DIFFERENT', u, s); } }
	else {
		console.log('Rules fingerprint:', now.seal); console.log(`${SEALED.length} files decide what is true on the chain.`);
		if (!was) console.log('NOT SEALED yet (no launch/SEAL.json).'); else if (diff.length) { console.log(`CHANGED since it was sealed on ${was.at}: ${diff.join(', ')}`); if (cmd === 'check') process.exitCode = 1; } else console.log(`Sealed on ${was.at}, and unchanged.`);
	}
}
