# DZY Chain

**An independent blockchain anyone can run from a laptop.** Payments are final in under a second and cost a tiny fraction of a cent. Names, tokens, creator payments and swaps with other chains are built in. Open to everyone: install a node and you're part of the network.

## Start in one line

```
# macOS / Linux
curl -fsSL https://chain.dznye.com/node/install.sh | sh

# Windows (PowerShell)
irm https://chain.dznye.com/node/windows.txt | iex
```

Or from this repository, with Node.js 24 and nothing else:

```
node node/runner.mjs
```

The node makes its own key, copies the chain and checks every block. Send it 1 DZY to stake and it starts earning. Add `--payout @yourname` to receive earnings in your wallet once a day.

## How it compares

| | Bitcoin | Ethereum | Solana | **DZY** |
|---|---|---|---|---|
| Run a full node | Hundreds of GB, a day or more to sync | Over 1 TB, specialised setup | Data-centre hardware | **Any laptop, synced in minutes** |
| Payment final | About an hour | About 13 minutes | Seconds | **Under a second (one block), never reversed** |
| Typical fee | Cents to dollars | Cents to dollars | A fraction of a cent | **About $0.00002** |
| Names (@you) | No | Separate service | Separate service | **Built in** |
| Your own token | No | Write and audit a contract | Deploy a program | **One transaction** |
| Sell to fans, tips, editions | Apps on top | Apps on top | Apps on top | **Built in** |
| Swap with other chains | Bridges, exchanges | Bridges, exchanges | Bridges, exchanges | **Built-in vaults for ETH, USDC, USDT, SOL, BNB and more** |
| What it needs | C++ toolchain | Several clients | Rust toolchain, big machines | **Node.js, no dependencies** |

- **Yours.** Keys never leave your device. Every node keeps the full history, so the chain lives on even if every website goes dark.
- **Cheap.** Fees are small enough for tips, subscriptions and a coffee.
- **Fast.** One block and it's final. No waiting for confirmations.
- **Readable.** A few files of TypeScript, with every rule covered by tests.

## Use it

- **Wallet:** [wallet.dznye.com](https://wallet.dznye.com): DZY, ETH, SOL, Bitcoin and dollar coins in one place, with a creator page and a shop.
- **Explorer:** [chain.dznye.com](https://chain.dznye.com)
- **Command line:** `node wallet/dzy.mjs help` and `node cli.mjs help`

## Build on it

Every node answers a plain JSON API (`docs/api.md`). Transactions are signed JSON (`docs/transactions.md`). Take payments, read names and balances, or sell items with a few HTTP calls. No SDK needed.

## Tests

`npm test`, or `node <file>` for any `*.test.mjs`.

## License

MIT. See `LICENSE`.
