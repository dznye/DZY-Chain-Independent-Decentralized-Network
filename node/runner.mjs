// The easy node: start it once, keep the computer on and online, that is all.
//   node chain/node/runner.mjs                      (or the one-line installers at chain.dznye.com/node/)
//   node chain/node/runner.mjs --payout @yourname   (sends what it earns to your wallet, once a day)
//   node chain/node/runner.mjs --status             (prints its address and state, then stops)
//
// What it does by itself:
//   - makes its own key the first time (kept in its folder, used for nothing else) and shows the address to fund;
//   - copies and checks every block of the chain (a follower: it can never create or move anything but its own coins);
//   - as soon as its address holds 1 DZY or more, stakes it, which makes it a checker: a few times an hour it says on
//     the chain which block it checked, and on days it was seen in 12 different hours it shares the checkers' 20% of
//     the validators' daily pay (paid from fees, never from new DZY);
//   - with --payout, sends what it earns beyond its stake to your wallet once a day;
//   - the vault helper (vaultwatch.mjs; --no-vaults turns it off): reads the exchange vaults' payments from this
//     connection and names them to the validators, who check each one on its own chain. No key is used for it.
// Settings: --data <folder> (default: ~/.dznye-node), --port 8787, --log <file>, DZNYE_API (default https://api.dznye.com).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newKey } from '../src/crypto.ts';
import { Client } from '../src/client.ts';
import { startNode } from './server.mjs';
import { watchVaults } from './vaultwatch.mjs';

const DZY = 100_000_000, KEEP = DZY / 100; // 0.01 DZY stays unstaked, for fees
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const API = (process.env.DZNYE_API ?? 'https://api.dznye.com').replace(/\/+$/, '');
const home = arg('data') ?? join(homedir(), '.dznye-node'), keyFile = join(home, 'key.json');
const logFile = arg('log'); // background runs (the installers) keep their lines here
const say = (t) => { const line = `${new Date().toISOString().slice(0, 16).replace('T', ' ')}  ${t}`; console.log(line); if (logFile) try { appendFileSync(logFile, line + String.fromCharCode(10)); } catch { /* the log is a convenience */ } };
const dzy = (n) => (n / DZY).toLocaleString('en-US', { maximumFractionDigits: 4 });

mkdirSync(home, { recursive: true });
if (!existsSync(keyFile)) {
	writeFileSync(keyFile, JSON.stringify(await newKey(), null, '\t') + '\n');
	try { chmodSync(keyFile, 0o600); } catch { /* Windows keeps it in the user's own folder */ }
}
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
const client = new Client(API);
const stakeOf = (a) => a?.stake?.bond ?? 0, liquid = (a) => a?.balances?.DZY ?? 0;

if (process.argv.includes('--status')) {
	const a = await client.account(key.address).catch(() => null);
	console.log(`Address: ${key.address}\nStaked:  ${dzy(stakeOf(a))} DZY\nFree:    ${dzy(liquid(a))} DZY\nFolder:  ${home}`);
} else await run(); // (no process.exit here: on Windows it can trip over a closing network handle)

async function run() {
// a new block about once a minute: asking every 20 seconds keeps up, and spares the chain's API (every 2 seconds was 43,000 requests a day)
// the chain's starting settings from the file shipped with this code (its hash is checked against them on every start),
// so the node starts from its own copy even when the API does not answer (and serves that copy at 127.0.0.1:8787)
const genesisFile = API === 'https://api.dznye.com' && existsSync(new URL('../launch/dznye-mainnet.genesis.json', import.meta.url)) ? fileURLToPath(new URL('../launch/dznye-mainnet.genesis.json', import.meta.url)) : undefined;
const node = await startNode({ follow: API, genesisFile, followMs: Number(process.env.FOLLOW_MS) || 20_000, dataDir: join(home, 'data'), port: Number(arg('port') ?? process.env.PORT ?? 8787), host: '127.0.0.1', checker: key });
say(`Dznye node running. Keep this computer on and online; nothing else to do.`);
say(`Its address: ${key.address}`);
if (!process.argv.includes('--no-vaults')) { watchVaults({ api: API, dataDir: home, say: (t) => say('vaults: ' + t) }); say('vault helper on: payments into the exchange vaults are named to the chain from this connection'); }

let payTo = null, paidDay = '', warned = 0;
const payout = arg('payout');
if (payout) payTo = /^[0-9a-f]{64}$/.test(payout) ? payout : await client.whoIs(payout);
if (payout && !payTo) say(`--payout ${payout}: not found right now (is the chain answering?); asked again at each look`);

async function look() {
	if (payout && !payTo) payTo = /^[0-9a-f]{64}$/.test(payout) ? payout : await client.whoIs(payout).catch(() => null); // a name not found at start (the chain was down): try again
	const a = await client.account(key.address).catch(() => null);
	if (!a) return say('the chain is not answering right now; trying again in a minute');
	const staked = stakeOf(a), free = liquid(a), s = node.core.followed ?? node.core.state;
	if (node.core.alert) return say(`ALERT: ${node.core.alert} (it stops vouching for the chain until this is resolved)`);
	// stake what arrived: 1 DZY or more makes it a checker
	if (staked < DZY && staked + free - KEEP >= DZY) { // only until it is a checker: what it earns after that stays free (paid out with --payout)
		await client.send(key, 'stake.bond', { amount: free - KEEP }).then(() => say(`staked ${dzy(free - KEEP)} DZY: checking in for the checkers' share`)).catch((e) => say('could not stake yet: ' + e.message));
		return;
	}
	if (!staked && Date.now() - warned > 3_600_000) { warned = Date.now(); say(`To start earning, send 1.01 DZY or more to ${key.address}`); }
	// once a day, earnings beyond the stake go to the owner's wallet
	const day = new Date().toISOString().slice(0, 10);
	if (payTo && day !== paidDay && free > KEEP * 2) {
		paidDay = day;
		await client.send(key, 'transfer', { asset: 'DZY', to: payTo, amount: free - KEEP }).then(() => say(`sent ${dzy(free - KEEP)} DZY to ${payout}`)).catch((e) => say('payout failed: ' + e.message));
	}
	if (s) say(`block ${Number(s.height).toLocaleString('en-US')} checked · staked ${dzy(staked)} DZY${free > KEEP ? ` · ${dzy(free)} free` : ''}`);
}
await look();
setInterval(() => look().catch((e) => say("error: " + e.message)), Number(process.env.RUNNER_EVERY_MS) || 10 * 60_000); // a look every 10 minutes
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => node.stop().then(() => process.exit(0)));
}
