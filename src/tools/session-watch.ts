import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { SessionWatcher } from "../session-watcher.js";

let watcher: SessionWatcher | null = null;

function getWatcher(services: TunnelServices): SessionWatcher {
  if (!watcher) {
    watcher = new SessionWatcher(services.wireClient);
  }
  return watcher;
}

export function registerWatchSession(server: McpServer, services: TunnelServices): void {
  server.tool(
    "watch_session",
    "启动后台监听任务 session 的完成状态。提交任务后调用此工具，tunnel 通过 WS 主动等待完成。完成后用 get_watch_result 获取回复。",
    {
      session_id: z.string().describe("要监听的目标 session ID"),
    },
    async ({ session_id }) => {
      const w = getWatcher(services);
      const watchId = w.watch(session_id);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            watch_id: watchId,
            session_id,
            hint: "后台已开始监听。用 get_watch_result(watch_id) 获取结果。",
          }, null, 2),
        }],
      };
    }
  );
}

export function registerGetWatchResult(server: McpServer, services: TunnelServices): void {
  server.tool(
    "get_watch_result",
    "获取 watch_session 的后台监听结果。返回 null 表示仍在等待中。",
    {
      watch_id: z.string().describe("watch_session 返回的 watch_id"),
    },
    async ({ watch_id }) => {
      const w = getWatcher(services);
      const result = w.getResult(watch_id);
      if (!result) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ready: false, hint: "任务仍在处理中，稍后再查。" }, null, 2),
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ready: true,
            status: result.status,
            result: result.result,
            error: result.error,
          }, null, 2),
        }],
      };
    }
  );
}
