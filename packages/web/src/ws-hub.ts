/**
 * WebSocket hub for broadcasting real-time updates to connected clients.
 * Channels: build, entities, logs, deploy
 */

export type WSChannel = 'build' | 'entities' | 'logs' | 'deploy';

export interface WSMessage {
  channel: WSChannel;
  event: string;
  data: unknown;
}

export interface WSClient {
  send(data: string): void;
  close(): void;
  readyState: number;
}

const OPEN = 1;

export class WSHub {
  private clients = new Map<WSChannel, Set<WSClient>>();

  constructor() {
    this.clients.set('build', new Set());
    this.clients.set('entities', new Set());
    this.clients.set('logs', new Set());
    this.clients.set('deploy', new Set());
  }

  subscribe(channel: WSChannel, client: WSClient): () => void {
    const channelSet = this.clients.get(channel);
    if (channelSet) {
      channelSet.add(client);
    }

    return () => {
      channelSet?.delete(client);
    };
  }

  broadcast(channel: WSChannel, event: string, data: unknown): void {
    const message: WSMessage = { channel, event, data };
    const payload = JSON.stringify(message);
    const channelSet = this.clients.get(channel);

    if (!channelSet) return;

    for (const client of channelSet) {
      if (client.readyState === OPEN) {
        try {
          client.send(payload);
        } catch {
          channelSet.delete(client);
        }
      } else {
        channelSet.delete(client);
      }
    }
  }

  getClientCount(channel: WSChannel): number {
    return this.clients.get(channel)?.size ?? 0;
  }

  closeAll(): void {
    for (const [, clients] of this.clients) {
      for (const client of clients) {
        try { client.close(); } catch { /* ignore */ }
      }
      clients.clear();
    }
  }
}
