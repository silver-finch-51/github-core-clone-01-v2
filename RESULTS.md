# Forge v2 — RESULTS

Competition: github-core-clone-01. Perf column = 4 workloads × ≤50 pts,
points = round(clamp(25 − 12.5·log2(t/T_ref), 0, 50)), t = median of 3 rounds.

T_ref (production sandbox, house reference forge, from the kit calibration file):
push 1640.8 ms · clone 266.9 ms · read 2759.7 ms · write 349.0 ms.

## Reference points

- v1 on the server (dev grade, dedicated 2-CPU pod): feature 600/600, agent 200/200,
  **perf 120/200**, placements_held false. The only lost points are perf.
- v1 code graded locally (this shared 1.5-CPU VM, process driver, Node 24, loopback,
  env and entry sharing the VM) — run "baseline-1", 2026-11-16:
  total 982, perf **182/200**, perf_p50_us 253,551.
  - push p50 565.7 ms (rounds 565.7 / 582.8 / 484.6) → 44 pts
  - clone p50 89.1 ms (rounds 146.5 / 89.1 / 49.5) → 45 pts
  - read p50 652.9 ms (rounds 735.1 / 652.9 / 628.3) → 50 pts (capped)
  - write p50 125.6 ms (rounds 182.7 / 96.5 / 125.6) → 43 pts
- Local absolute points are inflated vs the server: the calibration note records the
  same reference forge running 2.5–4.7× slower on the production cluster (gVisor +
  loaded shared nodes) than on a quiet rig. Back-solving v1's server 120 from the
  local 182 gives a geomean prod/local slowdown k ≈ 2.36, which reproduces the
  server total (est. 28.7 + 29.3 + 35.5 + 28.0 ≈ 121 ≈ 120). k is an estimate with
  per-workload error bars; what transfers is the *relative* speedup per workload:
  server points gained ≈ 12.5·log2(local speedup) per workload.
- Server 160/200 needs ≈ +40 pts ≈ a geomean 1.74× speedup over v1 across workloads
  (if spread evenly). Local targets at k≈2.36 for ~40 pts/workload on the server:
  push ≤ ~300 ms, clone ≤ ~50 ms, read ≤ ~510 ms, write ≤ ~65 ms.

## Diagnosis (code reading, before changes)

- **push** (200 sequential receive-packs, 2 HTTP reqs each): `parsePack`'s
  `inflateEntry` finds each deflate stream's length by exponential probing +
  binary search — roughly 5–15 `inflateSync` calls per object instead of 1
  (3 objects per push). Plus `storeObject` re-computes the sha1 that `parsePack`
  already computed. Ancestry/FF checks are already generation-cached (v1).
- **clone** (50 concurrent depth-1 fetches, ~3 HTTP reqs each): every fetch
  re-plans and re-deflates the identical pack (tip commit + tree + blob).
  No pack memoization anywhere.
- **read / write**: handlers are lean (Map lookups, small JSON), but every
  request pays `new URL()` parsing, an awaited body read even for bodyless
  GETs, and `sendJson` doing stringify → byteLength scan → re-encode.
  Server-side share of the round trip is small next to transport, so gains
  here are expected to be modest (10–25%).

## Changes and measurements

(appended below as they land; every grade run recorded, medians over runs)
