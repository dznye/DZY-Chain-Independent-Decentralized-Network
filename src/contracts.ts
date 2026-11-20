/* Contracts: small programs that live on the chain, hold coins and tokens, and keep their own storage.

   The language is JSON, so it needs no compiler and every node reads it the same way. A program is a set of functions;
   each function body is an expression, and an expression is a value or a list whose first item names an operation:
       ["+", ["arg", "amount"], 1]          ["require", [">", ["paid", "DZY"], 0], "send some DZY"]
   Everything is deterministic: whole numbers only (no fractions, no overflow past 2^53), no randomness, no clock but
   the block's time, no access to anything outside the chain. Every node therefore gets exactly the same result.

   Every step costs GAS, and a call carries a gas limit it pays for in advance, so a program that would run for ever
   simply stops. A call is ALL OR NOTHING: it works on a draft of its changes, and only if it finishes does the draft
   become real. If it fails (a `require`, a bad operation, too little gas), nothing it did happens, including any coins
   sent with the call.

   Version 2 adds: calling other contracts (["call", address, "fn", [args], asset?, amount?]), with a lock so a contract
   that is running can never be called back halfway ("re-entrancy", behind the biggest thefts on other chains), at most
   4 deep, all sharing one gas limit and one draft; making tokens (["newtoken", ...]) and issuing them (["mint", ...]);
   and events (["emit", value]) that apps can follow. A call that fails while running still pays for the gas it used,
   and the failure is recorded as an event; a call that is malformed is refused outright. */

export type Value = number | string | boolean | null;
export type Expr = Value | Expr[];
export interface Program { functions: Record<string, { args?: string[]; body: Expr; view?: boolean }>; init?: Expr }

export const LIMITS = {
	codeChars: 12_000, // a program's JSON
	maxGas: 200_000, // the most one call may use
	depth: 64, // how deeply expressions may nest
	callDepth: 4, // how deeply contracts may call contracts
	events: 50, // the newest events each contract keeps
	keyChars: 96, valueChars: 256, // a storage key, a stored string
	entries: 10_000, // stored values per contract
	argChars: 512 // all of a call's arguments
};
/** what each kind of step costs */
export const GAS = { step: 1, read: 20, write: 100, transfer: 200, perChar: 1, call: 500, emit: 50, token: 2000 };

/** a call that failed while running (not a malformed one): it still pays for the gas it used */
export class ContractFailure extends Error {
	readonly gasUsed: number;
	constructor(message: string, gasUsed: number) { super(message); this.gasUsed = gasUsed; }
}

const fail = (m: string): never => { throw new Error(m); };
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isName = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,31}$/i.test(v);

/** Check a program's shape before it is stored, so a broken one is refused at once, not when first called. */
export function checkProgram(p: unknown): Program {
	if (!p || typeof p !== 'object' || Array.isArray(p)) fail('a program is { functions: { name: { args, body } } }');
	const prog = p as Program;
	if (!prog.functions || typeof prog.functions !== 'object' || Array.isArray(prog.functions)) fail('a program needs functions');
	const names = Object.keys(prog.functions);
	if (!names.length || names.length > 64) fail('a program has 1 to 64 functions');
	for (const n of names) {
		if (!isName(n)) fail(`bad function name: ${n}`);
		const f = prog.functions[n];
		if (!f || typeof f !== 'object') fail(`bad function: ${n}`);
		if (f.args !== undefined && (!Array.isArray(f.args) || f.args.length > 16 || !f.args.every(isName))) fail(`bad arguments for ${n}`);
		if (f.view !== undefined && typeof f.view !== 'boolean') fail(`bad view flag for ${n}`);
		shape(f.body, 0);
	}
	if (prog.init !== undefined) shape(prog.init, 0);
	return prog;
}
function shape(e: unknown, depth: number) {
	if (depth > LIMITS.depth) fail('the program nests too deeply');
	if (e === null || typeof e === 'boolean' || typeof e === 'string') return;
	if (typeof e === 'number') { if (!isInt(e)) fail('only whole numbers are allowed'); return; }
	if (!Array.isArray(e) || !e.length || typeof e[0] !== 'string') fail('an expression is a value or ["operation", ...]');
	const arr = e as unknown[];
	if (!Object.hasOwn(OPS, arr[0] as string)) fail(`unknown operation: ${arr[0]}`);
	for (let i = 1; i < arr.length; i++) {
		// ["call", address, fn, [arg, arg, ...], ...]: the arguments are a plain list of expressions
		if (arr[0] === 'call' && i === 3 && Array.isArray(arr[3])) { if (arr[3].length > 16) fail('a call takes at most 16 arguments'); for (const x of arr[3]) shape(x, depth + 1); continue; }
		shape(arr[i], depth + 1);
	}
}

/** What a running contract can see and do. The ledger provides it; every change goes into a draft. */
export interface World {
	self: string; // the contract's address
	caller: string; // who called
	time: number; height: number; // of the block it runs in
	paid: Record<string, number>; // coins sent with this call (already in the contract's balance)
	readonly: boolean; // a "view": may read, may not change anything
	get(key: string): Value | undefined;
	set(key: string, v: Value): void;
	del(key: string): void;
	entries(): number;
	balance(who: string, asset: string): number;
	transfer(asset: string, to: string, amount: number): void;
	/** call another contract; returns its value and the gas it used (taken from this call's gas) */
	call(at: string, fn: string, args: Value[], pay: { asset: string; amount: number } | null, gasLeft: number): { value: Value; gasUsed: number };
	emit(v: Value): void;
	/** make a token this contract issues; returns its id */
	newToken(symbol: string, name: string, decimals: number, cap: number | null): string;
	mint(asset: string, to: string, amount: number): void;
}

interface Frame { args: Record<string, Value>; vars: Map<string, Value>; world: World; gas: { left: number } }
type Op = (f: Frame, a: Expr[]) => Value;

const use = (f: Frame, n: number) => { f.gas.left -= n; if (f.gas.left < 0) fail('out of gas'); };
const ev = (f: Frame, e: Expr): Value => {
	use(f, GAS.step);
	if (!Array.isArray(e)) return e;
	return OPS[e[0] as string](f, e.slice(1));
};
const num = (f: Frame, e: Expr, what = 'a number'): number => { const v = ev(f, e); return isInt(v) ? v : fail(`expected ${what}, got ${JSON.stringify(v)}`); };
const str = (f: Frame, e: Expr, what = 'text'): string => { const v = ev(f, e); return typeof v === 'string' ? v : fail(`expected ${what}`); };
const safe = (n: number) => (Number.isSafeInteger(n) ? n : fail('number too large'));
const addr = (v: Value) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : fail('expected an address'));
const key = (f: Frame, e: Expr) => {
	const k = str(f, e, 'a storage key');
	if (!k.length || k.length > LIMITS.keyChars) fail('a storage key is 1 to 96 characters');
	if (k === '__proto__') fail('that storage key is not allowed'); // it would behave differently once saved and loaded
	return k;
};
const writable = (f: Frame) => { if (f.world.readonly) fail('a view cannot change anything'); };
const asText = (v: Value) => (v === null ? 'null' : String(v));
const n2 = (name: string, fn: (a: number, b: number) => number): Op => (f, a) => { if (a.length !== 2) fail(`${name} takes two`); return safe(fn(num(f, a[0]), num(f, a[1]))); };
const cmp = (fn: (a: number, b: number) => boolean): Op => (f, a) => fn(num(f, a[0]), num(f, a[1]));

/** every operation a program may use; nothing else exists */
const OPS: Record<string, Op> = {
	// values and names
	arg: (f, a) => { const n = a[0]; if (typeof n !== 'string' || !Object.hasOwn(f.args, n)) fail(`no argument ${n}`); return f.args[n as string]; },
	let: (f, a) => { if (!isName(a[0])) fail('let needs a name'); const v = ev(f, a[1]); f.vars.set(a[0] as string, v); return v; },
	var: (f, a) => { const n = a[0] as string; if (!f.vars.has(n)) fail(`no variable ${n}`); return f.vars.get(n)!; },
	// arithmetic, on whole numbers only
	'+': n2('+', (x, y) => x + y), '-': n2('-', (x, y) => x - y), '*': n2('*', (x, y) => x * y),
	'/': n2('/', (x, y) => (y === 0 ? fail('division by zero') : Math.trunc(x / y))),
	'%': n2('%', (x, y) => (y === 0 ? fail('division by zero') : x % y)),
	min: n2('min', Math.min), max: n2('max', Math.max),
	// comparing
	'=': (f, a) => ev(f, a[0]) === ev(f, a[1]), '!=': (f, a) => ev(f, a[0]) !== ev(f, a[1]),
	'<': cmp((x, y) => x < y), '<=': cmp((x, y) => x <= y), '>': cmp((x, y) => x > y), '>=': cmp((x, y) => x >= y),
	and: (f, a) => { for (const e of a) if (ev(f, e) !== true) return false; return true; },
	or: (f, a) => { for (const e of a) if (ev(f, e) === true) return true; return false; },
	not: (f, a) => ev(f, a[0]) !== true,
	// text
	str: (f, a) => { const s = a.map((e) => asText(ev(f, e))).join(''); use(f, s.length * GAS.perChar); if (s.length > LIMITS.valueChars) fail('text too long'); return s; },
	len: (f, a) => str(f, a[0]).length,
	// flow
	if: (f, a) => (ev(f, a[0]) === true ? ev(f, a[1]) : a.length > 2 ? ev(f, a[2]) : null),
	seq: (f, a) => { let v: Value = null; for (const e of a) v = ev(f, e); return v; },
	for: (f, a) => { // ["for", name, from, to, body]: from..to inclusive, at most 1,000 rounds, gas permitting
		if (!isName(a[0])) fail('for needs a name');
		const from = num(f, a[1]), to = num(f, a[2]);
		if (to - from >= 1000) fail('a loop has at most 1,000 rounds');
		let v: Value = null;
		for (let i = from; i <= to; i++) { f.vars.set(a[0] as string, i); v = ev(f, a[3]); }
		return v;
	},
	require: (f, a) => { if (ev(f, a[0]) !== true) fail(typeof a[1] === 'string' ? a[1] : 'a requirement failed'); return true; },
	fail: (_f, a) => fail(typeof a[0] === 'string' ? a[0] : 'the contract refused'),
	// what the call knows
	caller: (f) => f.world.caller, self: (f) => f.world.self, now: (f) => f.world.time, height: (f) => f.world.height,
	paid: (f, a) => { const asset = str(f, a[0], 'an asset'); return Object.hasOwn(f.world.paid, asset) ? f.world.paid[asset] : 0; },
	balance: (f, a) => { use(f, GAS.read); return f.world.balance(a.length > 1 ? addr(ev(f, a[1])) : f.world.self, str(f, a[0], 'an asset')); },
	isaddress: (f, a) => { const v = ev(f, a[0]); return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v); },
	// storage
	get: (f, a) => { use(f, GAS.read); const v = f.world.get(key(f, a[0])); return v === undefined ? (a.length > 1 ? ev(f, a[1]) : null) : v; },
	has: (f, a) => { use(f, GAS.read); return f.world.get(key(f, a[0])) !== undefined; },
	set: (f, a) => {
		writable(f);
		const k = key(f, a[0]), v = ev(f, a[1]);
		if (typeof v === 'string' && v.length > LIMITS.valueChars) fail('a stored text is at most 256 characters');
		use(f, GAS.write + k.length + (typeof v === 'string' ? v.length : 0));
		if (f.world.get(k) === undefined && f.world.entries() >= LIMITS.entries) fail('this contract\'s storage is full');
		f.world.set(k, v); return v;
	},
	del: (f, a) => { writable(f); use(f, GAS.write); f.world.del(key(f, a[0])); return null; },
	// coins and tokens the contract holds
	transfer: (f, a) => {
		writable(f); use(f, GAS.transfer);
		const asset = str(f, a[0], 'an asset'), to = addr(ev(f, a[1])), amount = num(f, a[2], 'an amount');
		if (amount <= 0) fail('the amount must be above zero');
		f.world.transfer(asset, to, amount); return true;
	},
	// other contracts: ["call", address, "fn", [args...], asset?, amount?]
	call: (f, a) => {
		use(f, GAS.call);
		const at = addr(ev(f, a[0])), fn = str(f, a[1], 'a function name');
		const list = Array.isArray(a[2]) ? (a[2] as Expr[]).map((e) => ev(f, e)) : a[2] === undefined ? [] : fail('the arguments of a call are a list');
		const pay = a.length > 3 ? { asset: str(f, a[3], 'an asset'), amount: num(f, a[4], 'an amount') } : null;
		if (pay && pay.amount <= 0) fail('the amount must be above zero');
		if (pay) writable(f);
		try { const r = f.world.call(at, fn, list, pay, f.gas.left); use(f, r.gasUsed); return r.value; }
		catch (e) { if (e instanceof ContractFailure) { f.gas.left -= Math.min(f.gas.left, e.gasUsed); } throw new Error((e as Error).message); }
	},
	// events apps can follow
	emit: (f, a) => { writable(f); const v = ev(f, a[0]); if (typeof v === 'string' && v.length > LIMITS.valueChars) fail('text too long'); use(f, GAS.emit + (typeof v === 'string' ? v.length : 0)); f.world.emit(v); return null; },
	// tokens the contract makes and issues
	newtoken: (f, a) => {
		writable(f); use(f, GAS.token);
		const symbol = str(f, a[0], 'a symbol'), name = str(f, a[1], 'a name'), decimals = a.length > 2 ? num(f, a[2], 'decimals') : 0;
		const capV = a.length > 3 ? ev(f, a[3]) : null;
		if (capV !== null && !isInt(capV)) fail('a limit is a whole number, or null for none');
		return f.world.newToken(symbol, name, decimals, capV as number | null);
	},
	mint: (f, a) => {
		writable(f); use(f, GAS.transfer);
		const asset = str(f, a[0], 'an asset'), to = addr(ev(f, a[1])), amount = num(f, a[2], 'an amount');
		if (amount <= 0) fail('the amount must be above zero');
		f.world.mint(asset, to, amount); return true;
	}
};
export const OPERATIONS = Object.keys(OPS);

/** Is this a well-formed call of this program? Throws (the transaction is refused) when it is not. */
export function checkCall(prog: Program, fn: string, args: Value[], readonly: boolean) {
	if (!Object.hasOwn(prog.functions, fn)) fail(`no function ${fn}`);
	const f = prog.functions[fn];
	if (readonly && !f.view) fail(`${fn} is not a view`);
	const names = f.args ?? [];
	if (args.length !== names.length) fail(`${fn} takes ${names.length} argument${names.length === 1 ? '' : 's'}`);
}

/** Run one function of a program (or its set-up, when fn is null). Returns its value and the gas used. If it fails
    while running, throws a ContractFailure saying how much gas it used; the caller drops the draft. */
export function run(prog: Program, fn: string | null, args: Value[], world: World, gasLimit: number): { value: Value; gasUsed: number } {
	const gas = { left: gasLimit };
	let body: Expr | undefined, bound: Record<string, Value> = {};
	if (fn === null) body = prog.init;
	else {
		checkCall(prog, fn, args, world.readonly);
		const f = prog.functions[fn];
		(f.args ?? []).forEach((n, i) => { bound[n] = args[i]; });
		body = f.body;
	}
	if (body === undefined) return { value: null, gasUsed: 0 };
	try {
		const value = ev({ args: bound, vars: new Map(), world, gas }, body);
		return { value, gasUsed: gasLimit - gas.left };
	} catch (e) {
		throw new ContractFailure((e as Error).message, Math.min(gasLimit, gasLimit - gas.left));
	}
}
