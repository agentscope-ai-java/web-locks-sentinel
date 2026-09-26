/** A held or pending lock, as reported by a single `navigator.locks.query()` poll. */
export interface LockRecord {
  name: string;
  mode: LockMode;
  clientId: string;
}

export type LockMode = 'exclusive' | 'shared';

/** A lock held past `heldTooLongMs`. Stalls every other tab waiting on it. */
export interface HeldTooLongFinding {
  type: 'held-too-long';
  name: string;
  mode: LockMode;
  clientId: string;
  heldMs: number;
  thresholdMs: number;
}

/** A pending request that has waited past `pendingTooLongMs` — the observable
 * symptom of an actual deadlock, or of a lock simply held too long. */
export interface PendingTooLongFinding {
  type: 'pending-too-long';
  name: string;
  mode: LockMode;
  clientId: string;
  waitedMs: number;
  thresholdMs: number;
}

/** One acquisition edge that fed a reported inversion: lock `from` was already
 * held (by `clientId`, in that realm) when `to` was requested. */
export interface OrderEdge {
  from: string;
  to: string;
  clientId: string;
  observedAt: number;
}

/**
 * Two or more locks acquired in conflicting orders. `cycle` lists the lock
 * names in the order that closes the loop (`cycle[0] === cycle[cycle.length - 1]`).
 * This is a necessary precondition for a deadlock, reported the moment the
 * conflicting order is *observed* — before anything actually stalls.
 */
export interface LockOrderInversionFinding {
  type: 'lock-order-inversion';
  cycle: string[];
  edges: OrderEdge[];
}

export type Finding = HeldTooLongFinding | PendingTooLongFinding | LockOrderInversionFinding;

/** A point-in-time cross-tab view of `navigator.locks.query()`, with how long
 * each entry has been in that state. */
export interface CrossTabSnapshot {
  held: Array<LockRecord & { heldMs: number }>;
  pending: Array<LockRecord & { waitedMs: number }>;
}

/** The subset of `LockManager` this library depends on — matches `navigator.locks`. */
export interface LockManagerLike {
  request(name: string, callback: (lock: Lock | null) => Promise<unknown> | unknown): Promise<unknown>;
  request(
    name: string,
    options: LockOptionsLike,
    callback: (lock: Lock | null) => Promise<unknown> | unknown,
  ): Promise<unknown>;
  query?(): Promise<{ held?: LockRecord[]; pending?: LockRecord[] }>;
}

export interface LockOptionsLike {
  mode?: LockMode;
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

/** Minimal shape of the `Lock` a granted callback receives. */
export interface Lock {
  name: string;
  mode: LockMode;
}

export interface WatchLocksOptions {
  /** Report a held lock once it has been held longer than this. Default 5000. */
  heldTooLongMs?: number;
  /** Report a pending request once it has waited longer than this. Default 15000. */
  pendingTooLongMs?: number;
  /** How often to poll `navigator.locks.query()`. Default 1000. */
  pollIntervalMs?: number;
  /** Called for every finding, as soon as it's detected. */
  onFinding?: (finding: Finding) => void;
  /**
   * Name of the `BroadcastChannel` used to share acquisition order across tabs,
   * so an inversion between two different tabs is still caught. Pass `false` to
   * keep detection local to this realm only. Default `'web-locks-sentinel'`.
   */
  broadcastChannelName?: string | false;
  /** Defaults to `navigator.locks`. Override for testing or non-browser hosts. */
  locks?: LockManagerLike;
  /** Defaults to the global `BroadcastChannel` constructor, when present. */
  BroadcastChannel?: typeof BroadcastChannel;
}

export interface Sentinel {
  /** Stops polling, un-wraps `locks.request`, and closes the broadcast channel. */
  stop(): void;
  /** A fresh cross-tab view: who holds what, who is waiting, and for how long. */
  snapshot(): Promise<CrossTabSnapshot>;
}
