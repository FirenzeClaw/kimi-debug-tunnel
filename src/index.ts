#!/usr/bin/env node
import { startMcpServer } from "./mcp-server.js";
import { startHttpServer } from "./http-server.js";
import { wireClient } from "./wire-client.js";

const PORT = parseInt(process.env.TUNNEL_PORT || "3456", 10);
const KIMI_SERVER_PORT = parseInt(process.env.KIMI_SERVER_PORT || "5494", 10);

async function discoverToken(): Promise<string | null> {
  // Check env var first
  if (process.env.KIMI_SERVER_TOKEN) return process.env.KIMI_SERVER_TOKEN;

  // Try reading from kimi server's startup output (check common token file locations)
  // The token is printed when kimi web starts
  return null;
}

async function main(): Promise<void> {
  process.stderr.write("[kimi-debug-tunnel] v2.0.0 Starting...\n");

  // Start HTTP + WebSocket server for external clients
  startHttpServer(PORT);

  // Connect to Kimi Web UI server via REST API
  const serverUrl = `http://127.0.0.1:${KIMI_SERVER_PORT}`;

  try {
    await wireClient.connect();
    process.stderr.write(
      `[kimi-debug-tunnel] Connected to Kimi server on port ${KIMI_SERVER_PORT}\n`
    );
  } catch (err) {
    process.stderr.write(
      `[kimi-debug-tunnel] WARNING: Cannot connect to Kimi server: ${(err as Error).message}\n`
    );
    process.stderr.write(
      `[kimi-debug-tunnel] Start with: kimi web --no-open --port ${KIMI_SERVER_PORT}\n`
    );
    process.stderr.write(
      "[kimi-debug-tunnel] Set KIMI_SERVER_TOKEN env var with the bearer token\n"
    );
    process.stderr.write(
      "[kimi-debug-tunnel] Falling back to filesystem-based operations only\n"
    );
  }

  // Start MCP stdio server for Kimi Code CLI
  startMcpServer().catch((err) => {
    process.stderr.write(
      `[kimi-debug-tunnel] MCP server failed: ${err.message}\n`
    );
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = async () => {
    process.stderr.write("[kimi-debug-tunnel] Shutting down...\n");
    await wireClient.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
