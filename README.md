# DZY Chain - Independent Decentralized Network

**A blockchain anyone can run from a laptop.** Your keys, your history and your node, on your own computer. Payments
final in seconds for a tiny fraction of a cent, with names, tokens, creator payments and cross-chain swaps built in.
No company has to stay online for your coins, your name or your history to exist.

**Join the network:** run a node in one line, help keep the chain honest, and earn for it.

```
# macOS / Linux
curl -fsSL https://chain.dznye.com/node/install.sh | sh

# Windows (PowerShell)
irm https://chain.dznye.com/node/windows.txt | iex
```

Or from this repository: `node node/runner.mjs` (Node.js 24, nothing else to install).

---

## Why DZY

| | Bitcoin | Ethereum | Solana | **DZY** |
|---|---|---|---|---|
| Run a full node | Hundreds of GB, a day or more to sync | Over 1 TB, specialised setups | Data-centre hardware (hundreds of GB of RAM) | **Any laptop or PC, synced in minutes today** |
| A payment is final | About an hour (6 blocks) | About 13 minutes | Seconds | **Seconds: one block, never reversed** |
| Typical fee | Cents to dollars | Cents to dollars on the main chain | A fraction of a cent | **Under a millionth of a cent** |
| Names (@you instead of 0x…) | No | A separate service (ENS) | A separate service | **Built in** |
| Your own token | No | A smart contract to write and audit | A program to deploy | **One transaction** |
| Sell to fans, take tips, numbered editions | Apps on top | Apps on top | Apps on top | **Built in, paid in USDT, USDC, ETH, SOL or DZY** |
| Swap with other chains | Bridges and exchanges | Bridges and exchanges | Bridges and exchanges | **Built-in vaults: ETH, USDC, USDT, SOL, BNB and more** |
| What the whole thing needs | C++ toolchain | Several clients | Rust toolchain, big machines | **Node.js only, no dependencies** |

What that means in practice:

- **You own it, for real.** Your keys never leave your device. Your node keeps the whole history and your creators'
  public pictures, checked against their fingerprints. If every website went dark, the chain and your coins would
  still be on the nodes, including yours.
- **Cheap enough for everyday things.** Tips, subscriptions, a coffee, a sticker: fees are too small to notice.
- **Fast enough for a shop counter.** One block and it is final. No waiting for confirmations, no reorganisations.
- **Simple enough to read.** The whole chain is a few files of TypeScript you can read in an afternoon, and every
  rule is covered by tests in this repository.

## Earn by running a node

1. Install the node (above). It makes its own key and copies the chain.
2. Send 1 DZY or more to the address it shows. It stakes it by itself and becomes a **checker**: a few times an
   hour it records on the chain which block it checked.
3. On every day it stayed online, it shares the checkers' part of the validators' daily pay. Add
   `--payout @yourname` and earnings go to your wallet once a day.

Bigger stakes can run as **validators**, which make the blocks and earn the validators' pay. See `docs/node.md`.

## Use it

- **Web wallet:** [wallet.dznye.com](https://wallet.dznye.com): DZY, ETH, Solana, Bitcoin and dollar coins in one
  wallet, with a creator page, a shop and perps.
- **Command line:** `node wallet/dzy.mjs help` and `node cli.mjs help`.
- **Explorer:** [chain.dznye.com](https://chain.dznye.com).

## Build on it

Every node answers a plain JSON API (`docs/api.md`). Transactions are Ed25519-signed JSON (`docs/transactions.md`).
Accept payments, read names and balances, sell items or open sealed content with a few HTTP calls; no SDK required.

## Status

The network is young: validators are being added as operators join, and the code is tested but not yet independently
audited. Every node that joins makes it stronger. That is the point.

## Tests

`npm test`, or `node <file>` for any `*.test.mjs`.

## License

MIT. See `LICENSE`.
