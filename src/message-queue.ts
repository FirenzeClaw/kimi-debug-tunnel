export interface WebSocketClient {
  id: string;
  send: (data: string) => void;
}

/**
 * Lightweight WebSocket client registry + broadcast hub.
 * Replaces the previous queue-based design with a minimal pub/sub model.
 */
export class MessageQueue {
  private clients = new Map<string, WebSocketClient>();
  private broadcastCount = 0;

  registerClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** Broadcast a serialized object to all connected clients. */
  broadcastJson(payload: Record<string, unknown>): void {
    const frame = JSON.stringify(payload);
    for (const client of this.clients.values()) {
      try { client.send(frame); } catch {}
    }
    this.broadcastCount++;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getStatus(): {
    clientCount: number;
    broadcastCount: number;
  } {
    return {
      clientCount: this.clients.size,
      broadcastCount: this.broadcastCount,
    };
  }
}
