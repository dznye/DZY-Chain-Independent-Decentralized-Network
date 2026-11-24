/* What an action does, in plain words, and what it costs, in dollars: one price, no gas, no shards, no rent tables. For people
   who have only ever used PayPal. It decides nothing and is not part of the chain's rules: it reads the state and the rules'
   own prices, so what it says is what will be paid. Anything it has no words for, it says so. */
import { feeFor, itemFileFee, NATIVE, recordFee, resaleOn, RULES, usdCost, usdWorth, type State } from './ledger.ts';
import { BLOB, lookUsd, usdFor } from './blobs.ts';
import { keptTimes, newEntries } from './heart.ts';
import { lockFreeLeft, sunPays } from './sun.ts';

export interface Plain { title: string; lines: string[]; costUsd: number; cost: string; careful?: string; undo: string }
/** µ$ as a person says it */
export function money(usd: number): string {
	if (usd <= 0) return 'free';
	if (usd < 10_000) return 'less than 1 cent';
	if (usd < 1_000_000) { const c = Math.round(usd / 10_000); return c >= 100 ? '$1.00' : `${c} cent${c === 1 ? '' : 's'}`; }
	return '$' + (usd / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const size = (n: number) => (n < 1_000 ? `${n} bytes` : n < 1_000_000 ? `${Math.round(n / 1_000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`);
const years = (n: unknown) => `${n} year${n === 1 ? '' : 's'}`;
const ok = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
/** what `n` units of an asset are: "5 DZY ($0.59)" */
export function amountText(s: State, asset: unknown, n: unknown, time: number): string {
	if (typeof asset !== 'string' || !ok(n) || !Object.hasOwn(s.assets, asset)) return 'something this chain does not know';
	const a = s.assets[asset], whole = (n / 10 ** a.decimals).toLocaleString('en-US', { maximumFractionDigits: Math.min(a.decimals, 6) }), name = asset === 'xUSDC' || asset === 'xUSDT' || asset === 'DUSD' ? `$${whole}` : `${whole} ${asset.startsWith('x') && a.issuer === '0'.repeat(64) ? asset.slice(1) : a.symbol}`;
	const w = name.startsWith('$') ? null : usdWorth(s, asset, n, time);
	return w === null ? name : `${name} (${money(w)})`;
}
/** who an address is: its @name, or the ends of it */
export const who = (s: State, v: unknown): string => { if (typeof v !== 'string') return 'nobody'; const a = Object.hasOwn(s.accounts, v) ? s.accounts[v] : null; return a?.name ? '@' + a.name : /^[0-9a-f]{64}$/.test(v) ? `an account with no name (${v.slice(0, 4)}…${v.slice(-4)})` : 'an address that is not right'; };
const FINAL = 'This cannot be undone.', LATER = 'You can change this later.', BACK = 'You can get this back.';

export function explain(s: State, t: { from: string; type: string; data: Record<string, unknown>; tip?: number }, time: number = s.time): Plain {
	const d = t.data ?? {}, price = usdCost(s, NATIVE, 1_000_000) ? (shards: number) => usdWorth(s, NATIVE, shards, time) ?? 0 : () => 0;
	let fee = 0; try { const f = feeFor(s, t), lasting = !!s.heart && newEntries(s, t) > 0; fee = (f === (s.fee ?? 0) && lockFreeLeft(s, t.from) > 0) || (s.sun && sunPays(s, t.from, f, lasting)) ? 0 : price(f); } catch { /* not a form the chain knows */ } // (free: someone with DZY locked, or the chain's own welcome)
	let extra = 0, title = 'An action this page has no words for', lines: string[] = [`Its technical name is ${String(t.type).slice(0, 40)}.`], careful: string | undefined = 'Only confirm it if you know what it does.', undo = FINAL;
	const say = (a: string, b: string[], u = FINAL, x = 0) => { title = a; lines = b; undo = u; extra = x; careful = undefined; };
	const A = (asset: unknown, n: unknown) => amountText(s, asset, n, time), blob = typeof d.id === 'string' && s.blobs && Object.hasOwn(s.blobs, d.id) ? s.blobs[d.id] : null;
	switch (t.type) {
		case 'transfer': say(`Send ${A(d.asset ?? NATIVE, d.amount)}`, [`To ${who(s, d.to)}.`, 'It arrives in about a second.']); if (/no name|not right/.test(who(s, d.to))) careful = 'This account has no name. Check the address with the person: a payment to a wrong address cannot come back.'; break;
		case 'transfer.many': say(`Send to ${Array.isArray(d.to) ? d.to.length : 0} people at once`, [`In all: ${A(d.asset ?? NATIVE, Array.isArray(d.to) ? d.to.reduce((n: number, x) => n + (Array.isArray(x) && ok(x[1]) ? x[1] : 0), 0) : 0)}.`]); break;
		case 'name.set': say(`Take the name @${String(d.name).slice(0, 20)}`, ['People can pay you by this name instead of a long address.'], LATER, price(RULES.nameFee)); break;
		case 'gift.create': say(`Make a gift of ${A(d.asset ?? NATIVE, d.amount)}`, ['Anyone who has its link can take it.', 'If nobody does in time, you can take it back.'], BACK); careful = 'Whoever has the link has the money: send it only to the person it is for.'; break;
		case 'gift.claim': say('Take a gift', ['It goes to your account.']); break;
		case 'offer.create': { const g = d.give as Record<string, unknown> | undefined, w = d.want as Record<string, unknown> | undefined; say(`Offer ${A(g?.asset, g?.amount)}`, [`You get ${A(w?.asset, w?.amount)} when someone takes it.`, 'It waits here until then.'], 'You can take it back until someone takes it.'); break; }
		case 'offer.take': { const o = typeof d.id === 'string' && Object.hasOwn(s.offers, d.id) ? s.offers[d.id] : null; if (o) say(`Buy ${A(o.give.asset, o.give.amount)}`, [`You pay ${A(o.want.asset, o.want.amount)}.`]); break; }
		case 'swap': say(`Change ${A(d.give, d.amount)}`, [`You get at least ${A(d.want, d.min)}, or nothing happens.`]); break;
		case 'x.close': say(`Take your locked ${String(d.coin)} back`, ['You return DZY, and the coin comes to you.', '0.1% of the coin stays with the chain.']); break;
		case 'wdzy.out': say(`Move ${A(NATIVE, d.amount)} to Solana`, ['The chain holds your DZY, and the same amount comes to your Solana wallet as wDZY.', 'Bring it back any time: pay the wDZY back in, and your DZY are yours again here.']); break;
		case 'stake.bond': say(`Set aside ${A(NATIVE, d.amount)} to help run the chain`, ['You can earn from it.', 'It takes 14 days to get back.'], 'You get it back 14 days after you ask.'); careful = 'If your computer signs two different blocks, you lose all of it. Never run it in two places.'; break;
		case 'stake.delegate': say(`Back a validator with ${A(NATIVE, d.amount)}`, [`Behind ${who(s, d.validator)}.`, 'You share what it earns.', 'It takes 14 days to get back.'], 'You get it back 14 days after you ask.'); careful = 'If that validator cheats, you lose 5% of it.'; break;
		case 'lock.stake': say('Make a lock validator stake', ['It counts in the raffle for making blocks from now on, and earns as a validator does, not as a locker.', 'It stays held until the lock would have ended.'], FINAL); careful = 'A validator that signs two different blocks loses all of its stake: never run its key in two places.'; break;
		case 'lock': say(`Lock ${A(NATIVE, d.amount)} for ${years(d.years)}`, ['You can earn from it while it is locked.'], `You get it back in ${years(d.years)}, not before.`); careful = `You cannot use it until then.`; break;
		case 'blob.in': case 'blob.out': say('Keep a file', [`${size(Number(d.size) || 0)}, kept for ${years(d.years)}.`, 'A small picture of it can stay for ever.', `1 cent or less is held, and comes back if you close it.`], 'You can close it and get back what is left.', ok(d.size) && ok(d.years) ? usdFor(t.type === 'blob.in' ? 'in' : 'out', d.size, d.years) + price(BLOB.bond) : 0); careful = 'Others can see it. Do not keep anything private here unless you lock it first.'; break;
		case 'blob.part': say('Hand over part of a file', ['Already paid for.']); break;
		case 'blob.look': say('Keep a small picture of a file for ever', ['Everyone can always see it. There is nothing more to pay.'], FINAL, typeof d.b === 'string' ? lookUsd(Math.floor((d.b.length * 3) / 4)) * keptTimes(s) : 0); break;
		case 'tip': say(`Tip ${A(d.asset ?? NATIVE, d.amount)}`, [`To ${who(s, d.to)}.`, '0.5% of it goes to Dznye.']); break;
		case 'item.buy': say(`Buy “${String(d.item).slice(0, 40)}”`, [`You pay ${A(d.asset, d.amount)}.`, `From ${who(s, d.seller)}.`]); break;
		case 'resale.list': say(`Offer your “${String(d.item).slice(0, 40)}” for ${ok(d.usd) ? money(d.usd) : 'a price'}`, ['The creator and Dznye take the resale fee out of it when it sells.'], LATER); break;
		case 'resale.cancel': say('Take your offer back', []); undo = LATER; break;
		case 'resale.buy': say(`Buy “${String(d.item).slice(0, 40)}” from ${who(s, d.owner)}`, [`It costs ${ok(d.usd) ? money(d.usd) : 'what is asked'}, paid with ${String(d.asset).replace(/^x/, '').slice(0, 10)}.`]); break;
		case 'record.put': { let n = 0; try { n = recordFee(String(d.space), String(d.key), d as { value?: unknown; hash?: string; link?: string }) * keptTimes(s); } catch { /* not a form the chain takes */ } let file = 0; try { file = d.space === 'items' && resaleOn(s) ? itemFileFee(s, t.from, String(d.key), d.value) : 0; } catch { /* not a file the chain takes */ } if (file) say('Post something you sell, with its file', [`Its file: ${size(Number((d.value as Record<string, unknown>).fs) || 0)}, paid once.`, 'Anyone can see the post. Only buyers open the file.'], LATER, price(n + file)); else say('Write something down on the chain', ['Anyone can read it.', 'Only you can change it.'], LATER, price(n)); break; }
		case 'blob.renew': say(`Keep a file ${years(d.years)} longer`, [], FINAL, blob && ok(d.years) ? usdFor(blob.kind, blob.size, d.years) : 0); break;
		case 'blob.wake': say('Wake a sleeping file', [`Kept for ${years(d.years)}, in full quality again.`], 'You can close it if it is yours.', blob && ok(d.years) ? usdFor(blob.kind, blob.size, d.years) + price(BLOB.bond) : 0); break;
		case 'blob.close': say('Stop keeping a file', ['What is left of its money comes back to you.']); break;
		case 'nft.make': { const n = ok(d.copies) ? d.copies : 1, inside = ok(d.inside) ? d.inside : 0; say(n === 1 ? `Make “${String(d.name).slice(0, 40)}”, one of a kind` : `Make ${n} copies of “${String(d.name).slice(0, 40)}”`, [inside ? `Each has ${A(NATIVE, inside)} in it, which comes back to whoever burns it.` : 'You can sell, give or keep them.'], FINAL, price(RULES.assetFee + inside * n)); break; }
		case 'nft.burn': { const a = typeof d.asset === 'string' && Object.hasOwn(s.assets, d.asset) ? s.assets[d.asset] : null, n = ok(d.copies) ? d.copies : 1; say(`Burn ${n} of “${a?.name ?? '?'}”`, [a?.backed?.per ? `You get ${A(NATIVE, n * a.backed.per)}.` : 'There is no money in it: you get nothing.']); careful = 'It is gone for good.'; break; }
		case 'drop.claim': { const x = typeof d.id === 'string' && s.drops && Object.hasOwn(s.drops, d.id) ? s.drops[d.id] : null; say(`Collect “${String(d.name).slice(0, 40)}”`, [], FINAL, price((x?.price ?? 0) + BLOB.claimFee)); break; }
		case 'col.make': say(`Start a collection: “${String(d.name).slice(0, 40)}”`, [d.royalty ? `You get ${(Number(d.royalty) / 100).toLocaleString('en-US')}% of every sale on Dznye.` : 'No royalty.'], FINAL, price(BLOB.colFee)); break;
		case 'evm.in': say(`Move ${A(d.asset ?? NATIVE, d.amount)} to your Ethereum side`, [`To ${String(d.to).slice(0, 6)}…${String(d.to).slice(-4)}.`], BACK); careful = 'Check that address is yours.'; break;
		case 'key.add': say('Let another device use this account', [], LATER); careful = 'That device can spend everything here. Only add your own.'; break;
		case 'q.set': say('Give this account a hash key', ['A second key no quantum computer breaks, made from a recovery code you keep.', 'With that code, the account can always be taken back from another wallet.'], 'Only the hash key itself changes it from now on.'); careful = 'Whoever has the recovery code can take this account. Keep it offline.'; break;
		case 'q.run': { const act = d.act as { type?: unknown; data?: Record<string, unknown> } | undefined; say(`Use ${who(s, d.account)}'s hash key`, [...(d.key ? [`${who(s, d.key)} is put in charge of it: every other key of it stops working.`] : []), ...(act?.type === 'transfer' ? [`It sends ${A(act.data?.asset ?? NATIVE, act.data?.amount)} to ${who(s, act.data?.to)}.`] : act ? [`It does one thing as that account: ${String(act.type).slice(0, 30)}.`] : []), ...(d.only === true ? ['From now on only the hash key moves it.'] : d.only === false ? ['Its ordinary key may move it again.'] : []), 'Its next hash key comes from the same recovery code.']); break; }
		case 'grant.propose': say(`Propose paying ${A(d.asset ?? NATIVE, d.amount)} from the contributors' fund`, [`To ${who(s, d.to)}.`, `For: “${String(d.reason).slice(0, 60)}”.`, 'It is paid when more than two thirds of all stake says yes, within 7 days.']); break;
		case 'grant.vote': say(`Vote ${d.yes === true ? 'yes' : 'no'} on paying a contributor`, ['Your vote counts by the DZY you have staked or backing a validator.'], 'You can vote again to change it until voting ends.'); break;
		case 'grant.close': say('Clear away a proposal whose voting has ended', []); break;
		case 'stake.unbond': say(`Ask for ${A(NATIVE, d.amount)} of your stake back`, ['It stops counting now and comes back in 14 days.']); break;
		case 'stake.withdraw': say('Take back the stake that has come back', ['It goes to your account.']); break;
		case 'guardian.set': say('Choose someone who can help you get back in', [`${who(s, d.guardian)}.`, 'They cannot take your money. If they start a recovery, you have 3 days to stop it.'], LATER); break;
	}
	const costUsd = fee + extra + (t.tip ? price(t.tip) : 0);
	return { title, lines, costUsd, cost: extra ? `${money(costUsd)} in all` : costUsd <= 0 ? 'Free' : `Fee: ${money(costUsd)}`, undo, ...(careful ? { careful } : {}) };
}
