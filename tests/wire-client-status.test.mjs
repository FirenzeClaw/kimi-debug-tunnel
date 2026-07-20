import { test } from "node:test";
import assert from "node:assert/strict";
import { WireClient } from "../dist/wire-client.js";

// TS private 仅编译期约束，.mjs 中可直接触达以做单测
function makeClient() {
  return new WireClient(); // 构造不发起连接，baseUrl/token 来自 env 缺省
}

test("work_changed: busy=false + none → idle 并写入缓存", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "none", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "idle");
});

test("work_changed: busy=true → running", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: true, pending_interaction: "none", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "running");
});

test("work_changed: busy=true + approval → awaiting_approval（实测：审批等待时 busy 仍为 true）", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: true, pending_interaction: "approval", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "awaiting_approval");
});

test("work_changed: busy=false + approval → awaiting_approval", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "approval", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "awaiting_approval");
});

test("work_changed: 唤醒 idle resolver 并清空队列", () => {
  const c = makeClient();
  let got = null;
  c.statusResolvers.set("s1", [{ resolve: (v) => { got = v; }, reject: () => {} }]);
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "none", session_id: "s1" },
  });
  assert.equal(got, "idle");
  assert.equal(c.statusResolvers.has("s1"), false);
});

test("work_changed: awaiting_approval 只唤醒首个 resolver 且保留队列", () => {
  const c = makeClient();
  let got = null;
  c.statusResolvers.set("s1", [{ resolve: (v) => { got = v; }, reject: () => {} }]);
  c.handleDirectEvent({
    type: "event.session.work_changed",
    payload: { busy: false, pending_interaction: "approval", session_id: "s1" },
  });
  assert.equal(got, "awaiting_approval");
  assert.equal(c.statusResolvers.has("s1"), true);
});

test("旧事件 status_changed 仍生效（0.22.x 兼容）", () => {
  const c = makeClient();
  c.handleDirectEvent({
    type: "event.session.status_changed",
    payload: { status: "idle", session_id: "s1" },
  });
  assert.equal(c.getCachedStatus("s1"), "idle");
});

test("watch: assistant.delta 累积 + turn.started 重置（0.27 无 prompt.submitted 的兜底）", () => {
  const c = makeClient();
  c.watchOutputPath = "x"; // 仅开启累积分支，不触发写文件
  c.handleDirectEvent({ type: "assistant.delta", payload: { delta: "abc", session_id: "s1" } });
  assert.equal(c.watchAssistantText, "abc");
  c.handleDirectEvent({ type: "turn.started", payload: { turnId: 2, session_id: "s1" } });
  assert.equal(c.watchAssistantText, "");
});

test("watch: prompt.submitted 仍重置并计数（0.22.x 兼容）", () => {
  const c = makeClient();
  c.watchOutputPath = "x";
  c.handleDirectEvent({ type: "assistant.delta", payload: { delta: "abc", session_id: "s1" } });
  c.handleDirectEvent({ type: "prompt.submitted", payload: { session_id: "s1" } });
  assert.equal(c.watchAssistantText, "");
  assert.equal(c.watchPromptCount, 1);
});
