#!/usr/bin/env node
// The Dznye chain from the command line. Needs only Node 24. Run `node chain/cli.mjs help`.
// Keys are files you keep: { "address": "...", "secret": "..." }. A secret is never printed and never sent to a node;
// transactions are signed on this computer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newKey, sign } from './src/crypto.ts';
import { Client, fromParts, toParts } from './src/client.ts';
import { channelMessage, volunteerMessage, contractAddress, genesis, isAddr, POOLS, RULES } from './src/ledger.ts';

const HELP = `Dznye chain

  key new [file]                         make a key (default file: dznye-key.json)
  info                                   the chain: name, block, validators
  supply [asset]                         how much exists (DZY by default), and the pools
  balance <address>                      what an account holds
  tokens                                 every token on the chain
  send   --key f --to <address> --amount 1.5 [--asset DZY] [--memo "..."]
  token create --key f --symbol GOLD --name "Game gold" [--supply 0] [--decimals 0] [--cap n] [--fixed]
               make your own token (costs 1 DZY, burned). --fixed = no more can ever be made
  token mint   --key f --asset <id> --to <address> --amount 100 [--reason "..."]
  issue  --key f --to <address> --amount 10 --reason "..." [--pool community]
               issue DZY from a pool (only the chain's issuing key; the pool's limit and timetable apply)
  treasury pay --key f --to <address> --amount 10 --reason "..."
               pay out of the chain's treasury (only the issuing key; never to itself; the reason is public)
  validators                             who makes the blocks, and what each has staked
  stake bond     --key f --amount 1000   lock up DZY to be a validator (the key is the validator's key)
  stake unbond   --key f --amount 1000   start unlocking (it waits, still answerable for cheating, before it can come out)
  stake withdraw --key f                 take out what has finished unlocking
  stake unjail   --key f                 come back after being benched for missing turns
  genesis new --chain dznye-testnet-1 --authority <address> --validators a,b,c [--fee 1000] [--out genesis.json]
               write the file every node of a new chain starts from (see chain/launch/RUNBOOK.md)
  genesis check <file>                   does the node (--node) run exactly the chain in this file?
  contract deploy --key f --file program.json [--gas 10000]      put a program on the chain (1 DZY); prints its address
  contract call   --key f --contract <addr> --fn name [--args '[1,"x"]'] [--pay 1.5] [--asset DZY] [--gas 10000]
  contract view   --contract <addr> --fn name [--args '[...]']   ask it something, free, nothing changes
  contract show   --contract <addr>                              its code, storage and balances
  channel open    --key f --to <addr> --amount 10 [--asset DZY]  lock coins in a channel with someone
  channel fund    --key f --id <id> --amount 5                   add your own coins to it
  channel sign    --key f --id <id> --nonce 3 --a 7 --b 8        sign a state (both sides do; give the other your signature)
  channel close   --key f --id <id> --nonce 3 --a 7 --b 8 --sig-a .. --sig-b ..   both signed: paid out at once
  channel start   --key f --id <id> [--nonce .. --a .. --b .. --sig-a .. --sig-b ..]   close alone (the other has a day)
  channel update  --key f --id <id> --nonce .. --a .. --b .. --sig-a .. --sig-b ..     show a newer state while it closes
  channel settle  --key f --id <id>                              pay out after the waiting time
  channel show    --id <id>
  dev-keys                               local development: keys for a one-validator test chain (see README)

  Every command takes --node <url> (default http://127.0.0.1:8787, or the DZNYE_NODE environment variable).`;

const args = process.argv.slice(2);
const flag = (name, d) => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const words = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--fixed'));
// Stop with a message. It throws instead of calling process.exit, which on Windows can cut off what was being written to a pipe.
class Stop extends Error {}
const die = (m) => { throw new Stop(m); };
const need = (name) => { const v = flag(name); if (v === undefined || v === true) die(`Missing --${name}`); return String(v); };
const loadKey = (file) => { try { const k = JSON.parse(readFileSync(file, 'utf8')); if (!k.address || !k.secret) throw 0; return k; } catch { die(`Cannot read a key from ${file}`); } };
export function saveKey(file, key) {
	if (existsSync(file)) return false;
	mkdirSync(dirname(resolve(file)), { recursive: true });
	writeFileSync(file, JSON.stringify(key, null, '\t') + '\n', { mode: 0o600 });
	return true;
}
const node = () => new Client(String(flag('node', process.env.DZNYE_NODE ?? 'http://127.0.0.1:8787')));
const decimalsOf = async (c, asset) => { const a = (await c.assets())[asset]; if (!a) die(`No such token: ${asset}`); return a.decimals; };
const amountOf = (text, decimals) => toParts(text, decimals) ?? die(decimals ? `The amount must be a number with at most ${decimals} decimals` : 'The amount must be a whole number');

/** keys for a one-validator test chain on this computer: the node's settings and the issuing key, both ignored by git */
export async function devKeys() {
	const here = (p) => fileURLToPath(new URL(p, import.meta.url));
	const vars = here('./worker/.dev.vars'), issuerFile = here('./.dev-keys/issuer.json');
	if (existsSync(vars) && existsSync(issuerFile)) return { made: false, issuer: JSON.parse(readFileSync(issuerFile, 'utf8')), vars, issuerFile };
	const issuer = await newKey(), validator = await newKey();
	mkdirSync(dirname(issuerFile), { recursive: true });
	writeFileSync(issuerFile, JSON.stringify(issuer, null, '\t') + '\n', { mode: 0o600 });
	writeFileSync(vars, `AUTHORITY_ADDRESS=${issuer.address}\nVALIDATOR_ADDRESS=${validator.address}\nVALIDATOR_SECRET=${validator.secret}\n`, { mode: 0o600 });
	return { made: true, issuer, vars, issuerFile };
}

async function main() {
	const [cmd, sub] = words;
	if (!cmd || cmd === 'help' || flag('help')) return console.log(HELP);
	if (cmd === 'key' && sub === 'new') {
		const file = words[2] ?? 'dznye-key.json', key = await newKey();
		if (!saveKey(file, key)) die(`${file} already exists. Keys are never overwritten.`);
		return console.log(`Made a key.\n  address: ${key.address}\n  file:    ${resolve(file)}\nKeep the file safe and private. Whoever has it controls the account, and nobody can restore it.`);
	}
	if (cmd === 'dev-keys') {
		const r = await devKeys();
		console.log(r.made ? 'Made keys for a local test chain.' : 'Local test keys already exist; left as they are.');
		return console.log(`  issuing key:   ${r.issuerFile}\n  node settings: ${r.vars}\n  issuer address: ${r.issuer.address}\nStart the node:  node chain/node/server.mjs --env chain/worker/.dev.vars --data ./chain-data`);
	}
	if (cmd === 'genesis' && sub === 'new') {
		const validators = need('validators').split(',').map((v) => v.trim()).filter(Boolean), fee = Number(flag('fee', 0)), out = String(flag('out', 'genesis.json'));
		if (!validators.every(isAddr)) die('Every validator must be a 64-letter address');
		if (!Number.isSafeInteger(fee) || fee < 0 || fee > RULES.maxFee) die(`The fee is in DZY parts: a whole number from 0 to ${RULES.maxFee}`);
		const g = await genesis(need('chain'), need('authority'), 0, validators, fee);
		const file = { chain: g.chain, authority: g.authority, validators: g.validators, fee: g.fee ?? 0, hash: g.last, made: new Date().toISOString().slice(0, 10) };
		if (existsSync(out)) die(`${out} already exists. A genesis file is never overwritten.`);
		writeFileSync(out, JSON.stringify(file, null, '\t') + '\n');
		return console.log(`Wrote ${out}\n  chain ${file.chain}, ${file.validators.length} starting validator${file.validators.length > 1 ? 's' : ''}, fee ${file.fee} parts\n  genesis hash ${file.hash}\nEvery operator must start from this same file. Publish the hash so anyone can check it.`);
	}
	const c = node();
	if (cmd === 'genesis' && sub === 'check') {
		const file = JSON.parse(readFileSync(words[2] ?? die('Usage: genesis check <file> --node <url>'), 'utf8'));
		const g = await c.get('/genesis');
		if (g.last !== file.hash) die(`DIFFERENT CHAIN: the node's genesis hash is ${g.last}, the file says ${file.hash}`);
		return console.log(`Same chain: ${file.chain}, genesis hash ${file.hash}`);
	}
	if (cmd === 'info') {
		const i = await c.info();
		return console.log(`${i.name} (${i.chain})\n  block ${i.height}${i.time ? ' at ' + new Date(i.time).toISOString() : ''}\n  ${i.validators.length} validator${i.validators.length > 1 ? 's' : ''}${i.staked ? ' chosen by stake' : ''}; a block needs ${i.needed} signature${i.needed > 1 ? 's' : ''}\n  fee: ${i.fee ? fromParts(i.fee, 6) + ' DZY per transaction' : 'none'}\n  this node: ${i.role}${i.haltHeight ? ' (stops at block ' + i.haltHeight + ')' : ''}${i.snapshot ? '\n  snapshot: block ' + i.snapshot.height + ', hash ' + i.snapshot.hash : ''}${i.alert ? '\n  ALERT: ' + i.alert : ''}`);
	}
	if (cmd === 'supply') {
		const id = sub ?? 'DZY', s = await c.get('/supply/' + id), f = (n) => fromParts(n, s.decimals);
		const dzy = id === 'DZY';
		console.log(`${s.name} (${s.symbol})\n  exists now: ${f(s.supply)}\n  issued:     ${f(s.issued)}\n  ${dzy ? `treasury:   ${f(s.treasury)}\n  staked:     ${f(s.staked)}` : `burned:     ${f(s.burned)}`}${s.cap != null ? `\n  limit:      ${f(s.cap)} (${f(s.left)} not yet issued)` : '\n  limit:      none'}`);
		for (const [name, p] of Object.entries(s.pools ?? {})) console.log(`  pool ${name.padEnd(10)} ${f(p.issued).padStart(12)} issued of ${f(p.cap)}; ${f(Math.floor(p.unlocked))} unlocked so far`);
		return;
	}
	if (cmd === 'tokens') {
		for (const [id, a] of Object.entries(await c.assets())) console.log(`${id.padEnd(18)} ${a.symbol.padEnd(10)} ${fromParts(a.supply, a.decimals).padStart(16)}  ${a.name}`);
		return;
	}
	if (cmd === 'balance') {
		if (!sub) die('Usage: balance <address>');
		const [acct, assets] = await Promise.all([c.account(sub), c.assets()]);
		const held = Object.entries(acct.balances);
		if (!held.length) return console.log('Nothing yet.');
		for (const [id, n] of held) console.log(`${fromParts(n, assets[id]?.decimals ?? 0).padStart(18)} ${assets[id]?.symbol ?? id}${id === 'DZY' ? '' : '  (' + id + ')'}`);
		return;
	}
	if (cmd === 'send') {
		const key = loadKey(need('key')), asset = String(flag('asset', 'DZY')), memo = flag('memo');
		const amount = amountOf(need('amount'), await decimalsOf(c, asset));
		const id = await c.send(key, 'transfer', { asset, to: need('to'), amount, ...(typeof memo === 'string' ? { memo } : {}) });
		return console.log(`Sent. Transaction ${id}`);
	}
	if (cmd === 'token' && sub === 'create') {
		const key = loadKey(need('key')), decimals = Number(flag('decimals', 0)), fixed = !!flag('fixed');
		const supply = flag('supply') ? amountOf(String(flag('supply')), decimals) : 0, cap = flag('cap') ? amountOf(String(flag('cap')), decimals) : undefined;
		const id = await c.send(key, 'asset.create', { symbol: need('symbol'), name: need('name'), supply, mintable: !fixed, decimals, ...(cap ? { cap } : {}) });
		return console.log(`Made the token. Its id is ${Client.tokenId(id)}`);
	}
	if (cmd === 'token' && sub === 'mint') {
		const key = loadKey(need('key')), asset = need('asset'), reason = flag('reason');
		const id = await c.send(key, 'mint', { asset, to: need('to'), amount: amountOf(need('amount'), await decimalsOf(c, asset)), ...(typeof reason === 'string' ? { reason } : {}) });
		return console.log(`Issued. Transaction ${id}`);
	}
	if (cmd === 'contract') {
		const gas = flag('gas') ? Number(flag('gas')) : undefined;
		const argsOf = () => { try { const a = JSON.parse(String(flag('args', '[]'))); if (!Array.isArray(a)) throw 0; return a; } catch { die('--args must be a JSON list, like \'[1, "text"]\''); } };
		if (sub === 'deploy') {
			const key = loadKey(need('key'));
			let code; try { code = JSON.parse(readFileSync(need('file'), 'utf8')); } catch { die('Cannot read a program from that file'); }
			const id = await c.send(key, 'contract.deploy', { code, ...(gas ? { gas } : {}) });
			return console.log(`Deployed. The contract's address is ${await contractAddress(id)}`);
		}
		if (sub === 'call') {
			const key = loadKey(need('key')), asset = String(flag('asset', 'DZY'));
			const pay = flag('pay') ? { asset, amount: amountOf(String(flag('pay')), await decimalsOf(c, asset)) } : undefined;
			const tx = await c.prepare(key, 'contract.call', { contract: need('contract'), fn: need('fn'), args: argsOf(), ...(pay ? { pay } : {}), ...(gas ? { gas } : {}) });
			// try it first: a call that would fail while running still pays its gas, so do not send one that would
			const sim = await c.simulate(tx);
			if (sim.refused) die(sim.refused);
			if (sim.failed && !flag('anyway')) die(`This call would fail: ${sim.failed}. Nothing was sent (add --anyway to send it and pay its gas).`);
			return console.log(`Called (gas used: ${sim.gasUsed ?? '?'}). Transaction ${await c.submit(tx)}`);
		}
		if (sub === 'view') {
			const r = await c.get(`/contract/${need('contract')}/view?fn=${encodeURIComponent(need('fn'))}&args=${encodeURIComponent(JSON.stringify(argsOf()))}`);
			return console.log(JSON.stringify(r.value));
		}
		if (sub === 'show') return console.log(JSON.stringify(await c.get('/contract/' + need('contract')), null, 2));
		die('Usage: contract deploy|call|view|show (see help)');
	}
	if (cmd === 'channel') {
		const id = () => need('id');
		const chOf = async () => c.get('/channel/' + id());
		const state = async () => {
			if (!flag('nonce')) return {};
			const ch = await chOf(), d = await decimalsOf(c, ch.asset);
			const a = flag('a') === '0' ? 0 : amountOf(need('a'), d), b = flag('b') === '0' ? 0 : amountOf(need('b'), d);
			return { nonce: Number(need('nonce')), a, b, ...(flag('sig-a') ? { sigA: need('sig-a'), sigB: need('sig-b') } : {}) };
		};
		if (sub === 'open') {
			const key = loadKey(need('key')), asset = String(flag('asset', 'DZY'));
			const tx = await c.send(key, 'channel.open', { to: need('to'), asset, amount: amountOf(need('amount'), await decimalsOf(c, asset)) });
			return console.log(`Opened. The channel's id is ch${tx.slice(0, 16)}`);
		}
		if (sub === 'fund') { const key = loadKey(need('key')), ch = await chOf(); return console.log(`Added. Transaction ${await c.send(key, 'channel.fund', { id: id(), amount: amountOf(need('amount'), await decimalsOf(c, ch.asset)) })}`); }
		if (sub === 'sign') {
			const key = loadKey(need('key')), info = await c.info(), st = await state();
			if (st.nonce === undefined) die('Give --nonce, --a and --b');
			return console.log(await sign(key.secret, channelMessage(info.chain, id(), st.nonce, st.a, st.b)));
		}
		const ops = { close: 'channel.close', start: 'channel.start', update: 'channel.update', settle: 'channel.settle' };
		if (Object.hasOwn(ops, sub)) { const key = loadKey(need('key')); return console.log(`Done. Transaction ${await c.send(key, ops[sub], { id: id(), ...(sub === 'settle' ? {} : await state()) })}`); }
		if (sub === 'show') return console.log(JSON.stringify(await chOf(), null, 2));
		die('Usage: channel open|fund|sign|close|start|update|settle|show (see help)');
	}
	if (cmd === 'treasury' && sub === 'pay') {
		const key = loadKey(need('key'));
		const id = await c.send(key, 'treasury.spend', { to: need('to'), amount: amountOf(need('amount'), 8), reason: need('reason') });
		return console.log(`Paid from the treasury. Transaction ${id}`);
	}
	if (cmd === 'validators') {
		const v = await c.get('/validators'), dzy = (n) => fromParts(n, 8);
		console.log(`${v.validators.length} validator${v.validators.length > 1 ? 's' : ''}; a block needs ${v.needed}. ${v.staked ? 'Chosen by stake' : 'The starting set (staking has not taken over yet)'}; at least ${dzy(v.minStake)} DZY to stake, ${v.unbondDays} days to unlock.`);
		for (const a of v.validators) console.log(`  ${a}  ${v.stakes[a] ? dzy(v.stakes[a].bond) + ' DZY' : '(no stake)'}`);
		const others = Object.entries(v.stakes).filter(([a]) => !v.validators.includes(a));
		if (others.length) console.log('Not in the set now:');
		for (const [a, st] of others) console.log(`  ${a}  ${dzy(st.bond)} DZY${st.tomb ? '  BARRED (signed two different votes)' : st.jailed !== undefined ? '  benched until ' + new Date(st.jailed).toISOString() : ''}`);
		return;
	}
	if (cmd === 'stake') {
		const key = loadKey(need('key'));
		const ops = { bond: 'stake.bond', unbond: 'stake.unbond', withdraw: 'stake.withdraw', unjail: 'validator.unjail' };
		if (!Object.hasOwn(ops, sub)) die('Usage: stake bond|unbond|withdraw|unjail --key f [--amount n]');
		const data = sub === 'bond' || sub === 'unbond' ? { amount: amountOf(need('amount'), 8) } : {};
		const id = await c.send(key, ops[sub], data);
		return console.log({ bond: 'Staked.', unbond: 'Unlocking started.', withdraw: 'Taken out.', unjail: 'Back in the running.' }[sub] + ` Transaction ${id}`);
	}
	if (cmd === 'volunteer' && sub === 'sign') { // vouch for a volunteer node with a staked account (it earns nothing)
		const key = loadKey(need('key')), url = String(need('url')).replace(/\/+$/, ''), info = await c.info();
		console.log("Add these to the volunteer node's settings (all public):");
		console.log(`PUBLIC_URL=${url}\nOPERATOR=${key.address}\nOPERATOR_SIG=${await sign(key.secret, volunteerMessage(info.chain, url))}`);
		return console.log('Other nodes list it while this account has at least 1% of a seat staked (stake bond).');
	}
	if (cmd === 'issue') {
		const key = loadKey(need('key')), pool = String(flag('pool', 'community'));
		if (!Object.hasOwn(POOLS, pool)) die(`No such pool. The pools are: ${Object.keys(POOLS).join(', ')}`);
		const id = await c.send(key, 'mint', { asset: 'DZY', to: need('to'), amount: amountOf(need('amount'), 8), reason: need('reason'), pool });
		return console.log(`Issued from the ${pool} pool. Transaction ${id}`);
	}
	die(`Unknown command. Run: node chain/cli.mjs help`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((e) => { console.error(e?.message || String(e)); process.exitCode = 1; });
