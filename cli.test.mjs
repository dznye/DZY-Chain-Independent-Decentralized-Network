// The command line against a real local node: make keys, issue DZY, make a token, send, read. Run: node chain/cli.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newKey } from './src/crypto.ts';
import { startNode } from './node/server.mjs';
import { saveKey } from './cli.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'dznye-cli-'));
const issuer = await newKey(), validator = await newKey();
const node = await startNode({ port: 0, chain: 'dznye-cli-test', authority: issuer.address, validator, blockMs: 40 });
const run = (...a) => new Promise((ok) => execFile(process.execPath, ['--no-warnings', cli, ...a, '--node', node.url], { cwd: dir }, (err, out, errOut) => ok({ code: err ? err.code ?? 1 : 0, out: out.trim() || (err && !errOut.trim() ? `[no output: ${err.message} signal=${err.signal} code=${err.code}]` : ''), err: errOut.trim() })));
const f = (name) => join(dir, name);
saveKey(f('issuer.json'), issuer);

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };
try {
	let alice, bob, gold;
	await test('key new makes a key file and never shows the secret', async () => {
		const a = await run('key', 'new', f('alice.json')), b = await run('key', 'new', f('bob.json'));
		assert.equal(a.code, 0); assert.equal(b.code, 0);
		alice = JSON.parse(readFileSync(f('alice.json'), 'utf8')); bob = JSON.parse(readFileSync(f('bob.json'), 'utf8'));
		assert.match(a.out, new RegExp(alice.address)); assert.ok(!a.out.includes(alice.secret));
		assert.equal((await run('key', 'new', f('alice.json'))).code, 1); // never overwrites a key
	});
	await test('info and supply read the chain', async () => {
		assert.match((await run('info')).out, /Dznye \(dznye-cli-test\)[\s\S]*1 validator; a block needs 1 signature/);
		assert.match((await run('supply')).out, /limit:\s+12,000,000[\s\S]*pool founder/);
	});
	await test('issue: only the issuing key, only within a pool', async () => {
		assert.match((await run('issue', '--key', f('alice.json'), '--to', alice.address, '--amount', '5', '--reason', 'self')).err, /only the issuer/);
		assert.match((await run('issue', '--key', f('issuer.json'), '--to', alice.address, '--amount', '5', '--reason', 'x', '--pool', 'founder')).err, /founder pool has not unlocked/);
		assert.match((await run('issue', '--key', f('issuer.json'), '--to', alice.address, '--amount', '5', '--reason', 'x', '--pool', 'moon')).err, /No such pool/);
		assert.match((await run('issue', '--key', f('issuer.json'), '--to', alice.address, '--amount', '12.5', '--reason', 'first grant')).out, /Issued from the community pool/);
		assert.match((await run('balance', alice.address)).out, /12\.5 DZY/);
	});
	await test('send moves DZY, with decimals, and refuses what you do not have', async () => {
		assert.match((await run('send', '--key', f('alice.json'), '--to', bob.address, '--amount', '2.25', '--memo', 'lunch')).out, /Sent/);
		assert.match((await run('balance', bob.address)).out, /2\.25 DZY/);
		assert.match((await run('send', '--key', f('bob.json'), '--to', alice.address, '--amount', '99')).err, /not enough balance/);
		assert.match((await run('send', '--key', f('bob.json'), '--to', alice.address, '--amount', '0.000000001')).err, /at most 8 decimals/);
		assert.match((await run('balance', (await newKey()).address)).out, /Nothing yet/);
	});
	await test('token create and mint: anyone can make a token; only its maker can issue it', async () => {
		const made = await run('token', 'create', '--key', f('alice.json'), '--symbol', 'GOLD', '--name', 'Game gold', '--decimals', '2', '--cap', '1000');
		gold = made.out.match(/id is (a[0-9a-f]{16})/)?.[1];
		assert.ok(gold, JSON.stringify(made));
		assert.match((await run('token', 'mint', '--key', f('alice.json'), '--asset', gold, '--to', bob.address, '--amount', '40.5', '--reason', 'quest reward')).out, /Issued/);
		assert.match((await run('token', 'mint', '--key', f('bob.json'), '--asset', gold, '--to', bob.address, '--amount', '1')).err, /only the issuer/);
		assert.match((await run('token', 'mint', '--key', f('alice.json'), '--asset', gold, '--to', bob.address, '--amount', '2000')).err, /supply limit/);
		assert.match((await run('balance', bob.address)).out, /40\.5 GOLD/);
		assert.match((await run('tokens')).out, new RegExp(gold + '\\s+GOLD'));
		assert.match((await run('supply', gold)).out, /limit:\s+1,000 \(959\.5 not yet issued\)/);
		assert.match((await run('balance', alice.address)).out, /9\.25 DZY/); // 12.5 − 2.25 sent − 1 burned to make the token
		assert.match((await run('send', '--key', f('bob.json'), '--to', alice.address, '--amount', '0.5', '--asset', gold)).out, /Sent/);
	});
	await test('bad input fails cleanly', async () => {
		assert.equal((await run('send', '--key', f('nobody.json'), '--to', bob.address, '--amount', '1')).code, 1);
		assert.match((await run('send', '--key', f('alice.json'), '--amount', '1')).err, /Missing --to/);
		assert.match((await run('dance')).err, /Unknown command/);
		assert.match((await run('help')).out, /token create/);
	});
	await test('stake: the validator locks up DZY, staking takes over, and it starts unlocking', async () => {
		saveKey(f('validator.json'), validator);
		assert.match((await run('validators')).out, /1 validator; a block needs 1\. The starting set/);
		assert.match((await run('issue', '--key', f('issuer.json'), '--to', validator.address, '--amount', '1500', '--reason', 'stake grant')).out, /Issued/);
		assert.match((await run('stake', 'bond', '--key', f('validator.json'), '--amount', '999')).out, /Staked/); // too little for a seat: nothing changes
		assert.match((await run('validators')).out, /The starting set/);
		assert.match((await run('stake', 'bond', '--key', f('validator.json'), '--amount', '1')).out, /Staked/);
		assert.match((await run('validators')).out, new RegExp(`Chosen by stake[\\s\\S]*${validator.address}  1,000 DZY`));
		assert.match((await run('info')).out, /chosen by stake/);
		assert.match((await run('stake', 'withdraw', '--key', f('validator.json'))).err, /nothing has finished unlocking/);
		assert.match((await run('stake', 'unjail', '--key', f('validator.json'))).err, /not benched/);
		assert.match((await run('stake', 'dance', '--key', f('validator.json'))).err, /Usage: stake/);
		assert.match((await run('stake', 'bond', '--key', f('alice.json'), '--amount', '1000000')).err, /not enough DZY/);
	});
	await test('treasury: the charge for making a token went there; the issuing key pays it out, with a reason', async () => {
		assert.match((await run('supply')).out, /treasury:\s+1\n/); // the 1 DZY charge for GOLD
		assert.match((await run('treasury', 'pay', '--key', f('alice.json'), '--to', bob.address, '--amount', '0.5', '--reason', 'grant')).err, /only the chain's issuing key/);
		assert.match((await run('treasury', 'pay', '--key', f('issuer.json'), '--to', bob.address, '--amount', '0.5', '--reason', 'first grant')).out, /Paid from the treasury/);
		assert.match((await run('supply')).out, /treasury:\s+0\.5\n/);
		assert.match((await run('supply')).out, /issued:\s+1,512\.5\n/); // nothing destroyed: everything issued still exists
		assert.match((await run('supply')).out, /exists now: 1,512\.5\n/);
	});
	await test('contracts and channels from the command line: deploy, call, view; open, sign on both sides, close', async () => {
		const vault = fileURLToPath(new URL('./contracts/vault.json', import.meta.url));
		const d = await run('contract', 'deploy', '--key', f('alice.json'), '--file', vault);
		const at = d.out.match(/address is ([0-9a-f]{64})/)?.[1];
		assert.ok(at, JSON.stringify(d));
		const until = Date.now() + 3_600_000;
		assert.match((await run('contract', 'call', '--key', f('alice.json'), '--contract', at, '--fn', 'lock', '--args', `[${until}]`, '--pay', '1')).out, /Called/);
		assert.equal((await run('contract', 'view', '--contract', at, '--fn', 'unlocks')).out, String(until));
		assert.match((await run('contract', 'call', '--key', f('alice.json'), '--contract', at, '--fn', 'withdraw')).err, /still locked/);
		assert.match((await run('contract', 'show', '--contract', at)).out, /"until"/);
		assert.match((await run('contract', 'call', '--key', f('alice.json'), '--contract', at, '--fn', 'lock', '--args', 'nope')).err, /JSON list/);
		// a channel: alice locks 2 DZY, bob adds 0.5; they agree off the chain that alice now has 1.5 and bob 1
		const o = await run('channel', 'open', '--key', f('alice.json'), '--to', bob.address, '--amount', '2');
		const id = o.out.match(/id is (ch[0-9a-f]{16})/)?.[1];
		assert.ok(id, JSON.stringify(o));
		assert.match((await run('channel', 'fund', '--key', f('bob.json'), '--id', id, '--amount', '0.5')).out, /Added/);
		const state = ['--id', id, '--nonce', '1', '--a', '1.5', '--b', '1'];
		const sa = (await run('channel', 'sign', '--key', f('alice.json'), ...state)).out, sb = (await run('channel', 'sign', '--key', f('bob.json'), ...state)).out;
		assert.match(sa, /^[0-9a-f]{128}$/); assert.match(sb, /^[0-9a-f]{128}$/);
		const before = (await run('balance', bob.address)).out;
		assert.match((await run('channel', 'close', '--key', f('bob.json'), ...state, '--sig-a', sa, '--sig-b', sb)).out, /Done/);
		assert.notEqual((await run('balance', bob.address)).out, before);
		assert.match((await run('channel', 'show', '--id', id)).err, /No such channel/); // settled and gone
	});
	console.log(`\n${pass} tests passed`);
} finally { await node.stop(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
