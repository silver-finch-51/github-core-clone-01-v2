# github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/silver-finch-51/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/silver-finch-51/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge v2: a GitHub-compatible git forge in a single Node.js process, standard library only — the v1 Forge surface (git smart-HTTP protocol v0 and v2, REST v3, GraphQL v4, MCP streamable-HTTP, all over one in-memory store with a deterministic logical clock) with its hot paths reworked for the timed workloads: cheaper pack generation and object handling on push/clone, and lower per-request overhead on the REST read/write paths. Same wire behaviour, same byte-for-byte replay; only the speed changes.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=as6c4f7t&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
