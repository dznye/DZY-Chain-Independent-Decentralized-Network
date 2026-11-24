// Allyra's feed (src/gallery.ts): what is shown, rated, reported and taken down. Run: node chain/gallery.test.mjs
import assert from 'node:assert/strict';
import { gallery, rarity, GALLERY } from './src/gallery.ts';
import { RULES } from './src/ledger.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), NOW = 1_800_000_000_000, M = `/media/${A}/${'0'.repeat(32)}`, HOUR = 3_600_000;
const item = (x = {}) => ({ title: 'Art', kind: 'nft', usd: 5_000_000, editions: 3, cover: M, ...x });
const state = (records, more = {}) => ({ accounts: { [A]: { name: 'luna' } }, records: Object.fromEntries(Object.entries(records).map(([k, v], n) => [k, { value: v, at: NOW - HOUR - n }])), ...more });
const keys = (s) => gallery(s, NOW).map((p) => p.item);
let pass = 0; const test = (name, fn) => { fn(); pass++; console.log('ok  ', name); };

test('every kind lands in its category by itself; memberships, chats and things without a picture stay out', () => {
	const s = state({ [`${A}/items/n`]: item(), [`${A}/items/p`]: item({ kind: 'image', editions: undefined }), [`${A}/items/m`]: item({ kind: 'audio' }), [`${A}/items/v`]: item({ kind: 'video' }), [`${A}/items/f`]: item({ kind: 'file' }),
		[`${A}/items/club`]: item({ kind: 'membership', every: 'month' }), [`${A}/items/chat`]: item({ kind: 'chat' }), [`${A}/items/bare`]: item({ cover: '' }), [`${A}/items/bad`]: item({ cover: 'javascript:alert(1)' }), [`${A}/items/x`]: { title: 1 }, [`${A}/blocks/p-1`]: { t: 'image', url: M, label: 'free' }, [`${A}/blocks/b-1`]: { t: 'image', url: M } });
	assert.deepEqual(Object.fromEntries(gallery(s, NOW).map((p) => [p.item, p.cat])), { n: 'art', p: 'pictures', m: 'music', v: 'video', f: 'files', '~p-1': 'pictures' });
	assert.equal(gallery(s, NOW).find((p) => p.item === '~p-1').free, true); assert.equal(gallery(s, NOW)[0].name, 'luna');
});
test('rarity', () => assert.deepEqual([0, 1, 2, 10, 11, 100, 101].map(rarity), ['open', 'one', 'ultra', 'ultra', 'rare', 'rare', 'limited']));
test('ratings: 1 to 4 shards, one for each account (its latest), never the maker\'s own', () => {
	const r = (x) => ({ s: A, i: 'n', r: x }), s = state({ [`${A}/items/n`]: item(), [`${B}/rate/new`]: r(4), [`${B}/rate/old`]: r(1), [`${C}/rate/k`]: r(3), [`${A}/rate/me`]: r(4), [`${'d'.repeat(64)}/rate/k`]: r(5), [`${'e'.repeat(64)}/rate/k`]: r(2.5), [`${'f'.repeat(64)}/rate/k`]: r('4') });
	const p = gallery(s, NOW)[0]; assert.equal(p.rated, 2); assert.equal(p.stars, 3.5);
});
test('enough different reports take it out; the same account twice does not; @dzy can clear it, take it down, or a whole maker', () => {
	const rep = (n) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`${String(k).repeat(64)}/report/k`, { s: A, i: 'n', why: 'x' }]));
	assert.deepEqual(keys(state({ [`${A}/items/n`]: item(), ...rep(GALLERY.reportsHide - 1), [`${'0'.repeat(64)}/report/k2`]: { s: A, i: 'n' } })), ['n']);
	const gone = { [`${A}/items/n`]: item(), ...rep(GALLERY.reportsHide) }; assert.deepEqual(keys(state(gone)), []);
	assert.deepEqual(keys(state({ ...gone, [`${RULES.saleFeeTo}/hidden/k`]: { s: A, i: 'n', ok: 1 } })), ['n']);
	assert.deepEqual(keys(state({ [`${A}/items/n`]: item(), [`${RULES.saleFeeTo}/hidden/k`]: { s: A, i: 'n' } })), []);
	assert.deepEqual(keys(state({ [`${A}/items/n`]: item(), [`${RULES.saleFeeTo}/hidden/k`]: { s: A } })), []);
	assert.deepEqual(keys(state({ [`${A}/items/n`]: item(), [`${B}/hidden/k`]: { s: A } })), ['n'], 'anyone else cannot');
});
test('asks come from owners, cheapest first; an item taken off sale still shows while someone offers theirs', () => {
	const owned = { [`${B}/${A}/n`]: { at: NOW - HOUR, ed: 1 }, [`${C}/${A}/n`]: { at: NOW - 30 * 24 * HOUR, ed: 2 } };
	const s = state({ [`${A}/items/n`]: item({ off: true, resale: 500 }) }, { owned, listings: { [`${B}/${A}/n`]: { usd: 9e6, bps: 500, at: 1 }, [`${C}/${A}/n`]: { usd: 7e6, bps: 500, at: 1 } }, resales: { [`${A}/n`]: { n: 2, usd: 1e7, last: 6e6, at: 1 } } });
	const p = gallery(s, NOW)[0]; assert.deepEqual(p.asks, [{ owner: C, usd: 7e6, ed: 2 }, { owner: B, usd: 9e6, ed: 1 }]); assert.equal(p.feeBps, 500); assert.equal(p.last, 6e6); assert.ok(p.hot > 0);
	assert.deepEqual(keys(state({ [`${A}/items/n`]: item({ off: true }) })), []);
});
test('a capture shows with its item, only its maker\'s own, only well made', () => {
	const c = { sha: 'a'.repeat(64), h: 5, b: 'b'.repeat(64), at: NOW - HOUR }, it = { [`${A}/items/n`]: item() };
	assert.deepEqual(gallery(state({ ...it, [`${A}/capture/n`]: c }), NOW)[0].cap, { ...c, when: NOW - HOUR - 1 }); assert.equal(gallery(state({ ...it, [`${B}/capture/n`]: c }), NOW)[0].cap, undefined); assert.equal(gallery(state({ ...it, [`${A}/capture/n`]: { ...c, sha: 'x' } }), NOW)[0].cap, undefined);
});
test('a capture carries where it was taken (only near, about a kilometre), and never a place that is not one', () => {
	const c = { sha: 'a'.repeat(64), h: 5, b: 'b'.repeat(64), at: NOW - HOUR }, it = { [`${A}/items/n`]: item() }, cap = (v) => gallery(state({ ...it, [`${A}/capture/n`]: { ...c, ...v } }), NOW)[0].cap;
	assert.deepEqual(cap({ geo: { la: 4071, lo: -7401, r: 12 }, mv: 1 }).geo, { la: 40.71, lo: -74.01, r: 12 }); assert.equal(cap({ geo: { la: 4071, lo: -7401, r: 9 }, mv: 1 }).mv, 1);
	for (const geo of [{ la: 9_100, lo: 0, r: 5 }, { la: 40.7, lo: 0, r: 5 }, { la: 'x', lo: 0, r: 5 }, { la: 1, lo: 0 }, [1, 2], 'here']) { const k = cap({ geo, mv: 1 }); assert.ok(k, 'the capture itself still counts'); assert.equal(k.geo, undefined); assert.equal(k.mv, undefined); }
});
test('odd records never break it', () => { assert.deepEqual(gallery(state({ [`${A}/items/n`]: null, [`${A}/rate/k`]: [], [`${A}/report/k`]: { s: 5 }, [`${A}/blocks/p-9`]: 'x' }), NOW), []); assert.deepEqual(gallery({ accounts: {} }, NOW), []); });
console.log(`\n${pass} gallery tests passed`);
