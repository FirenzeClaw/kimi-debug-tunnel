import type { WireClient } from "./wire-client.js";
import type { MessageQueue } from "./message-queue.js";

export interface TunnelServices {
  wireClient: WireClient;
  messageQueue: MessageQueue;
  startTime: number;
}
