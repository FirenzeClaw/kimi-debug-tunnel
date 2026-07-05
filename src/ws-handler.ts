import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { TunnelServices } from "./types.js";
import type { WebSocketClient } from "./message-queue.js";
import type { TurnPromptResponse } from "./wire-client.js";

export function mountWebSocketHandler(
  wss: WebSocketServer,
  services: TunnelServices
): void {
  const { wireClient, messageQueue } = services;

  wss.on("connection", (ws: WebSocket) => {
    const clientId = randomUUID();
    const client: WebSocketClient = {
      id: clientId,
      send: (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      },
    };

    messageQueue.registerClient(client);

    ws.send(
      JSON.stringify({
        type: "system",
        content: `Connected. Client ID: ${clientId}`,
        clientId,
        wireConnected: wireClient.isConnected(),
        timestamp: new Date().toISOString(),
      })
    );

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === "command" && data.content) {
          if (data.sessionId) {
            wireClient.setSessionId(data.sessionId);
          }
          wireClient
            .sendPrompt(data.content, {
              includeThinking: data.include_thinking || false,
            })
            .then((response: TurnPromptResponse) => {
              ws.send(
                JSON.stringify({
                  type: "response",
                  id: randomUUID(),
                  content: response.finalText,
                  status: response.status,
                  promptId: response.promptId,
                  timestamp: new Date().toISOString(),
                })
              );
            })
            .catch((err: Error) => {
              ws.send(
                JSON.stringify({
                  type: "error",
                  content: err.message,
                  timestamp: new Date().toISOString(),
                })
              );
            });
        }
      } catch {
        ws.send(
          JSON.stringify({
            type: "error",
            content: "Invalid message format",
            timestamp: new Date().toISOString(),
          })
        );
      }
    });

    ws.on("close", () => {
      messageQueue.unregisterClient(clientId);
    });

    ws.on("error", () => {
      messageQueue.unregisterClient(clientId);
    });
  });
}
