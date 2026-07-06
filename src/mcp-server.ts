import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WireClient } from "./wire-client.js";
import { MessageQueue } from "./message-queue.js";
import { WorkflowEngine } from "./workflow-engine.js";
import type { TunnelServices } from "./types.js";

import { registerListSessions } from "./tools/list-sessions.js";
import { registerGetSessionInfo } from "./tools/get-session-info.js";
import { registerGetTunnelStatus } from "./tools/get-tunnel-status.js";
import { registerReadSessionLog } from "./tools/read-session-log.js";
import { registerExecutePrompt } from "./tools/execute-prompt.js";
import { registerChatWithSession } from "./tools/chat-with-session.js";
import { registerStreamResponse } from "./tools/stream-response.js";
import { registerListIORecords } from "./tools/list-io-records.js";
import { registerCreateSession } from "./tools/create-session.js";
import { registerPollSession } from "./tools/poll-session.js";
import { registerRunFlow } from "./tools/run-flow.js";
import { registerLearnWorkflow } from "./tools/learn-workflow.js";
import { registerExecuteWorkflow } from "./tools/execute-workflow.js";
import { registerListTemplates } from "./tools/list-workflow-templates.js";
import { registerContinueWorkflow } from "./tools/continue-workflow.js";
import { registerWatchSession, registerGetWatchResult } from "./tools/session-watch.js";

const server = new McpServer({
  name: "kimi-debug-tunnel",
  version: "2.0.0",
  description:
    "Kimi Code CLI 调试隧道 v2——通过 WebSocket Wire 协议实现推送式全自动化 session 统筹。支持多轮对话编排、实时流式响应、智能思考过滤。",
});

function createServer(): { server: typeof server; services: TunnelServices } {
  const wireClient = new WireClient();
  const messageQueue = new MessageQueue();
  const wireClientFactory = { create: () => new WireClient() };
  const workflowEngine = new WorkflowEngine({ wireClient, messageQueue, startTime: Date.now(), wireClientFactory });
  const services: TunnelServices = { wireClient, messageQueue, startTime: Date.now(), workflowEngine, wireClientFactory };

  registerCreateSession(server, services);
  registerExecutePrompt(server, services);
  registerChatWithSession(server, services);
  registerRunFlow(server, services);
  registerStreamResponse(server, services);

  registerListSessions(server);
  registerGetSessionInfo(server);
  registerReadSessionLog(server);
  registerListIORecords(server);
  registerPollSession(server, services);

  registerLearnWorkflow(server);
  registerListTemplates(server);
  registerExecuteWorkflow(server, services);
  registerContinueWorkflow(server, services);
  registerWatchSession(server, services);
  registerGetWatchResult(server, services);

  registerGetTunnelStatus(server, services);

  return { server, services };
}

export async function startMcpServer(): Promise<TunnelServices> {
  const { services } = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[kimi-debug-tunnel] MCP server connected via stdio\n");
  return services;
}

export { server };
