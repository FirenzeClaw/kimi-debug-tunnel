import { randomUUID } from "node:crypto";

export interface TunnelMessage {
  id: string;
  type: "command" | "response" | "system";
  content: string;
  timestamp: string;
  sessionId?: string;
  clientId?: string;
}

export interface WebSocketClient {
  id: string;
  send: (data: string) => void;
}

export class MessageQueue {
  private incomingMessages: TunnelMessage[] = [];
  private responseMessages: TunnelMessage[] = [];
  private clients: Map<string, WebSocketClient> = new Map();

  enqueueIncoming(content: string, clientId?: string, sessionId?: string): TunnelMessage {
    const msg: TunnelMessage = {
      id: randomUUID(),
      type: "command",
      content,
      timestamp: new Date().toISOString(),
      sessionId,
      clientId,
    };
    this.incomingMessages.push(msg);
    return msg;
  }

  dequeueIncoming(): TunnelMessage | undefined {
    return this.incomingMessages.shift();
  }

  pollIncoming(limit = 10): TunnelMessage[] {
    return this.incomingMessages.splice(0, limit);
  }

  enqueueResponse(content: string, inReplyTo?: string): TunnelMessage {
    const msg: TunnelMessage = {
      id: randomUUID(),
      type: "response",
      content,
      timestamp: new Date().toISOString(),
    };
    this.responseMessages.push(msg);

    for (const client of this.clients.values()) {
      client.send(JSON.stringify(msg));
    }

    return msg;
  }

  dequeueResponse(): TunnelMessage | undefined {
    return this.responseMessages.shift();
  }

  registerClient(client: WebSocketClient): void {
    this.clients.set(client.id, client);
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getIncomingCount(): number {
    return this.incomingMessages.length;
  }

  getResponseCount(): number {
    return this.responseMessages.length;
  }

  getStatus(): {
    clientCount: number;
    incomingQueueLength: number;
    responseQueueLength: number;
  } {
    return {
      clientCount: this.clients.size,
      incomingQueueLength: this.incomingMessages.length,
      responseQueueLength: this.responseMessages.length,
    };
  }
}

export const messageQueue = new MessageQueue();
