# Running a validator

Anyone can help run the chain with **1 DZY staked**. What the node does depends on whether other computers can reach it:

| | Checker | Validator |
|---|---|---|
| What it does | Copies and checks every block, and records a few times an hour which block it checked | The same, and it is in the draw to make blocks: every 10 minutes a crew is drawn from the validators online |
| Stake | 1 DZY or more | 1 DZY or more |
| Needs a public address | No | Yes: other validators must reach it (`PUBLIC_URL`) |
| Pay | On days it was seen in 12 different hours, the checkers share 20% of the day's work pay, by stake | Paid for the blocks it makes, plus a daily bonus drawn by stake |
| How | `node node/runner.mjs --payout <address>` (see [node.md](node.md)) | This page |

**Stake and chances.** The crew is drawn with one ticket per staked shard (the node's own stake plus what others back
it with): more stake, picked more often. While 64 or fewer validators are online, every one of them is in the crew.
Splitting one stake over several keys gains nothing.

(`GET /validators` also reports `minStake` and `seatPrice`: those are the rule from before the crew draw, kept for older
chains. On the Dznye chain, 1 DZY staked is enough.)

## Before you start

- **A machine that stays on.** A server or an always-on computer: a validator that is offline is not drawn and is not paid.
- **A public HTTPS address** for the node: a server with a domain, or a home computer behind a tunnel (for example
  Cloudflare Tunnel) or with port 8787 forwarded to it.
- **Node.js 24 or newer.** Nothing else to install.
- **1 DZY or more** for the stake, plus a little for fees.

## Steps

1. Get the code:

   ```
   git clone https://github.com/dznye/DZY-Chain-Independent-Decentralized-Network dzy
   cd dzy
   ```

2. Make the validator's key. Keep it on **this one machine only**: two machines with the same key would sign twice,
   which the chain punishes with the operator's whole stake.

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

5. Fund and stake. Send 1 DZY or more (plus a little for fees) to the validator's address, then:

   ```
   node cli.mjs stake bond --key validator.json --amount <DZY>
   ```

   From then on the node checks in with its public address and is in the draw. Unstaking takes `unbondDays` (at
   `GET /validators`).

6. Keep it running. On Linux, run it as a service (systemd: `Restart=always`). On Windows, a scheduled task at
   start-up with "restart on failure".

## Checking on it

```
curl https://api.dznye.com/nodes             # this node's check-ins (its address, hours seen today)
curl https://api.dznye.com/validators        # the current crew and its power
curl http://localhost:8787/                  # this node's height
```

Never run two copies with one key, and never restore an old copy of the data folder while the other is still running:
signing two different blocks at one height is punished.
