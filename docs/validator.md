# Running a validator

There are two ways to help run the chain:

| | Checker | Validator |
|---|---|---|
| What it does | Copies and checks every block, records a few times an hour which block it checked | Takes part in agreeing blocks: drawn into the crew that votes on each block |
| Stake | 1 DZY or more | One seat's worth (see `minStake` and `seatPrice` at `GET /validators`; about 1,000 DZY at the time of writing) |
| Needs a public address | No | Yes: other validators must reach it |
| Pay | An equal share of the checkers' part of the validators' daily pay, on days it was seen in 12 different hours | Equal shares of the validators' wage, a daily bonus drawn by stake, and seats in the crew by stake |
| How | `node node/runner.mjs --payout <address>` (see [node.md](node.md)) | This page |

## Before you start

- **A machine that stays on.** A server or an always-on computer. A laptop that sleeps loses its seat's pay.
- **A public HTTPS address** for the node: a server with a domain, or a home computer behind a tunnel (for example
  Cloudflare Tunnel) or with port 8787 forwarded to it.
- **Node.js 24 or newer.** Nothing else to install.
- **DZY for the stake.** Check the current seat price: `GET https://api.dznye.com/validators` (`minStake`, in parts of
  1/100,000,000 DZY).

## Steps

1. Get the code:

   ```
   git clone https://github.com/dznye/DZY-Chain-Independent-Decentralized-Network dzy
   cd dzy
   ```

2. Make the validator's key. Keep it on **this one machine only**: two machines with the same key would sign twice,
   which the chain punishes (part of the stake and the seat).

   ```
   node cli.mjs key new validator.json
   ```

3. Copy [validator.env.example](validator.env.example) to `validator.env` and fill in the address and secret from
   `validator.json`, and the public address of this node. Keep `validator.env` private: it holds the secret.

4. Start the node:

   ```
   node node/server.mjs --env validator.env --data ./chain-data --host 0.0.0.0 --port 8787
   ```

   It copies the chain from the peers first; wait until it reports the newest block.

5. Fund and stake. Send the seat's worth of DZY (plus a little for fees) to the validator's address, then:

   ```
   node cli.mjs stake bond --key validator.json --amount <DZY>
   ```

   Staking is locked: unbonding takes `unbondDays` (at `GET /validators`).

6. Keep it running. On Linux, run it as a service (systemd: `Restart=always`). On Windows, a scheduled task at
   start-up with "restart on failure".

## Checking on it

```
curl https://api.dznye.com/validators        # is the address in "validators", and its power
curl http://localhost:8787/                  # this node's height
```

If it misses blocks it loses pay; if it signs two different blocks at one height it is punished. Never run two copies
with one key, and never restore an old copy of the data folder while the other is still running.
