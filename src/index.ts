#!/usr/bin/env node
import { WireClient } from "./wire-client.js";
import { detectKimiServerUrl } from "./server-lock.js";
import { MessageQueue } from "./message-queue.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { PolicyEngine } from "./policy-engine.js";
import { MemoryStore } from "./memory-store.js";
import { OrchestrationStore } from "./orchestration-store.js";
import type { TunnelServices } from "./types.js";
import { startMcpServer } from "./mcp-server.js";
import { startHttpServer } from "./http-server.js";
import { listSessions } from "./session-store.js";

const PORT = parseInt(process.env.TUNNEL_PORT || "3456", 10);

async function main(): Promise<void> {
  process.stderr.write("[kimi-session-orchestrator] v2.0.0 Starting...\n");

  const wireClient = new WireClient();
  const messageQueue = new MessageQueue();
  const workflowEngine = new WorkflowEngine(wireClient, messageQueue);
  const policyEngine = new PolicyEngine();
  const memoryStore = new MemoryStore();
  wireClient.setPolicyEngine(policyEngine);
  wireClient.setMessageQueue(messageQueue);

  // Wire memory store to workflow engine for auto-injection (SPEC 002)
  // This also avoids repeating memory setup in each tool file
  // Initialize memory DB eagerly so all 6 memory_* MCP tools are usable
  const projectRoot = memoryStore.resolveProjectRoot(process.cwd());
  if (projectRoot) {
    memoryStore.ensureDb(projectRoot);
    process.stderr.write(`[kimi-session-orchestrator] Memory DB: ${projectRoot}/.kimi-tunnel/memory.db\n`);
  } else {
    process.stderr.write("[kimi-session-orchestrator] Memory DB: .kimi-tunnel/ not found under CWD, deferred\n");
  }
  workflowEngine.setMemoryStore(memoryStore, projectRoot);

  const services: TunnelServices = {
    sessionClient: wireClient,
    statusClient: wireClient,
    pushClient: wireClient,
    wireClient,
    messageQueue,
    startTime: Date.now(),
    workflowEngine,
    policyEngine,
    memoryStore,
    orchestrationStore: new OrchestrationStore(),
    tunnelProjectRoot: projectRoot,
  };

  // Start HTTP + WebSocket server for external clients
  startHttpServer(PORT, services);

  // Start MCP stdio server FIRST — must respond to tools/list within 30s
  // regardless of wire connection status (P1-3 fix: decouple stdio from wire lifecycle)
  startMcpServer(services).catch((err) => {
    process.stderr.write(
      `[kimi-session-orchestrator] MCP server failed: ${err.message}\n`
    );
    process.exit(1);
  });

  // Wire connection runs as background task — doesn't block MCP stdio
  wireClient.connect()
    .then(async () => {
      // Auto-detect the most recent session after successful connect
      if (!wireClient.getSessionId()) {
        const sessions = await listSessions();
        if (sessions.length > 0) {
          wireClient.setSessionId(sessions[0].id);
          process.stderr.write(
            `[kimi-session-orchestrator] Auto-selected session: ${sessions[0].id} (${sessions[0].title.slice(0, 50)})\n`
          );
        }
      }
    })
    .catch((err) => {
      process.stderr.write(
        `[kimi-session-orchestrator] WARNING: Kimi server not available at ${process.env.KIMI_SERVER_URL || detectKimiServerUrl()}: ${(err as Error).message}\n`
      );
      process.stderr.write(
        "[kimi-session-orchestrator] Start with: kimi web --no-open\n"
      );
      process.stderr.write(
        "[kimi-session-orchestrator] Set KIMI_SERVER_TOKEN env var if auth required\n"
      );
      process.stderr.write(
        "[kimi-session-orchestrator] Starting periodic reconnection (every 10s). Tools will auto-retry.\n"
      );
      wireClient.startHealthCheck();
    });

  // Graceful shutdown
  const shutdown = async () => {
    process.stderr.write("[kimi-session-orchestrator] Shutting down...\n");
    await wireClient.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
