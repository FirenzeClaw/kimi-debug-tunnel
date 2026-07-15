import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { TunnelServices } from "./types.js";
import {
  registerCreateSession,
  registerExecutePrompt,
  registerChatWithSession,
  registerRunFlow,
  registerStreamResponse,
  registerListSessions,
  registerGetSessionInfo,
  registerReadSessionLog,
  registerListIORecords,
  registerPollSession,
  registerLearnWorkflow,
  registerListTemplates,
  registerExecuteWorkflow,
  registerContinueWorkflow,
  registerWatchSession,
  registerGetWatchResult,
  registerContinueWatch,
  registerSetWatchOutput,
  registerGetTunnelStatus,
  registerListPolicies,
  registerApproveTool,
  registerDenyTool,
  registerMemorySet,
  registerMemoryGet,
  registerMemoryList,
  registerMemoryDelete,
  registerMemoryStatus,
  registerMemoryArchive,
  registerGradeStep,
} from "./tools/manifest.js";

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

  // Memory & knowledge sharing tools (SPEC 002)
  registerMemorySet(server, services);
  registerMemoryGet(server, services);
  registerMemoryList(server, services);
  registerMemoryDelete(server, services);
  registerMemoryStatus(server, services);
  registerMemoryArchive(server, services);

  // Grading & verification tool
  registerGradeStep(server, services);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[kimi-session-orchestrator] MCP server connected via stdio\n");
}
