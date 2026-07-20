import { test } from "node:test";
import assert from "node:assert/strict";
import { WireClient } from "../dist/wire-client.js";

// TS private 仅编译期约束，.mjs 中可直接触达以做单测
function makeStubClient() {
  const c = new WireClient();
  c.connected = true;
  c.transport = {
    apiGet: async () => ({ items: [] }),
    apiPost: async () => ({ prompt_id: "p1", content: [] }),
  };
  c.waitForStatus = async () => "idle";
  c.wsSubscribe = () => {};
  return c;
}

test("turn.ended failed → lastError 写入缓存", () => {
  const c = makeStubClient();
  c.handleDirectEvent({
    type: "turn.ended",
    payload: { reason: "failed", error: { code: "model.not_configured", message: "Model not set" }, session_id: "s1" },
  });
  assert.equal(c.sessionStateCache.get("s1").lastError, "[model.not_configured] Model not set");
});

test("turn.ended completed → 清除 lastError", () => {
  const c = makeStubClient();
  c.handleDirectEvent({
    type: "turn.ended",
    payload: { reason: "failed", error: { code: "x", message: "y" }, session_id: "s1" },
  });
  c.handleDirectEvent({ type: "turn.ended", payload: { reason: "completed", session_id: "s1" } });
  assert.equal(c.sessionStateCache.get("s1").lastError, undefined);
});

test("sendPrompt：turn 失败抛带错误码的异常", async () => {
  const c = makeStubClient();
  c.handleDirectEvent({
    type: "turn.ended",
    payload: { reason: "failed", error: { code: "model.not_configured", message: "Model not set" }, session_id: "s1" },
  });
  await assert.rejects(() => c.sendPrompt("s1", "hi"), /model\.not_configured/);
});

test("sendPrompt：turn 成功不抛错", async () => {
  const c = makeStubClient();
  c.handleDirectEvent({ type: "turn.ended", payload: { reason: "completed", session_id: "s1" } });
  const r = await c.sendPrompt("s1", "hi");
  assert.equal(r.status, "completed");
});
