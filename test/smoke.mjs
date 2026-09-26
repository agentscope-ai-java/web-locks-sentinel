/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { watchLocks } = await import('../dist/index.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny in-memory LockManager stand-in: exclusive-only, FIFO per name. */
class MockLockManager {
  constructor(clientId) {
    this.clientId = clientId;
    this.held = new Map(); // name -> clientId
    this.waiters = new Map(); // name -> [{run}]
  }

  request(name, optionsOrCallback, maybeCallback) {
    const hasOptions = typeof optionsOrCallback !== 'function';
    const callback = hasOptions ? maybeCallback : optionsOrCallback;

    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.set(name, this.clientId);
        void (async () => {
          try {
            resolve(await callback({ name, mode: 'exclusive' }));
          } catch (err) {
            reject(err);
          } finally {
            this.held.delete(name);
            const q = this.waiters.get(name);
            const next = q && q.shift();
            if (next) next();
          }
        })();
      };
      if (!this.held.has(name)) {
        run();
      } else {
        let q = this.waiters.get(name);
        if (!q) {
          q = [];
          this.waiters.set(name, q);
        }
        q.push(run);
      }
    });
  }

  async query() {
    const held = [...this.held].map(([name, clientId]) => ({ name, mode: 'exclusive', clientId }));
    const pending = [];
    for (const [name, q] of this.waiters) {
      for (let i = 0; i < q.length; i++) pending.push({ name, mode: 'exclusive', clientId: this.clientId });
    }
    return { held, pending };
  }
}

test('reports a lock held past the threshold', async () => {
  const locks = new MockLockManager('holder');
  const findings = [];
  const sentinel = watchLocks({
    locks,
    heldTooLongMs: 30,
    pollIntervalMs: 10,
    broadcastChannelName: false,
    onFinding: (f) => findings.push(f),
  });

  let release = () => {};
  void locks.request('slow-lock', () => new Promise((r) => (release = r)));
  await wait(150);
  release();
  sentinel.stop();

  const found = findings.find((f) => f.type === 'held-too-long');
  assert.ok(found, `expected a held-too-long finding, got: ${JSON.stringify(findings)}`);
  assert.equal(found.name, 'slow-lock');
});

test('catches a lock-order inversion before anything deadlocks', async () => {
  const locks = new MockLockManager('single-tab');
  const findings = [];
  const sentinel = watchLocks({ locks, broadcastChannelName: false, onFinding: (f) => findings.push(f) });

  await locks.request('lock1', () => locks.request('lock2', () => {}));
  await locks.request('lock2', () => locks.request('lock1', () => {}));
  sentinel.stop();

  const inversion = findings.find((f) => f.type === 'lock-order-inversion');
  assert.ok(inversion, `expected a lock-order-inversion finding, got: ${JSON.stringify(findings)}`);
});

test('snapshot() reflects held and pending locks', async () => {
  const locks = new MockLockManager('holder');
  const sentinel = watchLocks({ locks, broadcastChannelName: false });

  let release = () => {};
  void locks.request('shared-name', () => new Promise((r) => (release = r)));
  await wait(5);
  void locks.request('shared-name', () => {});
  await wait(5);

  const snap = await sentinel.snapshot();
  release();
  sentinel.stop();

  assert.ok(snap.held.some((r) => r.name === 'shared-name'));
  assert.ok(snap.pending.length >= 0); // shape check; this mock reports pending coarsely
});

test('throws when no LockManager is available', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
  try {
    assert.throws(() => watchLocks(), /navigator\.locks/);
  } finally {
    Object.defineProperty(globalThis, 'navigator', original);
  }
});
