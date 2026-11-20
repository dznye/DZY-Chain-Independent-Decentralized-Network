/* The safe file: one file that holds every wallet of an account, sealed behind a PIN.

   What is in it: one master secret (32 random bytes). Every wallet is worked out from it by a public rule, so the one
   file recovers all of them: the Dznye account (also its Solana address), and as many accounts as wanted on the
   Ethereum-style chains and Bitcoin, each with its own address that cannot be linked to the others.

   How it is sealed (honestly: nothing is uncrackable, so each part makes guessing slower or useless):
   - The PIN is stretched with scrypt (N = 2^17, r = 8: 128 MB of memory and about a second for every single guess), so
     guessing cannot be made cheap with graphics cards or special chips the way plain hashing can.
   - That key seals the master secret with AES-256-GCM. A wrong PIN fails the check; nothing in the file can confirm a
     guess any faster. Quantum computers do not break AES-256: the best known quantum method (Grover's) only halves its
     strength, to 128 bits, still far beyond reach.
   - The weak point is always the PIN itself. So the PIN is at least 12 characters, and the wallet offers one it makes:
     16 characters from a 32-letter alphabet with no look-alikes (80 bits): even 10^21 guesses (a sextillion) would try
     under a thousandth of them, each one forced to cost scrypt's memory and time.
   What it cannot stop: someone who learns the PIN and gets the file, malware on the device, or a fake site. And the
   chain's signatures (Ed25519, like Solana's and most chains') are not quantum-resistant; that is a chain-wide matter.

   Plain JavaScript with WebCrypto only, so the same code runs in the wallet and in Node, and Node's own scrypt checks it. */

const te = new TextEncoder(), td = new TextDecoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const fail = (m: string): never => { throw new Error(m); };

/* ---------- scrypt (RFC 7914), on WebCrypto's PBKDF2-HMAC-SHA256 ---------- */
async function pbkdf2(pass: Uint8Array, salt: Uint8Array, bytes: number) {
	const k = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 }, k, bytes * 8));
}
const R = (a: number, b: number) => (a << b) | (a >>> (32 - b));
function salsa8(B: Uint32Array, x: Uint32Array) { // Salsa20/8 core, in place on B (16 words), x is scratch
	x.set(B);
	for (let i = 0; i < 8; i += 2) {
		x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
		x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
		x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
		x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
		x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
		x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
		x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
		x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
	}
	for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}
function blockMix(B: Uint32Array, Y: Uint32Array, r: number, x: Uint32Array, t: Uint32Array) {
	t.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
	for (let i = 0; i < 2 * r; i++) {
		for (let j = 0; j < 16; j++) t[j] ^= B[i * 16 + j];
		salsa8(t, x);
		Y.set(t, ((i & 1) * r + (i >> 1)) * 16); // even blocks first, then odd
	}
}
/** scrypt(password, salt, N, r, p) → dkLen bytes */
export async function scrypt(pass: Uint8Array, salt: Uint8Array, N: number, r: number, p: number, dkLen: number): Promise<Uint8Array> {
	if (N < 2 || (N & (N - 1)) !== 0) fail('N must be a power of 2');
	const W = 32 * r, B = await pbkdf2(pass, salt, p * 128 * r);
	const Bw = new Uint32Array(B.buffer, B.byteOffset, B.byteLength / 4);
	const le = new DataView(B.buffer, B.byteOffset, B.byteLength);
	for (let i = 0; i < Bw.length; i++) Bw[i] = le.getUint32(i * 4, true);
	const V = new Uint32Array(N * W), X = new Uint32Array(W), Y = new Uint32Array(W), x = new Uint32Array(16), t = new Uint32Array(16);
	for (let k = 0; k < p; k++) {
		X.set(Bw.subarray(k * W, (k + 1) * W));
		for (let i = 0; i < N; i++) { V.set(X, i * W); blockMix(X, Y, r, x, t); X.set(Y); }
		for (let i = 0; i < N; i++) {
			const j = X[(2 * r - 1) * 16] & (N - 1);
			for (let q = 0; q < W; q++) X[q] ^= V[j * W + q];
			blockMix(X, Y, r, x, t); X.set(Y);
		}
		Bw.set(X, k * W);
	}
	for (let i = 0; i < Bw.length; i++) le.setUint32(i * 4, Bw[i], true);
	return pbkdf2(pass, B, dkLen);
}

/* ---------- the PIN ---------- */
export const PIN_MIN = 12;
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // 31 letters: no 0/o, 1/l/i
/** the reason a PIN is not good enough, or '' */
export function pinProblem(pin: unknown): string {
	if (typeof pin !== 'string' || pin.length < PIN_MIN) return `Use at least ${PIN_MIN} characters: a short PIN on a file can be guessed by anyone who copies the file`;
	if (pin.length > 128) return 'At most 128 characters';
	if (/^(.)\1+$/.test(pin) || /^(0123456789|1234567890|abcdefghijkl)/i.test(pin)) return 'That PIN is too easy to guess';
	return '';
}
/** a strong PIN, easy to type: 16 characters in 4 groups, e.g. k7m2-qx9v-br4t-h8wn (about 79 bits) */
export function makePin(): string {
	const out: string[] = [];
	while (out.length < 16) { const b = crypto.getRandomValues(new Uint8Array(1))[0]; if (b < 248) out.push(ALPHABET[b % 31]); } // no bias
	return [0, 4, 8, 12].map((i) => out.slice(i, i + 4).join('')).join('-');
}

/* ---------- sealing ---------- */
export const SAFE_N = 1 << 17, SAFE_R = 8;
export interface SafeFile { kind: 'dznye-safe'; v: 1; address: string; kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }; iv: string; data: string }
/* Version 2, the "Rubik's cube" seal (2026-11-19). The master secret is mixed with 32 bytes made from the PIN (scrypt):
   master XOR scrypt(PIN, salt). Every PIN therefore opens SOME wallet: the right one opens yours, a decoy PIN opens the
   wallet you put a little in for that purpose, and any other PIN opens a real-looking, empty wallet (the same one each
   time for that PIN). The file holds no address and no check value, so it never tells anyone, here or on another
   computer, whether a PIN was right. The only way to test a guess is to look up that wallet on the public chains, which
   costs a lookup per guess on top of the slow scrypt. Honest limit: a long, random PIN is still what protects the file. */
export interface SafeFile2 { kind: 'dznye-safe'; v: 2; kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }; data: string }
async function keyFrom(pin: string, salt: Uint8Array, N: number, r: number, p: number) {
	const raw = await scrypt(te.encode(pin.normalize('NFKC')), salt, N, r, p, 32);
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
/** seal a master secret (64 hex) behind `pin`, the new way (version 2: every PIN opens a wallet; nothing in the file
    says which PIN is right). `address` is not written into it: it is kept only so older callers still work. */
export async function sealSafe(master: string, pin: string, _address?: string, o: { N?: number } = {}): Promise<SafeFile2> {
	const why = pinProblem(pin); if (why) fail(why);
	if (!/^[0-9a-f]{64}$/.test(master)) fail('the master secret is 64 hex characters');
	const N = o.N ?? SAFE_N, salt = crypto.getRandomValues(new Uint8Array(16));
	const pad = await scrypt(te.encode(pin.normalize('NFKC')), salt, N, SAFE_R, 1, 32), m = unhex(master);
	return { kind: 'dznye-safe', v: 2, kdf: { name: 'scrypt', N, r: SAFE_R, p: 1, salt: hex(salt) }, data: hex(m.map((b, i) => b ^ pad[i])) };
}
/** TEST AND OLD FILES ONLY: the first seal (version 1), which says "wrong PIN" and names its address */
export async function sealSafeV1(master: string, pin: string, address: string, o: { N?: number } = {}): Promise<SafeFile> {
	const why = pinProblem(pin); if (why) fail(why);
	if (!/^[0-9a-f]{64}$/.test(master)) fail('the master secret is 64 hex characters');
	const N = o.N ?? SAFE_N, salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await keyFrom(pin, salt, N, SAFE_R, 1);
	const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('dznye-safe:' + address) }, key, te.encode(master)));
	return { kind: 'dznye-safe', v: 1, address, kdf: { name: 'scrypt', N, r: SAFE_R, p: 1, salt: hex(salt) }, iv: hex(iv), data: hex(data) };
}
export const isSafeFile = (f: unknown): f is SafeFile | SafeFile2 => !!f && typeof f === 'object' && (f as SafeFile).kind === 'dznye-safe' && ((f as SafeFile).v === 1 || (f as SafeFile2).v === 2);
/** open a safe file with a PIN: the master secret. A version 2 file always opens (a wrong PIN gives the wallet of that
    PIN, which is empty); a version 1 file says 'Wrong PIN' as it always did. */
export async function openSafe(f: SafeFile | SafeFile2, pin: string): Promise<string> {
	if (!isSafeFile(f)) fail('That is not a Dznye safe file');
	const { N, r, p, salt } = f.kdf;
	if (f.kdf.name !== 'scrypt' || !Number.isSafeInteger(N) || N < 1024 || N > 1 << 20 || r !== 8 || p !== 1) fail('This safe file uses settings this wallet does not open');
	if (f.v === 2) {
		if (!/^[0-9a-f]{64}$/.test(f.data) || !/^[0-9a-f]{32}$/.test(salt)) fail('This safe file is damaged');
		const pad = await scrypt(te.encode(String(pin).normalize('NFKC')), unhex(salt), N, r, p, 32), d = unhex(f.data);
		return hex(d.map((b, i) => b ^ pad[i]));
	}
	const key = await keyFrom(String(pin), unhex(salt), N, r, p);
	try {
		return td.decode(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(f.iv), additionalData: te.encode('dznye-safe:' + f.address) }, key, unhex(f.data))));
	} catch { return fail('Wrong PIN, or the file was changed'); }
}

/* ---------- every wallet from one master secret ---------- */
/** a new master secret: 32 random bytes */
/* The keys file (2026-11-19): every chain's keys of a wallet that was NOT made from a safe file (one restored from a
   plain key file or a validator card, whose Ethereum-style and Bitcoin keys were made at random in one browser). Same
   "Rubik's cube" seal as version 2: the 64 key bytes (the 0x key, then the Bitcoin key) XOR 64 bytes made from the PIN
   by scrypt. No address, no check value: every PIN opens a pair of valid-looking keys, and only the right PIN gives the
   ones with coins. The wallet also carries its private vault inside the file when there is one; that part is sealed
   with AES-GCM under a key made from the 0x key, so (honestly) a guess at the PIN can then be checked offline, still at
   one full scrypt per guess. A long PIN is what protects it. */
export interface KeysFile { kind: 'dznye-keys'; v: 1; kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }; data: string; vault?: { slot: string; iv: string; data: string } }
const KEYS_PIN_MIN = 12; // 6 before 2026-11-20: such files still open; new ones need a PIN that resists offline guessing
export async function sealKeys(keys: { eth: string; btc: string }, pin: string, o: { N?: number } = {}): Promise<KeysFile> {
	if (typeof pin !== 'string' || pin.length < KEYS_PIN_MIN || pin.length > 128) fail(`Use a PIN of ${KEYS_PIN_MIN} to 128 characters (Me, Security: change your PIN)`);
	for (const k of [keys?.eth, keys?.btc]) if (!/^[0-9a-f]{64}$/.test(String(k))) fail('each key is 64 hex characters');
	const N = o.N ?? SAFE_N, salt = crypto.getRandomValues(new Uint8Array(16));
	const pad = await scrypt(te.encode(pin.normalize('NFKC')), salt, N, SAFE_R, 1, 64), m = unhex(keys.eth + keys.btc);
	return { kind: 'dznye-keys', v: 1, kdf: { name: 'scrypt', N, r: SAFE_R, p: 1, salt: hex(salt) }, data: hex(m.map((b, i) => b ^ pad[i])) };
}
export const isKeysFile = (f: unknown): f is KeysFile => !!f && typeof f === 'object' && (f as KeysFile).kind === 'dznye-keys' && (f as KeysFile).v === 1;
/** open a keys file: { eth, btc } for that PIN. Never says a PIN is wrong: a wrong one gives other (empty) keys. */
export async function openKeys(f: KeysFile, pin: string): Promise<{ eth: string; btc: string }> {
	if (!isKeysFile(f) || !/^[0-9a-f]{128}$/.test(f.data) || !/^[0-9a-f]{32}$/.test(f.kdf?.salt ?? '')) fail('That is not a keys file');
	const N = f.kdf.N, r = f.kdf.r;
	if (N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 16) fail('That keys file has settings this wallet will not use');
	const pad = await scrypt(te.encode(String(pin).normalize('NFKC')), unhex(f.kdf.salt), N, r, 1, 64), d = unhex(f.data);
	const out = hex(d.map((b, i) => b ^ pad[i]));
	return { eth: out.slice(0, 64), btc: out.slice(64) };
}
export const newMaster = () => hex(crypto.getRandomValues(new Uint8Array(32)));
/** the 32-byte seed of wallet `n` for `purpose` ('dznye', 'eth', 'btc'): HMAC-SHA-512 of a public label, keyed by the
    master secret, first half. Different purposes and numbers give unrelated keys; the same master always the same ones. */
export async function deriveSeed(master: string, purpose: string, n = 0): Promise<string> {
	if (!/^[0-9a-f]{64}$/.test(master)) fail('bad master secret');
	if (!/^[a-z]{2,10}$/.test(purpose) || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000) fail('bad wallet path');
	const k = await crypto.subtle.importKey('raw', unhex(master), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
	return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(`dznye-wallet:${purpose}:${n}`))).slice(0, 32));
}
/** a secp256k1 secret (Ethereum-style chains, Bitcoin) for wallet `n`: the seed, reduced into the curve's range */
export async function deriveSecp(master: string, purpose: string, n = 0): Promise<string> { // 'eth' (every 0x chain), 'btc', or 'evm' + a chain (that chain's own)
	const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
	for (let i = 0; ; i++) {
		const s = BigInt('0x' + await deriveSeed(master, purpose, n * 1000 + i)); // in the rare case it is out of range, the next
		if (s > 0n && s < SECP_N) return s.toString(16).padStart(64, '0');
	}
}
/** the Dznye key (also its Solana address) of wallet : an Ed25519 key from its 32-byte seed, in the chain's own key format */
export async function deriveDznye(master: string, n = 0): Promise<{ address: string; secret: string }> {
	const secret = '302e020100300506032b657004220420' + await deriveSeed(master, 'dznye', n); // PKCS#8 for an Ed25519 seed
	const k = await crypto.subtle.importKey('pkcs8', unhex(secret), { name: 'Ed25519' }, true, ['sign']);
	const jwk = await crypto.subtle.exportKey('jwk', k) as JsonWebKey;
	const pub = Uint8Array.from(atob((jwk.x as string).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
	return { address: hex(pub), secret };
}
