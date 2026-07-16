<!-- 修改记录见 CHANGELOG.md -->

# Kimi Session Orchestrator

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v2.16-brightgreen)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)]()
[![Python](https://img.shields.io/badge/python-%E2%89%A5%203.7-3776AB)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-29-orange)]()
[![Skills](https://img.shields.io/badge/skills-10-blue)]()

**Kimi Code CLI 的 Loop Engineering PM 编排系统。** 29 个 MCP 工具——不手动 prompt Agent，而是设计自动 prompt Agent 的循环系统。

## 解决什么问题

| 问题 | 方案 |
|------|------|
| **上下文腐化** — session 越跑越笨，偏离规范 | `session-retire` 一键快速退役接班 + `loop-orchestrator` 干净上下文派发 |
| **无法确认完工** — Agent 说"好了"但实际没好 | `grade_step` LLM 评分验证 + loop 指纹检测，不过就重试 |
| **冷启动灾难** — 每次新 session 从零开始 | `from_session` 注入 + 7-block 交接模板，5 步建完上下文 |
| **重复告知规范** — Agent 不记得项目约定 | `memory_set` 一次录入 → 新 session 自动注入索引 → 按需拉取 |
| **超时截断** — 耗时任务被 MCP 30s 超时杀死 | 即发即返 + Bash 后台 Python 轮询（v2.16 首次调用自动写入 poll.py → 后续短命令引用 + poll-result-{sid}.txt），OS 进程退出自动通知 |

<details>
<summary><b>更多场景对照</b></summary>

| 痛点 | 行业现状 | 本项目 |
|------|----------|--------|
| 上下文不可见 | 浏览器端无任何指示 | `poll_session` WS 缓存优先 + bash 通知 `[CTX_HIGH]`（v2.14） |
| 会话交接繁琐 | 手写总结，容易遗漏 | `session-retire` 全自动 pipeline（归档→7-block→接班） |
| 多 Agent 编排 | 缺编排层，状态不可见 | `OrchestrationStore` PM→子 session 追踪 + WS 实时推送 |
| 跨项目知识不共享 | 项目级记忆绑定单仓库 | `resolveProjectRoot` + 双层注入（v2.13） |
| 服务端崩溃 | 任务丢失，需手动重做 | 五层离线防御 + `poll_command` 动态端口适配重启 |

</details>

## 快速开始

```bash
git clone https://github.com/FirenzeClaw/kimi-session-orchestrator.git
cd kimi-session-orchestrator
# 0. 确认 Python ≥ 3.7（后台轮询依赖）
python3 --version || python --version

npm install && npm run build

# 1. 启动 Kimi Server
kimi web --no-open

# 2. 设置 token 并启动 Tunnel
export KIMI_SERVER_TOKEN="<printed-at-startup>"
npm start
```

注册到 `~/.kimi-code/mcp.json`：

```json
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["<绝对路径>/dist/index.js"],
      "env": { "KIMI_SERVER_TOKEN": "<token>" }
    }
  }
}
```

`/reload` 即可使用。详见 [完整安装指南](#安装与部署)。

## 架构

```
用户 ──HTTP/WS──▶ Express Server ──REST──▶ Kimi Server
                       │                      │
         ┌─────────────┼──────────────┐       │
         ▼             ▼              ▼       │
   WorkflowEngine  SessionWatcher  PolicyEngine │
   MemoryStore(SQLite)  MessageQueue  OrchestrationStore
                       │
                   MCP stdio ──▶ Kimi Code CLI
```

## 工具概览

| 类别 | 工具 | 
|------|------|
| **Session** | `create_session` `list_sessions` `get_session_info` `get_tunnel_status` |
| **任务** | `execute_prompt` `chat_with_session` `run_flow` `execute_workflow` `continue_workflow` |
| **监控** | `poll_session` `list_io_records` `read_session_log` `watch_session` `get_watch_result` |
| **记忆** | `memory_set` `memory_get` `memory_list` `memory_delete` `memory_status` `memory_archive` |
| **验证** | `grade_step` — LLM 自动评分（pass/fail + 详细反馈） |
| **权限** | `list_policies` `approve_tool` `deny_tool` |
| **工作流** | `learn_workflow` `list_templates` |
| **推送** | `stream_response` `set_watch_output` |

完整工具参数见 [API.md](API.md)。

## Skill

10 个配套 skill，分为 Agent 级（新 session 自动加载）和 PM 级（按需调用）：

| Skill | 级别 | 一句话 |
|-------|:--:|------|
| `kimi-session-orchestrator` | Agent | 启动协议：auto 检测 → Q1 角色维度 → 按需加载 guide |
| `loop-orchestrator` | PM | `/loop-orchestrator` 一键启动 6 阶段自主循环 |
| `loop-contract-from-docs` | PM | 从 SPEC/PRD/PLAN/TASK 提取 AC、复杂度和 Loop Contract |
| `loop-contract-from-idea` | PM | 一句话需求 → 5 轮追问 → 基线锁定 → Loop Contract |
| `cron-scheduler` | PM | 定时自动化编排：cron.yaml 双写、自举续期链、run_lock 防重叠 |
| `session-retire` | PM | 退役→接班全自动 pipeline，近乎无损接力 |
| `xmind-orchestrated` | Agent | 困境分析——task session 独立上下文 + 零污染 |
| `xmind` | Agent | 本地子 Agent 困境分析（原版） |
| `agent-session-monitor` | Agent | 无需 API 认证，wire.jsonl 尾部状态推断 |
| `mcp-async-tool` | Agent | MCP 异步工具设计模式——解决 >30s 超时 |

安装：

```bash
# Agent 级
cp -r skills/kimi-session-orchestrator ~/.agents/skills/
cp -r skills/xmind-orchestrated ~/.agents/skills/
cp -r skills/xmind ~/.agents/skills/
cp skills/agent-session-monitor.md ~/.agents/skills/agent-session-monitor/SKILL.md
cp skills/mcp-async-tool.md ~/.agents/skills/mcp-async-tool/SKILL.md

# PM 级
cp -r skills/session-retire ~/.kimi-code/skills/
cp -r skills/loop-orchestrator ~/.kimi-code/skills/
cp -r skills/loop-contract-from-docs ~/.kimi-code/skills/
cp -r skills/loop-contract-from-idea ~/.kimi-code/skills/
cp -r skills/cron-scheduler ~/.kimi-code/skills/
```

## 记忆系统

三层架构——PM 一次性录入，session 自动继承。

```
L1: 项目知识库 (.kimi-tunnel/memory.db)
    PM: memory_set(ns, key, value)
    Session: create_session(memory_level) → 自动注入索引 → 自主 memory_get

L2: Session 上下文 (session:<id>/*)
    运行时更新，退役后 memory_archive 归档到 L1

L3: 学习沉淀 (learn skill → 向量库)
    从 L1+L2 提取可复用模式
```

**v2.13+**：支持跨项目双层注入——`buildInjection()` 按 `profile.cwd` 自动生成全局正文 + 子项目索引导航表。

## 文档

| 文档 | 说明 |
|------|------|
| [API.md](API.md) | Kimi Server REST API（51 端点） |
| [docs/coordinator-guide.md](docs/coordinator-guide.md) | PM 统筹准入规范 |
| [docs/loop-engineering-analysis.md](docs/loop-engineering-analysis.md) | Loop Engineering 概念与项目对照 |
| [docs/loop-engineering-reference.md](docs/loop-engineering-reference.md) | Loop Engineering 全面参考（16 章，7 篇来源聚合） |
| [specs/](specs/) | 7 个功能规格（001-007，含 cross-model grader 与 cron-scheduler） |
| [docs/superpowers/specs/](docs/superpowers/specs/) | 架构设计文档（含 Loop Contract 双 Skill 设计） |
| [docs/issues/](docs/issues/) | 已修复问题记录（5 个） |

## 安装与部署

### 前置条件

- Node.js ≥ 22（`node:sqlite` 内置 + tsc 编译）
- Python ≥ 3.7（后台轮询脚本 `poll_command` 运行时依赖）
- Kimi Code CLI ≥ 0.22.3
- Git Bash（Windows）或 bash

### 环境变量

| 变量 | 必需 | 默认 | 说明 |
|------|:--:|------|------|
| `KIMI_SERVER_TOKEN` | ✅ | — | Kimi Server 启动时打印的 Bearer Token |
| `KIMI_SERVER_URL` | 否 | 自动检测 | 覆盖 Kimi Server 地址（端口自动从 lock 检测） |
| `TUNNEL_PORT` | 否 | `3456` | Tunnel HTTP/WS 监听端口 |
| `KIMI_CODE_HOME` | 否 | `~/.kimi-code` | Kimi Code 数据目录 |

### 部署红线

| # | 规则 |
|---|------|
| 1 | ⛔ 不要硬编码 `KIMI_SERVER_URL`——端口每次启动可能不同 |
| 2 | `KIMI_SERVER_TOKEN` 必须在 `mcp.json` 的 `env` 中 |
| 3 | 安装后执行 `/reload` |
| 4 | 更新代码后需重装 skill：`git pull` → `npm run build` → 重装 → `/reload` |

### Linux

与上方完全一致，仅路径用绝对路径。自动端口检测、MCP stdio、跨平台 API 均兼容。

## 项目结构

```
src/          — TypeScript 核心（index, mcp-server, wire-client, workflow-engine, memory-store 等）
  tools/      — 29 个 MCP 工具
shared/       — 浏览器端 JS（API 客户端、状态管理、渲染、注入）
ext/          — Chrome MV3 扩展
userscript/   — Tampermonkey 用户脚本
skills/       — 10 个配套 Skill（含 Loop Contract 双 Skill + cron-scheduler）
templates/    — 工作流 YAML 模板
docs/         — 规格、设计文档、问题记录
specs/        — 功能规格（001-005）
```

## FAQ

<details>
<summary><b>Tunnel 连接失败？</b></summary>

最常见根因：`mcp.json` 中硬编码了 `KIMI_SERVER_URL`。**删除该行**——Tunnel 自动从 lock 文件检测端口。确认 `kimi web` 运行中 + token 正确。
</details>

<details>
<summary><b>task session 调用 memory_get 失败？</b></summary>

确保 `~/.kimi-code/mcp.json` 中注册了 `kimi-session-orchestrator`，然后 `/reload`。全局 `mcp.json` 对所有 session 生效——配置一次即可。
</details>

<details>
<summary><b>Kimi Server 崩溃了？</b></summary>

Tunnel 内置五层防御：过期 lock 清理 + 10s 心跳 + 断连判定 + 指数退避重连 + WS 独立重连。短时中断自动恢复，运行中的 task session 不受影响。
</details>

<details>
<summary><b>/reload 后 MCP 超时？</b></summary>

`kimi web` 未运行或已崩溃。v2.9.1 起 MCP stdio 优先启动，wire 离线时工具返回友好报错而非进程崩溃。
</details>

## 参与贡献

[Bug / 功能请求](https://github.com/FirenzeClaw/kimi-session-orchestrator/issues) · Fork → PR · 提交前 `npm run build` 零错误。

## License

MIT
