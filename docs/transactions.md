# Transactions

## Format

```
{
  "chain": "dznye-mainnet",
  "from": "<64 hex: the sender's Ed25519 public key>",
  "nonce": 7,
  "type": "transfer",
  "data": { "asset": "DZY", "to": "<64 hex>", "amount": 150000000 },
  "payer": "<optional: an account that pays the fee>",
  "tip": "<optional: shards on top of the fee, to go first while blocks are full>",
  "max": "<optional: the most fee it may cost; above it, it waits>",
  "sig": "<128 hex: Ed25519 signature>",
  "payerSig": "<only with payer>"
}
```

- `chain` binds the transaction to one chain; it is refused anywhere else.
- `nonce` is the sender's next number (`GET /account/<address>` gives `nextNonce`). Each nonce is used once.
- Amounts are integers in the smallest unit of the asset.

## Signing

The signed message is the string `dzy-tx:` followed by the canonical JSON (keys sorted, no spaces) of
`{ chain, from, nonce, type, data, signer, payer, tip, max }`, leaving out fields that are not present. The transaction id is the
SHA-256 of that message. A fee payer signs `dzy-pay:` followed by the same message.

`src/ledger.ts` exports `txMessage`, `signTx` and `signPayer`; `src/client.ts` wraps them for applications.

## Fees

Every transaction pays the fee of the moment (`GET /` and `GET /fees` show it) from the sender, or from `payer` when one
signed. With the Heart rules the fee follows how full blocks are, by bytes and by work, and is never below 20 millionths of
a dollar in DZY (`feeFloor`). An action pays one fee for every 1,000 characters (`sizeExtra`), and ten fees when it adds
an entry every node must keep for good, more past a day's share (`newEntries`, `keptTimes`). `tip` goes on top and is
shared like any fee; `max` makes it wait rather than pay more. Some transactions carry their own charges (names, tokens,
contract deployment); the handler for each type in `src/ledger.ts` states them. `POST /explain` says the whole price in
dollars before signing.

## Types

The transaction types and their rules are the handlers in `src/ledger.ts`. Each is covered by the tests in the
`*.test.mjs` files at the top of this repository.

### Hash keys (the last rules, from block 9,721)

A hash key is a Winternitz one-time key made only of SHA-256 (`src/wots.ts`): no quantum computer breaks it.

- `q.set { root }`: signed by the account's ordinary key, once. `root` is the first hash key's root (`wotsKey(secret).root`).
  From then on only the hash key changes it.
- `q.run { account, root, key?, only?, act?, seed, sig }`: handed in by anyone (who pays its fee, about 14 normal fees: the
  signature is 4,288 hex characters). `seed`, `sig` = `wotsSign(secret_n, qMessage(chain, account, n, { root, key, only, act }))`
  where `n` is `hashKey.n` from `GET /account/<account>`; `root` names the next hash key. `key` puts a new ordinary key in
  charge (every other key, agent, guardian, recovery and several-key rule is dropped); `only: true` lets nothing but the hash
  key move the account; `act { type, data }` does one thing as the account (`transfer`, `transfer.many`, `stake.unbond`,
  `stake.withdraw`, `stake.undelegate`, `stake.claim`, `offer.create`, `offer.cancel`, `swap`, `x.sell`, `x.close`, `key.add`,
  `key.remove`, `name.set`, `lock.stake`).
- Never sign two different messages with one `secret_n`. The web wallet derives every `secret_n` from one 32-byte recovery
  code (`sha256("dzy-qn" ‖ code ‖ n as 4 bytes)`, `site/public/js/hashkey.js`), keeps a signed step until the chain takes it and
  hands in the same step again rather than signing a new one. Its rescue signs the key change alone first, then one transfer
  per coin, so no signed step can go stale.

### Grants (the Heart rules)

A tenth of every fee goes to the contributors' fund (`GET /heart`: `grants` in DZY shards, `coin.g` per coin).

- `grant.propose { to, asset, amount, reason }`: by anyone with DZY staked or delegated. `asset` is `DZY` or an exchange coin
  (`BTC`, `ETH`, `SOL`, `USDC`, ...); `reason` 3 to 60 characters; at most 50 open.
- `grant.vote { id, yes }`: by anyone with DZY staked or delegated; a later vote replaces an earlier one. Paid at once when the
  yes votes' stake is more than two thirds of all, if the fund holds enough. Voting lasts 7 days.
- `grant.close { id }`: anyone clears a proposal whose voting has ended.
