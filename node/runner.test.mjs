// The easy node runner (node/runner.mjs), run as its own program against a chain on this computer: it makes its own
// key, follows and checks the chain, stakes itself as soon as DZY arrives (keeping a little for fees), stakes only until
// it is a checker, and pays what it earns after that to its owner's wallet. Run: node chain/node/runner.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newKey } from '../src/crypto.ts';
import { Client } from '../src/client.ts';
import { startNode } from './server.mjs';

const DZY = 100_000_000, CHAIN = 'dznye-runner-test';
const v = await newKey(), bank = await newKey(), owner = await newKey();
const lead = await startNode({ port: 0, validator: v, blockMs: 100, sun: { chain: CHAIN, time: Date.now(), validators: [v.address], seedWait: 0, sales: [{ to: bank.address, units: 1_000 * DZY, paid: 200_000_000, proof: 'test' }] } });
const client = new Client(lead.url), dir = mkdtempSync(join(tmpdir(), 'dznye-runner-'));
const until = async (what, cond, ms = 40_000) => { const end = Date.now() + ms; for (;;) { if (await cond().catch(() => false)) return; if (Date.now() > end) throw new Error('timed out waiting for: ' + what); await new Promise((r) => setTimeout(r, 300)); } };
let log = '';
const runner = spawn(process.execPath, ['--no-warnings', new URL('./runner.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--data', dir, '--port', '0', '--payout', owner.address], { env: { ...process.env, DZNYE_API: lead.url, RUNNER_EVERY_MS: '700' } });
runner.stdout.on('data', (d) => { log += d; }); runner.stderr.on('data', (d) => { log += d; });

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };
try {
	let me;
	await test('it makes its own key, kept in its folder, and asks for 1 DZY', async () => {
		await until('a key file', async () => existsSync(join(dir, 'key.json')));
		me = JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')).address;
		await until('the funding line', async () => log.includes('send 1.01 DZY or more to ' + me));
	});
	await test('it follows and checks the chain', async () => {
		await client.send(bank, 'transfer', { asset: 'DZY', to: owner.address, amount: DZY }); // any block will do
		await until('a checked block', async () => /block [1-9][0-9,]* checked/.test(log));
	});
	await test('3 DZY arrive: it stakes all but 0.01 DZY by itself', async () => {
		await client.send(bank, 'transfer', { asset: 'DZY', to: me, amount: 3 * DZY });
		await until('the stake', async () => (await client.account(me)).stake?.bond === 3 * DZY - DZY / 100);
	});
	await test('once it is a checker, what it earns is not staked: it goes to the owner\'s wallet', async () => {
		const had = (await client.account(owner.address)).balances.DZY ?? 0;
		await client.send(bank, 'transfer', { asset: 'DZY', to: me, amount: DZY / 2 }); // stands in for a day's pay
		await until('the payout', async () => ((await client.account(owner.address)).balances.DZY ?? 0) > had);
		const a = await client.account(me);
		assert.equal(a.stake.bond, 3 * DZY - DZY / 100, 'it staked the earnings instead of paying them out');
		assert.ok(((await client.account(owner.address)).balances.DZY ?? 0) - had >= DZY / 2 - DZY / 50, 'the payout is short');
	});
	console.log(`${pass} tests passed`);
} catch (e) { console.log('--- runner log ---\n' + log); throw e; } finally {
	runner.kill(); await lead.stop(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* still closing */ }
}
