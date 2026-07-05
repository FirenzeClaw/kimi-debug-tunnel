import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerListSessions } from "./tools/list-sessions.js";
import { registerGetSessionInfo } from "./tools/get-session-info.js";
import { registerGetTunnelStatus } from "./tools/get-tunnel-status.js";
import { registerReadSessionLog } from "./tools/read-session-log.js";
import { registerExecutePrompt } from "./tools/execute-prompt.js";
import { registerChatWithSession } from "./tools/chat-with-session.js";
import { registerStreamResponse } from "./tools/stream-response.js";

const server = new McpServer({
  name: "kimi-debug-tunnel",
  version: "2.0.0",
  description:
    "Kimi Code CLI 调试隧道 v2——通过 WebSocket Wire 协议实现推送式全自动化 session 统筹。支持多轮对话编排、实时流式响应、智能思考过滤。",
});

// v2 push-based tools (replacing poll_incoming / send_prompt / push_response)
registerExecutePrompt(server);
registerChatWithSession(server);
registerStreamResponse(server);

// Session management tools
registerListSessions(server);
registerGetSessionInfo(server);
registerReadSessionLog(server);

// Status tool
registerGetTunnelStatus(server);

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[kimi-debug-tunnel] MCP server connected via stdio\n");
}

export { server };
