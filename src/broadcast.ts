import type { OrderEdge } from './types.ts';

type EdgeMessage = { kind: 'edge' } & Omit<OrderEdge, 'observedAt'> & { observedAt: number };

/**
 * Shares acquisition-order edges across tabs so an inversion between two
 * different tabs — not just two call sites in the same one — is still
 * caught. Only edges *this* realm observed via `wrap-request.ts` are sent;
 * edges received from elsewhere are merged locally but never re-broadcast,
 * so there's no echo.
 */
export class EdgeBroadcaster {
  private readonly channel: BroadcastChannel | undefined;

  constructor(
    ctor: typeof BroadcastChannel | undefined,
    name: string,
    onRemoteEdge: (edge: OrderEdge) => void,
  ) {
    if (!ctor) return;
    this.channel = new ctor(name);
    this.channel.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as EdgeMessage;
      if (msg && msg.kind === 'edge') {
        onRemoteEdge({ from: msg.from, to: msg.to, clientId: msg.clientId, observedAt: msg.observedAt });
      }
    };
  }

  send(edge: OrderEdge): void {
    this.channel?.postMessage({ kind: 'edge', ...edge } satisfies EdgeMessage);
  }

  close(): void {
    this.channel?.close();
  }
}
