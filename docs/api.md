# HTTP interface

Every node answers JSON over HTTP. Amounts are integers in an asset's smallest unit (DZY has 8 decimals).

## Chain

| Request | Answer |
|---|---|
| `GET /` | chain name, height, last block hash, validators, fee |
| `GET /genesis` | the chain's starting settings |
| `GET /blocks?from=1&limit=100` | blocks in order |
| `GET /block/<height>` | one block |
| `GET /validators`, `GET /nodes`, `GET /peers` | who makes blocks; known nodes |
| `GET /snapshot` | the latest state snapshot |
| `GET /supply`, `GET /supply/<asset>`, `GET /economy` | amounts in existence and their pools |
| `POST /tx` | submit a signed transaction: `{ "tx": { ... } }` (see transactions.md) |
| `POST /simulate` | run a transaction without keeping its result |

## Accounts and names

| Request | Answer |
|---|---|
| `GET /account/<address>` | balances, nonce, name, links |
| `GET /name/<name>` | the address holding a name, and its linked addresses |
| `GET /names/premium` | the current price of 1, 2 and 3 character names |

## Assets and markets

`GET /assets`, `GET /offers`, `GET /trades`, `GET /liquidity`, `GET /quote`, `GET /markets`, `GET /swaps`,
`GET /swap/<id>`, `GET /xoffers`, `GET /xoffer/<id>`, `GET /exchange`, `GET /exchange/<address>`, `GET /usd`.

## Records and creators

| Request | Answer |
|---|---|
| `GET /record/<writer>/<space>/<key>` | one record |
| `GET /records/<writer>/<space>` | a writer's records in a space |
| `GET /space/<space>` | a space across all writers, newest first |
| `GET /owned/<buyer>/<seller>/<item>` | whether an account owns an item |
| `GET /sales/<seller>/<item>`, `GET /itemquote/<seller>/<item>` | sales count; the price in each coin |
| `GET /tips/<address>` | a tip box |
| `GET /media/<address>/<id>` | a picture this node keeps |

## Contracts, channels, streams

`GET /contracts`, `GET /contract/<address>`, `GET /channel/<id>`, `GET /stream/<id>`, `GET /streams/<address>`,
`GET /gift/<id>`, `GET /tasks`, `GET /task/<id>`.

## Between nodes

`POST /consensus` carries proposals and votes between validators. `POST /peers` announces a node's public address.
