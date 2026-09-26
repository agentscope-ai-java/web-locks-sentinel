# web-locks-sentinel

Diagnostics for `navigator.locks`: a lock held long enough to stall every
other tab, two code paths acquiring the same locks in opposite orders — a
deadlock, caught the moment the conflicting order is observed rather than
after everything freezes — and a live cross-tab view of who holds what.

## The problem

The [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
(`navigator.locks`) coordinates work across tabs of the same origin — one
tab elects itself leader, another waits its turn to write to IndexedDB, and
so on. Its failure modes are invisible by design:

- **A lock held too long stalls every other tab waiting on it**, and nothing
  tells you which lock, which tab, or for how long. You find out when a user
  reports the app "just hangs."
- **Two code paths that acquire the same two locks in opposite orders can
  deadlock permanently**, with no error, no stack trace, no rejected
  promise — both `request()` calls just never resolve. DevTools' Application
  panel shows you the two stuck requests *after* it happens; it doesn't warn
  you the two orders exist before they collide.

`navigator.locks.query()` already exposes every held and pending lock across
every tab and worker on the origin — it's the mechanism the first two
diagnostics need — but nothing polls it, and nothing at all watches the
*order* locks are acquired in, which is what the third one needs.

### The obvious fixes don't cover this

Every existing package we found in this space — `navigator.locks` (aermin's
polyfill), `disposable-lock`, `web-locks-polyfill`, `using-mutex`,
`cross-tab-kit` — is an **ergonomic wrapper** around `request()`: promise
sugar, a disposable/`using` pattern, or a polyfill for browsers that predate
the native API. None of them call `query()`, and none of them track
acquisition order — a `grep -r query` and `grep -r deadlock` across all five
packages' published sources comes back empty. They make acquiring a lock
nicer to write; they don't tell you anything went wrong.

## Install

```sh
npm install web-locks-sentinel
```

Requires a browser (or Node 24+, which now ships `navigator.locks` natively)
with `navigator.locks`. `query()` — needed for the held/pending/cross-tab
checks — has been Baseline widely-available since March 2022; order-inversion
detection alone only needs `request()`, which is older still.

## Use

```ts
import { watchLocks } from 'web-locks-sentinel';

const sentinel = watchLocks({ heldTooLongMs: 5000, onFinding: (f) => console.warn(f) });

// ... your app runs, using navigator.locks.request() as normal ...

sentinel.stop();
```

`watchLocks` does two things simultaneously:

1. **Polls `navigator.locks.query()`** (default every second) to catch a lock
   held, or a request pending, longer than a threshold — across every tab,
   since `query()` already reports the whole origin, not just this one.
2. **Wraps `navigator.locks.request`** to notice when one lock is requested
   while another is already held in the same realm, building a directed
   graph of "lock A was held when B was requested" edges. The moment an edge
   closes a cycle with an edge observed elsewhere — the same two locks
   wanted in the opposite order — that's a lock-order inversion: the
   precondition every deadlock needs, reported before anything stalls.

```ts
sentinel.snapshot(); // -> Promise<{ held: [...], pending: [...] }>, with heldMs/waitedMs
```

### Findings

```ts
{ type: 'held-too-long', name, mode, clientId, heldMs, thresholdMs }
{ type: 'pending-too-long', name, mode, clientId, waitedMs, thresholdMs }
{ type: 'lock-order-inversion', cycle: ['lock1', 'lock2', 'lock1'], edges: [...] }
```

`cycle` lists the lock names in the order that closes the loop
(`cycle[0] === cycle[cycle.length - 1]`); it isn't always two locks — three
or more call sites can chain into a longer cycle, and this is detected the
same way.

## Options

| Option | Default | What it controls |
| --- | --- | --- |
| `heldTooLongMs` | `5000` | Report a held lock once it's been held this long. |
| `pendingTooLongMs` | `15000` | Report a pending request once it's waited this long — the observable symptom of a real deadlock. |
| `pollIntervalMs` | `1000` | How often `query()` is polled. |
| `onFinding` | — | Called for every finding, as soon as it's detected. |
| `broadcastChannelName` | `'web-locks-sentinel'` | Shares observed acquisition order across tabs via `BroadcastChannel`, so an inversion split across two tabs is still caught. Pass `false` to keep it local to this realm. |
| `locks` | `navigator.locks` | Override for testing, or a non-`navigator` host. |

## Why order-inversion detection works the way it does

There's no `AsyncLocalStorage` in a browser realm to track "the same logical
call chain" across `await` boundaries. This library uses a coarser, honestly
documented signal instead: the set of lock names whose `request()` callback
is *currently in flight* in this realm. Requesting `lock2` while `lock1`'s
callback hasn't returned yet records an edge `lock1 -> lock2` — exactly the
shape a real nested "hold this, then also want that" call site produces,
which is what a deadlock needs.

The tradeoff: two entirely unrelated features that happen to hold different
locks at the same moment, in the same tab, look identical to a real nested
acquisition. A reported inversion is worth investigating, not a certainty
that a live deadlock exists — but it's exactly the kind of thing you want a
false-positive-tolerant warning for, since the alternative is finding out
after two tabs have already frozen.

## What it does not do

- **It doesn't fix anything.** Purely diagnostic — it never denies, delays,
  or reorders a lock request.
- **Cross-tab order-inversion detection only sees tabs also running this
  library** (with the same `broadcastChannelName`). A tab that acquires
  locks without `watchLocks()` running is invisible to inversion detection,
  though its held/pending locks still show up in `query()`-based findings
  and `snapshot()` regardless.
- **It doesn't disambiguate multiple concurrent requests for the same
  `(name, mode, clientId)`.** `query()` doesn't hand back a per-request id,
  so two overlapping shared-mode holds by the same client collapse into one
  tracked instance.
- **No stealing detection, no priority inspection.** `steal` and `signal`
  pass straight through to the real `request()`; the sentinel only observes.

## Develop

```sh
node --test "test/*.test.ts"    # unit suite, mocks navigator.locks (Node has no such API)
npm run demo                    # node examples/deadlock-demo.ts — Node 24+ ships navigator.locks

npm run build && npm run test:dist   # what CI runs against node 20 and 22
```

### Verification

`navigator.locks` doesn't exist in Node before v24 and isn't implemented by
jsdom at all, so the unit suite above runs against an in-memory mock
(`test/mock-lock-manager.ts`) — it proves the detection *logic* (cycle
detection, threshold sweeps, dedup) but not the real API's behavior.

The library was additionally verified against a real browser: headless
Chrome, launched with `--remote-debugging-port` and driven over the
DevTools Protocol from a Node script (two tabs, for the cross-tab checks).
Real output from that run:

```
PASS: navigator.locks exists with request/query in real Chrome
PASS: held-too-long detected in real Chrome
  {"type":"held-too-long","name":"long-lock","heldMs":301,"thresholdMs":300,...}
PASS: pending-too-long detected in real Chrome
  {"type":"pending-too-long","name":"contended-lock","waitedMs":301,"thresholdMs":300,...}
PASS: lock-order-inversion detected in real Chrome (single tab)
  {"type":"lock-order-inversion","cycle":["order-b","order-a","order-b"],...}
PASS: cross-tab lock-order-inversion detected via BroadcastChannel in real Chrome
PASS: tab B's snapshot() sees a lock held by tab A (query() is partition-wide)
  [{"name":"cross-view-lock","mode":"exclusive","clientId":"71EAC03FABF368F907227C2920AB7D8E","heldMs":208}]

ALL BROWSER CHECKS PASSED
```

`examples/deadlock-demo.ts` produces the same findings against Node 24's
native `navigator.locks`, for a quick look without a browser:

```
1. A lock held past the threshold
  finding: held-too-long   "checkout-cart" held 301ms (limit 300ms), client node-52156-0

2. Two call paths acquiring the same locks in opposite orders
  finding: lock-order-inversion  pricing -> inventory -> pricing

3. A pending request that has waited unreasonably long
  finding: held-too-long   "report-lock" held 307ms (limit 300ms), client node-52156-0
  finding: pending-too-long "report-lock" waited 306ms (limit 300ms), client node-52156-0
```

## License

MIT
