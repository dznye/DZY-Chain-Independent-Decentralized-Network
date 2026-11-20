/* Encoding, hashing and signatures for the Dznye chain. Web Crypto only, so the same file runs in a browser,
   a Cloudflare Worker and Node. No dependencies. */

const enc = new TextEncoder();

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function unhex(s: string): Uint8Array<ArrayBuffer> {
	if (typeof s !== 'string' || !/^([0-9a-f]{2})*$/.test(s)) throw new Error('bad hex');
	const out = new Uint8Array(new ArrayBuffer(s.length / 2));
	for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** One exact text form for any value, so everyone hashes and signs the same bytes: keys sorted, whole numbers only. */
export function canon(v: unknown): string {
	if (v === null) return 'null';
	if (typeof v === 'string') return JSON.stringify(v);
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (typeof v === 'number') {
		if (!Number.isSafeInteger(v)) throw new Error('only whole numbers are allowed');
		return String(v);
	}
	if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
		return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
	}
	throw new Error('this value cannot be encoded');
}

export async function sha256(s: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

/** A Merkle root over text leaves. Leaves and inner nodes are hashed with different prefixes, and an odd node is
    carried up (never duplicated), so two different lists can never give the same root. */
export async function merkleRoot(leaves: string[]): Promise<string> {
	if (!leaves.length) return sha256('dzy-empty');
	let level = await Promise.all(leaves.map((l) => sha256('leaf:' + l)));
	while (level.length > 1) {
		const next: Promise<string>[] = [];
		for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256('node:' + level[i] + level[i + 1]) : Promise.resolve(level[i]));
		level = await Promise.all(next);
	}
	return level[0];
}

const ED = { name: 'Ed25519' } as const;

/** A new account key. The address is the public key; the secret must never leave its owner. */
export async function newKey(): Promise<{ address: string; secret: string }> {
	const k = (await crypto.subtle.generateKey(ED, true, ['sign', 'verify'])) as CryptoKeyPair;
	return {
		address: hex(new Uint8Array((await crypto.subtle.exportKey('raw', k.publicKey)) as ArrayBuffer)),
		secret: hex(new Uint8Array((await crypto.subtle.exportKey('pkcs8', k.privateKey)) as ArrayBuffer))
	};
}

export async function sign(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('pkcs8', unhex(secret), ED, false, ['sign']);
	return hex(new Uint8Array(await crypto.subtle.sign(ED, key, enc.encode(message))));
}

/** SHA-256 of raw bytes given as hex, as hex. The same hash Bitcoin script (OP_SHA256), Ethereum (the sha256
    precompile) and Solana programs compute, so one secret can unlock locks on all of them. */
export async function sha256Bytes(bytesHex: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', unhex(bytesHex))));
}

/* Base58, the alphabet Solana (and Bitcoin) write addresses in. A Dznye address is a raw Ed25519 public key, exactly
   what a Solana address is, so the same key is an account on both: only the spelling differs. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function toBase58(bytesHex: string): string {
	const b = unhex(bytesHex);
	let n = 0n;
	for (const x of b) n = n * 256n + BigInt(x);
	let out = '';
	while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
	for (const x of b) { if (x !== 0) break; out = '1' + out; }
	return out;
}
/** base58 → hex, or null when it is not valid base58 */
export function fromBase58(text: string): string | null {
	if (typeof text !== 'string' || !text || text.length > 64) return null;
	let n = 0n;
	for (const c of text) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
	let h = n ? n.toString(16) : '';
	if (h.length % 2) h = '0' + h;
	for (const c of text) { if (c !== '1') break; h = '00' + h; }
	return h;
}
/** a Dznye address written as a Solana address, and back (null when it is not a 32-byte Solana address) */
export const solanaAddress = (address: string) => toBase58(address);
export function fromSolana(text: string): string | null {
	const h = fromBase58(text);
	return h && h.length === 64 ? h : null;
}

/** a Dznye address: 64 lower-case hex digits */
export const isAddrHex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** true only when `sig` is this address's signature of exactly this message; never throws */
export async function verify(address: string, message: string, sig: string): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey('raw', unhex(address), ED, false, ['verify']);
		return await crypto.subtle.verify(ED, key, unhex(sig), enc.encode(message));
	} catch {
		return false;
	}
}
