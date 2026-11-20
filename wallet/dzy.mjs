#!/usr/bin/env node
// dzy: the DZY wallet for your own computer (Windows, Mac, Linux). Needs only Node.js 24. Run `node wallet/dzy.mjs help`.
//
// It holds DZY, buys it with ETH, USDC or SOL, swaps it on the Dznye market, and runs a node. Your wallet is one backup
// file sealed with your PIN, the same file the web wallet makes: open either one with the other. Nothing secret ever
// leaves this computer; every transaction is signed here.
//
// Buying: `dzy receive` shows your own ETH and SOL addresses (as QR codes). Send coins there from any exchange or
// wallet, then `dzy buy`. The wallet pays them into the chain's vault for that coin, with your DZY address written in
// the payment, and the validators give you DZY once that chain has made the payment final.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client, fromParts, toParts } from '../src/client.ts';
import { deriveDznye, deriveSecp, isSafeFile, makePin, newMaster, openSafe, pinProblem, sealSafe } from '../src/safe.ts';
import { evmAddressOf, signEvmTx } from '../src/evmsign.ts';
import { EVM, anyRpc } from '../src/evm.ts';
import { buildMessage, onCurve, solanaOf, wire, SOLANA_NODES } from '../src/solana.ts';
import { anyRpc as solAnyRpc } from '../src/solana.ts';
import { fromBase58, toBase58 } from '../src/crypto.ts';
import { qrMatrix } from './qr.mjs';
import { evmTokenOf, NATIVE } from '../src/xtokens.ts';

const HELP = `dzy: the DZY wallet

  dzy new                      make a wallet (a backup file sealed with a PIN)
  dzy open <file>              use a backup file from the web wallet or another computer
  dzy receive                  your addresses, with QR codes: DZY, and ETH / SOL to buy with
  dzy balance                  what you hold: DZY, staked, locked, and coins waiting to buy with
  dzy price                    DZY's price, and how much DZY one ETH, SOL, USDC or BTC buys
  dzy buy <amount> <coin> [--on <chain>]      pay into the vault, get DZY: ETH, USDC, USDT, BNB, POL, AVAX or SOL
                               chains: arb, base, op, bsc, polygon, avax, eth (or sol for SOL)
  dzy send <@name|address> <amount> [asset]     send DZY (or another coin held on Dznye)
  dzy swap <amount> <from> <to>                 swap on the Dznye market, e.g.  dzy swap 0.005 ETH DZY
  dzy name <name>              take a name (6+ characters, free with the starter credit)
  dzy node [--payout @name]    run a node on this computer: it checks the chain and earns while it is on
  dzy backup                   where your backup file is (keep a copy somewhere else, with your PIN written down)

  --yes skips "are you sure". DZY_PIN, DZY_HOME, DZY_API (default https://api.dznye.com) are read from the environment.`;

const DZY = 100_000_000;
const args = process.argv.slice(2), words = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--yes'].includes(args[i - 1])));
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const HOME = process.env.DZY_HOME ?? join(homedir(), '.dzy'), SAFE = join(HOME, 'wallet.json'), PUB = join(HOME, 'addresses.json');
const api = new Client(process.env.DZY_API ?? 'https://api.dznye.com');
class Stop extends Error {}
const stop = (m) => { throw new Stop(m); };
const out = (t = '') => console.log(t);
const dzyText = (n) => fromParts(n, 8);

/* ---------- asking ---------- */
function ask(q, hidden = false) {
	return new Promise((ok) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (hidden && process.stdin.isTTY) { rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); else process.stdout.write('*'.repeat(s.length ? 1 : 0)); }; }
		rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); ok(a.trim()); });
	});
}
const sure = async (q) => flag('yes') || /^y(es)?$/i.test(await ask(q + ' (y/N) '));
const pin = async () => process.env.DZY_PIN ?? (await ask('PIN: ', true));

/* ---------- the wallet: one sealed file, plus the public addresses (so looking needs no PIN) ---------- */
const pub = () => { if (!existsSync(PUB)) stop('No wallet yet. Make one with `dzy new`, or `dzy open <backup file>`.'); return JSON.parse(readFileSync(PUB, 'utf8')); };
async function keys(p) {
	if (!existsSync(SAFE)) stop('No wallet yet. Make one with `dzy new`.');
	let master;
	try { master = await openSafe(JSON.parse(readFileSync(SAFE, 'utf8')), p ?? (await pin())); } catch { stop('Wrong PIN.'); }
	const d = await deriveDznye(master), eth = await deriveSecp(master, 'eth', 0);
	// the new lock opens a wallet for every PIN; here, next to your own addresses, a different one means a mistyped PIN
	if (existsSync(PUB) && d.address !== pub().dznye) stop('That PIN opens a different wallet, not this one. Nothing was signed.');
	return { dz: d, eth: BigInt('0x' + eth), ethAddress: evmAddressOf(BigInt('0x' + eth)) };
}
async function keep(file, master, p) {
	mkdirSync(HOME, { recursive: true });
	const d = await deriveDznye(master), eth = evmAddressOf(BigInt('0x' + (await deriveSecp(master, 'eth', 0))));
	writeFileSync(SAFE, JSON.stringify(file, null, '\t') + '\n');
	try { chmodSync(SAFE, 0o600); } catch { /* Windows: it is in the user's own folder */ }
	writeFileSync(PUB, JSON.stringify({ dznye: d.address, solana: solanaOf(d.address), eth }, null, '\t') + '\n');
	void p;
	return d;
}

/* ---------- QR codes in the terminal: two rows per line, dark on light ---------- */
function qr(text) {
	const m = qrMatrix(text), n = m.length, at = (r, c) => r >= 0 && r < n && c >= 0 && c < n && m[r][c];
	const lines = [];
	for (let r = -2; r < n + 2; r += 2) {
		let s = '';
		for (let c = -2; c < n + 2; c++) { const top = at(r, c), bot = at(r + 1, c); s += `\x1b[${top ? 30 : 97}m\x1b[${bot ? 40 : 107}m▀`; }
		lines.push(s + '\x1b[0m');
	}
	return lines.join('\n');
}

/* ---------- the other chains: public nodes (or DZY_EVM_RPC / DZY_SOL_RPC, for tests) ---------- */
const evmRpc = (net) => anyRpc(process.env.DZY_EVM_RPC ? [process.env.DZY_EVM_RPC.replace('{net}', net)] : EVM[net].rpc);
const solRpc = () => solAnyRpc(process.env.DZY_SOL_RPC ? [process.env.DZY_SOL_RPC] : SOLANA_NODES);
const NET_NAMES = { eth: 'Ethereum', base: 'Base', arb: 'Arbitrum', op: 'Optimism', polygon: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche', sol: 'Solana' };
const w = (n) => BigInt(n).toString(16).padStart(64, '0'), aw = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const exactParts = (t, d) => { const m = /^(\d{1,12})(?:\.(\d*))?$/.exec(String(t).trim()); if (!m || (m[2] ?? '').length > d) return null; const v = BigInt(m[1] + (m[2] ?? '').padEnd(d, '0')); return v > 0n ? v : null; };
const bigText = (n, d) => { const s = BigInt(n).toString().padStart(d + 1, '0'), f = s.slice(-d).replace(/0+$/, ''); return s.slice(0, -d) + (f ? '.' + f.slice(0, 8) : ''); };

async function sendEvm(net, key, from, to, data, value = 0n) {
	const rpc = evmRpc(net), c = EVM[net];
	const [nonce, price, have] = await Promise.all([rpc('eth_getTransactionCount', [from, 'pending']), rpc('eth_gasPrice', []), rpc('eth_getBalance', [from, 'latest'])]);
	let gas;
	try { gas = (BigInt(await rpc('eth_estimateGas', [{ from, to, data, value: '0x' + value.toString(16) }])) * 13n) / 10n; } catch (e) { stop(`${c.name} says this would fail: ${e.message}`); }
	const gasPrice = (BigInt(price) * 115n) / 100n + 1n;
	if (BigInt(have) < gas * gasPrice + value) stop(`Not enough ${c.coin} on ${c.name} for this and its network fee (about ${bigText(gas * gasPrice, 18)} ${c.coin}).`);
	const t = signEvmTx(key, { nonce: BigInt(nonce), gasPrice, gas, to, value, data, chainId: c.id });
	const hash = await rpc('eth_sendRawTransaction', [t.raw]);
	for (let i = 0; i < 120; i++) { const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); if (r) { if (r.status !== '0x1') stop(`It failed on ${c.name}: ${c.explorer}${hash}`); return hash; } await new Promise((ok) => setTimeout(ok, 3000)); }
	stop(`Sent, but not in a block yet: ${c.explorer}${hash}`);
}
const b58bytes = (a) => { const h = fromBase58(a); if (!h) stop('Not a Solana address'); return Buffer.from(h.padStart(64, '0'), 'hex'); };
async function pda(seeds, program) {
	const pb = b58bytes(program);
	for (let bump = 255; bump >= 0; bump--) {
		const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...pb, ...new TextEncoder().encode('ProgramDerivedAddress')])));
		if (!onCurve(h)) return toBase58(Buffer.from(h).toString('hex'));
	}
	stop('no address');
}
async function signSol(secret, msg) {
	const k = await crypto.subtle.importKey('pkcs8', Buffer.from(secret, 'hex'), { name: 'Ed25519' }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k, msg));
}

/* ---------- commands ---------- */
const C = {
	help() { out(HELP); },
	async new() {
		if (existsSync(SAFE)) stop(`There is already a wallet here (${SAFE}). To keep both, set DZY_HOME to another folder.`);
		let p = process.env.DZY_PIN ?? (await ask('Choose a PIN (12+ characters), or press Enter and one is made for you: ', true));
		const made = !p;
		if (made) p = makePin();
		else { const why = pinProblem(p); if (why) stop(why); if (!process.env.DZY_PIN && (await ask('Once more: ', true)) !== p) stop('The two PINs are not the same.'); }
		out('Making your wallet…');
		const master = newMaster(), d = await deriveDznye(master);
		await keep(await sealSafe(master, p, d.address), master, p);
		out(`\nYour DZY address: ${d.address}`);
		if (made) out(`\nYour PIN: ${p}\nWrite it down now, somewhere safe. Nobody can reset it, not even us.`);
		out(`\nYour backup file: ${SAFE}\nCopy it somewhere else too (a USB stick, your cloud). The file and the PIN bring back this wallet anywhere.`);
		out('\nNext: `dzy name <yourname>` (free), then `dzy receive` to buy DZY.');
	},
	async open() {
		const f = words[1] ?? stop('Which file? `dzy open <backup file>`');
		let file;
		try { file = JSON.parse(readFileSync(f, 'utf8')); } catch { stop('Cannot read that file.'); }
		if (!isSafeFile(file)) stop('That is not a Dznye backup file.');
		if (existsSync(SAFE) && !(await sure(`Replace the wallet already here (${pub().dznye.slice(0, 10)}…)?`))) stop('Nothing changed.');
		const p = await pin();
		let master;
		try { master = await openSafe(file, p); } catch { stop('Wrong PIN for that file.'); }
		const upgraded = file.v === 1, sealed = upgraded ? await sealSafe(master, p) : file; // old files get the new lock
		const d = await keep(sealed, master, p);
		out(`Opened: ${d.address}${upgraded ? '\nYour backup now uses the new lock: copy the new file (dzy backup) and keep it instead of the old one.' : ''}`);
		const a = await api.account(d.address).catch(() => null);
		if (!a?.name && !(a?.nonce > 0) && !Object.values(a?.balances ?? {}).some((n) => n > 0)) out('This wallet is new and empty. If you expected coins, the PIN may be a little different: run `dzy open` again.');
	},
	async receive() {
		const a = pub(), acct = await api.account(a.dznye).catch(() => null);
		const show = (title, line, addr) => { out(`\n${title}\n${line}\n`); out(qr(addr)); out(addr); };
		show('DZY', acct?.name ? `People can pay you at @${acct.name}, or this address:` : 'Your DZY address:', a.dznye);
		show('To buy with ETH, BNB, POL, AVAX, USDC or USDT', 'Send here on Arbitrum, Base, Optimism, BNB Chain, Polygon, Avalanche or Ethereum (the same address on all of them). Then `dzy buy`.', a.eth);
		show('To buy with SOL', 'Send SOL here, on Solana. Then `dzy buy <amount> SOL`.', a.solana);
		out('\nThese are your own addresses: only this wallet can move what lands there.');
	},
	async balance() {
		const a = pub(), [acct, x] = await Promise.all([api.account(a.dznye), api.get('/exchange/' + a.dznye).catch(() => null)]);
		const b = acct.balances ?? {};
		out(`DZY            ${dzyText(b.DZY ?? 0)}${acct.name ? `   (@${acct.name})` : ''}`);
		if (acct.stake?.bond) out(`Staked         ${dzyText(acct.stake.bond)} DZY`);
		for (const [c, n] of Object.entries(x?.locks ?? {})) if (n) out(`Locked ${c.padEnd(7)} ${bigText(n, ['USDC', 'USDT'].includes(c) ? 6 : c === 'BTC' ? 8 : 9)} ${c}   (yours: bought DZY with it; close the lock any time in the wallet)`);
		for (const [id, n] of Object.entries(b)) if (/^x[A-Z]+$/.test(id) && n) out(`${(id.slice(1) + ' on Dznye').padEnd(15)}${bigText(n, ['xUSDC', 'xUSDT'].includes(id) ? 6 : id === 'xBTC' ? 8 : 9)}`);
		const waiting = [];
		for (const net of ['arb', 'base', 'op', 'bsc', 'polygon', 'avax', 'eth']) {
			const r = evmRpc(net), c = EVM[net];
			const own = await r('eth_getBalance', [a.eth, 'latest']).catch(() => '0x0');
			if (BigInt(own || '0x0') > 0n) waiting.push(`${bigText(BigInt(own), 18)} ${NATIVE[net]} on ${c.name}`);
			for (const coin of ['USDC', 'USDT']) {
				const t = evmTokenOf(net, coin); if (!t) continue;
				const n = await r('eth_call', [{ to: t.token, data: '0x70a08231' + aw(a.eth) }, 'latest']).catch(() => '0x0');
				if (BigInt(n || '0x0') > 0n) waiting.push(`${bigText(BigInt(n), t.decimals)} ${coin} on ${c.name}`);
			}
		}
		const sol = await solRpc()('getBalance', [a.solana]).catch(() => null);
		if (sol?.value) waiting.push(`${bigText(BigInt(sol.value), 9)} SOL`);
		if (waiting.length) out(`\nReady to buy DZY with: ${waiting.join(', ')}   (dzy buy <amount> <coin>)`);
	},
	async price() {
		const x = await api.get('/exchange');
		out(`1 DZY ≈ $${(x.dzyPrice / 1e6).toFixed(4)}`);
		for (const [c, v] of Object.entries(x.coins)) out(`1 ${c.padEnd(5)} = ${v.price ? Math.floor(v.price / x.dzyPrice).toLocaleString('en-US') + ' DZY' : 'no agreed price right now'}${Object.keys(v.vaults ?? {}).length ? `   (buy on ${Object.keys(v.vaults).map((n) => NET_NAMES[n] ?? n).join(', ')})` : '   (not open yet)'}`);
	},
	async buy() {
		const amountText = words[1] ?? stop('How much? e.g. `dzy buy 0.01 ETH`'), coin = String(words[2] ?? '').toUpperCase();
		const x = await api.get('/exchange'), v = x.coins[coin] ?? stop(`Buy with ${Object.keys(x.coins).filter((c) => c !== 'BTC').join(', ')}, e.g. \`dzy buy 0.01 ETH\``), vaults = v?.vaults ?? {};
		const net = coin === 'SOL' ? 'sol' : String(flag('on', Object.keys(vaults).find((n) => n !== 'sol') ?? Object.entries(NATIVE).find(([, c]) => c === coin)?.[0] ?? 'arb'));
		const vault = vaults[net] ?? stop(`Buying with ${coin} on ${NET_NAMES[net] ?? net} is not open yet. Open now: ${Object.keys(vaults).map((n) => NET_NAMES[n] ?? n).join(', ') || 'none yet'}.`);
		const tk = net === 'sol' ? null : evmTokenOf(net, coin) ?? stop(`${coin} is not paid on ${NET_NAMES[net] ?? net}.`);
		const dec = net === 'sol' ? 9 : tk.decimals, units = exactParts(amountText, dec) ?? stop('That is not an amount.');
		const chainUnits = units / 10n ** BigInt(dec - v.decimals), about = v.price && x.dzyPrice ? Number(chainUnits) / 10 ** v.decimals * v.price / x.dzyPrice : 0;
		const over = !v.price || chainUnits > BigInt(v.limits?.deposit ?? Infinity) || BigInt(v.total ?? 0) + chainUnits > BigInt(v.limits?.vault ?? Infinity);
		out(over ? `${amountText} ${coin} would arrive on Dznye as ${coin}, not DZY (${!v.price ? 'no agreed price right now' : 'over the limit for one payment'}).` : `${amountText} ${coin} buys about ${about.toLocaleString('en-US', { maximumFractionDigits: 2 })} DZY.`);
		if (!(await sure(`Pay ${amountText} ${coin} into the vault on ${NET_NAMES[net]}?`))) stop('Nothing sent.');
		const k = await keys(), me = k.dz.address;
		if (net === 'sol') {
			const from = solanaOf(me), rpc = solRpc();
			const ix = { program: vault, keys: [{ key: from, signer: true, writable: true }, { key: await pda([new TextEncoder().encode('vault')], vault), writable: true }, { key: '11111111111111111111111111111111' }], data: [1, ...Buffer.from(me, 'hex'), ...Buffer.from(w(units).slice(-16), 'hex').reverse()] };
			const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), msg = buildMessage(from, [ix], value.blockhash);
			const id = await rpc('sendTransaction', [wire(await signSol(k.dz.secret, msg), msg), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
			out(`Sent on Solana: ${id}`);
		} else {
			const from = k.ethAddress;
			if (/^0x0+$/.test(tk.token)) await sendEvm(net, k.eth, from, vault, '0xb214faa5' + me, units); // the network's own coin
			else {
				const token = tk.token, r = evmRpc(net), allowed = async () => BigInt((await r('eth_call', [{ to: token, data: '0xdd62ed3e' + aw(from) + aw(vault) }, 'latest'])) || '0x0');
				if (BigInt((await r('eth_call', [{ to: token, data: '0x70a08231' + aw(from) }, 'latest'])) || '0x0') < units) stop(`You have less than ${amountText} ${coin} on ${NET_NAMES[net]}. Send some to ${from} first.`);
				if ((await allowed()) < units) {
					if (coin === 'USDT' && (await allowed()) > 0n) await sendEvm(net, k.eth, from, token, '0x095ea7b3' + aw(vault) + w(0)); // Tether: back to zero first
					out(`Allowing the vault to take exactly that ${coin}…`); await sendEvm(net, k.eth, from, token, '0x095ea7b3' + aw(vault) + w(units));
				}
				await sendEvm(net, k.eth, from, vault, '0x84abac95' + aw(token) + w(units) + me);
			}
			out(`Sent on ${NET_NAMES[net]}.`);
		}
		const mins = net === 'sol' ? 1 : EVM[net].finalMinutes;
		out(`${over ? `Your ${coin} arrives on Dznye` : 'Your DZY arrive'} in about ${mins} minutes, once ${NET_NAMES[net]} has made it final. Check with \`dzy balance\`.`);
		if (flag('wait')) { const d0 = (await api.account(me)).balances?.DZY ?? 0; for (let i = 0; i < (mins + 10) * 6; i++) { await new Promise((ok) => setTimeout(ok, 10_000)); const d1 = (await api.account(me)).balances?.DZY ?? 0; if (d1 > d0) { out(`Arrived: +${dzyText(d1 - d0)} DZY`); return; } } }
	},
	async send() {
		const to = words[1] ?? stop('To whom? `dzy send @name 1.5`'), amountText = words[2] ?? stop('How much?'), asset = words[3] ?? 'DZY';
		const addr = to.startsWith('@') ? (await api.whoIs(to)) ?? stop(`No one is called ${to}.`) : /^[0-9a-f]{64}$/.test(to) ? to : stop('Send to @name or a DZY address (64 letters and digits).');
		const dec = asset === 'DZY' ? 8 : ['xUSDC', 'xUSDT'].includes(asset) ? 6 : asset === 'xBTC' ? 8 : 9, amount = toParts(amountText, dec) ?? stop('That is not an amount.');
		if (!(await sure(`Send ${amountText} ${asset} to ${to}${to.startsWith('@') ? ` (${addr.slice(0, 8)}…)` : ''}?`))) stop('Nothing sent.');
		const k = await keys();
		await api.send(k.dz, 'transfer', { asset, to: addr, amount });
		out('Sent.');
	},
	async swap() {
		const DEC = { DZY: 8, xBTC: 8, xUSDC: 6, xUSDT: 6 }, amountText = words[1] ?? stop('e.g. `dzy swap 0.005 ETH DZY`'), id = (s) => { const u = String(s ?? '').toUpperCase(); return u === 'DZY' ? 'DZY' : ['ETH', 'SOL', 'USDC', 'USDT', 'BTC', 'BNB', 'POL', 'AVAX'].includes(u) ? 'x' + u : stop(`What is ${s}?`); };
		const from = id(words[2]), to = id(words[3]), dec = DEC[from] ?? 9;
		const amount = toParts(amountText, dec) ?? stop('That is not an amount.'), me = pub().dznye;
		let q;
		try { q = await api.get(`/quote?from=${from}&to=${to}&amount=${amount}&who=${me}`); } catch { stop('No way to swap that right now.'); }
		const odec = DEC[to] ?? 9, least = Math.max(1, Math.floor(q.out * 0.99));
		out(`About ${fromParts(q.out, odec)} ${to.replace(/^x/, '')} (at least ${fromParts(least, odec)}).`);
		if (!(await sure('Swap?'))) stop('Nothing swapped.');
		const k = await keys();
		await api.send(k.dz, 'swap', { give: from, want: to, amount, min: least });
		out('Swapped.');
	},
	async name() {
		const n = String(words[1] ?? stop('`dzy name <name>`')).toLowerCase().replace(/^@/, '');
		if (!/^[a-z0-9][a-z0-9-]{4,18}[a-z0-9]$/.test(n)) stop('6 to 20 small letters, digits or dashes.');
		if (await api.whoIs(n)) stop(`@${n} is taken.`);
		const k = await keys();
		await api.send(k.dz, 'credit.take', {}).catch(() => { /* already taken, or not needed */ });
		await api.send(k.dz, 'name.set', { name: n });
		out(`You are @${n}. People can pay you by that name.`);
	},
	async node() { process.argv.splice(2, 1); await import('../node/runner.mjs'); },
	backup() { pub(); out(`Your backup file: ${SAFE}\nKeep a copy somewhere else (a USB stick, your cloud), and your PIN written down apart from it.\nIt opens in the web wallet too: wallet.dznye.com, Restore from backup.`); },
};

const cmd = words[0] ?? 'help';
try {
	if (!Object.hasOwn(C, cmd)) stop(`No command "${cmd}". Try \`dzy help\`.`);
	await C[cmd]();
} catch (e) { if (e instanceof Stop) { console.error(e.message); process.exitCode = 1; } else { console.error(e.message ?? e); process.exitCode = 1; } }
