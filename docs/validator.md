# Running a validator

Anyone can help run the chain. Checking needs **1 DZY staked**; making blocks needs **a place**, staked (69 DZY at
first: `GET /heart` gives `nextPlace`). What the node does depends on whether other computers can reach it:

| | Checker (Guardian) | Validator |
|---|---|---|
| What it does | Copies and checks every block, and records a few times an hour which block it checked (free) | The same, and it is in the raffle for every block |
| Stake | 1 DZY or more | A place: 69 DZY at first, doubling at every 25 validators (`nextPlace`) |
| Needs a public address | No | Yes: other validators must reach it (`PUBLIC_URL`) |
| Pay | On days it was seen in 12 different hours and made fewer blocks than its share: 5% of every fee, shared by stake x time | 40% of every fee, by the blocks it made (shared with its backers after its commission) |
| How | `node node/runner.mjs --payout <address>` (see [node.md](node.md)) | This page |

**Power is stake x time (the Heart and time rules, live since blocks 8,760 and 8,820).** 1 DZY behind a validator (its
own plus what others back it with) for 1 second online is 1 raffle shard, up to four years. Added stake starts its own
clock. After an hour away, every second away takes 4 off; a missed turn costs a day (at most half), and 3 missed in a row
bench it. Who makes each block, and who steps in, is drawn by raffle shards, seeded by Bitcoin. Splitting one stake over
several keys gains nothing.

**Proven and the starting validators.** A validator with 69 DZY and 30 days online is proven. Until 4 proven others with
250,000 DZY between them are online, the starting validators carry the chain, and everyone else together holds at most a
quarter of the say (then their share of 250,000 DZY, then all of it).

**Cheating.** Two blocks signed at one place, which anyone can prove: the whole stake and the seat for good; the prover
gets a part, the rest is a bonus for the honest. Confirming a payment from another chain that a guardian objected to and
a starting validator threw out: the seat for 30 days, all raffle shards and a tenth of the stake.

`GET /heart` shows every validator's stake, time online, raffle shards, whether it is proven, and its chance at the next
block. (`GET /validators` also reports `minStake` and `seatPrice`: the rule from before the Heart upgrade, kept for
older chains.)

## Before you start

- **A machine that stays on.** A server or an always-on computer: a validator that is offline is not drawn and is not paid.
- **A public HTTPS address** for the node: a server with a domain, or a home computer behind a tunnel (for example
  Cloudflare Tunnel) or with port 8787 forwarded to it.
- **Node.js 24 or newer.** Nothing else to install.
- **The price of a place** for the stake (69 DZY or more: `nextPlace` at `GET /heart`), plus a little for fees.

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

5. Fund and stake. Send the price of a place (plus a little for fees) to the validator's address, then:

   ```
   node cli.mjs stake bond --key validator.json --amount <DZY>
   ```

   From then on the node checks in with its public address and its raffle shards start counting. Unstaking takes `unbondDays` (at
   `GET /validators`).

6. Keep it running. On Linux, run it as a service (systemd: `Restart=always`). On Windows, a scheduled task at
   start-up with "restart on failure".

## Checking on it

```
curl https://api.dznye.com/nodes             # this node's check-ins (its address, hours seen today)
curl https://api.dznye.com/heart             # every validator's power, raffle shards and chance
curl https://api.dznye.com/validators        # stakes and the current crew
curl http://localhost:8787/                  # this node's height
```

Never run two copies with one key, and never restore an old copy of the data folder while the other is still running:
signing two different blocks at one height is punished.
