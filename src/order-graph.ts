import type { LockOrderInversionFinding, OrderEdge } from './types.ts';

/**
 * A directed graph of "lock `from` was already held when `to` was requested"
 * edges. An inversion is a cycle: some path already leads from `to` back to
 * `from`, so adding `from -> to` closes the loop. That loop is exactly the
 * shape a real deadlock needs — two (or more) paths wanting the same locks in
 * opposite orders — and it's visible the instant the second order is
 * observed, without either path ever actually stalling.
 *
 * Reported cycles are deduplicated by their sorted node set, so a standing
 * inversion between the same locks doesn't re-fire on every acquisition.
 */
export class OrderGraph {
  private readonly edges = new Map<string, Map<string, OrderEdge>>();
  private readonly reported = new Set<string>();

  /** Add an edge; returns a finding if it closes a cycle with existing edges. */
  addEdge(from: string, to: string, clientId: string, observedAt: number): LockOrderInversionFinding | undefined {
    if (from === to) return undefined;

    const existing = this.edges.get(from)?.get(to);
    if (!existing) {
      let out = this.edges.get(from);
      if (!out) {
        out = new Map();
        this.edges.set(from, out);
      }
      out.set(to, { from, to, clientId, observedAt });
    }

    // A path already exists from `to` back to `from`; adding `from -> to`
    // closes it into a loop: from -> to -> ... -> from.
    const back = this.findPath(to, from);
    if (!back) return undefined;

    const cycle = [from, ...back];
    const key = [...new Set(cycle)].sort().join('\u0000');
    if (this.reported.has(key)) return undefined;
    this.reported.add(key);

    const edges: OrderEdge[] = [{ from, to, clientId, observedAt }];
    for (let i = 0; i < back.length - 1; i++) {
      const edge = this.edges.get(back[i]!)?.get(back[i + 1]!);
      if (edge) edges.push(edge);
    }

    return { type: 'lock-order-inversion', cycle, edges };
  }

  /** Breadth-first search for a path from `start` to `goal`, `start` included. */
  private findPath(start: string, goal: string): string[] | undefined {
    if (start === goal) return [start];
    const seen = new Set([start]);
    const queue: string[][] = [[start]];
    while (queue.length > 0) {
      const path = queue.shift()!;
      const last = path[path.length - 1]!;
      for (const next of this.edges.get(last)?.keys() ?? []) {
        if (next === goal) return [...path, next];
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push([...path, next]);
      }
    }
    return undefined;
  }
}
