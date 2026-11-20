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
  "sig": "<128 hex: Ed25519 signature>",
  "payerSig": "<only with payer>"
}
```

- `chain` binds the transaction to one chain; it is refused anywhere else.
- `nonce` is the sender's next number (`GET /account/<address>` gives `nextNonce`). Each nonce is used once.
- Amounts are integers in the smallest unit of the asset.

## Signing

The signed message is the string `dzy-tx:` followed by the canonical JSON (keys sorted, no spaces) of
`{ chain, from, nonce, type, data, signer, payer }`, leaving out fields that are not present. The transaction id is the
SHA-256 of that message. A fee payer signs `dzy-pay:` followed by the same message.

`src/ledger.ts` exports `txMessage`, `signTx` and `signPayer`; `src/client.ts` wraps them for applications.

## Fees

Every transaction pays the chain's fixed fee (`GET /` shows it) from the sender, or from `payer` when one signed.
Some transactions carry their own charges (names, tokens, contract deployment); the handler for each type in
`src/ledger.ts` states them.

## Types

The transaction types and their rules are the handlers in `src/ledger.ts`. Each is covered by the tests in the
`*.test.mjs` files at the top of this repository.
