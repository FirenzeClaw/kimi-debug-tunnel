import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TunnelServices } from "../types.js";
import { listTemplates } from "../workflow-store.js";

export function registerListTemplates(server: McpServer, _services?: TunnelServices): void {
  server.tool(
    "list_templates",
    "列出所有可用的工作流模板。返回模板名称、版本、步骤数、描述。",
    {},
    async () => {
      try {
        const templates = await listTemplates();

        if (templates.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "暂无可用的工作流模板。用 learn_workflow 创建新模板。",
              },
            ],
          };
        }

        const items = templates.map((t) => ({
          name: t.name,
          version: t.version,
          steps: t.steps.length,
          projectCwd: t.projectCwd,
          description: t.description || "",
          stepList: t.steps.map((s) => s.id),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ templates: items }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `获取模板列表失败: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
