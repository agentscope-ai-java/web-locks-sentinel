import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrderGraph } from '../src/order-graph.ts';

test('no finding for a single direction', () => {
  const graph = new OrderGraph();
  assert.equal(graph.addEdge('lock1', 'lock2', 'a', 1), undefined);
  assert.equal(graph.addEdge('lock1', 'lock2', 'a', 2), undefined);
});

test('reports a two-lock inversion the moment the opposite order is seen', () => {
  const graph = new OrderGraph();
  assert.equal(graph.addEdge('lock1', 'lock2', 'pathA', 1), undefined);
  const finding = graph.addEdge('lock2', 'lock1', 'pathB', 2);

  assert.ok(finding);
  assert.equal(finding.type, 'lock-order-inversion');
  assert.deepEqual(finding.cycle, ['lock2', 'lock1', 'lock2']);
  assert.equal(finding.edges.length, 2);
});

test('reports a longer cycle across three locks', () => {
  const graph = new OrderGraph();
  assert.equal(graph.addEdge('a', 'b', 'p1', 1), undefined);
  assert.equal(graph.addEdge('b', 'c', 'p2', 2), undefined);
  const finding = graph.addEdge('c', 'a', 'p3', 3);

  assert.ok(finding);
  assert.deepEqual(finding.cycle, ['c', 'a', 'b', 'c']);
});

test('a self-request is never an inversion', () => {
  const graph = new OrderGraph();
  assert.equal(graph.addEdge('lock1', 'lock1', 'a', 1), undefined);
});

test('does not re-report the same standing inversion', () => {
  const graph = new OrderGraph();
  graph.addEdge('lock1', 'lock2', 'a', 1);
  const first = graph.addEdge('lock2', 'lock1', 'b', 2);
  const second = graph.addEdge('lock2', 'lock1', 'b', 3);

  assert.ok(first);
  assert.equal(second, undefined);
});

test('unrelated edges do not trigger a false inversion', () => {
  const graph = new OrderGraph();
  graph.addEdge('lock1', 'lock2', 'a', 1);
  const finding = graph.addEdge('lock3', 'lock4', 'b', 2);
  assert.equal(finding, undefined);
});
