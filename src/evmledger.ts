/* Solidity contracts on Dznye itself (the Heart upgrade): the Ethereum machine (evmcore.ts), run by every validator like any
   other rule of the chain. No operator, no bridge and nobody to trust besides the chain.

   - One DZY here is 10^18 wei there (a shard is 10^10 wei). evm.in moves DZY, or any token of the chain (xUSDC, xETH, a
     launched coin...), from a Dznye account to a 0x address; a 0x address takes it out again by calling the exit.
   - A signed Ethereum transaction travels inside an evm.run, sent by anyone (a node does it for wallets: /evm). It is
     checked exactly as Ethereum would: the signature, the chain id, the nonce, the balance, the gas.
   - Gas costs shards: max(10, 2 x fee) a unit, so it rises with the chain's own fee (a payment 0.0021 DZY, a swap about 0.012). Whoever carried the transaction gets
     their fee back out of it; the rest goes into the fee pot (40% validators, 30% backing, ...).
   - 0x…0d27 is the exit: call it with DZY and a 32-byte Dznye address. Every token has its own ERC-20 address here
     (tokenAddress), run by the chain: balanceOf, transfer, approve, transferFrom, and exit(bytes32 to, uint256 amount).
   Nothing in here can touch anything of the chain outside what was brought in (evmHeld), and it never pays out more. */
import { evmRoom, workAdd } from './work.ts';
import { createAddress, decodeTx, hex, intrinsic, keccak, rlp, toWord, transact, unhex, Vm, word32, type Env, type EvmTx, type Host, type Log, type Native } from './evmcore.ts';

const own = (o: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(o, k), B = BigInt, N = Number;
const fail = (m: string): never => { throw new Error(m); };
export const EVM_RULES = Object.freeze({ callGas: 6_000_000, chainId: 4_479_577n, txGas: 12_000_000, blockGas: 30_000_000, maxRaw: 130_000, wei: 10n ** 10n, exit: '0'.repeat(36) + '0d27' }); // the chain id is "DZY" in letters' codes
export interface EvmAcct { n: number; b: string; c?: string; t?: string } // nonce, balance (wei, hex), code's hash, the token it is
export interface EvmState { held: Record<string, number> }
export interface Receipt { hash: string; from: string; to: string | null; contract?: string; ok: boolean; gas: number; price: string; logs: Log[]; raw: string; why?: string }
interface S { chain: string; height: number; time: number; last: string; fee?: number; heart?: unknown; evm?: EvmState; evmAccts?: Record<string, EvmAcct>; evmCodes?: Record<string, string>; evmSlots?: Record<string, string>; assets: Record<string, { symbol: string; name: string; decimals: number; supply: number }>; recent?: { h: number; hashes: string[] } }
export interface EvmBank { add(who: string, asset: string, n: number): void; sub(who: string, asset: string, n: number): void; balance(who: string, asset: string): number; toFees(n: number): void; amount(v: unknown): number; asset(v: unknown): string; /** what carrying this cost in fees, and who paid it */ carried: number; carrier: string }

const CODES = new Map<string, Uint8Array>(); // code already read, by its hash (never part of a result)
function codeOf(s: S, h: string): Uint8Array { let c = CODES.get(h); if (c) return c; c = unhex(s.evmCodes![h]); if (CODES.size > 500) CODES.delete(CODES.keys().next().value as string); CODES.set(h, c); return c; }
const EMPTY = new Uint8Array(0), NATIVE_CODE = Uint8Array.of(0xfe);
export const shardsPerGas = (s: S) => Math.max(10, Math.ceil((s.fee ?? 0) / 1_000)); // a payment's 21,000 gas: about as much as 20 ordinary fees; a stored word's 20,000: a lasting entry's price
export const tokenAddress = (asset: string) => 'd27d27' + hex(keccak(new TextEncoder().encode('dzy-asset:' + asset))).slice(0, 34);
export function hostOf(s: S): Host {
	return {
		account(a) { const x = s.evmAccts && own(s.evmAccts, a) ? s.evmAccts[a] : null; if (!x) return null; return { nonce: B(x.n), balance: x.b === '' ? 0n : B('0x' + x.b), code: x.t ? NATIVE_CODE : x.c ? codeOf(s, x.c) : EMPTY, ...(x.c ? { hash: x.c } : {}) }; },
		slot(a, k) { const key = a + k.toString(16).padStart(64, '0'), v = s.evmSlots && own(s.evmSlots, key) ? s.evmSlots[key] : undefined; return v === undefined ? 0n : B('0x' + v); },
		blockHash(n) { const i = s.recent ? N(n) - s.recent.h : -1, h = n === B(s.height) ? s.last : s.recent && i >= 0 && i < s.recent.hashes.length ? s.recent.hashes[i] : ''; return h ? B('0x' + h) : 0n; },
	};
}
export const envOf = (s: S, time: number, height: number, origin: string): Env => { const p = B(shardsPerGas(s)) * EVM_RULES.wei; return { origin, gasPrice: p, number: B(height), time: B(Math.floor(time / 1000)), gasLimit: B((s.heart as { fut?: 1 } | undefined)?.fut ? evmRoom(s as never) : EVM_RULES.blockGas), ...((s.heart as { fut?: 1 } | undefined)?.fut ? { fut: true } : {}), chainId: EVM_RULES.chainId, random: toWord(keccak(new TextEncoder().encode(`dzy-random:${s.last}:${height}`))), baseFee: p, coinbase: '0'.repeat(40) }; };

/* ---------- the chain's own contracts: the exit, and every token's ERC-20 ---------- */
interface Out { to: string; asset: string; n: number }
const SEL = Object.fromEntries(['name()', 'symbol()', 'decimals()', 'totalSupply()', 'balanceOf(address)', 'transfer(address,uint256)', 'approve(address,uint256)', 'allowance(address,address)', 'transferFrom(address,address,uint256)', 'exit(bytes32,uint256)'].map((f) => [hex(keccak(new TextEncoder().encode(f))).slice(0, 8), f]));
const TOPIC = { transfer: hex(keccak(new TextEncoder().encode('Transfer(address,address,uint256)'))), approval: hex(keccak(new TextEncoder().encode('Approval(address,address,uint256)'))) };
const balSlot = (a: string) => toWord(keccak(unhex(a.padStart(64, '0') + '0'.repeat(64)))), allowSlot = (o: string, p: string) => toWord(keccak(unhex(o.padStart(64, '0') + p.padStart(64, '0')))), TOTAL = 2n;
const text = (t: string) => { const b = new TextEncoder().encode(t), o = new Uint8Array(64 + Math.ceil(b.length / 32) * 32); o[31] = 32; o.set(word32(B(b.length)), 32); o.set(b, 64); return o; };
export function natives(s: S): Native {
	return (vm, m) => {
		const no = (gas = 0) => ({ ok: false, out: EMPTY, gas });
		if (m.to === EVM_RULES.exit) {
			if (m.gas < 9_000 || m.readonly) return no();
			const to = hex(m.data);
			if (m.data.length !== 32 || m.value <= 0n || m.value % EVM_RULES.wei !== 0n) return no(m.gas - 9_000);
			vm.setBalance(m.to, vm.acct(m.to).balance - m.value); // what arrived here leaves
			const o: Out = { to, asset: 'DZY', n: N(m.value / EVM_RULES.wei) }; vm.outs.push(o); vm.note(() => { vm.outs.pop(); });
			vm.log({ at: m.to, topics: [hex(keccak(new TextEncoder().encode('Exit(bytes32,uint256)'))), to], data: hex(word32(m.value)) });
			return { ok: true, out: EMPTY, gas: m.gas - 9_000 };
		}
		const id = s.evmAccts && own(s.evmAccts, m.to) ? s.evmAccts[m.to].t : undefined;
		if (id === undefined) return null;
		const f = SEL[hex(m.data.subarray(0, 4))], w = (i: number) => { const b = new Uint8Array(32), from = 4 + i * 32; b.set(m.data.subarray(from, from + 32)); return b; }, addr = (i: number) => { const b = w(i); return b.subarray(0, 12).some((x) => x) ? null : hex(b.subarray(12)); }, num = (i: number) => toWord(w(i));
		const cost = !f ? 0 : /^(name|symbol|decimals|totalSupply|balanceOf|allowance)/.test(f) ? 2_600 : f.startsWith('approve') ? 25_000 : f.startsWith('transferFrom') ? 45_000 : 35_000;
		if (m.gas < cost) return no();
		const left = m.gas - cost, yes = (out: Uint8Array) => ({ ok: true, out, gas: left }), one = word32(1n), a = s.assets[id], T = m.to;
		if (!f || m.value !== 0n) return no(left);
		const bal = (x: string) => vm.sload(T, balSlot(x));
		const move = (from: string, to: string, v: bigint) => { const b = bal(from); if (b < v) return false; vm.sstore(T, balSlot(from), b - v); vm.sstore(T, balSlot(to), bal(to) + v); vm.log({ at: T, topics: [TOPIC.transfer, from.padStart(64, '0'), to.padStart(64, '0')], data: hex(word32(v)) }); return true; };
		switch (f) {
			case 'name()': return yes(text(a.name)); case 'symbol()': return yes(text(a.symbol)); case 'decimals()': return yes(word32(B(a.decimals))); case 'totalSupply()': return yes(word32(vm.sload(T, TOTAL)));
			case 'balanceOf(address)': { const x = addr(0); return x ? yes(word32(bal(x))) : no(left); }
			case 'allowance(address,address)': { const x = addr(0), y = addr(1); return x && y ? yes(word32(vm.sload(T, allowSlot(x, y)))) : no(left); }
		}
		if (m.readonly) return no();
		if (f === 'approve(address,uint256)') { const p = addr(0); if (!p) return no(left); vm.sstore(T, allowSlot(m.from, p), num(1)); vm.log({ at: T, topics: [TOPIC.approval, m.from.padStart(64, '0'), p.padStart(64, '0')], data: hex(word32(num(1))) }); return yes(one); }
		if (f === 'transfer(address,uint256)') { const to = addr(0); return to && !/^0{40}$/.test(to) && move(m.from, to, num(1)) ? yes(one) : no(left); }
		if (f === 'transferFrom(address,address,uint256)') {
			const from = addr(0), to = addr(1), v = num(2); if (!from || !to || /^0{40}$/.test(to)) return no(left);
			const k = allowSlot(from, m.from), al = vm.sload(T, k); if (al < v) return no(left);
			if (!move(from, to, v)) return no(left);
			if (al !== (1n << 256n) - 1n) vm.sstore(T, k, al - v);
			return yes(one);
		}
		const v = num(1), b = bal(m.from); if (v <= 0n || b < v || v > B(Number.MAX_SAFE_INTEGER)) return no(left); // exit
		vm.sstore(T, balSlot(m.from), b - v); vm.sstore(T, TOTAL, vm.sload(T, TOTAL) - v);
		const o: Out = { to: hex(w(0)), asset: id, n: N(v) }; vm.outs.push(o); vm.note(() => { vm.outs.pop(); });
		vm.log({ at: T, topics: [TOPIC.transfer, m.from.padStart(64, '0'), '0'.repeat(64)], data: hex(word32(v)) });
		return yes(one);
	};
}
export const newVm = (s: S, time: number, height: number, origin: string) => new Vm(hostOf(s), envOf(s, time, height, origin), natives(s));

/* ---------- transactions ---------- */
const DECODED = new Map<string, ReturnType<typeof decodeTx>>(); // a signature already worked out is not worked out again (speed only)
export function decoded(raw: string): ReturnType<typeof decodeTx> {
	let t = DECODED.get(raw); if (t) return t;
	t = decodeTx(unhex(raw), EVM_RULES.chainId);
	if (DECODED.size > 3_000) DECODED.delete(DECODED.keys().next().value as string); DECODED.set(raw, t);
	return t;
}
/** a host with more cores may lend them (node/evmpool.mjs): what it gives back is what this code would have worked out */
let lent: ((raws: string[], chainId: bigint) => Promise<(ReturnType<typeof decodeTx> | null)[]>) | null = null;
export const lendDecoder = (f: typeof lent) => { lent = f; };
export async function decodeTogether(raws: unknown[]): Promise<void> {
	if (!lent) return;
	const todo = [...new Set(raws.filter((r): r is string => typeof r === 'string' && r.length <= EVM_RULES.maxRaw && !DECODED.has(r)))].slice(0, 2_000);
	if (todo.length < 8) return;
	const out = await lent(todo, EVM_RULES.chainId).catch(() => []); out.forEach((t, i) => { if (t) { if (DECODED.size > 3_000) DECODED.delete(DECODED.keys().next().value as string); DECODED.set(todo[i], t); } });
}
/** why this transaction cannot run now, or '' */
export function problem(s: S, t: ReturnType<typeof decodeTx>): string {
	const price = B(shardsPerGas(s)) * EVM_RULES.wei, a = hostOf(s).account(t.from), need = intrinsic(t);
	if (t.max < price) return `the gas price is below the chain's: ${price} wei`;
	if (t.gasLimit > EVM_RULES.txGas) return `at most ${EVM_RULES.txGas} gas`;
	if (t.gasLimit < Math.max(need.need, need.floor)) return 'intrinsic gas too low';
	if (t.to === null && t.data.length > 49_152) return 'the contract is too big';
	const nonce = a?.nonce ?? 0n; if (t.nonce !== nonce) return t.nonce < nonce ? 'nonce too low' : `nonce too high: the next is ${nonce}`;
	if (a?.code.length) return 'a contract cannot send transactions';
	if ((a?.balance ?? 0n) < B(t.gasLimit) * price + t.value) return 'insufficient funds for gas * price + value';
	return '';
}
/** every receipt made while a block was put together or checked, by that block's state; then by the block */
const BY_STATE = new WeakMap<object, Receipt[]>(), BY_BLOCK = new WeakMap<object, Receipt[]>();
export const receiptsOf = (block: object) => BY_BLOCK.get(block) ?? [];
export const keepReceipts = (block: object, state: object) => { const r = BY_STATE.get(state); if (r) BY_BLOCK.set(block, r); };
/** the draft's changes, into the state */
function write(s: S, vm: Vm) {
	const accts = (s.evmAccts ??= {});
	for (const [a, x] of vm.accts) {
		const was = own(accts, a) ? accts[a] : null; if (was?.t) { const b = x.balance.toString(16); if (b !== '0' && b !== was.b) accts[a] = { ...was, b }; continue; }
		const gone = x.nonce === 0n && x.balance === 0n && x.code.length === 0;
		if (gone) { if (was) delete accts[a]; continue; }
		const c = x.code.length ? vm.codeHash(x) : undefined, b = x.balance === 0n ? '' : x.balance.toString(16);
		if (was && was.n === N(x.nonce) && was.b === b && was.c === c) continue;
		if (c && !(s.evmCodes && own(s.evmCodes, c))) (s.evmCodes ??= {})[c] = hex(x.code);
		accts[a] = { n: N(x.nonce), b, ...(c ? { c } : {}) };
	}
	for (const [k, v] of vm.slots) {
		const a = k.slice(0, 40), key = a + k.slice(40).padStart(64, '0'), was = s.evmSlots && own(s.evmSlots, key) ? s.evmSlots[key] : undefined;
		if (v === 0n) { if (was !== undefined) delete s.evmSlots![key]; } else { const t = v.toString(16); if (t !== was) (s.evmSlots ??= {})[key] = t; }
	}
	if (!Object.keys(accts).length) delete s.evmAccts;
}
type EH = (s: S, from: string, d: Record<string, unknown>, id: string, time: number, ctx: { height: number }, bank: EvmBank) => () => void;
const only = (d: Record<string, unknown>, ...k: string[]) => { for (const x of Object.keys(d)) if (!k.includes(x)) fail(`"${x}" is not expected here`); };
const need = (s: S) => { if (!s.heart) fail('Ethereum contracts start with the Heart upgrade'); };
export const EVM_HANDLERS: Record<string, EH> = {
	/** DZY, or any token, from here to a 0x address there */
	'evm.in'(s, from, d, _id, time, ctx, bank) {
		need(s); only(d, 'to', 'amount', 'asset');
		const to = typeof d.to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(d.to) ? d.to.slice(2).toLowerCase() : fail('to: a 0x address'), amount = bank.amount(d.amount), asset = d.asset === undefined ? 'DZY' : bank.asset(d.asset);
		if (bank.balance(from, asset) < amount) fail('not enough balance');
		if (/^0{30}/.test(to) || to.startsWith('d27d27')) fail('that address belongs to the machine: coins sent there are lost');
		const T = tokenAddress(asset);
		return () => {
			bank.sub(from, asset, amount); const h = ((s.evm ??= { held: {} }).held); h[asset] = (own(h, asset) ? h[asset] : 0) + amount;
			const vm = newVm(s, time, ctx.height, to);
			if (asset === 'DZY') vm.setBalance(to, vm.acct(to).balance + B(amount) * EVM_RULES.wei);
			else { const x = s.evmAccts && own(s.evmAccts, T) ? s.evmAccts[T] : null; if (!x?.t) (s.evmAccts ??= {})[T] = { n: 1, b: x?.b ?? '', t: asset }; const k = balSlot(to); vm.sstore(T, k, vm.sload(T, k) + B(amount)); vm.sstore(T, TOTAL, vm.sload(T, TOTAL) + B(amount)); }
			write(s, vm);
		};
	},
	/** a signed Ethereum transaction, carried by anyone */
	'evm.run'(s, _from, d, _id, time, ctx, bank) {
		need(s); only(d, 'raw', 'gas');
		const raw = typeof d.raw === 'string' && d.raw.length <= EVM_RULES.maxRaw && /^([0-9a-f]{2})+$/.test(d.raw) ? d.raw : fail('raw: a signed Ethereum transaction, in hex');
		let t: ReturnType<typeof decodeTx>; try { t = decoded(raw); } catch (e) { return fail((e as Error).message); }
		if (d.gas !== t.gasLimit) fail('gas: the transaction\'s own gas limit');
		const why = problem(s, t); if (why) fail(why);
		const price = B(shardsPerGas(s)) * EVM_RULES.wei, vm = newVm(s, time, ctx.height, t.from);
		vm.accts.get(t.from) ?? vm.acct(t.from); vm.acct(t.from).balance -= B(t.gasLimit) * price; // the most it may cost is set aside first, as on Ethereum
		const r = transact(vm, t as EvmTx), paid = r.used * shardsPerGas(s);
		vm.acct(t.from).balance += B(t.gasLimit - r.used) * price;
		const outs = vm.outs as Out[], list = BY_STATE.get(s as object) ?? [];
		return () => {
			write(s, vm);
			workAdd(s as never, r.used, (s.heart as { fut?: 1 } | undefined)?.fut ? evmRoom(s as never) : 1);
			const h = s.evm!.held; h.DZY -= paid;
			const back = Math.min(paid, bank.carried); if (back) bank.add(bank.carrier, 'DZY', back); if (paid - back) bank.toFees(paid - back);
			for (const o of outs) { h[o.asset] -= o.n; if (h[o.asset] < 0) fail('cannot happen: more went out than came in'); bank.add(o.to, o.asset, o.n); }
			for (const k of Object.keys(h)) if (!h[k]) delete h[k];
			list.push({ hash: t.hash, from: t.from, to: t.to, ...(r.address ? { contract: r.address } : {}), ok: r.ok, gas: r.used, price: price.toString(), logs: r.ok ? vm.logs : [], raw, ...(r.ok ? {} : { why: hex(r.out).slice(0, 1_000) }) }); BY_STATE.set(s as object, list);
		};
	},
};
export function evmHeld(s: S, t: Record<string, number>) { for (const [k, n] of Object.entries(s.evm?.held ?? {})) t[k] = (t[k] ?? 0) + n; }

/* ---------- what wallets and apps ask (JSON-RPC, as any Ethereum node answers) ---------- */
const q = (v: bigint | number) => '0x' + v.toString(16), q32 = (v: string) => '0x' + v.padStart(64, '0');
class RpcError extends Error { code: number; data?: string; constructor(code: number, m: string, data?: string) { super(m); this.code = code; this.data = data; } }
export interface RpcHost { state(): S; pending?(): S; now(): number; block(h: number): { height: number; time: number; prev: string; hash: string; receipts: Receipt[] } | null; find(hash: string): { height: number; index: number } | null; send(raw: string, gas: number): Promise<string> }
/** run a call on the state as it is; nothing is kept */
export function simulate(s: S, time: number, c: Record<string, unknown>, gas: number) {
	const a = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.slice(2).toLowerCase() : null), from = a(c.from) ?? '0'.repeat(40), vm = newVm(s, time, s.height + 1, from);
	const data = unhex(String(c.input ?? c.data ?? '0x')), value = c.value === undefined ? 0n : B(c.value as string), to = c.to === undefined || c.to === null ? null : a(c.to) ?? fail('bad address');
	if (data.length > 130_000) fail('too much data');
	if (value > vm.acct(from).balance) vm.acct(from).balance += value; // a trial, as Ethereum nodes allow
	const t: EvmTx = { from, to, nonce: vm.acct(from).nonce, value, data, gasLimit: gas, price: 0n };
	return transact(vm, t);
}
function revertText(out: Uint8Array): string { if (out.length >= 68 && hex(out.subarray(0, 4)) === '08c379a0') { const n = N(toWord(out.subarray(36, 68))); if (n <= out.length - 68) return 'execution reverted: ' + new TextDecoder().decode(out.subarray(68, 68 + n)); } return 'execution reverted'; }
export async function evmRpc(h: RpcHost, method: string, p: unknown[]): Promise<unknown> {
	const s = h.state(), price = B(shardsPerGas(s)) * EVM_RULES.wei, host = hostOf(s);
	const addr = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.slice(2).toLowerCase() : (() => { throw new RpcError(-32602, 'bad address'); })());
	const height = (v: unknown) => (v === undefined || v === 'latest' || v === 'pending' || v === 'safe' || v === 'finalized' ? s.height : v === 'earliest' ? 1 : typeof v === 'string' && /^0x[0-9a-f]{1,12}$/i.test(v) ? parseInt(v, 16) : (() => { throw new RpcError(-32602, 'bad block'); })());
	const logsOf = (r: Receipt, b: { height: number; hash: string }, i: number, base: number) => r.logs.map((l, j) => ({ address: '0x' + l.at, topics: l.topics.map(q32), data: '0x' + l.data, blockNumber: q(b.height), blockHash: '0x' + b.hash, transactionHash: '0x' + r.hash, transactionIndex: q(i), logIndex: q(base + j), removed: false }));
	const txView = (r: Receipt, b: { height: number; hash: string }, i: number) => { const t = decoded(r.raw); return { hash: '0x' + r.hash, blockNumber: q(b.height), blockHash: '0x' + b.hash, transactionIndex: q(i), from: '0x' + r.from, to: r.to ? '0x' + r.to : null, nonce: q(t.nonce), value: q(t.value), input: '0x' + hex(t.data), gas: q(t.gasLimit), gasPrice: q(B(r.price)), type: q(t.type), chainId: q(EVM_RULES.chainId), ...(t.type === 2 ? { maxFeePerGas: q(t.max), maxPriorityFeePerGas: q(t.tip) } : {}), v: '0x0', r: '0x0', s: '0x0' }; };
	const blockView = (n: number, full: boolean) => { const b = h.block(n); if (!b) return null; return { number: q(n), hash: '0x' + b.hash, parentHash: '0x' + b.prev, timestamp: q(Math.floor(b.time / 1000)), nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0', mixHash: q32(hex(keccak(new TextEncoder().encode(b.prev)))), sha3Uncles: q32('1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347'), logsBloom: '0x' + '0'.repeat(512), stateRoot: q32(b.hash), transactionsRoot: q32(b.hash), receiptsRoot: q32(b.hash), miner: '0x' + '0'.repeat(40), extraData: '0x', size: '0x0', gasLimit: q(EVM_RULES.blockGas), gasUsed: q(b.receipts.reduce((g, r) => g + r.gas, 0)), baseFeePerGas: q(price), uncles: [], transactions: b.receipts.map((r, i) => (full ? txView(r, b, i) : '0x' + r.hash)) }; };
	switch (method) {
		case 'eth_chainId': return q(EVM_RULES.chainId); case 'net_version': return String(EVM_RULES.chainId); case 'web3_clientVersion': return 'Dznye/heart'; case 'net_listening': return true; case 'eth_syncing': return false; case 'eth_accounts': return []; case 'eth_mining': return false;
		case 'eth_blockNumber': return q(s.height); case 'eth_gasPrice': return q(price); case 'eth_maxPriorityFeePerGas': return '0x0';
		case 'eth_feeHistory': { const n = Math.min(64, Math.max(1, parseInt(String(p[0]), String(p[0]).startsWith('0x') ? 16 : 10) || 1)); return { oldestBlock: q(Math.max(0, s.height - n + 1)), baseFeePerGas: Array(n + 1).fill(q(price)), gasUsedRatio: Array(n).fill(0.1), reward: Array.isArray(p[2]) ? Array(n).fill(p[2].map(() => '0x0')) : undefined }; }
		case 'eth_getBalance': return q(host.account(addr(p[0]))?.balance ?? 0n); case 'eth_getTransactionCount': return q((p[1] === 'pending' && h.pending ? hostOf(h.pending()) : host).account(addr(p[0]))?.nonce ?? 0n); case 'eth_getCode': return '0x' + hex(host.account(addr(p[0]))?.code ?? EMPTY);
		case 'eth_getStorageAt': return q32(host.slot(addr(p[0]), B(p[1] as string)).toString(16));
		case 'eth_call': { const c = (p[0] ?? {}) as Record<string, unknown>, r = simulate(s, h.now(), c, Math.min(EVM_RULES.callGas, c.gas === undefined ? EVM_RULES.callGas : N(B(c.gas as string)))); if (!r.ok) throw new RpcError(3, revertText(r.out), '0x' + hex(r.out)); return '0x' + hex(r.out); }
		case 'eth_estimateGas': {
			const c = (p[0] ?? {}) as Record<string, unknown>, top = simulate(s, h.now(), c, EVM_RULES.txGas); if (!top.ok) throw new RpcError(3, revertText(top.out), '0x' + hex(top.out));
			let lo = top.used, hi = Math.min(EVM_RULES.txGas, Math.ceil(top.used * 1.6) + 10_000); // what it needs to be given can be more than what it uses (refunds, the 63/64 rule)
			for (let i = 0; i < 6 && hi - lo > top.used / 50; i++) { const m = Math.floor((lo + hi) / 2); let ok = false; try { ok = simulate(s, h.now(), c, m).ok; } catch { /* too little */ } if (ok) hi = m; else lo = m; }
			return q(hi);
		}
		case 'eth_sendRawTransaction': { const raw = String(p[0] ?? '').toLowerCase().replace(/^0x/, ''); if (!/^([0-9a-f]{2})+$/.test(raw) || raw.length > EVM_RULES.maxRaw) throw new RpcError(-32602, 'bad transaction'); let t; try { t = decoded(raw); } catch (e) { throw new RpcError(-32000, (e as Error).message); } if (h.find(t.hash)) throw new RpcError(-32000, 'already known'); try { await h.send(raw, t.gasLimit); } catch (e) { throw new RpcError(-32000, (e as Error).message); } return '0x' + t.hash; }
		case 'eth_getTransactionByHash': { const f = h.find(String(p[0] ?? '').slice(2)), b = f ? h.block(f.height) : null; return f && b ? txView(b.receipts[f.index], b, f.index) : null; }
		case 'eth_getTransactionReceipt': { const f = h.find(String(p[0] ?? '').slice(2)), b = f ? h.block(f.height) : null; if (!f || !b) return null; const r = b.receipts[f.index]; let base = 0, total = 0; b.receipts.forEach((x, i) => { if (i < f.index) base += x.logs.length; if (i <= f.index) total += x.gas; }); return { transactionHash: '0x' + r.hash, transactionIndex: q(f.index), blockNumber: q(b.height), blockHash: '0x' + b.hash, from: '0x' + r.from, to: r.to ? '0x' + r.to : null, contractAddress: r.contract ? '0x' + r.contract : null, status: r.ok ? '0x1' : '0x0', gasUsed: q(r.gas), cumulativeGasUsed: q(total), effectiveGasPrice: q(B(r.price)), type: q(decoded(r.raw).type), logsBloom: '0x' + '0'.repeat(512), logs: logsOf(r, b, f.index, base) }; }
		case 'eth_getBlockByNumber': return blockView(height(p[0]), p[1] === true);
		case 'eth_getBlockByHash': { for (let n = s.height; n > Math.max(0, s.height - 256); n--) if (h.block(n)?.hash === String(p[0]).slice(2)) return blockView(n, p[1] === true); return null; }
		case 'eth_getLogs': {
			const f = (p[0] ?? {}) as Record<string, unknown>, from = height(f.fromBlock), to = Math.min(height(f.toBlock), s.height); if (to - from > 5_000) throw new RpcError(-32005, 'at most 5,000 blocks at once');
			const as = f.address === undefined ? null : (Array.isArray(f.address) ? f.address : [f.address]).map((x) => addr(x)), ts = (Array.isArray(f.topics) ? f.topics : []) as (string | string[] | null)[], out: unknown[] = [];
			for (let n = Math.max(1, from); n <= to; n++) { const b = h.block(n); if (!b?.receipts.length) continue; let base = 0; b.receipts.forEach((r, i) => { for (const l of logsOf(r, b, i, base)) if ((!as || as.includes(l.address.slice(2))) && ts.every((t, k) => t === null || t === undefined || (Array.isArray(t) ? t : [t]).some((x) => x.toLowerCase() === l.topics[k]))) out.push(l); base += r.logs.length; }); if (out.length > 10_000) throw new RpcError(-32005, 'too many results'); }
			return out;
		}
		default: throw new RpcError(-32601, `${method} is not here`);
	}
}
/** one request or a list of them, answered */
export async function evmAnswer(h: RpcHost, body: unknown): Promise<unknown> {
	const one = async (r: { id?: unknown; method?: unknown; params?: unknown } | null) => { const id = r?.id ?? null; try { if (typeof r?.method !== 'string') throw new RpcError(-32600, 'bad request'); return { jsonrpc: '2.0', id, result: await evmRpc(h, r.method, Array.isArray(r.params) ? r.params : []) ?? null }; } catch (e) { const x = e as RpcError; return { jsonrpc: '2.0', id, error: { code: x.code ?? -32000, message: x.message, ...(x.data === undefined ? {} : { data: x.data }) } }; } };
	if (Array.isArray(body)) { const out = []; for (const r of body.slice(0, 20)) out.push(await one(r)); return out; }
	return one(body as never);
}
export { createAddress, rlp };
