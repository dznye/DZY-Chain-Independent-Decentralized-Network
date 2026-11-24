# Wallet and client

## Wallet

`wallet/dzy.mjs` keeps one backup file sealed with a PIN (scrypt, then the master secret mixed with the result; every
PIN opens some wallet, so a guess cannot be checked offline). All keys are derived from the master secret and every
transaction is signed locally.

```
node wallet/dzy.mjs new             make a wallet
node wallet/dzy.mjs open <file>     use an existing backup file
node wallet/dzy.mjs receive         addresses, with QR codes
node wallet/dzy.mjs balance         holdings
node wallet/dzy.mjs send @name 1.5  send, with the chain's own price first (--fast tips to go first while blocks are full, --slow waits for a quiet block)
node wallet/dzy.mjs grants          the contributors' fund and its proposals (grants vote <id> yes|no)
node wallet/dzy.mjs help            every command
```

## Client

`cli.mjs` talks to any node (`--node <url>`, or `DZNYE_NODE`; default `http://127.0.0.1:8787`).

```
node cli.mjs key new [file]
node cli.mjs info
node cli.mjs balance <address>
node cli.mjs send --key <file> --to <address> --amount 1.5
node cli.mjs token create --key <file> --symbol GOLD --name "Gold" --supply 1000
node cli.mjs genesis new --chain <name> --authority <address> --validators a,b,c
node cli.mjs contract deploy --key <file> --file program.json
node cli.mjs help
```

Example contracts are in `contracts/`.

## Web wallet: hash key and grants

- **Me → Security → Hash key** (`site/public/js/hashkey.js`): makes a hash key from a recovery code you download and
  confirms (`q.set`), and takes an account back into the open wallet with that code (`q.run`: first the key change, then one
  transfer per coin). The open wallet pays the fees, so it needs a little DZY first; it says how much (from `POST /explain`).
- **Me → Earn & sell → Contributors' fund** (`site/public/js/grants.js`): the fund, the open proposals, Yes / No, propose,
  and clear ended ones (`grant.*`).
