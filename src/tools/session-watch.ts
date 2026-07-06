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

export function registerContinueWatch(server: McpServer, services: TunnelServices): void {
  server.tool(
    "continue_watch",
    "检查后台监听结果。若任务 session 已完成，自动提交下一步指令并启动新一轮后台监听，形成完整自动化循环。",
    {
      watch_id: z.string().describe("当前 watch_id"),
      next_instruction: z.string().optional().describe("任务完成后发给 session 的下一步指令。提供后自动提交+启动新 watch。"),
    },
    async ({ watch_id, next_instruction }) => {
      const w = getWatcher(services);
      const result = await w.continueWatch(watch_id, next_instruction);

      if (!result) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ready: false, hint: "任务仍在处理中，稍后调用 continue_watch 再查。" }, null, 2),
          }],
        };
      }

      const resp: Record<string, unknown> = {
        ready: true,
        result: result.result,
      };
      if (result.next_watch_id) resp.next_watch_id = result.next_watch_id;
      if (result.error) resp.error = result.error;

      return {
        content: [{
          type: "text",
          text: JSON.stringify(resp, null, 2),
        }],
      };
    }
  );
}

export function registerSetWatchOutput(server: McpServer, services: TunnelServices): void {
  server.tool(
    "set_watch_output",
    "设置监听结果文件路径。设置后每次 prompt.completed 时自动写入结果到该文件，统筹 session 读取即可获取任务回复。",
    {
      path: z.string().describe("状态文件的绝对路径，如 /c/Users/admin/watch-status.json"),
    },
    async ({ path }) => {
      services.wireClient.setWatchOutput(path);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            set: true,
            path,
            hint: "已设置。每次 prompt.completed 时将自动写入结果到此文件。读取此文件即可获取任务回复。",
          }, null, 2),
        }],
      };
    }
  );
}
