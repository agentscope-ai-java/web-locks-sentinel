import { EdgeBroadcaster } from './broadcast.ts';
import { LockQueryPoller } from './poller.ts';
import { OrderGraph } from './order-graph.ts';
import { AcquisitionTracker } from './wrap-request.ts';
import type { CrossTabSnapshot, Finding, LockManagerLike, Sentinel, WatchLocksOptions } from './types.ts';

export type * from './types.ts';

const DEFAULTS = {
  heldTooLongMs: 5000,
  pendingTooLongMs: 15_000,
  pollIntervalMs: 1000,
  broadcastChannelName: 'web-locks-sentinel',
} as const;

/**
 * Watches `navigator.locks` for the failure modes it hides by design: a lock
 * held long enough to stall every other tab, a request that has waited long
 * enough to suggest it never will be granted, and two call paths acquiring
 * the same locks in opposite orders — a deadlock, reported the moment the
 * conflicting order is observed rather than after everything freezes.
 *
 * @example
 * ```ts
 * const sentinel = watchLocks({ heldTooLongMs: 5000, onFinding: f => console.warn(f) });
 * // ...
 * sentinel.stop();
 * ```
 */
export function watchLocks(options: WatchLocksOptions = {}): Sentinel {
  const locks = options.locks ?? (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (!locks) {
    throw new Error(
      'web-locks-sentinel: no LockManager available (navigator.locks is missing, and no `locks` option was given).',
    );
  }

  const onFinding: (finding: Finding) => void = options.onFinding ?? (() => {});
  const clientId = `sentinel:${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const graph = new OrderGraph();
  const channelName = options.broadcastChannelName ?? DEFAULTS.broadcastChannelName;
  const broadcastCtor =
    channelName === false
      ? undefined
      : (options.BroadcastChannel ?? (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel);

  const broadcaster =
    channelName === false
      ? undefined
      : new EdgeBroadcaster(broadcastCtor, channelName, (edge) => {
          const finding = graph.addEdge(edge.from, edge.to, edge.clientId, edge.observedAt);
          if (finding) onFinding(finding);
        });

  const tracker = new AcquisitionTracker(locks, (edge) => {
    const observedAt = Date.now();
    const finding = graph.addEdge(edge.from, edge.to, clientId, observedAt);
    if (finding) onFinding(finding);
    broadcaster?.send({ ...edge, clientId, observedAt });
  });
  tracker.wrap();

  const poller = new LockQueryPoller(locks, {
    heldTooLongMs: options.heldTooLongMs ?? DEFAULTS.heldTooLongMs,
    pendingTooLongMs: options.pendingTooLongMs ?? DEFAULTS.pendingTooLongMs,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
    onFinding,
  });

  return {
    stop(): void {
      poller.stop();
      tracker.unwrap();
      broadcaster?.close();
    },
    snapshot(): Promise<CrossTabSnapshot> {
      return poller.snapshot();
    },
  };
}

export default watchLocks;
