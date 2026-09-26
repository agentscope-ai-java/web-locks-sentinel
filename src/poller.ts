import type {
  CrossTabSnapshot,
  Finding,
  LockManagerLike,
  LockMode,
  LockRecord,
} from './types.ts';

interface Tracked {
  firstSeen: number;
  reported: boolean;
}

/** `name|mode|clientId` — as fine-grained an identity as `query()` gives us. */
function keyOf(r: LockRecord): string {
  return `${r.name}\u0000${r.mode}\u0000${r.clientId}`;
}

/**
 * Polls `navigator.locks.query()` to catch what a single acquisition never
 * shows: a lock still held long after it should have been released, and a
 * request that has been waiting long enough to suggest it never will be.
 *
 * `query()` already reports across every tab and worker sharing this origin,
 * so this is the cross-tab view for free — no `BroadcastChannel` needed for
 * this half of the library.
 */
export class LockQueryPoller {
  private readonly locks: LockManagerLike;
  private readonly heldTooLongMs: number;
  private readonly pendingTooLongMs: number;
  private readonly onFinding: (finding: Finding) => void;
  private readonly heldSeen = new Map<string, Tracked>();
  private readonly pendingSeen = new Map<string, Tracked>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    locks: LockManagerLike,
    opts: { heldTooLongMs: number; pendingTooLongMs: number; pollIntervalMs: number; onFinding: (finding: Finding) => void },
  ) {
    this.locks = locks;
    this.heldTooLongMs = opts.heldTooLongMs;
    this.pendingTooLongMs = opts.pendingTooLongMs;
    this.onFinding = opts.onFinding;
    if (typeof this.locks.query === 'function') {
      this.timer = setInterval(() => void this.tick(), opts.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** A fresh snapshot, independent of the polling cadence. */
  async snapshot(): Promise<CrossTabSnapshot> {
    const now = Date.now();
    const { held, pending } = await this.query();
    return {
      held: held.map((r) => ({ ...r, heldMs: now - (this.heldSeen.get(keyOf(r))?.firstSeen ?? now) })),
      pending: pending.map((r) => ({ ...r, waitedMs: now - (this.pendingSeen.get(keyOf(r))?.firstSeen ?? now) })),
    };
  }

  private async query(): Promise<{ held: LockRecord[]; pending: LockRecord[] }> {
    const result = (await this.locks.query?.()) ?? {};
    return {
      held: (result.held ?? []).map(normalize),
      pending: (result.pending ?? []).map(normalize),
    };
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const { held, pending } = await this.query();
    sweep(this.heldSeen, held, now, this.heldTooLongMs, (r, waitedMs) =>
      this.onFinding({ type: 'held-too-long', name: r.name, mode: r.mode, clientId: r.clientId, heldMs: waitedMs, thresholdMs: this.heldTooLongMs }),
    );
    sweep(this.pendingSeen, pending, now, this.pendingTooLongMs, (r, waitedMs) =>
      this.onFinding({ type: 'pending-too-long', name: r.name, mode: r.mode, clientId: r.clientId, waitedMs, thresholdMs: this.pendingTooLongMs }),
    );
  }
}

function normalize(r: LockRecord): LockRecord {
  return { name: r.name, mode: (r.mode ?? 'exclusive') as LockMode, clientId: r.clientId };
}

/** Tracks first-seen times for a poll's rows, reporting once per threshold crossing. */
function sweep(
  seen: Map<string, Tracked>,
  rows: LockRecord[],
  now: number,
  thresholdMs: number,
  report: (row: LockRecord, elapsedMs: number) => void,
): void {
  const present = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    present.add(key);
    let tracked = seen.get(key);
    if (!tracked) {
      tracked = { firstSeen: now, reported: false };
      seen.set(key, tracked);
    }
    const elapsed = now - tracked.firstSeen;
    if (!tracked.reported && elapsed >= thresholdMs) {
      tracked.reported = true;
      report(row, elapsed);
    }
  }
  // Anything that dropped out of this poll is gone (released, or granted); a
  // future reappearance of the same name/mode/clientId is a fresh instance.
  for (const key of seen.keys()) {
    if (!present.has(key)) seen.delete(key);
  }
}
