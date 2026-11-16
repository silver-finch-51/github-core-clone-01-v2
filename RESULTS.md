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

All runs: full local grade (grade-local, process driver). Feature stayed
**600/600** and agent **200/200** in every run below — no conformance regression.

### Change 1 — pack receive path (git.ts, githttp.ts), commit c5bb8fa

- `inflateEntry`: one `inflateSync(..., {info: true})` per object; the stream
  length comes from the zlib engine's `bytesWritten` instead of ~5–15 probing
  inflates. The probing code remains as a fallback if the info path ever fails.
- `storeObjectAt`: receive-pack stores pack objects under the sha `parsePack`
  already computed instead of hashing every object a second time.

Runs (p50 ms per workload):
| run | push | clone | read | write | perf | perf_p50_us |
|---|---|---|---|---|---|---|
| inflate-1 | 386.4 | 128.4 | 639.5 | 99.1 | 186 | 236,785 |
| inflate-2 | 390.2 | 113.3 | 823.4 | 112.5 | 182 | 252,980 |

push 565.7 → ~388 median (**1.46×**, all 6 rounds below every baseline round).
write drifted down too (shared request path unaffected — mostly VM noise).
clone/read unchanged within noise (neither touches pack parsing).

### Change 2 — fetch pack memo + request path (store.ts, githttp.ts, app.ts, http.ts), commit 84d73f8

- `fetchResponse` memoizes pack bytes per repo, keyed by the plan's object-sha
  list (immutable objects + deterministic writer ⇒ byte-identical hits; cache
  bounded at 64 entries). The clone benchmark's 50 identical depth-1 fetches
  now deflate once.
- The v2 capability advertisement is a module-level constant instead of being
  rebuilt per request.
- `app.ts`: request URLs are split by hand (WHATWG parser kept as fallback for
  absolute-form / dot-segment / fragment URLs); bodyless requests skip the
  awaited body read.
- `http.ts` `sendJson`: encodes the body to a Buffer once (was: stringify →
  byteLength scan → re-encode on end).

Runs (p50 ms per workload):
| run | push | clone | read | write | perf | perf_p50_us |
|---|---|---|---|---|---|---|
| reqpath-1 | 342.9 | 111.4 | 691.1 | 93.9 | 190 | 223,103 |
| reqpath-2 | 366.2 | 80.9 | 528.8 | 82.0 | 197 | 189,313 |
| reqpath-3 | 331.5 | 121.5 | 709.6 | 113.7 | 183 | 238,743 |
| reqpath-4 | 286.1 | 95.6 | 684.1 | 103.5 | 191 | 209,796 |
| reqpath-5 | 302.0 | 99.5 | 547.9 | 88.5 | 193 | 195,338 |

### Final local medians (5 runs of the final code) vs the v1 baseline run

| workload | v1 baseline p50 | v2 median p50 | speedup |
|---|---|---|---|
| push | 565.7 ms | 331.5 ms | **1.71×** (clean round separation) |
| clone | 89.1 ms | 99.5 ms | not measurable — baseline was a single run inside the same noise band (rounds 49–147 ms vs 47–202 ms) |
| read | 652.9 ms | 684.1 ms | not measurable — same noise band |
| write | 125.6 ms | 93.9 ms | **1.34×** (all 5 run-medians below the baseline median) |

Local perf total: median 191/200 (baseline 182) — locally the push gain is
hidden by the 50-pt per-workload cap. perf_p50_us (the tie-break): 253,551 →
median 209,796 (−17%).

Dead ends / not attempted, honestly:
- read and clone did not move measurably on this VM: both are dominated by
  transport + the env client sharing the same 1.5 CPUs under the process
  driver, and the remaining server-side work per request is already a few
  small object builds. The request-path opts may still pay off on the server
  (dedicated pod, gVisor syscall costs), but that is an inference, not a
  measurement.
- No Node flags are available (the grader runs `node /bot/main.ts` directly),
  no dependencies may be added (stdlib only), and main.ts is fixed by the
  rules — the remaining levers were all in the code paths above.

## Bottom line (honest)

Transferring the measured per-workload speedups to the server with the
k≈2.36 mapping that reproduces v1's server 120/200 from its local numbers
(server points ≈ v1's per-workload estimate + 12.5·log2(speedup)):

- push ≈ 29 → ~38 (+9), write ≈ 28 → ~33 (+5), read ≈ 35 (unchanged locally;
  maybe +1–2 from the request-path opts), clone ≈ 29 (pack memo unproven
  locally; maybe +0–4 under the server's dedicated CPU).
- **Expected server perf ≈ 135–141/200, total ≈ 935–941/1000** (v1: 920),
  with feature 600/600 and agent 200/200 intact. The gain is ≈ +15–20 points,
  not the +40 that a 160 perf column would need — the remaining points sit in
  transport- and client-bound workloads that stdlib server code cannot move
  much further.
- **placements_held: unlikely to flip.** The finals take the top 60 of ~5,460
  entries; v1 at 920 held no place, and ~935–941 is only ~2% higher. This v2
  is a strictly better entry than v1 (same features, faster push/write, lower
  tie-break latency), worth submitting as a new round — but it should be
  entered as a points improvement, not as a likely prize winner.
