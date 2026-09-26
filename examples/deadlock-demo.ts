/**
 * Drives every finding this library detects against a real `navigator.locks`.
 * Node 24+ ships the Web Locks API natively, so this needs no browser — it's
 * a convenience for seeing real output quickly. The library itself targets
 * the browser; see the README for how this was verified there too.
 *
 *   node examples/deadlock-demo.ts
 */
import { watchLocks } from '../src/index.ts';
import type { Finding } from '../src/types.ts';

function describe(f: Finding): string {
  switch (f.type) {
    case 'held-too-long':
      return `held-too-long   "${f.name}" held ${f.heldMs}ms (limit ${f.thresholdMs}ms), client ${f.clientId}`;
    case 'pending-too-long':
      return `pending-too-long "${f.name}" waited ${f.waitedMs}ms (limit ${f.thresholdMs}ms), client ${f.clientId}`;
    case 'lock-order-inversion':
      return `lock-order-inversion  ${f.cycle.join(' -> ')}`;
  }
}

async function main() {
  const sentinel = watchLocks({
    heldTooLongMs: 300,
    pendingTooLongMs: 300,
    pollIntervalMs: 100,
    onFinding: (f) => console.log('  finding:', describe(f)),
  });

  console.log('\n1. A lock held past the threshold');
  let release = () => {};
  void navigator.locks.request('checkout-cart', () => new Promise<void>((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 500));
  release();

  console.log('\n2. Two call paths acquiring the same locks in opposite orders');
  await navigator.locks.request('inventory', () => navigator.locks.request('pricing', () => {}));
  await navigator.locks.request('pricing', () => navigator.locks.request('inventory', () => {}));

  console.log('\n3. A pending request that has waited unreasonably long');
  let releaseReport = () => {};
  void navigator.locks.request('report-lock', () => new Promise<void>((r) => (releaseReport = r)));
  await new Promise((r) => setTimeout(r, 50));
  void navigator.locks.request('report-lock', () => {});
  await new Promise((r) => setTimeout(r, 500));
  releaseReport();

  await new Promise((r) => setTimeout(r, 200));
  const snap = await sentinel.snapshot();
  console.log('\n4. A fresh cross-tab snapshot right before stopping');
  console.log('  held:', JSON.stringify(snap.held));
  console.log('  pending:', JSON.stringify(snap.pending));

  sentinel.stop();
}

main();
