import type { Lock, LockManagerLike, LockOptionsLike, OrderEdge } from './types.ts';

/**
 * Wraps `locks.request` to observe the order in which locks are acquired.
 *
 * There is no `AsyncLocalStorage` in a browser realm, so "the same logical
 * call chain" can't be tracked precisely across `await` boundaries. Instead
 * this tracks a coarser, honest signal: the set of lock names whose callback
 * is *currently in flight* in this realm. Whenever a new `request()` call is
 * made while other locks are already held here, an edge is recorded from each
 * currently-held lock to the new one — that's exactly the shape a nested
 * "hold lock 1, then also want lock 2" call site produces, which is the
 * precondition a deadlock needs.
 *
 * The tradeoff: two genuinely unrelated features that happen to hold
 * different locks at the same moment, in the same tab, look identical to a
 * real nested acquisition. See the README for why that's an acceptable cost
 * for a diagnostic.
 */
type RequestFn = LockManagerLike['request'];

export class AcquisitionTracker {
  /** Refcounted so the same name held twice at once (shared mode) isn't dropped early. */
  private readonly held = new Map<string, number>();
  private readonly onEdge: (edge: Omit<OrderEdge, 'clientId' | 'observedAt'>) => void;
  private readonly original: RequestFn;
  private readonly locks: LockManagerLike & { request: RequestFn };

  constructor(locks: LockManagerLike, onEdge: (edge: Omit<OrderEdge, 'clientId' | 'observedAt'>) => void) {
    this.locks = locks as LockManagerLike & { request: RequestFn };
    this.onEdge = onEdge;
    this.original = locks.request.bind(locks);
  }

  /** Replaces `locks.request` with an instrumented version. Call `unwrap()` once done. */
  wrap(): void {
    const self = this;
    const instrumentedRequest: RequestFn = function (
      name: string,
      optionsOrCallback: LockOptionsLike | ((lock: Lock | null) => unknown),
      maybeCallback?: (lock: Lock | null) => unknown,
    ) {
      const hasOptions = typeof optionsOrCallback !== 'function';
      const options = hasOptions ? (optionsOrCallback as LockOptionsLike) : undefined;
      const callback = (hasOptions ? maybeCallback : optionsOrCallback) as (lock: Lock | null) => unknown;

      const release = () => {
        const count = self.held.get(name);
        if (count === undefined) return;
        if (count <= 1) self.held.delete(name);
        else self.held.set(name, count - 1);
      };

      const instrumented = (lock: Lock | null) => {
        // `ifAvailable` grants a null lock when unavailable: nothing was acquired.
        if (lock === null) return callback(lock);

        for (const other of self.held.keys()) self.onEdge({ from: other, to: name });
        self.held.set(name, (self.held.get(name) ?? 0) + 1);
        try {
          return Promise.resolve(callback(lock)).finally(release);
        } catch (err) {
          release();
          throw err;
        }
      };

      return hasOptions
        ? self.original(name, options as LockOptionsLike, instrumented)
        : self.original(name, instrumented);
    } as RequestFn;

    this.locks.request = instrumentedRequest;
  }

  /** Restores the original `request`. */
  unwrap(): void {
    this.locks.request = this.original;
  }
}
