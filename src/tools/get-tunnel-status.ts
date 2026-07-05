import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { messageQueue } from "../message-queue.js";
import { wireClient } from "../wire-client.js";

let startTime = Date.now();

export function registerGetTunnelStatus(server: McpServer): void {
  server.tool(
    "get_tunnel_status",
    "获取调试隧道当前状态：已连接客户端数、Wire 协议连接状态、消息队列长度、运行时间。",
    {},
    async () => {
      const status = messageQueue.getStatus();
      const uptime = Math.floor((Date.now() - startTime) / 1000);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                version: "2.0.0",
                wireConnected: wireClient.isConnected(),
                ...status,
                uptimeSeconds: uptime,
                uptimeDisplay: `${Math.floor(uptime / 60)}m ${uptime % 60}s`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
