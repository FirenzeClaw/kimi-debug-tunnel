/**
 * Pure functions for processing Kimi content blocks.
 * No side effects, no state — independently testable.
 */

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  tool_call_id?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

export function extractThinking(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "thinking" && b.thinking)
    .map((b) => b.thinking!)
    .join("\n");
}

export function filterThinking(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type !== "thinking");
}

export function hasTextResponse(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => b.type === "text");
}
