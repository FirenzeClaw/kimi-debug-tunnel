import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { registerWatchSession, registerGetWatchResult, registerContinueWatch, registerSetWatchOutput } from "./tools/session-watch.js";
import { registerListPolicies } from "./tools/list-policies.js";
import { registerApproveTool } from "./tools/approve-tool.js";
import { registerDenyTool } from "./tools/deny-tool.js";
import { registerListBlocks } from "./tools/list-blocks.js";
import { registerMemorySet } from "./tools/memory-set.js";
import { registerMemoryGet } from "./tools/memory-get.js";
import { registerMemoryList } from "./tools/memory-list.js";
import { registerMemoryDelete } from "./tools/memory-delete.js";
import { registerMemoryStatus } from "./tools/memory-status.js";
import { registerMemoryArchive } from "./tools/memory-archive.js";

export async function startMcpServer(services: TunnelServices): Promise<void> {
  const server = new McpServer({
    name: "kimi-session-orchestrator",
    version: "2.0.0",
    description:
      "Kimi Code CLI 调试隧道 v2——通过 WebSocket Wire 协议实现推送式全自动化 session 统筹。支持多轮对话编排、实时流式响应、智能思考过滤。",
  });

  registerCreateSession(server, services);
  registerExecutePrompt(server, services);
  registerChatWithSession(server, services);
  registerRunFlow(server, services);
  registerStreamResponse(server, services);

  registerListSessions(server, services);
  registerGetSessionInfo(server, services);
  registerReadSessionLog(server, services);
  registerListIORecords(server, services);
  registerPollSession(server, services);

  registerLearnWorkflow(server, services);
  registerListTemplates(server, services);
  registerExecuteWorkflow(server, services);
  registerContinueWorkflow(server, services);
  registerWatchSession(server, services);
  registerGetWatchResult(server, services);
  registerContinueWatch(server, services);
  registerSetWatchOutput(server, services);

  registerGetTunnelStatus(server, services);

  // Policy & permission management tools
  registerListPolicies(server, services);
  registerApproveTool(server, services);
  registerDenyTool(server, services);
  registerListBlocks(server, services);

  // Memory & knowledge sharing tools (SPEC 002)
  registerMemorySet(server, services);
  registerMemoryGet(server, services);
  registerMemoryList(server, services);
  registerMemoryDelete(server, services);
  registerMemoryStatus(server, services);
  registerMemoryArchive(server, services);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[kimi-session-orchestrator] MCP server connected via stdio\n");
}
