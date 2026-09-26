import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchLocks } from '../src/index.ts';
import type { Finding } from '../src/types.ts';
import { LockRegistry } from './mock-lock-manager.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('reports a lock held past the threshold, with how long and by whom', async () => {
  const registry = new LockRegistry();
  const locks = registry.client('holder');
  const findings: Finding[] = [];

  const sentinel = watchLocks({
    locks,
    heldTooLongMs: 30,
    pollIntervalMs: 10,
    broadcastChannelName: false,
    onFinding: (f) => findings.push(f),
  });

  const release = { current: () => {} };
  void locks.request('slow-lock', () => new Promise<void>((r) => (release.current = r)));

  await wait(150);
  release.current();
  sentinel.stop();

  const found = findings.find((f): f is Extract<Finding, { type: 'held-too-long' }> => f.type === 'held-too-long');
  assert.ok(found, `expected a held-too-long finding, got: ${JSON.stringify(findings)}`);
  assert.equal(found.name, 'slow-lock');
  assert.equal(found.clientId, 'holder');
  assert.ok(found.heldMs >= 30, `heldMs was ${found.heldMs}`);
});

test('reports a pending request that has waited unreasonably long', async () => {
  const registry = new LockRegistry();
  const holder = registry.client('holder');
  const waiter = registry.client('waiter');
  const findings: Finding[] = [];

  const sentinel = watchLocks({
    locks: waiter,
    pendingTooLongMs: 30,
    pollIntervalMs: 10,
    broadcastChannelName: false,
    onFinding: (f) => findings.push(f),
  });

  const release = { current: () => {} };
  void holder.request('contended', () => new Promise<void>((r) => (release.current = r)));
  await wait(5); // let the holder actually acquire before the waiter queues
  void waiter.request('contended', () => {});

  await wait(150);
  release.current();
  sentinel.stop();

  const found = findings.find((f): f is Extract<Finding, { type: 'pending-too-long' }> => f.type === 'pending-too-long');
  assert.ok(found, `expected a pending-too-long finding, got: ${JSON.stringify(findings)}`);
  assert.equal(found.name, 'contended');
  assert.equal(found.clientId, 'waiter');
});

test('does not report a lock released well under the threshold', async () => {
  const registry = new LockRegistry();
  const locks = registry.client('quick');
  const findings: Finding[] = [];

  const sentinel = watchLocks({
    locks,
    heldTooLongMs: 1000,
    pollIntervalMs: 10,
    broadcastChannelName: false,
    onFinding: (f) => findings.push(f),
  });

  await locks.request('fast-lock', async () => {
    await wait(20);
  });
  await wait(50);
  sentinel.stop();

  assert.equal(findings.filter((f) => f.type === 'held-too-long').length, 0);
});

test('catches a lock-order inversion within one realm before anything deadlocks', async () => {
  const registry = new LockRegistry();
  const locks = registry.client('single-tab');
  const findings: Finding[] = [];

  const sentinel = watchLocks({ locks, broadcastChannelName: false, onFinding: (f) => findings.push(f) });

  // Path A: lock1 then lock2.
  await locks.request('lock1', () => locks.request('lock2', () => {}));
  // Path B: lock2 then lock1 — the opposite order.
  await locks.request('lock2', () => locks.request('lock1', () => {}));

  sentinel.stop();

  const inversion = findings.find((f): f is Extract<Finding, { type: 'lock-order-inversion' }> => f.type === 'lock-order-inversion');
  assert.ok(inversion, `expected a lock-order-inversion finding, got: ${JSON.stringify(findings)}`);
  assert.deepEqual(inversion.cycle, ['lock2', 'lock1', 'lock2']);
  assert.equal(inversion.cycle[0], inversion.cycle[inversion.cycle.length - 1]);
});

test('does not flag two independently-ordered locks that never invert', async () => {
  const registry = new LockRegistry();
  const locks = registry.client('single-tab');
  const findings: Finding[] = [];

  const sentinel = watchLocks({ locks, broadcastChannelName: false, onFinding: (f) => findings.push(f) });

  await locks.request('lock1', () => locks.request('lock2', () => {}));
  await locks.request('lock1', () => locks.request('lock2', () => {}));
  await locks.request('lock3', () => {});

  sentinel.stop();
  assert.equal(findings.filter((f) => f.type === 'lock-order-inversion').length, 0);
});

test('catches an inversion split across two tabs via the broadcast channel', async () => {
  const registry = new LockRegistry();
  const tabA = registry.client('tab-a');
  const tabB = registry.client('tab-b');
  const channelName = `web-locks-sentinel-test-${Math.random().toString(36).slice(2)}`;
  const findingsA: Finding[] = [];
  const findingsB: Finding[] = [];

  const sentinelA = watchLocks({ locks: tabA, broadcastChannelName: channelName, onFinding: (f) => findingsA.push(f) });
  const sentinelB = watchLocks({ locks: tabB, broadcastChannelName: channelName, onFinding: (f) => findingsB.push(f) });

  await tabA.request('lockX', () => tabA.request('lockY', () => {}));
  await wait(50); // let the broadcast reach tab B before it acquires in the opposite order
  await tabB.request('lockY', () => tabB.request('lockX', () => {}));
  await wait(50);

  sentinelA.stop();
  sentinelB.stop();

  const all = [...findingsA, ...findingsB];
  const inversion = all.find((f): f is Extract<Finding, { type: 'lock-order-inversion' }> => f.type === 'lock-order-inversion');
  assert.ok(inversion, `expected a cross-tab lock-order-inversion finding, got: ${JSON.stringify(all)}`);
});

test('snapshot reports the cross-tab view of held and pending locks', async () => {
  const registry = new LockRegistry();
  const holder = registry.client('holder');
  const waiter = registry.client('waiter');

  const sentinel = watchLocks({ locks: holder, broadcastChannelName: false });

  const release = { current: () => {} };
  void holder.request('shared-name', () => new Promise<void>((r) => (release.current = r)));
  await wait(5);
  void waiter.request('shared-name', () => {});
  await wait(5);

  const snap = await sentinel.snapshot();
  release.current();
  sentinel.stop();

  assert.ok(snap.held.some((r) => r.name === 'shared-name' && r.clientId === 'holder'));
  assert.ok(snap.pending.some((r) => r.name === 'shared-name' && r.clientId === 'waiter'));
  assert.ok(typeof snap.held[0]?.heldMs === 'number');
});

test('stop() unwraps request and stops polling', async () => {
  const registry = new LockRegistry();
  const locks = registry.client('c');
  const findings: Finding[] = [];

  const sentinel = watchLocks({
    locks,
    heldTooLongMs: 20,
    pollIntervalMs: 10,
    broadcastChannelName: false,
    onFinding: (f) => findings.push(f),
  });
  sentinel.stop();

  const release = { current: () => {} };
  void locks.request('after-stop', () => new Promise<void>((r) => (release.current = r)));
  await wait(100);
  release.current();

  assert.equal(findings.length, 0);
});

test('throws when no LockManager is available', () => {
  // `navigator` is a getter-only global; override the descriptor rather than assigning.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')!;
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
  try {
    assert.throws(() => watchLocks(), /navigator\.locks/);
  } finally {
    Object.defineProperty(globalThis, 'navigator', original);
  }
});
