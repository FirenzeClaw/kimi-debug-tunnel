import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { TunnelServices } from "./types.js";
import type { WebSocketClient } from "./message-queue.js";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  // Serve web console
  const consoleHtmlPath = join(__dirname, "public", "console.html");
  let consoleHtml: string;
  try {
    consoleHtml = readFileSync(consoleHtmlPath, "utf-8");
  } catch {
    consoleHtml = "<html><body><h1>Debug Console not found</h1></body></html>";
  }

  app.get("/", (_req, res) => {
    res.type("html").send(consoleHtml);
  });

  // Serve workflow console
  const workflowConsoleHtmlPath = join(__dirname, "public", "workflow-console.html");
  let workflowConsoleHtml: string;
  try {
    workflowConsoleHtml = readFileSync(workflowConsoleHtmlPath, "utf-8");
  } catch {
    workflowConsoleHtml = "<html><body><h1>Workflow Console not found</h1></body></html>";
  }

  app.get("/workflow-console.html", (_req, res) => {
    res.type("html").send(workflowConsoleHtml);
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
      const response = await wireClient.sendPrompt(prompt, {
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

  // REST API: simple send (queues to existing poll system for backwards compat)
  app.post("/api/send", (req, res) => {
    const { content, sessionId } = req.body;

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "Missing or invalid 'content' field" });
      return;
    }

    const msg = { id: randomUUID(), content, timestamp: new Date().toISOString(), sessionId };
    res.json({ success: true, messageId: msg.id });
  });

  // REST API: tunnel status (now includes wire client status)
  app.get("/api/status", (_req, res) => {
    res.json({
      ...messageQueue.getStatus(),
      wireConnected: wireClient.isConnected(),
      version: "2.0.0",
    });
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
            wireClient
              .sendPrompt(data.content, {
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
        `[kimi-debug-tunnel] Port ${port} already in use — HTTP server skipped (MCP stdio still available)\n`
      );
    } else {
      throw err;
    }
  });

  httpServer.listen(port, "0.0.0.0", () => {
    process.stderr.write(
      `[kimi-debug-tunnel] HTTP+WS server listening on http://0.0.0.0:${port}\n`
    );
  });
}
