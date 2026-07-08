#!/usr/bin/env node
import { WireClient } from "./wire-client.js";
import { MessageQueue } from "./message-queue.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { PolicyEngine } from "./policy-engine.js";
import { MemoryStore } from "./memory-store.js";
import type { TunnelServices } from "./types.js";
import { startMcpServer } from "./mcp-server.js";
import { startHttpServer } from "./http-server.js";
import { listSessions } from "./session-store.js";

const PORT = parseInt(process.env.TUNNEL_PORT || "3456", 10);

async function main(): Promise<void> {
  process.stderr.write("[kimi-debug-tunnel] v2.0.0 Starting...\n");

  const wireClient = new WireClient();
  const messageQueue = new MessageQueue();
  const workflowEngine = new WorkflowEngine(wireClient, messageQueue);
  const policyEngine = new PolicyEngine();
  const memoryStore = new MemoryStore();
  wireClient.setPolicyEngine(policyEngine);
  wireClient.setMessageQueue(messageQueue);

  // Initialize memory DB eagerly so all 6 memory_* MCP tools are usable
  // without requiring a session tool (create_session/execute_prompt) call first.
  // Fixes: docs/issues/memory-init-timing.md
  const projectRoot = memoryStore.resolveProjectRoot(process.cwd());
  if (projectRoot) {
    memoryStore.ensureDb(projectRoot);
    process.stderr.write(`[kimi-debug-tunnel] Memory DB: ${projectRoot}/.kimi-tunnel/memory.db\n`);
  } else {
    process.stderr.write("[kimi-debug-tunnel] Memory DB: .kimi-tunnel/ not found under CWD, deferred\n");
  }

  const services: TunnelServices = {
    wireClient,
    messageQueue,
    startTime: Date.now(),
    workflowEngine,
    policyEngine,
    memoryStore,
    tunnelProjectRoot: projectRoot,  // for cross-project injection (SPEC 002)
  };

  // Start HTTP + WebSocket server for external clients
  startHttpServer(PORT, services);

  // Connect to Kimi server via REST API
  try {
    await wireClient.connect();

    // Auto-detect the most recent session
    if (!wireClient.getSessionId()) {
      const sessions = await listSessions();
      if (sessions.length > 0) {
        wireClient.setSessionId(sessions[0].id);
        process.stderr.write(
          `[kimi-debug-tunnel] Auto-selected session: ${sessions[0].id} (${sessions[0].title.slice(0, 50)})\n`
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `[kimi-debug-tunnel] WARNING: Kimi server not available: ${(err as Error).message}\n`
    );
    process.stderr.write(
      "[kimi-debug-tunnel] Start with: kimi web --no-open\n"
    );
    process.stderr.write(
      "[kimi-debug-tunnel] Set KIMI_SERVER_TOKEN env var if auth required\n"
    );
    process.stderr.write(
      "[kimi-debug-tunnel] Falling back to basic tools (execute_prompt/chat_with_session will not work)\n"
    );
  }

  // Start MCP stdio server for Kimi Code CLI
  startMcpServer(services).catch((err) => {
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
