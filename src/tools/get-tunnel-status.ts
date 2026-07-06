import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";

export function registerGetTunnelStatus(server: McpServer, services: TunnelServices): void {
  const { messageQueue, wireClient, startTime } = services;

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
                wsConnected: wireClient.isWsConnected(),
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
