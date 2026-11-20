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
