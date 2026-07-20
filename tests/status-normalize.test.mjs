import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionStatus } from "../dist/status-normalize.js";

// ── 旧模型（0.22.x）：status 字段优先，原样透传 ──
test("legacy: status enum passthrough", () => {
  assert.equal(normalizeSessionStatus({ status: "idle" }), "idle");
  assert.equal(normalizeSessionStatus({ status: "running" }), "running");
  assert.equal(normalizeSessionStatus({ status: "awaiting_approval" }), "awaiting_approval");
  assert.equal(normalizeSessionStatus({ status: "aborted" }), "aborted");
});

// ── 新模型（0.24+）：busy=true → running ──
test("busy model: busy=true → running", () => {
  assert.equal(normalizeSessionStatus({ busy: true }), "running");
  assert.equal(
    normalizeSessionStatus({ busy: true }, { pending_interaction: "approval" }),
    "running"
  );
});

// ── 新模型（0.24+）：busy=false → 看 pending_interaction ──
test("busy model: busy=false + no detail → idle", () => {
  assert.equal(normalizeSessionStatus({ busy: false }), "idle");
});
test("busy model: busy=false + pending_interaction=none → idle", () => {
  assert.equal(
    normalizeSessionStatus({ busy: false }, { pending_interaction: "none" }),
    "idle"
  );
});
test("busy model: busy=false + approval → awaiting_approval", () => {
  assert.equal(
    normalizeSessionStatus({ busy: false }, { pending_interaction: "approval" }),
    "awaiting_approval"
  );
});
test("busy model: busy=false + question → awaiting_question", () => {
  assert.equal(
    normalizeSessionStatus({ busy: false }, { pending_interaction: "question" }),
    "awaiting_question"
  );
});

// ── 边界：两模型字段都缺失 → unknown（不误判） ──
test("edge: empty body → unknown", () => {
  assert.equal(normalizeSessionStatus({}), "unknown");
  assert.equal(normalizeSessionStatus({ status: "" }), "unknown");
});

// ── 边界：status 与 busy 同时存在时 status 优先（前向兼容） ──
test("edge: status wins over busy", () => {
  assert.equal(normalizeSessionStatus({ status: "idle", busy: true }), "idle");
});
