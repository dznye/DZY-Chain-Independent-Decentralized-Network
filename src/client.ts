import { signPayer, signTx, txMessage, type Tx } from './ledger.ts';
import { sign } from './crypto.ts';

/* A small client for any Dznye node: read the chain, and sign and send transactions with a key you hold.
   It is what the command line (cli.mjs) uses, and what any app, server, bot or agent can use. The node never
   sees a secret: transactions are signed here and only the signed result is sent. */

export interface Key { address: string; secret: string }

/** "1.5" → 1500000 for a coin with 6 decimals. Text only, no floating point. Null when it is not a valid amount. */
export function toParts(text: string, decimals: number): number | null {
	const m = /^(\d{1,12})(?:\.(\d*))?$/.exec(String(text).trim());
	if (!m || (m[2] ?? '').length > decimals) return null;
	const n = Number(m[1] + (m[2] ?? '').padEnd(decimals, '0'));
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/** 1500000 → "1.5" for a coin with 6 decimals */
export function fromParts(parts: number, decimals: number): string {
	const s = String(Math.trunc(parts)).padStart(decimals + 1, '0');
	const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
	return frac ? whole + '.' + frac : whole;
}

export class Client {
	readonly url: string;
	private lines = new Map<string, Promise<unknown>>(); // one send at a time per key, so nonces never collide
	constructor(url: string) { this.url = url.replace(/\/+$/, ''); }

	async get<T = any>(path: string): Promise<T> {
		const r = await fetch(this.url + path, { signal: AbortSignal.timeout(15_000) });
		const d = (await r.json().catch(() => ({}))) as any;
		if (!r.ok) throw new Error(d.error ?? `The node answered ${r.status}`);
		return d;
	}
	info() { return this.get('/'); }
	account(address: string) { return this.get('/account/' + address); }
	assets() { return this.get<Record<string, { symbol: string; name: string; decimals: number; issuer: string; supply: number }>>('/assets'); }

	/** Sign one transaction with `key` without sending it. `payer` names another account that will pay the fee:
	    hand the result to that payer to add its signature (`sponsor`), then `submit` it. */
	async prepare(key: Key, type: string, data: Record<string, unknown>, opts: { payer?: string } = {}): Promise<Tx> {
		const [info, acct] = await Promise.all([this.info(), this.account(key.address)]);
		return signTx(key.secret, { chain: info.chain, from: key.address, nonce: acct.nextNonce, type, data, ...(opts.payer ? { payer: opts.payer } : {}) });
	}
	/** As one of several keys an account needs: agree to exactly this transaction. */
	static async cosign(key: Key, tx: Tx): Promise<Tx> {
		return { ...tx, cosigs: [...(tx.cosigs ?? []), { key: key.address, sig: await sign(key.secret, txMessage(tx)) }] };
	}
	/** the address behind a name (without the @), or null */
	async whoIs(name: string): Promise<string | null> {
		try { return (await this.get('/name/' + encodeURIComponent(name.replace(/^@/, '').toLowerCase()))).address; } catch { return null; }
	}
	/** As the payer: agree to pay a transaction's fee. Check what it does first: you pay for whatever it is. */
	static sponsor(payer: Key, tx: Tx): Promise<Tx> {
		if (tx.payer !== payer.address) throw new Error('this transaction does not name that payer');
		return signPayer(payer.secret, tx);
	}
	/** Try a signed transaction without sending it: { ok, fee, gasUsed?, failed? (ran but failed), refused? (invalid) }. */
	async simulate(tx: Tx): Promise<{ ok: boolean; id?: string; fee?: number; gasUsed?: number; failed?: string; refused?: string }> {
		const r = await fetch(this.url + '/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }), signal: AbortSignal.timeout(15_000) });
		return r.json();
	}
	/** Send a signed transaction. With `wait` it returns once the transaction is in a block. Returns its id. */
	async submit(tx: Tx, wait = true): Promise<string> {
		const r = await fetch(this.url + '/tx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx }), signal: AbortSignal.timeout(15_000) });
		const d = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
		if (!r.ok) throw new Error(d.error ?? `The node answered ${r.status}`);
		for (let i = 0; wait && i < 150; i++) {
			if ((await this.account(tx.from)).nonce >= tx.nonce) return d.id as string;
			await new Promise((ok) => setTimeout(ok, 200));
		}
		if (wait) throw new Error('The transaction was accepted but is not in a block yet');
		return d.id as string;
	}

	/** Sign one transaction with `key` and send it. With `wait` (the default) it returns once the transaction is in a block.
	    `payer` (a key you also hold) pays the fee instead of `key`. Returns the transaction's id. Throws with the node's
	    reason when it is refused. */
	send(key: Key, type: string, data: Record<string, unknown>, wait = true, opts: { payer?: Key } = {}): Promise<string> {
		const job = async () => {
			let tx = await this.prepare(key, type, data, { payer: opts.payer?.address });
			if (opts.payer) tx = await Client.sponsor(opts.payer, tx);
			return this.submit(tx, wait);
		};
		const run = (this.lines.get(key.address) ?? Promise.resolve()).then(job, job);
		this.lines.set(key.address, run.catch(() => {}));
		return run;
	}
	/** the id a new token gets: it comes from the id of the transaction that created it */
	static tokenId(txId: string) { return 'a' + txId.slice(0, 16); }
}
