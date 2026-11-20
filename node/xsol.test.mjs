// The exchange's Solana vault (chain/vaults/sol), on a real Solana chain on this computer (solana-test-validator):
// attacks on the program with four validators, then the whole loop with a Dznye node, whose validator's own Dznye key
// is the vault's signer: deposit 2 SOL, confirm on Dznye, sell back, the node signs, the vault pays exactly, once.
// Needs Solana's tools (cargo-build-sbf, solana-test-validator): on Windows inside WSL (~/solana/solana-release/bin),
// elsewhere on PATH or SOLANA_BIN; without them the test says so and passes nothing. Run: node chain/node/xsol.test.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { toBase58 } from '../src/crypto.ts';
import { buildMessage, onCurve, wire } from '../src/solana.ts';
import { newKey } from '../src/crypto.ts';
import { signTx, testExchangeFrom, testExchangeVaults } from '../src/ledger.ts';
import { fromBase58 } from '../src/xrelease.ts';
import { startNode } from './server.mjs';

const WIN = process.platform === 'win32', BIN = process.env.SOLANA_BIN || (WIN ? '~/solana/solana-release/bin' : '');
const shell = (cmd) => (WIN ? ['wsl', ['-e', 'bash', '-lc', cmd]] : ['bash', ['-lc', cmd]]);
const run = (cmd) => { const [c, a] = shell(cmd); return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); };
const bin = (n) => (BIN ? `${BIN}/${n}` : n);
try { run(`test -x ${bin('solana-test-validator')} && test -x ${bin('cargo-build-sbf')}`); } catch { console.log('skipped: Solana tools not found'); process.exit(0); }
// build the program (in WSL's own disk on Windows: much faster than the shared one)
const SRC = fileURLToPath(new URL('../vaults/sol/', import.meta.url)), wslSrc = WIN ? '/mnt/' + SRC[0].toLowerCase() + SRC.slice(2).replaceAll('\\', '/') : SRC;
const BUILD = '$HOME/.dznye-build/sol';
run(`. $HOME/.cargo/env 2>/dev/null; export PATH=${BIN || '$PATH'}:$PATH; mkdir -p ${BUILD} && cp -r ${wslSrc}src ${wslSrc}Cargo.toml ${BUILD}/ && cd ${BUILD} && cargo-build-sbf >/dev/null 2>&1`);
const PROGRAM = run(`${bin('solana-keygen')} pubkey ${BUILD}/target/deploy/dznye_vault-keypair.json`).trim();
// a second, independent vault (the same program at another address) for the loop with a Dznye node
const PROGRAM2 = toBase58(createHash('sha256').update('dznye xsol second vault').digest('hex'));

const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = await freePort(), faucet = await freePort(), gossip = await freePort();
const [vc, va] = shell(`${bin('solana-test-validator')} --reset --quiet --ledger /tmp/dznye-xsol-${port} --rpc-port ${port} --faucet-port ${faucet} --gossip-port ${gossip} --dynamic-port-range ${port + 2}-${port + 30} --bpf-program ${PROGRAM} ${BUILD}/target/deploy/dznye_vault.so --bpf-program ${PROGRAM2} ${BUILD}/target/deploy/dznye_vault.so`);
const validator = spawn(vc, va, { stdio: 'ignore' });
const RPC = `http://127.0.0.1:${port}`;
let rid = 0;
async function rpc(method, params = []) { const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) })).json(); if (r.error) { const e = new Error(r.error.message + ' ' + (r.error.data?.logs ?? []).join(' | ')); throw e; } return r.result; }
for (let i = 0; i < 300; i++) { try { if ((await rpc('getHealth')) === 'ok') break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 300)); }

/* ---- keys, addresses, transactions ---- */
const keyPair = () => { const k = generateKeyPairSync('ed25519'); const pub = Buffer.from(k.publicKey.export({ format: 'jwk' }).x, 'base64url'); return { k, pub, b58: toBase58(pub.toString('hex')) }; };
const signBytes = (kp, msg) => new Uint8Array(edSign(null, Buffer.from(msg), kp.k.privateKey));
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return [...b]; };
const SYSTEM = '11111111111111111111111111111111', SYSVAR_IX = 'Sysvar1nstructions1111111111111111111111111', ED25519 = 'Ed25519SigVerify111111111111111111111111111';
const PROGRAM_B = fromBase58(PROGRAM);
function pda(seeds, prog = PROGRAM) { const pb = fromBase58(prog); for (let bump = 255; bump >= 0; bump--) { const h = createHash('sha256'); for (const s of seeds) h.update(s); h.update(Buffer.from([bump])); h.update(pb); h.update('ProgramDerivedAddress'); const out = new Uint8Array(h.digest()); if (!onCurve(out)) return toBase58(Buffer.from(out).toString('hex')); } throw new Error('no address'); }
const CONFIG = pda([Buffer.from('config')]), VAULT = pda([Buffer.from('vault')]);
async function send(payer, ixs) {
	const { value: { blockhash } } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
	const msg = buildMessage(payer.b58, ixs, blockhash), sig = await rpc('sendTransaction', [wire(signBytes(payer, msg), msg), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
	for (let i = 0; i < 200; i++) { const s = (await rpc('getSignatureStatuses', [[sig]])).value[0]; if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') { if (s.err) throw new Error('failed: ' + JSON.stringify(s.err)); return sig; } await new Promise((r) => setTimeout(r, 200)); }
	throw new Error('not confirmed');
}
const airdrop = async (to, sol) => { const s = await rpc('requestAirdrop', [to, sol * 1e9]); for (let i = 0; i < 200; i++) { const st = (await rpc('getSignatureStatuses', [[s]])).value[0]; if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return; await new Promise((r) => setTimeout(r, 200)); } };
const balance = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;
/** the set as the program reads it: n, then each key (32) and power (u64), keys ascending */
const setData = (pubs) => { const sorted = [...pubs].sort((a, b) => Buffer.compare(a, b)); return [sorted.length, ...sorted.flatMap((p) => [...p, ...u64(1)])]; };
/** an Ed25519 instruction carrying signatures, each with its key and message inside it (offsets point into itself) */
function ed25519Ix(items) {
	// each distinct message is stored once and every signature of it points there (a transaction holds 1,232 bytes)
	const head = 2 + 14 * items.length, body = [], offs = [], msgAt = new Map();
	let at = head + 96 * items.length;
	for (const { msg } of items) { const k = Buffer.from(msg).toString('hex'); if (!msgAt.has(k)) { msgAt.set(k, at); at += msg.length; } }
	let kp = head;
	for (const { pub, sig, msg } of items) { offs.push([kp + 32, kp, msgAt.get(Buffer.from(msg).toString('hex')), msg.length]); body.push(...pub, ...sig); kp += 96; }
	for (const k of msgAt.keys()) body.push(...Buffer.from(k, 'hex'));
	const w = (n) => [n & 255, n >> 8];
	return { program: ED25519, keys: [], data: [items.length, 0, ...offs.flatMap(([sigOff, pkOff, msgOff, len]) => [...w(sigOff), ...w(0xffff), ...w(pkOff), ...w(0xffff), ...w(msgOff), ...w(len), ...w(0xffff)]), ...body] };
}
const releaseMsg = (setId, id, to, amount, mint = new Uint8Array(32)) => new Uint8Array([...Buffer.from('dznye-x-release'), ...PROGRAM_B, ...u64(setId), ...id, ...mint, ...fromBase58(to), ...u64(amount)]);
const releaseIx = (payer, id, to, amount, prog = PROGRAM) => ({ program: prog, keys: [{ key: payer.b58, signer: true, writable: true }, { key: pda([Buffer.from('config')], prog) }, { key: pda([Buffer.from('released'), id], prog), writable: true }, { key: pda([Buffer.from('vault')], prog), writable: true }, { key: to, writable: true }, { key: SYSVAR_IX }, { key: SYSTEM }], data: [3, ...id, ...new Uint8Array(32), ...fromBase58(to), ...u64(amount)] });
const id32 = (s) => new Uint8Array(createHash('sha256').update(s).digest());

let pass = 0;
const test = async (name, fn) => { const note = await fn(); pass++; console.log('ok  ', name, note ? '— ' + note : ''); };
const fails = async (p, why) => { try { await p; } catch (e) { assert.match(e.message, why); return; } throw new Error('it went through: expected ' + why); };
const open = [];
try {
	const payer = keyPair(), depositor = keyPair(), payee = keyPair(), vs = [keyPair(), keyPair(), keyPair(), keyPair()].sort((a, b) => Buffer.compare(a.pub, b.pub));
	await airdrop(payer.b58, 10); await airdrop(depositor.b58, 10);

	await test('the vault is set up once, with four validators; deposits are tagged with a Dznye address', async () => {
		await send(payer, [{ program: PROGRAM, keys: [{ key: payer.b58, signer: true, writable: true }, { key: CONFIG, writable: true }, { key: SYSTEM }], data: [0, ...setData(vs.map((v) => v.pub))] }]);
		await fails(send(payer, [{ program: PROGRAM, keys: [{ key: payer.b58, signer: true, writable: true }, { key: CONFIG, writable: true }, { key: SYSTEM }], data: [0, ...setData([payer.pub])] }]), /already set up/);
		const dz = createHash('sha256').update('a dznye address').digest();
		await send(depositor, [{ program: PROGRAM, keys: [{ key: depositor.b58, signer: true, writable: true }, { key: VAULT, writable: true }, { key: SYSTEM }], data: [1, ...dz, ...u64(3e9)] }]);
		assert.equal(await balance(VAULT), 3e9);
		await fails(send(depositor, [{ program: PROGRAM, keys: [{ key: depositor.b58, signer: true, writable: true }, { key: VAULT, writable: true }, { key: SYSTEM }], data: [1, ...new Uint8Array(32), ...u64(1e9)] }]), /no Dznye address/);
		return `program ${PROGRAM}, vault ${VAULT}: 3 SOL deposited`;
	});

	await test('three of four signatures release exactly once; two of four cannot; a changed amount or an outsider does not count; a validator cannot sign twice', async () => {
		const id = id32('payout-1'), msg = releaseMsg(1, id, payee.b58, 1e9), sig = (v) => ({ pub: v.pub, sig: signBytes(v, msg), msg });
		await fails(send(payer, [ed25519Ix([sig(vs[0]), sig(vs[1])]), releaseIx(payer, id, payee.b58, 1e9)]), /more than two thirds/);
		await fails(send(payer, [ed25519Ix([sig(vs[0]), sig(vs[1]), sig(vs[2])]), releaseIx(payer, id, payee.b58, 2e9)]), /more than two thirds/); // signed for 1 SOL
		const outsider = keyPair();
		await fails(send(payer, [ed25519Ix([sig(vs[0]), sig(vs[1]), { pub: outsider.pub, sig: signBytes(outsider, msg), msg }]), releaseIx(payer, id, payee.b58, 1e9)]), /not a validator of this set/);
		await fails(send(payer, [ed25519Ix([sig(vs[0]), sig(vs[0]), sig(vs[1])]), releaseIx(payer, id, payee.b58, 1e9)]), /signed twice/);
		await send(payer, [ed25519Ix([sig(vs[0]), sig(vs[1]), sig(vs[2])]), releaseIx(payer, id, payee.b58, 1e9)]);
		assert.equal(await balance(payee.b58), 1e9, 'the payee was not paid exactly 1 SOL');
		await fails(send(payer, [ed25519Ix([sig(vs[0]), sig(vs[1]), sig(vs[2])]), releaseIx(payer, id, payee.b58, 1e9)]), /already released/);
		assert.equal(await balance(VAULT), 2e9, 'the vault paid more than once');
	});

	await test('a forged signature fails in Solana\'s own check; the set changes only by its own signatures, and old signatures then fail', async () => {
		const id = id32('payout-2'), msg = releaseMsg(1, id, payee.b58, 1e8), good = (v) => ({ pub: v.pub, sig: signBytes(v, msg), msg });
		const bad = { pub: vs[2].pub, sig: signBytes(vs[2], releaseMsg(1, id, payee.b58, 999)), msg };
		await fails(send(payer, [ed25519Ix([good(vs[0]), good(vs[1]), bad]), releaseIx(payer, id, payee.b58, 1e8)]), /invalid|failed|Error/i);
		const fresh = keyPair(), newSet = setData([fresh.pub]);
		const setMsg = new Uint8Array([...Buffer.from('dznye-x-signers'), ...PROGRAM_B, ...u64(1), ...createHash('sha256').update(Buffer.from(newSet)).digest()]);
		const setIx = (signers) => [ed25519Ix(signers.map((v) => ({ pub: v.pub, sig: signBytes(v, setMsg), msg: setMsg }))), { program: PROGRAM, keys: [{ key: CONFIG, writable: true }, { key: SYSVAR_IX }], data: [4, ...newSet] }];
		await fails(send(payer, setIx(vs.slice(0, 2))), /more than two thirds/);
		await send(payer, setIx(vs.slice(0, 3)));
		await fails(send(payer, [ed25519Ix(vs.slice(0, 3).map(good)), releaseIx(payer, id, payee.b58, 1e8)]), /more than two thirds/); // the old set signed for set 1: those signatures match nothing now
		const m2 = releaseMsg(2, id, payee.b58, 1e8);
		await send(payer, [ed25519Ix([{ pub: fresh.pub, sig: signBytes(fresh, m2), msg: m2 }]), releaseIx(payer, id, payee.b58, 1e8)]);
		assert.equal(await balance(payee.b58), 1.1e9);
		return 'the new set (one validator) released 0.1 SOL; the old set could not';
	});

	await test('the whole loop with a Dznye node: the validator\'s own Dznye key is the vault\'s signer; 2 SOL deposited, confirmed, sold back, signed by the node, paid exactly once', async () => {
		const CHAIN = 'dznye-xsol-test', DZY = 100_000_000, V = await newKey(), A = await newKey();
		testExchangeFrom(CHAIN, 1);
		const node = await startNode({ port: 0, sun: { chain: CHAIN, time: Date.now(), validators: [V.address], seedWait: 0, sales: [{ to: V.address, units: 100 * DZY, paid: 20_000_000, proof: 'test' }] }, validator: V, blockMs: 50, watchMs: 300, solanaRpc: rpc, priceRead: async () => ({ SOL: 150_000_000 }) }); // the node's own watchers read this local Solana chain
		open.push(node);
		const get = async (p) => (await fetch(node.url + p)).json();
		const tx = async (k, type, data) => { const r = await fetch(node.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: await signTx(k.secret, { chain: CHAIN, from: k.address, nonce: (await get('/account/' + k.address)).nextNonce, type, data }) }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
		const until = async (what, cond, tries = 150) => { for (let i = 0; i < tries; i++) { if (await cond().catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error('timed out: ' + what); };
		// vault 2's one signer is the Dznye validator's own key: its Dznye address IS an Ed25519 (Solana) key
		const C2 = pda([Buffer.from('config')], PROGRAM2), V2 = pda([Buffer.from('vault')], PROGRAM2);
		await send(payer, [{ program: PROGRAM2, keys: [{ key: payer.b58, signer: true, writable: true }, { key: C2, writable: true }, { key: SYSTEM }], data: [0, ...setData([Buffer.from(V.address, 'hex')])] }]);
		testExchangeVaults(CHAIN, { sol: PROGRAM2 });
		const sig = await send(depositor, [{ program: PROGRAM2, keys: [{ key: depositor.b58, signer: true, writable: true }, { key: V2, writable: true }, { key: SYSTEM }], data: [1, ...Buffer.from(A.address, 'hex'), ...u64(2e9)] }]);
		assert.equal(await balance(V2), 2e9);
		// nobody confirms by hand: the node finds the deposit in the vault once it is finalized (about 15 seconds here)
		await until('claims', async () => (await get('/exchange/' + A.address)).locks.SOL === 2e9, 600);
		void sig;
		const payee2 = keyPair();
		await tx(A, 'x.close', { coin: 'SOL', net: 'sol', to: payee2.b58 }); // the whole lock, for the DZY it bought
		await until('the payout', async () => (await get('/exchange/' + A.address)).payouts.length === 1);
		const p = (await get('/exchange/' + A.address)).payouts[0];
		const r = await get(`/exchange/release/${p.id}?setId=1`);
		assert.equal(r.signer, V.address); assert.equal(r.amount, String(2e9 - 2e6), 'not 2 SOL less 0.1%');
		const msg = Buffer.from(r.message, 'hex'), id = Buffer.from(r.id32.replace(/^0x/, ''), 'hex'), item = { pub: Buffer.from(V.address, 'hex'), sig: Buffer.from(r.sig, 'hex'), msg };
		await fails(send(payer, [ed25519Ix([item]), releaseIx(payer, id, payee2.b58, 2e9 - 2e6 + 1, PROGRAM2)]), /more than two thirds/); // one lamport more than signed
		await send(payer, [ed25519Ix([item]), releaseIx(payer, id, payee2.b58, 2e9 - 2e6, PROGRAM2)]);
		assert.equal(await balance(payee2.b58), 2e9 - 2e6, 'the payee was not paid exactly');
		assert.equal(await balance(V2), 2e6, '0.002 SOL did not stay in the pot');
		await until('the payout marked paid', async () => !!(await get('/exchange/' + A.address)).payouts[0].tx, 600); // the node read the vault's release
		await fails(send(payer, [ed25519Ix([item]), releaseIx(payer, id, payee2.b58, 2e9 - 2e6, PROGRAM2)]), /already released/);
		return `2 SOL deposited, confirmed on Dznye, sold back; the node signed and the vault paid ${(2e9 - 2e6) / 1e9} SOL once; 0.002 SOL stays in the pot`;
	});
	console.log(`\n${pass} tests passed`);
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { for (const n of open) await n.stop().catch(() => {}); validator.kill(); try { run(`pkill -f 'solana-test-validator.*dznye-xsol-${port}' || true`); } catch { /* gone */ } testExchangeFrom('dznye-xsol-test', null); testExchangeVaults('dznye-xsol-test', null); }
