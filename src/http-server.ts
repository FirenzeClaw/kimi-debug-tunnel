import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { TunnelServices } from "./types.js";
import type { WebSocketClient } from "./message-queue.js";
import { randomUUID } from "node:crypto";

export function startHttpServer(port: number, services: TunnelServices): void {
  const { wireClient, messageQueue } = services;
  const app = express();
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  // Suppress WebSocketServer crash when HTTP port is already in use
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") {
      throw err;
    }
  });

  app.use(express.json());

  // CORS: allow cross-origin requests from Kimi Web UI (any localhost port)
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // REST API: execute prompt directly via Wire protocol (push-based)
  app.post("/api/execute", async (req, res) => {
    const { prompt, timeout_ms, include_thinking } = req.body;

    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing or invalid 'prompt' field" });
      return;
    }

    if (!wireClient.isConnected()) {
      res.status(503).json({
        error: "Wire client not connected",
        hint: "Start Kimi server: kimi web --no-open. Set KIMI_SERVER_TOKEN if needed.",
      });
      return;
    }

    try {
      const sid = wireClient.getPmSessionId();
      if (!sid) {
        res.status(400).json({ error: "No session selected. Use create_session or list_sessions first." });
        return;
      }
      const response = await wireClient.sendPrompt(sid, prompt, {
        timeoutMs: timeout_ms || 300000,
        includeThinking: include_thinking || false,
      });

      res.json({
        success: true,
        promptId: response.promptId,
        status: response.status,
        response: response.finalText,
        thinkingAvailable: response.thinkingText.length > 0,
        messageCount: response.messages.length,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: (err as Error).message,
      });
    }
  });

  // REST API: tunnel status (now includes wire client status)
  app.get("/api/status", (_req, res) => {
    res.json({
      ...messageQueue.getStatus(),
      wireConnected: wireClient.isConnected(),
      version: "2.0.0",
    });
  });

  // REST API: orchestration relationships (PM → child sessions)
  app.get("/api/orchestrations", (_req, res) => {
    if (!wireClient.isConnected()) {
      res.status(503).json({ error: "Wire client not connected" });
      return;
    }
    const store = services.orchestrationStore;
    const orchestrations = store ? store.getAll() : [];
    res.json({ orchestrations });
  });

  // REST API: get Kimi Server token (localhost only)
  app.get("/api/token", (req, res) => {
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    if (!req.ip || !loopback.includes(req.ip)) {
      res.status(403).json({ error: "Access restricted to localhost" });
      return;
    }
    const token = process.env.KIMI_SERVER_TOKEN;
    if (!token) {
      res.status(404).json({ error: "KIMI_SERVER_TOKEN not configured" });
      return;
    }
    res.json({ token });
  });

  // WebSocket handling
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
          // Direct execute via Wire if connected
          if (wireClient.isConnected() && data.execute_direct !== false) {
            const sid = wireClient.getPmSessionId();
            if (!sid) {
              ws.send(JSON.stringify({ type: "error", content: "No session selected", timestamp: new Date().toISOString() }));
              return;
            }
            wireClient
              .sendPrompt(sid, data.content, {
                includeThinking: data.include_thinking || false,
              })
              .then((response) => {
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
              .catch((err) => {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    content: err.message,
                    timestamp: new Date().toISOString(),
                  })
                );
              });
          } else {
            // wireClient not connected — ignore incoming commands
          }
        }
      } catch {
        // Unparseable message — ignore
      }
    });

    ws.on("close", () => {
      messageQueue.unregisterClient(clientId);
    });

    ws.on("error", () => {
      messageQueue.unregisterClient(clientId);
    });
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `[kimi-session-orchestrator] Port ${port} already in use — HTTP server skipped (MCP stdio still available)\n`
      );
    } else {
      throw err;
    }
  });

  httpServer.listen(port, "0.0.0.0", () => {
    process.stderr.write(
      `[kimi-session-orchestrator] HTTP+WS server listening on http://0.0.0.0:${port}\n`
    );
  });
}
