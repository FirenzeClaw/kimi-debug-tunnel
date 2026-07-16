<!-- 修改记录见文末 §版本历史 -->

# Kimi Session Orchestrator

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v2.12.3-brightgreen)]()
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-29-orange)]()
[![Skills](https://img.shields.io/badge/skills-7-blue)]()
[![Loop Engineering](https://img.shields.io/badge/Loop%20Engineering-L2%20%E9%AA%8C%E8%AF%81%E9%97%AD%E7%8E%AF-blueviolet)]()

Kimi Code CLI 的 **Loop Engineering** PM 视角多 session 编排系统——不手动 prompt Agent，而是设计自动 prompt Agent 的循环系统。29 个 MCP 工具，支持 L2 验证闭环（`grade_step` LLM 自动评分 + loop 指纹检测）+ 自适应工作流引擎 + 三层共享内存 + 权限策略管理。

---

> 启动 session 整理完 PRD、SPEC、PLAN 后想直接实施，又担心上下文累积导致 session 注意力不集中？
>
> → **方案 A — 快速接力**：`session-retire` skill。检测到衰减信号 → 退役 → 归档 → 7-block 交接 → 接班 session 接续。轻度腐化时近乎无损，重度时能止损。
>
> → **方案 B — 不直接实施**：`/loop-orchestrator`。把当前 session 转为 PM 统筹角色，拆解任务→派发到**独立 task session**→验证→交付。实施 session 永远从干净上下文起步，腐化从源头规避。
>
> 每次 session 交接 handoff 麻烦且不连贯？
>
> → 同一套 `session-retire` pipeline：`memory_archive` 自动归档 findings → `memory_set` 结构化 handoff（completed/pending/decisions）→ 接班人 `fromSession` 注入 + 自举协议，**5 步建完上下文**，不用手写交接文档。
>
> 重复工作交给 Agent 总是停在犄角旮旯，或者不确定是否真的完工？
>
> → `grade_step` LLM 自动评分验证 + loop 指纹检测：逐条验收标准评分（pass/fail + 详细反馈），失败自动重试（≤2 次），**3 次不过升级阻塞干预**，不是模糊的"看起来差不多了"。
>
> 想要 Loop Engineering 能力但又无从下手？
>
> → `/loop-orchestrator` 一键启动：Q1-Q5 引导（目标→模式→策略→标准→确认），进入 6 阶段**全自主循环**（记忆加载→拆解→执行→阻塞干预→里程碑→交付），PM 只需给目标，系统自己转。

**这就是 Kimi Session Orchestrator 要解决的问题。** 你不是在手动操作 Agent——你是在设计一套**自动运转的编排系统**。拆解→派发→验证→修复→交付，PM 把关、Agent 执行、系统兜底。

---

## 目录

- [Loop Engineering](#loop-engineering-v29)
- [架构](#架构)
- [⛔ Agent自动部署必读](#-部署必读)
- [快速开始](#快速开始)
  - [前置条件](#前置条件)
  - [安装](#安装)
  - [启动](#启动)
  - [环境变量](#环境变量)
  - [注册到 Kimi Code CLI](#注册到-kimi-code-cli)
  - [Skill](#skill)
  - [更新工具](#更新工具)
- [MCP 工具](#mcp-工具)
  - [Session 管理](#session-管理)
  - [任务下发](#任务下发)
  - [状态监控](#状态监控)
  - [共享记忆](#共享记忆v25)
  - [工作流模板](#工作流模板)
  - [权限策略](#权限策略)
  - [推送](#推送)
- [REST API](#rest-api)
- [项目结构](#项目结构)
- [共享记忆系统](#共享记忆系统v25)
- [权限策略系统](#权限策略系统v24)
- [参考文档](#参考文档)
- [Linux 部署](#linux-部署)
- [常见问题 (FAQ)](#常见问题-faq)
- [参与贡献](#参与贡献)
- [版本历史](#版本历史)
- [License](#license)

## 架构

```
外部用户 (浏览器 / curl)
    ↕ HTTP + WebSocket (默认 3456，通过 TUNNEL_PORT 配置)
┌──────────────────────────────┐
│   kimi-session-orchestrator MCP 服务器 │
│   ├─ Express HTTP Server      │
│   ├─ WebSocket Server         │
│   ├─ WireClient (ISessionClient + IStatusClient + IPushClient) │
│   ├─ WorkflowEngine (自适应工作流)      │
│   ├─ SessionWatcher (WS 后台监听)       │
│   ├─ PolicyEngine (权限策略引擎)       │
│   ├─ MemoryStore (SQLite 共享记忆)     │
│   ├─ MessageQueue (WebSocket pub/sub)  │
│   ├─ OrchestrationStore (编排关系追踪) │
│   └─ MCP stdio transport      │
└─────────────┬────────────────┘
              ↕ Bearer Token REST API
┌─────────────────────────────┐
│   Kimi Server (kimi web)    │  端口自动检测
│   POST /api/v1/sessions/... │
└─────────────────────────────┘
```

## 行业痛点对照

AI 编码 CLI 工具在 8 大类场景中存在公认痛点，本项目逐一给出了系统化方案。

<details>
<summary><b>① 上下文腐化（Context Rot）</b></summary>

| 痛点 | 行业现状 | 本项目方案 |
|------|----------|-----------|
| **对话越长 AI 越笨** — Lost-in-the-Middle 效应：上下文 >50% 后优先遗忘早期内容 | Claude Code 提供 `/compact`；Web 版 ChatGPT/Claude 完全不显示上下文用量 | `session-retire` skill：≥2 衰减信号自动退役 → 7-block 交接 → 接班 session 零腐化 |
| **注意力涣散** — session 后期偏离规范、输出质量下降 | 多数工具依赖用户凭直觉开新聊天 | `/loop-orchestrator`：每次实施在独立 task session 中完成，干净上下文起步 |
| **上下文不可见** — 浏览器端工具无任何上下文用量指示 | Claude Code CLI 有百分比；Web 端完全无 | `poll_session` + `agent-session-monitor`：PM 随时查看 task session 状态，无需 API 认证 |
| **无效循环** — agent 声称"修好了"但实际未变，反复消耗 token | Replit / Claude Code 用户常见 | `grade_step` LLM 自动评分 ≤2 次重试 → 3 次不过升级阻塞；loop 指纹自动检测循环模式 |

</details>

<details>
<summary><b>② 会话交接（Session Handoff）</b></summary>

| 痛点 | 行业现状 | 本项目方案 |
|------|----------|-----------|
| **冷启动灾难** — 新 session 零上下文，需重新发现已完成工作和决策 | Anthropic 用 `claude-progress.txt` 桥接；LangGraph 用 checkpoint 快照 | `from_session` 参数自动拉取 handoff → 注入首条 prompt；7-block 模板：completed/pending/decisions + 记忆索引 |
| **手动交接繁琐** — 每次开新 session 手写总结，容易遗漏 | 行业最佳实践 5 层 handoff（状态快照 + 叙事 + 决策 + 优先级 + 警告） | `session-retire` pipeline 全自动：`memory_archive` 归档 → 结构化 handoff → 接班 session 5 步建完上下文 |

</details>

<details>
<summary><b>③ 执行验证（Execution Verification）</b></summary>

| 痛点 | 行业现状 | 本项目方案 |
|------|----------|-----------|
| **无法确认任务真正完成** — agent 说"看起来差不多了"，无量化验证 | SWE-bench 离线衡量；日常使用依赖人工 review | `grade_step`：逐条验收标准评分（pass/fail + 详细反馈），可量化判定 |
| **MCP 超时截断** — 耗时 >30s 的任务被协议超时截断 | 无标准化的异步工具模式 | 即发即返 + `Bash(run_in_background=true)` 后台轮询：零 token 等待，OS 进程退出自动通知 |
| **服务端崩溃中断任务** — Kimi Server ~20h OOM 后正在执行的任务丢失 | 大部分工具需手动重启 + 重做 | §9 断连 4 步自主恢复 (R1-R4)；`poll_command` 动态端口：Server 重启换端口后脚本不失效 |

</details>

<details>
<summary><b>④ 多 Agent 编排（Multi-Agent Orchestration）</b></summary>

| 痛点 | 行业现状 | 本项目方案 |
|------|----------|-----------|
| **无法有效分工** — 大任务不知如何拆解和协调 | Cursor Background Agents 独立 VM 并行；LangGraph 图状态管理 | `/loop-orchestrator`：PM 拆解 → 独立 task session 派发 → 并行/串行策略 → 6 阶段自主循环 |
| **子任务状态不可见** — PM 不清楚各 task session 进度和瓶颈 | Windsurf RAG 索引代码库；多数工具缺编排层 | `OrchestrationStore` PM→子 session 关系追踪；WebSocket 实时推送；`poll_session` WS 缓存优先 |
| **并行工作冲突** — 多个 agent 同时改同一文件 | Cursor 独立分支隔离 | PM 硬边界：仅用 MCP 工具编排，不直接操作代码；冲突在 PM 层消解 |

</details>

<details>
<summary><b>⑤ 记忆与知识持久化（Memory & Knowledge）</b></summary>

| 痛点 | 行业现状 | 本项目方案 |
|------|----------|-----------|
| **重复告知项目信息** — 每次新 session 重新描述项目结构、技术栈、规范 | Claude Code CLAUDE.md 持久化指令；LangChain JSON 文档存储 | `memory_set` 一次性录入 → `create_session(memory_level)` 自动注入索引 → task session 自主 `memory_get` 按需拉取（~200B 注入量） |
| **跨项目知识不共享** — 项目 A 的最佳实践无法应用到项目 B | 多数工具项目级记忆绑定到单仓库 | `resolveProjectRoot` 向上查找 `.kimi-tunnel/` → 每项目独立 memory.db → 跨项目自动匹配 |
| **记忆腐化** — 旧规范未过期，agent 引用过时信息 | Redis/Mem0 需手动管理 | `expire` 标记 + `include_expired` 过滤 + `memory_status` 过期条目列表 → PM 主动清理 |

</details>

此外，项目在以下方面也做了力所能及的探索——受限于 MCP 协议本身的边界（进程生命周期由宿主管理、无持久化运行时），这些方向实现的是"在可能的范围内尽量改善"而非根治：

- **权限与安全**：三层架构（session/任务/工具级）+ 3 内置策略 + 自定义 YAML + PM 手动 `approve_tool` / `deny_tool` 决策闭环
- **配置与可发现性**：`server-lock.ts` 自动检测端口避免硬编码；5 项 FAQ + `agent-session-monitor` 无需 API 诊断；skill 自动检测角色按需加载 guide
- **容错与恢复**：MCP stdio 优先启动防进程假死；`poll_command` 动态端口适配 Server 重启；五层离线防御（过期 lock 清理 + 心跳 + 退避重连 + WS 降级）

> 注：MCP 服务器作为子进程，无法独立控制自身生命周期、无法持久化后台任务、无法在宿主退出后继续运行。这些是协议层面的限制，需 MCP 规范演进或宿主侧改进才能根本解决。

---

## Loop Engineering（v2.12+）

已独立为 `loop-orchestrator` skill。用户 `/loop-orchestrator` 直接激活，不再从 `kimi-session-orchestrator` Q1 分叉。

详细设计见 `docs/superpowers/specs/2026-07-15-loop-orchestrator-v2-design.md`。

---

## ⛔ Agent自动部署必读

| # | 规则 | 违反后果 |
|---|------|----------|
| 1 | **不要在 `mcp.json` 的 `env` 中设置 `KIMI_SERVER_URL`** | Kimi Server 每次启动端口可能不同，硬编码会导致 `Connection refused` |
| 2 | **`KIMI_SERVER_TOKEN` 必须在 `mcp.json` 的 `env` 中设置** | 否则 tunnel 无法通过 Kimi Server 认证 |
| 3 | **Tunnel 端口自动从 `~/.kimi-code/server/lock` 检测** | 无需任何手动配置 |
| 4 | **安装后执行 `/reload`** | 否则 MCP 工具和 skill 不生效 |
| 5 | **更新代码后需重装 skill**：`git pull` → `npm run build` → 重装 skill → `/reload` | 仅 build 不更新 skill 文件 |

## 快速开始

### 前置条件

- **Node.js ≥ 22**（`node:sqlite` 内置模块要求）
- Kimi Code CLI ≥ 0.22.3
- Git Bash（Windows）或 bash（Linux/macOS）

### 安装

```bash
git clone https://github.com/FirenzeClaw/kimi-session-orchestrator.git
cd kimi-session-orchestrator
npm install
npm run build
```

### 启动

```bash
# 1. 启动 Kimi Server（Tunnel 自动从 ~/.kimi-code/server/lock 检测端口，无需显式指定 --port）
kimi web --no-open

# 2. 设置 token（Kimi Server 启动时打印）
export KIMI_SERVER_TOKEN="your-token-here"

# 3. 启动 Tunnel
npm start
```

Tunnel 启动后自动连接 Kimi Server，选择最近 session，初始化记忆库（如 `.kimi-tunnel/` 存在）。

> **端口自动检测**：Tunnel 启动时自动读取 `~/.kimi-code/server/lock` 获取 Kimi Server 实际端口。**不要在 `mcp.json` 或环境变量中硬编码 `KIMI_SERVER_URL`**——端口每次启动可能不同，硬编码会导致连接失败。仅在自动检测异常时才显式设置。

### 注册到 Kimi Code CLI

在 `~/.kimi-code/mcp.json` 中添加（路径按实际安装位置调整）：

```json
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["<项目绝对路径>/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "your-token-here"
      }
    }
  }
}
```

> **注意**：`KIMI_SERVER_URL` 无需设置——Tunnel 自动从 lock 文件检测端口。仅在需要覆盖自动检测时才显式设置。

然后 `/reload` 即可使用。

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|:--:|--------|------|
| `KIMI_SERVER_TOKEN` | ✅ 是 | — | Kimi Server 启动时打印的 Bearer Token |
| `KIMI_SERVER_URL` | 否 | 自动检测 | 覆盖 Kimi Server 地址，如 `http://127.0.0.1:5494` |
| `TUNNEL_PORT` | 否 | `3456` | Tunnel HTTP/WebSocket 监听端口 |
| `KIMI_CODE_HOME` | 否 | `~/.kimi-code` | Kimi Code CLI 数据目录（含 server/lock、sessions/） |

### Skill

本项目配套 7 个 skill，分为 **Agent 级**（新 session 自动加载）和 **PM 级**（统筹 session 按需调用）。

#### Skill 列表

| Skill | 级别 | 效果 |
|-------|:--:|------|
| `kimi-session-orchestrator` | Agent | 加载时触发最小启动协议（~73 行）：auto 检测 → Q1 角色维度（PM 规划派发/长轮次编排/执行者）→ 按需加载对应 guide（planning/orchestration/execute）。不再含 Loop Engineering 入口 |
| `agent-session-monitor` | Agent | 无需 API 认证，通过解析 wire.jsonl 尾部的状态机符号推断 task session 是正常运行/卡住/等待审批/已完成——API 不可用时的备选诊断手段 |
| `mcp-async-tool` | Agent | 提供 MCP 异步工具设计模式知识——当 task session 需要耗时 >30s 的操作时参考此模式避免协议超时截断 |
| `session-retire` | PM | 退役→接班自动化 pipeline：`memory_archive` 归档 → 提取 7-block 上下文交接模板 → 创建接班 session → 注入模板 → 新 session 自举。在注意力衰减或阶段转换时一键完成交接 |
| `loop-orchestrator` | PM | Loop Engineering 自主编排——独立 skill。用户给定目标后 PM 全权拆解→派发→验证→修复→交付，里程碑汇报，不降级目标。`/loop-orchestrator` 激活 |
| `xmind-orchestrated` | Agent | 困境分析升级版——task session 独立上下文 + 零认知污染注入。MCP 不可用时自动降级子 Agent |
| `xmind` | Agent | 本地子 Agent 困境分析（保留原版）——独立 Agent 打破思维惯性，zoom-out 宏观视角 |

#### 使用场景

| 场景 | 涉及 Skill | 触发条件 |
|------|-----------|----------|
| **Loop Engineering**：PM 全权拆解→派发→验证→修复→交付，里程碑汇报 | `loop-orchestrator` skill（独立激活） | 用户 `/loop-orchestrator` 启动 |
| **规划派发**：需求理解→工作分解→并行编排 | `kimi-session-orchestrator` → `guide-planning.md` | PM 意图=planning |
| **长轮次编排**：多轮多步骤编排，即发即返+后台轮询 | `kimi-session-orchestrator` → `guide-orchestration.md` | PM 意图=orchestration |
| **任务执行**：单个 task session 内执行具体开发任务 | `kimi-session-orchestrator` → `guide-execute.md` | task session 激活 execute 维度 |
| **API 不可用诊断**：Kimi Server 离线、token 失效、无法 poll | `agent-session-monitor` 直接读 wire.jsonl 尾部状态机 | `poll_session` 超时或 `get_tunnel_status` 返回 false |
| **耗时任务 >30s**：代码生成、批量处理、多轮编排 | `mcp-async-tool` 指导即发即返+后台轮询模式 | 预判任务耗时将超过 MCP 超时上限 |
| **注意力衰减退役**：上下文 ~360K、偏离规范、幻觉、重复工作 | `session-retire` pipeline Phase 1→5 自动交接 | ≥2 个衰减信号同时出现 |
| **里程碑阶段转换**：审查完成→修复开始、修复完成→验证开始 | `session-retire` 自动传递 7-block 上下文 + 记忆归档 | 前一阶段产出已审查合格 |
| **陷入复杂问题**：同一 bug 反复无进展、架构死胡同 | `xmind-orchestrated` 创建 task session 独立上下文分析 | 连续 3 轮未解决问题 |
| **快速困境分析**：简单架构决策、设计权衡 | `xmind` 本地子 Agent 独立分析 | 单轮可解决的宏观视角问题 |
| **MCP 不可用时降级**：tunnel 离线但需要困境分析 | `xmind-orchestrated` 自动降级为本地子 Agent | `xmind-orchestrated` 检测 MCP 不可用后自动 fallback |

#### 安装

```bash
# Agent 级 skill（新 session 自动加载）——安装到 ~/.agents/skills/
rm -rf ~/.agents/skills/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
rm -rf ~/.agents/skills/xmind-orchestrated
cp -r skills/xmind-orchestrated ~/.agents/skills/xmind-orchestrated
rm -rf ~/.agents/skills/xmind
cp -r skills/xmind ~/.agents/skills/xmind
cp skills/agent-session-monitor.md ~/.agents/skills/agent-session-monitor/SKILL.md
cp skills/mcp-async-tool.md ~/.agents/skills/mcp-async-tool/SKILL.md

# PM 级 skill（统筹 session 按需调用）——安装到 ~/.kimi-code/skills/
rm -rf ~/.kimi-code/skills/session-retire
cp -r skills/session-retire ~/.kimi-code/skills/session-retire

# PM 级 skill — Loop Orchestrator
rm -rf ~/.kimi-code/skills/loop-orchestrator
cp -r skills/loop-orchestrator ~/.kimi-code/skills/loop-orchestrator
```

新 session 加载 `kimi-session-orchestrator` skill 后自动触发最小启动协议——auto 检测 → Q1 角色维度 → 按需 Read 对应 guide。`/reload` 后生效。

### 更新工具

#### ⛔ 更新前检查

更新前确认以下前置条件，避免 `/reload` 后 MCP 连接失败：

| # | 检查项 | 验证方式 |
|---|--------|----------|
| 1 | **`kimi web` 运行中** | `curl http://127.0.0.1:<端口>/api/v1/meta`（需 token） |
| 2 | `KIMI_SERVER_TOKEN` 正确 | 对比 `cat ~/.kimi-code/server/lock` 端口与 `mcp.json` 中的 token |

> `kimi web` 未运行是最常见的更新后连接失败原因——Tunnel 启动时从 lock 文件读取端口，若 Kimi Server 不在线则报 `ECONNREFUSED`。详见 [FAQ](#常见问题-faq)。

#### 更新步骤

```bash
git pull
npm run build                              # 重新编译 TypeScript

# 更新 Agent 级 skill
rm -rf ~/.agents/skills/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
rm -rf ~/.agents/skills/xmind-orchestrated
cp -r skills/xmind-orchestrated ~/.agents/skills/xmind-orchestrated
rm -rf ~/.agents/skills/xmind
cp -r skills/xmind ~/.agents/skills/xmind

# 更新 PM 级 skill
rm -rf ~/.kimi-code/skills/session-retire
cp -r skills/session-retire ~/.kimi-code/skills/session-retire
rm -rf ~/.kimi-code/skills/loop-orchestrator
cp -r skills/loop-orchestrator ~/.kimi-code/skills/loop-orchestrator
```

#### 使更新生效

在 Kimi Code CLI 中执行 `/reload` 使 MCP 工具和 skill 变更生效。

> **原理**：`/reload` 会杀死旧 MCP 进程并重新启动，新进程加载更新后的 `dist/index.js`。仅 `git pull` + `npm run build` 不更新 skill 文件时，`/reload` 即可——编译输出已变更。若端口 3456 被旧孤儿进程占用，`/reload` 通常能清理；残留时手动 `taskkill /PID <pid>` 即可。

## MCP 工具

### Session 管理

| 工具 | 描述 |
|------|------|
| `create_session` | 创建新 session，支持 cwd/permission_mode/memory_level/from_session/policy |
| `list_sessions` | 列出所有 session（按更新时间倒序） |
| `get_session_info` | 查看 session 详情（含 wire.jsonl 路径、标题、cwd） |
| `get_tunnel_status` | Wire 连接状态、客户端数、运行时间、WS 连接状态 |

### 任务下发

| 工具 | 描述 |
|------|------|
| `execute_prompt` | 发送 prompt（即发即返），支持 auto_mode/thinking/policy/skip_memory |
| `chat_with_session` | 向已有 session 发送任务（即发即返） |
| `run_flow` | 多步流程：创建 session → 逐步下发 → 自动等待每步完成 |
| `execute_workflow` | 执行工作流模板：加载模板 → 自动驱动 → 自适应调整 |
| `continue_workflow` | 对暂停的工作流执行决策（retry/skip/abort/manual） |

### 状态监控

| 工具 | 描述 |
|------|------|
| `poll_session` | 结构化轮询 session 状态（WS 缓存优先，active/swarm/awaiting/done/error/idle） |
| `list_io_records` | 快速提取 prompt ↔ 回复（过滤 tool_call/thinking 噪音） |
| `read_session_log` | 读取完整对话日志，支持分页和增量 |
| `watch_session` | WS 后台监听，主动等待 session 完成 |
| `get_watch_result` | 获取后台监听结果（非阻塞） |
| `continue_watch` | 拿结果 + 发下一步 + 启动新监听 |

### 共享记忆（v2.5+）

| 工具 | 描述 |
|------|------|
| `memory_set` | 写入键值对到命名空间，自动版本递增 |
| `memory_get` | 读取条目，支持 namespace/key 过滤 + 过期条目 |
| `memory_list` | 列出命名空间键名（前缀匹配） |
| `memory_delete` | 删除指定条目 |
| `memory_status` | 知识库全景：条目数、命名空间分布、最后更新 |
| `memory_archive` | 将 session L2 findings 归档为 L1 learnings |

> **v2.6 注入策略**：`create_session(memory_level)` 自动注入**记忆索引**（命名空间 + 键名 + 读取建议），task session 首 turn 自主调用 `memory_get` 按需拉取。注入文本从 ~600B 降至 ~200B。

### 工作流模板

| 工具 | 描述 |
|------|------|
| `learn_workflow` | 从描述或历史 session 学习工作流，生成 YAML 模板 |
| `list_templates` | 列出可用模板（名称、版本、步骤数） |

### 权限策略

| 工具 | 描述 |
|------|------|
| `list_policies` | 列出内置 + 自定义策略，含验证状态 |
| `approve_tool` | PM 放行被阻断的工具调用（once/session scope） |
| `deny_tool` | PM 拒绝被阻断的工具调用 |

### 验证评分

| 工具 | 描述 |
|------|------|
| `grade_step` | LLM 自动评分验证——对 task session 产出按标准评分，返回 pass/fail + 反馈 |

### 推送

| 工具 | 描述 |
|------|------|
| `stream_response` | 实时推送结果到所有 WebSocket 调试客户端 |
| `set_watch_output` | 设置监听结果文件路径，完成后自动写入 |

## REST API

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/status` | GET | 隧道状态：wire 连接、客户端数、运行时间 |
| `/api/orchestrations` | GET | PM→子 session 编排关系列表 |
| `/api/token` | GET | 获取 Kimi Server Token（仅限 localhost 访问） |
| `/api/execute` | POST | 发送 prompt 并等待回复 |
| `/ws` | WebSocket | 实时双向通信 |

### 示例

```bash
# 端口默认 3456，也可通过 TUNNEL_PORT 设置
curl -X POST http://localhost:${TUNNEL_PORT:-3456}/api/execute \
  -H "Content-Type: application/json" \
  -d '{"prompt":"你的 prompt","timeout_ms":60000}'
```

## 智能思考过滤

- **默认**：排除思考链内容，仅返回文本回复
- **自动触发**：当回复含"不确定/可能/需要更多"等模糊词时，自动读取思考内容确认意图
- **手动**：设置 `include_thinking: true` 强制包含

## 项目结构

```
src/
├── index.ts                     # 入口：DI 装配，启动 HTTP+MCP，初始化记忆库和编排追踪
├── types.ts                     # ISessionClient / IStatusClient / IPushClient / IMemoryStore / IWorkflowEngine + TunnelServices
├── mcp-server.ts                # MCP stdio 服务器（注册 29 个工具）
├── http-server.ts               # Express + WebSocket + /api/orchestrations + /api/token
├── wire-client.ts               # Kimi Server REST + WS 推送（实现 ISessionClient/IStatusClient/IPushClient）
├── message-queue.ts             # WebSocket pub/sub 广播
├── orchestration-store.ts       # PM→子 session 编排关系内存追踪
├── session-store.ts             # 文件系统扫描 + 路径解析
├── session-log-reader.ts        # wire.jsonl 日志解析 + IO 提取 + sanitizeText
├── workflow-template.ts         # 模板类型定义 + YAML 解析 + Zod 校验
├── workflow-store.ts            # 模板持久化（templates/ CRUD）
├── workflow-engine.ts           # 自适应工作流引擎
├── policy-types.ts              # 策略类型 + Zod schema + 已知工具清单
├── policy-builtins.ts           # read-only / safe-edit / full-access
├── policy-store.ts              # YAML 策略文件 CRUD
├── policy-engine.ts             # 策略解析/检查/绑定
├── memory-store.ts              # SQLite 持久化 + buildInjection() + 记忆profiles
├── session-watcher.ts           # WS 事件驱动后台监听（3s 检查状态，完成时自动拉取回复）
├── poll-command.ts              # Bash 轮询脚本生成（curl + Python urllib fetch）
├── wire-transport.ts            # REST 底层 HTTP 传输
├── server-lock.ts               # Kimi Server 端口自动检测（lock 文件解析）
├── tools/                       # 29 个 MCP 工具
│   ├── helpers.ts               # injectMemoryIntoPrompt + preparePrompt + ensureConnected + setMemoryProfileWithExpiry
│   ├── manifest.ts              # 工具注册桶文件（统一导入点）
│   ├── create-session.ts        # + 编排追踪
│   ├── run-flow.ts              # + 编排追踪
│   ├── execute-workflow.ts      # + 编排追踪
│   └── ...

shared/                          # 浏览器端共享 JS（ES2020+）
├── api.js                       # Tunnel + Kimi Server API 客户端
├── state.js                     # Session 树状态管理
├── renderer.js                  # DOM 渲染（复用页面原生样式）
├── injector.js                  # DOM 注入 + token 自动填入
└── styles.css                   # 最小注入样式

ext/                             # Chrome MV3 扩展
├── manifest.json                # content_scripts → Kimi Web UI 页面
├── content.js                   # 扩展入口
├── service-worker.js
├── options.html                 # 端口配置页
├── options.js
└── icons/

userscript/                      # Tampermonkey 用户脚本源
└── （构建输出到 dist/userscript/）

scripts/
└── build-userscript.mjs         # 共享代码内联 → .user.js

skills/                          # 配套 Skill（7 个）
├── kimi-session-orchestrator/   # Agent 级——MCP 工具使用规范
├── xmind-orchestrated/          # Agent 级——task session 隔离困境分析
├── xmind/                       # Agent 级——本地子 Agent 困境分析（保留原版）
├── session-retire/              # PM 级——退役与接班自动化 pipeline（v2.7 新增）
├── loop-orchestrator/           # PM 级——Loop Engineering 自主编排（v2.11+ 独立）
├── agent-session-monitor.md     # wire.jsonl 状态推断
└── mcp-async-tool.md            # 异步工具设计模式
```

> **v2.7 变更**：`src/public/console.html` 和 `workflow-console.html` 已移除。监控 UI 迁移至浏览器扩展 + JS 脚本插件，直接注入 Kimi Web UI 侧边栏。新增 `session-retire` skill——退役→接班自动化 pipeline（memory_archive + 7-block 模板 + 新 session 启动自举协议）。
>
> **v2.11 变更**：架构深化第2轮——IWireClient（20方法）拆分为 ISessionClient/IStatusClient/IPushClient 三个聚焦接口；消除 ambient sessionId（submitPrompt/sendPrompt/getSessionStatus 参数化，8个save/restore块删除）；apiGet/apiPost → getSessionMessages/resolveApproval 语义方法；记忆注入统一到 helpers.ts（injectMemoryIntoPrompt + setMemoryProfileWithExpiry）；移除 WorkflowEngine `||` 回退（workflowEngine 非可选）；tools/manifest.ts 桶文件；session-log-reader 共享 parseWireJsonl 解析流。
>
> **v2.10 变更**：架构深化——WireClient 上帝类拆分，新增 IWireClient 接口 + `server-lock.ts`；删除 `memory-injector.ts`（死代码）；新增 `tools/helpers.ts`（preparePrompt + ensureConnected，消除 4 处重复样板）；记忆 profile 从 WireClient 移至 MemoryStore；WorkflowEngine/SessionWatcher 改用 IWireClient；`workflow-store.ts` 手写 toYaml → js-yaml dump；移除 `/api/send` 死端点。
>
> **v2.8.5 修复**：`buildInjection()` 空守卫在 project 知识库为空时过早返回，截断 `fromSession` handoff 注入——`session-retire` 交接数据被静默丢弃。修复：handoff 提前收集 + 联合判空 + handoff-only 分支 + 去重。
>
> **v2.8 变更**：`buildInjection()` 注入文本 `memory_get("ns")` → `memory_get(namespace="ns")`——消除工具名歧义；REST API 端点删过时补漏（移除已删除的 `/` 和 `/workflow-console.html`，补充 `/api/orchestrations`、`/api/token`）；新增"更新工具"章节；全文档过时内容清理。

## 共享记忆系统（v2.5+）

```
┌─────────────────────────────────────────────────┐
│ L1: 项目知识库 (.kimi-tunnel/memory.db)          │
│ PM 一次性录入 → task session 启动时自动注入索引    │
│ project/meta / decisions / risks / learnings    │
├─────────────────────────────────────────────────┤
│ L2: Session 上下文 (session:<id>/*)             │
│ 创建时写入，运行时更新，退役后归档                  │
├─────────────────────────────────────────────────┤
│ L3: 学习沉淀 (learn skill → 向量库)              │
│ 从 L1+L2 提取可复用模式                          │
└─────────────────────────────────────────────────┘

PM 操作:                            Task session 首 turn:
  memory_set(ns, key, value)         → 收到索引 → memory_get(namespace=ns)
  create_session(memory_level=full)  → 评估关联 → 拉取条目 → 执行任务
  execute_prompt(task)               → 同一 turn 完成上下文建立 + 工作
```

## 权限策略系统（v2.4+）

- **三层架构**：Session 级策略（create_session permission_mode）+ 任务级策略（policy 参数）+ 工具级回调（Bash 检测 awaiting_approval → PM 手动 approve_tool / deny_tool）。已移除 approveAll 自动裁决，改为 PM 决策闭环。
- **3 内置策略**：`read-only`（只读）/ `safe-edit`（安全编辑，禁 shell 命令）/ `full-access`（全部允许）
- **自定义 YAML**：`.kimi-tunnel/policies/<name>.yaml`
- **PM Dashboard**：实时阻断事件面板，支持 approve/deny（once/session scope）

## 参考文档

| 文档 | 用途 |
|------|------|
| `API.md` | Kimi Server REST API 完整参考 |
| `docs/coordinator-guide.md` | 统筹 Session 准入规范（PM视角 v2.8） |
| `docs/issues/memory-init-timing.md` | [FIXED] MemoryStore 启动初始化缺陷 |
| `docs/issues/memory-cross-project-injection.md` | [FIXED] 跨项目注入静默失效 |
| `docs/issues/grade-step-empty-response.md` | [FIXED] grade_step 两项修复：grader 无数据评分 + JSON 截断容错 |
| `docs/issues/memory-call-namespace-mismatch.md` | [FIXED] Skill memory_get/set 调用格式错误——两类：位置参数 + key-in-namespace（17处，2个skill） |
| `docs/issues/mcp-wire-offline-freeze.md` | [FIXED] MCP 进程在 Kimi Server 离线时假死——stdio 优先启动 |
| `specs/001-adaptive-workflow-engine/` | 自适应工作流引擎 [DONE] |
| `specs/002-session-memory-share/` | Session 冷启动记忆共享 [DONE] |
| `specs/003-permission-policy/` | 权限与策略管理 [DONE] |
| `specs/004-memory-lazy-inject/` | 记忆注入策略升级——索引+按需自读 [DONE] |
| `specs/005-web-ui-extension/` | Kimi Web UI 编排监控插件——浏览器扩展+JS脚本双版本 |
| `docs/loop-engineering-analysis.md` | Loop Engineering 概念与本项目架构逐项对照分析——四层循环堆栈/三级 Agent Loop/差距识别/改进方向 |
| `docs/superpowers/specs/2026-07-11-skill-split-design.md` | [DONE] Skill 拆分加载架构设计 |
| `docs/superpowers/plans/2026-07-11-skill-split.md` | [DONE] Skill 拆分实现计划 |

## Linux 部署

前置条件、安装、启动、MCP 注册、Skill 安装与上方 [快速开始](#快速开始) 完全一致。以下仅补充 Linux 特有的注意事项。

### 注册 MCP（Linux 路径示例）

```bash
mkdir -p ~/.kimi-code

cat > ~/.kimi-code/mcp.json << 'EOF'
{
  "mcpServers": {
    "kimi-session-orchestrator": {
      "command": "node",
      "args": ["/home/user/kimi-session-orchestrator/dist/index.js"],
      "env": {
        "KIMI_SERVER_TOKEN": "<token>"
      }
    }
  }
}
EOF
```

> `args` 中的路径需为绝对路径，按实际 clone 位置调整。`/reload` 后生效。

### 构建兼容性

项目 `package.json` 的 build 脚本使用 `cp -r`，兼容 Linux。

### 平台兼容性

| 组件 | Linux | 备注 |
|------|:--:|------|
| `node:sqlite` | ✅ | Node 22+ 内置 |
| `path.join/dirname` | ✅ | 全项目使用跨平台 API |
| 文件路径 | ✅ | 统一 `replace(/\\/g, "/")` 归一化 |
| MCP stdio | ✅ | 标准协议 |
| Kimi Server CLI | ✅ | `kimi web` 跨平台 |
| Wire Client 重连 | ✅ | MCP stdio 优先启动（v2.9.1），wire 连接后台异步；启动失败后每 10s 自动重试 |
| Kimi Server 端口 | ✅ | 自动从 `~/.kimi-code/server/lock` 检测 |

## 常见问题 (FAQ)

<details>
<summary><b>Tunnel 连接失败，日志显示 Connection refused on 5494？</b></summary>

**根因**：`mcp.json` 或环境变量中硬编码了 `KIMI_SERVER_URL=http://127.0.0.1:5494`。Kimi Server 每次启动端口可能不同，硬编码会导致连接被拒。

**解决**：从 `mcp.json` 的 `env` 中**删除** `KIMI_SERVER_URL` 行。Tunnel 自动从 `~/.kimi-code/server/lock` 检测实际端口，无需手动设置。仅在自动检测异常时才需要覆盖。
</details>

<details>
<summary><b>为什么 task session 调用 <code>memory_get</code> 失败？</b></summary>

**根本原因**：注入文本告诉 task session 调用 `memory_get`，但该工具属于 `kimi-session-orchestrator` MCP 服务器。如果 task session 的 `~/.kimi-code/mcp.json` 中没有注册此服务器，session 会找不到工具，或误调其他 MCP 服务器的同名工具。

**解决方案**：
1. 确保 `~/.kimi-code/mcp.json` 中已注册 `kimi-session-orchestrator`（见上方 [注册到 Kimi Code CLI](#注册到-kimi-code-cli)）
2. 注册后执行 `/reload`，task session 即可使用 `memory_get` 等工具
3. 全局 `mcp.json` 对所有 session（包括 task session）生效——配置一次即可
</details>

<details>
<summary><b>Kimi Server 崩溃/重启后 Tunnel 如何处理？</b></summary>

Tunnel 内置五层离线防御，无需人工干预：

| 机制 | 行为 |
|------|------|
| **过期 lock 自动清理** | 启动时检测 lock 文件 PID 是否存活——已死则自动删 lock + 打印诊断（含 PID/启动时间/修复命令），避免 `kimi web` 和 Tunnel 双重失败 |
| **心率探测** | 每 10 秒 ping Kimi Server `/api/v1/meta` |
| **断连判定** | 连续 3 次心跳失败 → 标记 `connected=false` |
| **REST 自动重连** | 断连后立即尝试重连，指数退避 1s→32s（6 次），之后每 10s 持续重试。**每次重连前重新检测 lock 端口**——过期 lock 已自动清理，新 `kimi web` 的端口会被自动感知 |
| **WebSocket 独立重连** | WS 断开后独立退避 3s→60s（最多 10 次），耗尽后降级为 REST 轮询 |

**PM 侧表现**：
- 短时中断（< 30s）：`get_tunnel_status` 返回 `wireConnected: false`，恢复后自动重连
- 长时间中断：健康确认后自动恢复，`wireConnected` 重新变为 `true`
- 正在运行的 task session 不受影响——prompt 已提交到 Kimi Server 端
</details>

<details>
<summary><b>创建 task session 前需要确认什么？</b></summary>

PM 应在创建 task session 前确认以下 4 项（一次性配置）：

| # | 检查项 | 验证方式 |
|---|--------|----------|
| 1 | Kimi Server 运行中 | `curl localhost:<端口>/api/v1/meta`（需 token） |
| 2 | `KIMI_SERVER_TOKEN` 已设置 | `echo $KIMI_SERVER_TOKEN` |
| 3 | `mcp.json` 已注册 orchestrator | 检查 `~/.kimi-code/mcp.json` 含 `kimi-session-orchestrator` |
| 4 | Skill 已安装 | `ls ~/.agents/skills/kimi-session-orchestrator/SKILL.md` |

其中第 3 项决定 task session 能否使用 `memory_get` 等编排工具——这是最常见的配置遗漏。
</details>

<details>
<summary><b>Tunnel 启动后报 "Wire client not connected"？</b></summary>

1. 确认 Kimi Server 正在运行：`kimi web --no-open`
2. 确认 `KIMI_SERVER_TOKEN` 已正确设置
3. Tunnel 会在启动失败后每 10s 自动重试连接，等待 1-2 分钟即可
</details>

<details>
<summary><b>MCP 启动时会自动唤起 Kimi Web Server 吗？</b></summary>

**不会。** Orchestrator 是纯客户端，只连接到已运行的 Kimi Server。两者是独立进程，必须先单独启动 `kimi web --no-open`，再 `/reload` 或启动 Tunnel。

Orchestrator 会通过 lock 文件自动检测 Kimi Server 端口；若 Server 未运行，Tunnel 每 10s 自动重试连接，但不会主动拉起 Server 进程。
</details>

<details>
<summary><b>更新代码后 Skill 没有生效？</b></summary>

仅 `git pull` + `npm run build` 不更新 skill 文件。Skill 是独立拷贝到用户目录的，需要手动重装：

```bash
rm -rf ~/.agents/skills/kimi-session-orchestrator
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
rm -rf ~/.agents/skills/xmind-orchestrated
cp -r skills/xmind-orchestrated ~/.agents/skills/xmind-orchestrated
```

然后 `/reload`。
</details>

<details>
<summary><b>/reload 后 MCP 超时 "Timed out after 30000ms"？</b></summary>

**根因**：`kimi web` 未运行或已崩溃。v2.9.1 起 MCP stdio 已优先启动——wire 离线时工具调用返回 "Wire client 未连接" 而非进程崩溃。出现此错误通常是 Kimi Server 进程已退出。

**解决**：确认 `kimi web --no-open` 运行中，然后 `/reload`。
</details>

<details>
<summary><b>端口被占用（默认 3456）？</b></summary>

设置 `TUNNEL_PORT` 环境变量更换端口，MCP stdio 功能不受影响。

```bash
export TUNNEL_PORT=3457
npm start
```
</details>

## 参与贡献

- **Bug 报告 / 功能请求**：[GitHub Issues](https://github.com/FirenzeClaw/kimi-session-orchestrator/issues)
- **代码贡献**：Fork → Feature Branch → Pull Request。提交前确保 `npm run build` 零错误。
- **文档规范**：参考 `docs/coordinator-guide.md` 了解项目约定。

## 版本历史

| 日期 | 版本 | 变更 |
|------|:--:|------|
| 2026-07-16 | v2.12.3 | **MCP 去歧义 + 断连恢复 + 轮询动态端口**：① `buildInjection()` 注入 ⛔ 前缀指定 `kimi-session-orchestrator` MCP——修复 task session 调错 `memory` 知识图谱 MCP 同名工具；② loop-orchestrator 新增 §9 Kimi Server 断连 4 步自主恢复（R1-R4），5 个 guide 引用；③ `poll_command` 从硬编码端口改为每次轮询动态读 lock 文件——Server 重启换端口后脚本不再失效；④ 确认 Kimi Server OOM 崩溃为断连根因（~20h 运行后堆耗尽） |
| 2026-07-16 | v2.12.2 | **Loop 自循环协议序列化**：§3 执行循环从箭头流程图重构为 7 步编号门控协议（STEP 1-7，每步 ✓ 门控 + ⛔ 阻断点）。修复 PM 遗忘 Bash 后台监控问题——execute_prompt→Bash 从建议变为不可跳过步骤，SKILL.md 新增 4 项自检清单。verify/implement/parallel 统一引用核心 STEP 编号 |
| 2026-07-16 | v2.12.1 | **Skill memory 调用格式修复**：`session-retire` 7-block 模板 `memory_get` namespace 拼写错误（`session/<id>/handoff/completed` → `session/<id>/handoff`），致接班 session 手动读取返回空（`fromSession` 注入正常）；`loop-orchestrator` 5 文件 17 处修复——`memory_get` 位置参数→命名参数（防 MCP 工具名冲突）+ `memory_set` key-in-namespace 拆分。详见 skills 代码 |
| 2026-07-15 | v2.12 | **Loop Orchestrator v2**：Loop Engineering 独立为 `loop-orchestrator` skill（9 文件）——从 `kimi-session-orchestrator` 完全剥离。PM 硬边界（仅 MCP 工具）、6 阶段自主循环（记忆加载→拆解→执行→阻塞干预→里程碑→交付）、注入防腐化（单次 ≤3 项/≤500 字）、Memory 全程集成、用户中断保护。主 skill Q1 移除 Loop 入口，删除旧 guide-loop-*.md 7 文件。详见 `docs/superpowers/specs/2026-07-15-loop-orchestrator-v2-design.md` |
| 2026-07-15 | v2.11 | **架构深化第2轮**：IWireClient → ISessionClient/IStatusClient/IPushClient 三接口拆分（20法→7/2/8）；消除 ambient sessionId 并发竞态（submitPrompt/sendPrompt/getSessionStatus 参数化，8个save/restore块删除）；apiGet/apiPost → getSessionMessages/resolveApproval 语义方法；记忆注入统一到 helpers.ts（injectMemoryIntoPrompt + setMemoryProfileWithExpiry，消除2处副本）；移除 WorkflowEngine `||` 回退（TunnelServices.workflowEngine 非可选）；tools/manifest.ts 桶文件统一注册；session-log-reader 共享 parseWireJsonl 解析流（3个parser→1个generator）。净 -150 行重复代码，15/15 E2E 通过 |
| 2026-07-15 | v2.9.1 | **grade_step 两项修复**：① 评分前拉取目标 session IO 产出（修复 grader 无数据评分）；② JSON 截断容错——正则 fallback 提取 pass/score（修复反馈过长→score=0 误报）。**MCP stdio 优先启动**：`startMcpServer` 移至 `wireClient.connect` 之前，connect 改为后台异步（修复 Kimi Server 离线时 MCP 进程假死）。并行 Loop demo 验证通过 |
| 2026-07-15 | v2.9.0 | **Loop Engineering 验证闭环**——Q1 A入口 + 7分层guide + `grade_step` LLM评分工具 + loop指纹检测。PM 可选实施/验收模式、单/并行策略，guide 按需加载节省56-60% token |
| 2026-07-15 | v2.8.5 | **修复 `fromSession` handoff 注入被空守卫截断**（`memory-store.ts` `buildInjection()`）：project 知识库为空时提前返回 "无共享记忆条目"，导致 `session-retire` 写入的 handoff 数据（completed/pending/decisions）被静默丢弃，新 session 仅收到 7-block 模板文本。修复后 handoff 收集提前到空守卫之前，联合判空，新增 handoff-only 分支，去重 DB 查询。`agent-tool-reliability` 项目实测验证 |
| 2026-07-14 | v2.8.4 | poll_command `fetch_result` 彻底修复：curl 管道截断 → Python `urllib` 直连 HTTP；`2>/dev/null` 移除（错误不再静默吞）；Windows GBK emoji 乱码 → `PYTHONIOENCODING=utf-8` |
| 2026-07-14 | v2.8.3 | `detectKimiServerUrl()` 过期 lock 自动清理——PID 活性检测 + 自动删 lock + `connect()` 重连前 URL 重新检测 |
| 2026-07-12 | v2.8.1 | "更新工具"章节补全：新增更新前检查（kimi web 运行 + token 校验）+ 孤儿进程清理 + `/reload` 原理说明；本机实测确认 kimi web 未运行是 ECONNREFUSED 最常见根因 |
| 2026-07-11 | v2.8 | Skill 拆分加载 + xmind-orchestrated（task session 隔离困境分析）+ 注入格式修正 + poll-command 离线检测 + 全文档重构 |
| 2026-07-09 | v2.7 | 新增 `session-retire` skill：退役→接班自动化 pipeline；PM Dashboard 迁移至浏览器扩展 |
| 2026-07-08 | v2.6 | 记忆注入策略升级：全量预载 → 索引+按需自读（三级格式）；注入文本 ~600B→~200B |
| 2026-07-08 | v2.5 | 三层共享内存系统：MemoryStore + 6 个 memory_* MCP 工具 + 自动注入 |
| 2026-07-07 | v2.4 | 三层权限系统：策略引擎 + 3 内置策略 + 自定义 YAML |
| 2026-07-07 | v2.3 | PM Dashboard 重写；coordinator-guide v2.3（PM 范式/Skill 调度/注意力管理） |
| 2026-07-06 | v2.0 | 自适应工作流引擎；即发即返模式；WS 状态缓存 |
| 2026-07-05 | v1.0 | 初始版本 |

## License

MIT
