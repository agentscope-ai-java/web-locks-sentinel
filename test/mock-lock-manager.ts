import type { Lock, LockManagerLike, LockMode, LockOptionsLike, LockRecord } from '../src/types.ts';

interface QueueItem {
  name: string;
  mode: LockMode;
  clientId: string;
  grant: () => void;
}

/**
 * A minimal, faithful-enough in-memory stand-in for `navigator.locks`, since
 * neither Node nor jsdom implements the Web Locks API. FIFO per lock name,
 * exclusive/shared modes, `ifAvailable`. Several `MockLockManager`s created
 * from the same `LockRegistry` simulate several tabs sharing one origin —
 * `query()` on any of them sees every client's held and pending locks, the
 * way the real API's is scoped to the storage partition, not one tab.
 */
export class LockRegistry {
  private heldExclusive = new Map<string, string>();
  private heldShared = new Map<string, Set<string>>();
  private waiters = new Map<string, QueueItem[]>();

  client(clientId: string = `client-${Math.random().toString(36).slice(2)}`): MockLockManager {
    return new MockLockManager(this, clientId);
  }

  canGrant(name: string, mode: LockMode): boolean {
    if (this.heldExclusive.has(name)) return false;
    if (mode === 'exclusive') return !this.heldShared.get(name)?.size;
    return true;
  }

  acquire(name: string, mode: LockMode, clientId: string): void {
    if (mode === 'exclusive') {
      this.heldExclusive.set(name, clientId);
      return;
    }
    let set = this.heldShared.get(name);
    if (!set) {
      set = new Set();
      this.heldShared.set(name, set);
    }
    set.add(clientId);
  }

  release(name: string, mode: LockMode, clientId: string): void {
    if (mode === 'exclusive') this.heldExclusive.delete(name);
    else this.heldShared.get(name)?.delete(clientId);
    this.pump(name);
  }

  enqueue(item: QueueItem): void {
    let q = this.waiters.get(item.name);
    if (!q) {
      q = [];
      this.waiters.set(item.name, q);
    }
    q.push(item);
  }

  private pump(name: string): void {
    const q = this.waiters.get(name);
    if (!q) return;
    while (q.length > 0) {
      const next = q[0]!;
      if (!this.canGrant(name, next.mode)) break;
      q.shift();
      this.acquire(name, next.mode, next.clientId);
      next.grant();
      if (next.mode === 'exclusive') break;
    }
  }

  query(): { held: LockRecord[]; pending: LockRecord[] } {
    const held: LockRecord[] = [];
    for (const [name, clientId] of this.heldExclusive) held.push({ name, mode: 'exclusive', clientId });
    for (const [name, set] of this.heldShared) {
      for (const clientId of set) held.push({ name, mode: 'shared', clientId });
    }
    const pending: LockRecord[] = [];
    for (const q of this.waiters.values()) {
      for (const item of q) pending.push({ name: item.name, mode: item.mode, clientId: item.clientId });
    }
    return { held, pending };
  }
}

export class MockLockManager implements LockManagerLike {
  readonly clientId: string;
  private readonly registry: LockRegistry;

  constructor(registry: LockRegistry, clientId: string) {
    this.registry = registry;
    this.clientId = clientId;
  }

  request(
    name: string,
    optionsOrCallback: LockOptionsLike | ((lock: Lock | null) => unknown),
    maybeCallback?: (lock: Lock | null) => unknown,
  ): Promise<unknown> {
    const hasOptions = typeof optionsOrCallback !== 'function';
    const options: LockOptionsLike = hasOptions ? (optionsOrCallback as LockOptionsLike) : {};
    const callback = (hasOptions ? maybeCallback : optionsOrCallback) as (lock: Lock | null) => unknown;
    const mode: LockMode = options.mode ?? 'exclusive';

    return new Promise((resolve, reject) => {
      const run = (): void => {
        void (async () => {
          const lock: Lock = { name, mode };
          try {
            resolve(await callback(lock));
          } catch (err) {
            reject(err);
          } finally {
            this.registry.release(name, mode, this.clientId);
          }
        })();
      };

      if (this.registry.canGrant(name, mode)) {
        this.registry.acquire(name, mode, this.clientId);
        run();
        return;
      }
      if (options.ifAvailable) {
        void Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      this.registry.enqueue({ name, mode, clientId: this.clientId, grant: run });
    });
  }

  async query(): Promise<{ held: LockRecord[]; pending: LockRecord[] }> {
    return this.registry.query();
  }
}
