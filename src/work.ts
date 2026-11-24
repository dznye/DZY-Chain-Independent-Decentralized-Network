/* How much computing a block may hold, and how full it is of it (the last rules, heart.ts). On its own, so that whatever runs
   contracts can count its work without needing the rest of the rules. */
interface S { heart?: { size: number; fut?: 1; load?: number } }
export const FUTURE = Object.freeze({ blockGas: 12_000_000, blockGasMost: 30_000_000, qChars: 9_000, sizeStart: 1_400_000 });
/** the gas Ethereum contracts may use in a block: as the block's size, it follows demand and what the validators can take */
export const evmRoom = (s: S) => Math.min(FUTURE.blockGasMost, Math.max(FUTURE.blockGas, Math.floor((FUTURE.blockGas * s.heart!.size) / FUTURE.sizeStart)));
/** work done in this block, in millionths of the most one may hold (counted up by what runs, and cleared when the block ends) */
export function workAdd(s: S, used: number, most: number) { if (s.heart?.fut && used > 0) s.heart.load = Math.min(1_000_000, (s.heart.load ?? 0) + Math.ceil((used * 1_000_000) / most)); }
/** how full a block was, as bytes: by its size, or by its work if that was more */
export function fullness(s: S, bytes: number): number { const l = s.heart?.load; if (s.heart && l !== undefined) delete s.heart.load; return l ? Math.max(bytes, Math.floor((l * s.heart!.size) / 1_000_000)) : bytes; }
