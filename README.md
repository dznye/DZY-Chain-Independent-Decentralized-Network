# DZY Chain - Independent Decentralized Network

DZY is a proof-of-stake blockchain with byzantine fault tolerant consensus and instant finality. This repository
contains the reference node, a command-line wallet, a command-line client, and the vault contracts used to move coins
in from other chains. It is written in TypeScript and JavaScript and runs on Node.js 24 with no dependencies.

## Requirements

Node.js 24 or later.

## Running a node

Follow the DZY network and check every block:

```
node node/runner.mjs
```

Or start the node directly:

```
node node/server.mjs --follow https://api.dznye.com --data ./chain-data
```

A new node can also start from the genesis file in `launch/dznye-mainnet.genesis.json`. See `docs/node.md`.

## Running your own chain

```
node cli.mjs key new me.json
CHAIN=mychain-1 AUTHORITY_ADDRESS=<address> VALIDATOR_ADDRESS=<address> VALIDATOR_SECRET=<secret> \
  node node/server.mjs --data ./data
```

## Wallet

```
node wallet/dzy.mjs help
```

## Documentation

- `docs/node.md`: running a node, settings, joining as a checker or validator
- `docs/api.md`: the node's HTTP interface
- `docs/transactions.md`: transaction format, signing and fees
- `docs/wallet.md`: the command-line wallet and client

## Tests

```
npm test
```

Each `*.test.mjs` file runs on its own with `node <file>`.

## License

MIT. See `LICENSE`.
