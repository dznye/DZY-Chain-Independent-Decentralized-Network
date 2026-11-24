// The exchange's releases (EXCHANGE.md, chain/vaults/evm/src/DznyeVault.sol): what a validator signs so that a vault on an
// Ethereum-style chain pays a sell-back made on Dznye. A validator signs only a payout that is on the chain, not yet paid,
// on a network whose vault is listed (exchangeVaults), for exactly the coin, amount and payee the chain recorded. The
// vault checks that more than two thirds of its validator set's power signed, so no one validator can pay anything.
//
// Each validator's Ethereum key is worked out from its own Dznye secret, so there is no second secret to keep: anyone who
// holds the Dznye key holds this one, and no one else does.
import { sha256 } from './crypto.ts';
import { evmAddressOf, signDigest } from './evmsign.ts';
import { keccak256, SECP_N } from './secp.ts';
import { EVM } from './evm.ts';
import { exchangeVaults, wdzyMint, type State } from './ledger.ts';
import { evmTokenOf } from './xtokens.ts';

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** a validator's Ethereum signing key, from its Dznye secret (hex): never 0, always below the curve's order */
export async function evmKeyOf(dznyeSecret: string): Promise<bigint> {
	return (BigInt('0x' + (await sha256('dznye-x-evm-key:' + dznyeSecret))) % (SECP_N - 1n)) + 1n;
}
/** the address a validator's vault signatures come from */
export const evmSignerOf = async (dznyeSecret: string) => evmAddressOf(await evmKeyOf(dznyeSecret));

/** a payout's id as the vault knows it: one per payout per chain, so a payout on a test chain is never one on the real one */
export const payoutId32 = (chain: string, id: string) => '0x' + hex(keccak256(enc.encode(`dznye-x-payout:${chain}:${id}`)));

/** exactly DznyeVault.releaseDigest: keccak of abi.encode("dznye-x-release", chainid, vault, setId, id, token, to,
    amount), as an Ethereum signed message */
export function releaseDigest(r: { chainId: number; vault: string; setId: number; id32: string; token: string; to: string; amount: bigint }): Uint8Array {
	const tag = enc.encode('dznye-x-release');
	const head = word(256n) + word(BigInt(r.chainId)) + addrWord(r.vault) + word(BigInt(r.setId)) + r.id32.replace(/^0x/, '').padStart(64, '0') + addrWord(r.token) + addrWord(r.to) + word(r.amount);
	const tail = word(BigInt(tag.length)) + hex(tag).padEnd(Math.ceil(tag.length / 32) * 64, '0');
	const inner = keccak256(unhex(head + tail));
	return keccak256(new Uint8Array([...enc.encode('\x19Ethereum Signed Message:\n32'), ...inner]));
}

/** What the vault pays for a payout, or why this validator will not sign it. `setId`: the vault's current set (the
    caller reads it from the vault; a signature for another set simply fails there). */
export function releaseFor(s: State, payoutId: string, setId: number) {
	const p = s.xpays && Object.hasOwn(s.xpays, payoutId) ? s.xpays[payoutId] : null;
	if (!p) return { error: 'no such payout' } as const;
	if (p.tx) return { error: 'already paid' } as const;
	const chain = EVM[p.net], vault = exchangeVaults(s)[p.net];
	if (!chain) return { error: `${p.net} is not an Ethereum-style network` } as const;
	if (!vault || !/^0x[0-9a-fA-F]{40}$/.test(vault)) return { error: `no vault is listed on ${p.net}` } as const;
	if (!Number.isSafeInteger(setId) || setId < 1) return { error: 'name the vault\'s current set: setId' } as const;
	const t = evmTokenOf(p.net, p.coin); // the network's own coin, or its USDC or USDT (xtokens.ts)
	if (!t) return { error: `${p.coin} is not paid from the vault on ${p.net}` } as const;
	const token = t.token, amount = BigInt(p.amount) * 10n ** BigInt(t.scale); // back from the chain's units to the token's
	return { chainId: chain.id, vault, setId, id32: payoutId32(s.chain, payoutId), token, to: p.to, amount };
}

/* ---- Solana (vaults/sol/src/lib.rs): validators sign with their own Dznye key, which is an Ed25519 key, and the
   program reads the signatures that Solana's Ed25519 program checked in the same transaction ---- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function fromBase58(s: string): Uint8Array {
	let n = 0n;
	for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i); }
	const out: number[] = [];
	while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
	for (const c of s) { if (c !== '1') break; out.unshift(0); }
	if (out.length > 32) throw new Error('not a 32-byte address');
	return Uint8Array.from([...new Array(32 - out.length).fill(0), ...out]);
}
const u64le = (n: bigint) => { const b = new Uint8Array(8); let x = n; for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
/** exactly release_message in vaults/sol/src/lib.rs */
export function solReleaseMessage(r: { program: string; setId: number; id32: string; mint: string | null; to: string; amount: bigint }): Uint8Array {
	return new Uint8Array([...enc.encode('dznye-x-release'), ...fromBase58(r.program), ...u64le(BigInt(r.setId)), ...unhex(r.id32), ...(r.mint ? fromBase58(r.mint) : new Uint8Array(32)), ...fromBase58(r.to), ...u64le(r.amount)]);
}
/** What the Solana vault pays for a payout, or why this validator will not sign it */
export function solReleaseFor(s: State, payoutId: string, setId: number, usdcMint: string) {
	const p = s.xpays && Object.hasOwn(s.xpays, payoutId) ? s.xpays[payoutId] : null;
	if (!p) return { error: 'no such payout' } as const;
	if (p.tx) return { error: 'already paid' } as const;
	if (p.net !== 'sol') return { error: 'not a Solana payout' } as const;
	const program = exchangeVaults(s).sol;
	if (!program || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(program)) return { error: 'no vault is listed on sol' } as const;
	if (!Number.isSafeInteger(setId) || setId < 1) return { error: 'name the vault\'s current set: setId' } as const;
	const wdzy = p.coin === 'wDZY' ? wdzyMint(s.chain) : null;
	if (p.coin === 'wDZY' && !wdzy) return { error: 'DZY on Solana has no token on this chain' } as const;
	if (p.coin !== 'SOL' && p.coin !== 'USDC' && p.coin !== 'wDZY') return { error: `${p.coin} is not paid from the Solana vault` } as const;
	return { program, setId, id32: payoutId32(s.chain, payoutId), mint: p.coin === 'SOL' ? null : p.coin === 'wDZY' ? wdzy : usdcMint, to: p.to, amount: BigInt(p.amount) }; // SOL in lamports, USDC in millionths: as the chain counts them
}
/** this validator's Ed25519 signature on a Solana release, with its key (32 bytes, hex: also its Dznye address) */
export async function signSolRelease(dznyeSecret: string, r: Parameters<typeof solReleaseMessage>[0]) {
	const message = solReleaseMessage(r), key = await crypto.subtle.importKey('pkcs8', unhex(dznyeSecret), { name: 'Ed25519' }, false, ['sign']);
	return { message: hex(message), sig: hex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message))) };
}

/** this validator's signature (65 bytes, hex) on a release, as the vault checks it */
export async function signRelease(dznyeSecret: string, r: Parameters<typeof releaseDigest>[0]) {
	const key = await evmKeyOf(dznyeSecret), { r: rr, s, odd } = signDigest(key, releaseDigest(r));
	return { signer: evmAddressOf(key), sig: '0x' + word(rr) + word(s) + (odd ? '1c' : '1b') };
}
