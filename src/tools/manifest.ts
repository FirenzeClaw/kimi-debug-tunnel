/**
 * Tool manifest — single import point for all MCP tool registrars.
 * v2.11: Replaces 29 individual imports in mcp-server.ts.
 * Add a new tool here and it's automatically registered.
 */

export { registerCreateSession } from "./create-session.js";
export { registerExecutePrompt } from "./execute-prompt.js";
export { registerChatWithSession } from "./chat-with-session.js";
export { registerRunFlow } from "./run-flow.js";
export { registerStreamResponse } from "./stream-response.js";

export { registerListSessions } from "./list-sessions.js";
export { registerGetSessionInfo } from "./get-session-info.js";
export { registerReadSessionLog } from "./read-session-log.js";
export { registerListIORecords } from "./list-io-records.js";
export { registerPollSession } from "./poll-session.js";

export { registerLearnWorkflow } from "./learn-workflow.js";
export { registerListTemplates } from "./list-workflow-templates.js";
export { registerExecuteWorkflow } from "./execute-workflow.js";
export { registerContinueWorkflow } from "./continue-workflow.js";
export {
  registerWatchSession,
  registerGetWatchResult,
  registerContinueWatch,
  registerSetWatchOutput,
} from "./session-watch.js";

export { registerGetTunnelStatus } from "./get-tunnel-status.js";

export { registerListPolicies } from "./list-policies.js";
export { registerApproveTool } from "./approve-tool.js";
export { registerDenyTool } from "./deny-tool.js";

export { registerMemorySet } from "./memory-set.js";
export { registerMemoryGet } from "./memory-get.js";
export { registerMemoryList } from "./memory-list.js";
export { registerMemoryDelete } from "./memory-delete.js";
export { registerMemoryStatus } from "./memory-status.js";
export { registerMemoryArchive } from "./memory-archive.js";

export { registerGradeStep } from "./grade-step.js";
