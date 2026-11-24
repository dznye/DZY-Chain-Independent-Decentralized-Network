// Allyra, the art exchange, as a node sees it (GET /gallery): every picture, song, clip or file its maker shows or sells, in
// one list, with how many were made and sold, what owners ask for theirs, and how people rate it. Read only: nothing here
// is a rule of the chain. Everything comes from records anyone can read:
//   items/* and the free picture posts blocks/p-*  what is shown (a free post is "~" + its block's key)
//   rate/*   { s, i, r }   someone's rating: r is 1 to 4 shards (dznye.com's own rating), one counted for each account
//   report/* { s, i, why } someone asks for a look; reportsHide different accounts take a piece out of the list
//   hidden/* (written by @dzy only) { s, i? } taken down: one piece, or everything of that maker; { s, i, ok: 1 } looked at, stays
import { itemNft, itemOf, resaleBps, RULES, RESALE, type State } from './ledger.ts';

export const GALLERY = Object.freeze({ max: 500, reportsHide: 5, week: 7 * 86_400_000 });
/** what is shown, by kind; memberships, chats and services are not art and stay on their maker's page */
const CATS: Record<string, string> = { nft: 'art', image: 'pictures', video: 'video', audio: 'music', file: 'files', software: 'files', course: 'files', other: 'files' };
/** how rare, from how many will ever exist (0: no limit) */
export const rarity = (n: number) => (!n ? 'open' : n === 1 ? 'one' : n <= 10 ? 'ultra' : n <= 100 ? 'rare' : 'limited');
const hex64 = /^[0-9a-f]{64}$/;
/** where a capture says it was taken (kept in hundredths of a degree: about a kilometre), in degrees, and whether a hand held it;
    nothing when it is not a real place */
function placeOf(v: Record<string, unknown>): Pick<NonNullable<Piece['cap']>, 'geo' | 'mv'> {
	const g = v.geo as Record<string, unknown> | undefined, n = (x: unknown, m: number) => Number.isSafeInteger(x) && Math.abs(x as number) <= m;
	const geo = g && typeof g === 'object' && n(g.la, 9_000) && n(g.lo, 18_000) && n(g.r, 1e7) ? { la: (g.la as number) / 100, lo: (g.lo as number) / 100, r: g.r as number } : null;
	return { ...(geo ? { geo } : {}), ...(geo && v.mv === 1 ? { mv: 1 as const } : {}) };
}
const pic = (u: unknown) => typeof u === 'string' && (/^\/media\/[0-9a-f]{64}\/[0-9a-f]{32}$/.test(u) || (/^https:\/\/[\x21-\x7e]{1,300}$/.test(u) && !/["'<>\\`]/.test(u)));

export interface Piece {
	seller: string; item: string; name: string; title: string; about: string; kind: string; cat: string; cover: string; at: number;
	free: boolean; usd: number; editions: number; sold: number; rare: string; off: boolean; feeBps: number;
	stars: number; rated: number; resold: number; last: number; asks: { owner: string; usd: number; ed: number }[]; hot: number; held?: true;
	/** a file it opens into, and its public preview: fingerprint, size, extension; the preview's picture-store id */
	file?: string; fs?: number; ft?: string; pv?: string;
	/** taken with Capture: the file's fingerprint, the block seen as it was taken, when its maker says, when the chain took it */
	cap?: { sha: string; h: number; b: string; at: number; when: number; geo?: { la: number; lo: number; r: number }; mv?: 1 };
	/** a card that is a real NFT (when the chain links them: ledger.ts nftItemsOn): its asset */
	nft?: string;
	/** a card on its side (88 by 63), as its maker framed it */
	side?: 1;
}
/** every piece that may be shown now, newest first; `all`: also those taken out of the list (held), for whoever looks at reports */
export function gallery(s: State, now: number, all = false): Piece[] {
	const rec = s.records ?? {}, rates = new Map<string, Map<string, { r: number; at: number }>>(), reports = new Map<string, Set<string>>(), hid = new Set<string>(), cleared = new Set<string>();
	const caps = new Map<string, NonNullable<Piece['cap']>>();
	const art: [string, string, Record<string, unknown>, number][] = [];
	for (const k of Object.keys(rec)) {
		const a = k.indexOf('/'), b = k.indexOf('/', a + 1), writer = k.slice(0, a), space = k.slice(a + 1, b), key = k.slice(b + 1);
		if (!['items', 'blocks', 'rate', 'report', 'hidden', 'capture'].includes(space)) continue;
		const v = rec[k].value as Record<string, unknown> | undefined;
		if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
		if (space === 'items') { art.push([writer, key, v, rec[k].at]); continue; }
		if (space === 'blocks') { if (v.t === 'image' && key.startsWith('p-')) art.push([writer, '~' + key, v, rec[k].at]); continue; }
		if (space === 'capture') { if (typeof v.sha === 'string' && hex64.test(v.sha) && Number.isSafeInteger(v.h) && typeof v.b === 'string' && hex64.test(v.b) && Number.isSafeInteger(v.at)) caps.set(`${writer}/${key}`, { sha: v.sha, h: v.h as number, b: v.b, at: v.at as number, when: rec[k].at, ...placeOf(v) }); continue; }
		if (typeof v.s !== 'string' || !hex64.test(v.s)) continue;
		const id = `${v.s}/${String(v.i)}`;
		if (space === 'rate' && writer !== v.s && Number.isSafeInteger(v.r) && (v.r as number) >= 1 && (v.r as number) <= 4) {
			const m = rates.get(id) ?? new Map(); rates.set(id, m);
			if ((m.get(writer)?.at ?? -1) <= rec[k].at) m.set(writer, { r: v.r as number, at: rec[k].at });
		} else if (space === 'report') (reports.get(id) ?? reports.set(id, new Set()).get(id)!).add(writer);
		else if (space === 'hidden' && writer === RULES.saleFeeTo) { if (v.ok === 1) cleared.add(id); else hid.add(v.i === undefined ? `${v.s}/` : id); }
	}
	// bought or resold in the last week, by piece; the asks, by piece
	const recent = new Map<string, number>(), asks = new Map<string, { owner: string; usd: number; ed: number }[]>();
	for (const [k, o] of Object.entries(s.owned ?? {})) if (now - o.at < GALLERY.week) { const id = k.slice(k.indexOf('/') + 1); recent.set(id, (recent.get(id) ?? 0) + 1); }
	for (const [k, l] of Object.entries(s.listings ?? {})) { const o = s.owned?.[k]; if (!o) continue; const n = k.indexOf('/'), id = k.slice(n + 1); (asks.get(id) ?? asks.set(id, []).get(id)!).push({ owner: k.slice(0, n), usd: l.usd, ed: o.ed ?? 0 }); }
	const out: Piece[] = [];
	for (const [seller, item, v, at] of art) {
		const id = `${seller}/${item}`, free = item.startsWith('~'), it = free ? null : itemOf(v), kind = free ? 'image' : typeof v.kind === 'string' ? v.kind : 'other';
		if (!free && (!it || it.month || !Object.hasOwn(CATS, kind) || typeof v.title !== 'string')) continue;
		const cover = pic(free ? v.url : v.cover) ? String(free ? v.url : v.cover) : '';
		const held = hid.has(id) || hid.has(`${seller}/`) || ((reports.get(id)?.size ?? 0) >= GALLERY.reportsHide && !cleared.has(id));
		if (!cover || (held && !all)) continue;
		const ask = (asks.get(id) ?? []).sort((a, b) => a.usd - b.usd || (a.owner < b.owner ? -1 : 1)).slice(0, 20);
		if (it?.off && !ask.length) continue; // its maker stopped selling it, and nobody offers theirs
		const given = [...(rates.get(id)?.values() ?? [])], stars = given.length ? given.reduce((n, x) => n + x.r, 0) / given.length : 0;
		const rs = s.resales && Object.hasOwn(s.resales, id) ? s.resales[id] : null, days = Math.max(0, now - at) / 86_400_000;
		out.push({ seller, item, name: s.accounts[seller]?.name ?? '', title: String(free ? v.label ?? '' : v.title).slice(0, 80), about: typeof v.about === 'string' ? v.about.slice(0, 300) : '', kind, cat: CATS[kind], cover, at,
			free, usd: it?.usd ?? 0, editions: it?.editions ?? 0, sold: s.sales && Object.hasOwn(s.sales, id) ? s.sales[id].n : 0, rare: free ? 'free' : rarity(it!.editions), off: it?.off ?? false, feeBps: resaleBps(v),
			stars: Math.round(stars * 100) / 100, rated: given.length, resold: rs?.n ?? 0, last: rs?.last ?? 0, asks: ask,
			// what is rising: bought this week counts most, then how many liked it (more than 2 shards), fading over weeks
			hot: ((recent.get(id) ?? 0) * 3 + Math.max(0, stars - 2) * Math.log2(1 + given.length)) / (1 + days / 14), ...(held ? { held: true as const } : {}),
			...(!free && typeof v.file === 'string' && hex64.test(v.file) && Number.isSafeInteger(v.fs) ? { file: v.file, fs: v.fs as number, ft: typeof v.ft === 'string' && /^[a-z0-9]{1,9}$/.test(v.ft) ? v.ft : '', ...(typeof v.pv === 'string' && /^[0-9a-f]{32}$/.test(v.pv) ? { pv: v.pv } : {}) } : {}),
			...(!free && caps.has(id) ? { cap: caps.get(id)! } : {}),
			...(!free && itemNft(s, v, s.height) ? { nft: itemNft(s, v, s.height)! } : {}), ...(v.side === 1 ? { side: 1 as const } : {}) });
	}
	return out.sort((a, b) => b.at - a.at || (a.seller + a.item < b.seller + b.item ? -1 : 1)).slice(0, GALLERY.max);
}
export { RESALE };
