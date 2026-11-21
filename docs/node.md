# Running a node

## Follower

A follower copies every block from one or more sources and checks each one. It holds no key and cannot create or move
anything.

```
node node/server.mjs --follow https://api.dznye.com --data ./chain-data
```

`--follow` accepts several sources separated by commas: node addresses, and archive folders or addresses ending in
`/index.json` (see `archive.mjs`). The node copies from all of them, checks everything, and finds more nodes through
`GET /peers`.

## Runner

`node/runner.mjs` starts a follower with sensible defaults:

```
node node/runner.mjs                     # default data folder: ~/.dznye-node
node node/runner.mjs --payout <address>  # send earnings beyond the stake to an address once a day
node node/runner.mjs --status            # print the node's address and state, then exit
```

On first start it creates its own key in the data folder. Once that address holds 1 DZY or more, the runner stakes it
and the node becomes a checker: a few times an hour it records which block it checked, and shares the checkers' part of
the validators' daily pay on days it was active.

To also make blocks (a validator: the same 1 DZY staked, plus a public address), see
[validator.md](validator.md).

## Options

```
--port 8787       --host 127.0.0.1 (0.0.0.0 to accept other computers)
--data <folder>   --follow <sources>   --env <file of NAME=value lines>
```

Environment settings:

| Name | Meaning |
|---|---|
| `CHAIN`, `AUTHORITY_ADDRESS` | a new chain's name and issuing key |
| `VALIDATOR_ADDRESS`, `VALIDATOR_SECRET` | this node's validator key |
| `VALIDATORS`, `PEERS` | every validator's address; the other validators' URLs |
| `BLOCK_MS`, `FEE` | block interval; fee per transaction in DZY parts |
| `GENESIS` | a genesis file: sets the chain, authority, validators and fee, and checks its hash |
| `SNAPSHOT_EVERY`, `SNAPSHOT_FROM`, `TRUST_HASH` | keep snapshots; start from another node's snapshot of a trusted block |
| `HALT_HEIGHT` | stop at that block for a planned upgrade |
| `PUBLIC_URL` | this node's public address, announced to other nodes |
| `CHECKER_ADDRESS`, `CHECKER_SECRET` | a follower's staked key, for checking in |
| `OPERATOR`, `OPERATOR_SIG` | a volunteer node's vouching account and its signature of `PUBLIC_URL` |
| `SOLANA_RPC`, `BTC_RPC`, `EVM_RPC_*` | validators: nodes of other chains, for watching vault payments |

## Pictures

A node with a data folder also keeps the public pictures that records point to (`/media/<address>/<id>`, where the id
is the first 32 hex digits of the picture's SHA-256). Each picture is copied once from other nodes, checked against its
id, and served at the same address.

## Data

The data folder holds `chain.sqlite` (blocks, state and snapshots) and `media/`. Deleting it makes the node copy the
chain again from its sources.
