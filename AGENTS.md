<!--
修改记录:
  2026-07-06 | kimi-code (arch) | 确定后台监听最佳方案：Bash REST 轮询（OS进程信号驱动，零开销），set_watch_output 降为备选；修复 WS 直接帧处理、ESM require 兼容
  2026-07-06 | kimi-code (feature) | 新增 watch_session/get_watch_result/continue_watch/set_watch_output 4工具：WS 后台监听 + 自动化循环 + 文件输出
  2026-07-06 | kimi-code (architecture) | 架构深化 8/8 项：删除 session-manager+flowOrchestrator、message-queue简化为pub/sub、WireClientFactory DI、run_flow统一到WorkflowEngine、WS推送状态缓存、poll_session WS快路径
  2026-07-06 | kimi-code (bugfix) | selftest 修复：WireClient.connect 缺失、activeExecutions 泄漏、model/thinking 参数被忽略、escapeYaml 转义不完整
  2026-07-06 | kimi-code (feature) | 新增自适应工作流引擎：learn_workflow/execute_workflow/list_templates/continue_workflow 4个工具 + 模板存储 + Web 监管页面
  2026-07-06 | kimi-code (bugfix) | 修复 run_flow /auto 注入：不设 session 级 permission_mode，改用 REST API autoApprove；submitPrompt 新增 autoApprove 重试机制
  2026-07-06 | kimi-code (bugfix) | 修复 chat_with_session/run_flow/execute_prompt MCP 超时：移除阻塞 wait 路径，统一即发即返 + 自动重连
  2026-07-06 | kimi-code (architecture) | 架构深化（6/6 项）：① 消除 9 文件 584 行死代码 ② 拆分 session-manager 为 store+reader（576→72 行） ③ 消除 3 个单例为 DI（wireClient/messageQueue/startTime） ④ WireClient 拆分跳过（收益边际） ⑤ 激活 TunnelServices DI ⑥ 统一路由/WS 模式（保持内联）
  2026-07-06 | kimi-code (feature) | 新增 poll_session 工具：结构化轮询 session 运行状态，替代后台 bash 监控
  2026-07-06 | kimi-code (feature) | 新增 create_session 工具：通过 REST API 创建新 session，支持权限模式 auto/manual/yolo
  2026-07-06 | kimi-code (feature) | execute_prompt / chat_with_session 新增 wait 参数（默认 false）：即发即返不阻塞；新增 submitPrompt 快通道
  2026-07-06 | kimi-code (feature) | execute_prompt / chat_with_session 新增 auto_mode 参数：自动通过 API 审批所有工具调用
  2026-07-06 | kimi-code (polish) | 工具质量提升：readSessionLog 分页修复、tool_call 截断、get_session_info 含 wirePath、超时诊断提示
  2026-07-06 | kimi-code (feature) | 新增 list_io_records 工具
  2026-07-06 | kimi-code (bugfix) | 修复 EADDRINUSE 多 session 冲突
  2026-07-05 | kimi-code (project-init) | 初始生成
-->

<!-- AUTO:PROJECT-META -->
## 项目元信息

- **项目**: kimi-debug-tunnel
- **仓库**: https://github.com/FirenzeClaw/kimi-debug-tunnel.git
- **分支**: master
- **技术栈**: TypeScript 5.6, Node.js ≥ 18, Express 4, WebSocket (ws), MCP SDK 1.12, Zod 3
- **类型**: MCP 服务器 + HTTP/WebSocket 调试隧道
- **初始化时间**: 2026-07-05T16:11:30Z
<!-- AUTO:END -->

<!-- AUTO:STRUCTURE -->
## 目录结构

```
src/
├── index.ts                 # 入口：创建 TunnelServices，启动 HTTP+MCP 双服务器
├── types.ts                 # TunnelServices 接口（wireClient, messageQueue, startTime, workflowEngine）
├── mcp-server.ts            # MCP stdio 服务器，注册全部 18 个工具
├── http-server.ts           # Express + WebSocket 装配入口（薄层）
├── wire-client.ts           # Kimi Server REST + WS 推送客户端（状态缓存）
├── message-queue.ts         # WebSocket 客户端注册 + pub/sub 广播（简化为 67 行）
├── session-orchestrator.ts  # 多轮任务编排引擎（不再被 chat_with_session 使用）
├── workflow-template.ts     # 工作流模板类型定义 + YAML解析 + 校验
├── workflow-store.ts        # 模板持久化（CRUD：list/load/save/delete）
├── workflow-engine.ts       # 自适应工作流引擎：创建session→逐步驱动→阻塞处理→恢复
├── session-watcher.ts        # WS 事件驱动后台监听：每3s检查状态，完成时自动拉取回复
├── tools/
│   ├── execute-prompt.ts    # 发送 prompt 并等待完整回复
│   ├── create-session.ts    # 通过 REST API 创建新 session
│   ├── chat-with-session.ts # 全自动多轮编排
│   ├── stream-response.ts   # 实时推送到所有 WebSocket 客户端
│   ├── list-sessions.ts     # 列出所有 session
│   ├── get-session-info.ts  # 查看 session 详情
│   ├── read-session-log.ts  # 读取对话日志
│   ├── list-io-records.ts   # 快速查看输入输出记录（仅 prompt+回复）
│   ├── poll-session.ts      # 结构化轮询 session 运行状态（WS 缓存优先）
│   ├── run-flow.ts           # 分步流程执行引擎
│   ├── learn-workflow.ts    # 从描述或历史session学习工作流模板
│   ├── execute-workflow.ts  # 执行工作流模板：创建session→逐步驱动→自适应调整
│   ├── list-workflow-templates.ts # 列出可用模板
│   ├── continue-workflow.ts # 对暂停的工作流执行决策（重试/跳过/终止/覆盖）
│   ├── session-watch.ts     # watch_session/get_watch_result/continue_watch 后台监听
│   └── get-tunnel-status.ts # Wire 连接状态、客户端数、运行时间
└── public/
    ├── console.html          # Web 调试控制台
    └── workflow-console.html # 工作流实时监管页面（WebSocket 进度推送）
```
<!-- AUTO:END -->

<!-- AUTO:BUILD -->
## 构建与运行

```bash
npm install          # 安装依赖
npm run build        # tsc 编译 + 复制静态文件到 dist/
npm start            # node dist/index.js（需先 build 且 Kimi Server 运行中）
npm run dev          # tsc --watch
npm run inspector    # MCP Inspector 调试模式
```

**前置条件**：
1. 启动 Kimi Server: `kimi web --no-open --port 5494`
2. 设置 token: `export KIMI_SERVER_TOKEN="<printed-at-startup>"`
3. 启动 Tunnel: `npm start`
<!-- AUTO:END -->

## 项目约定

<!-- AUTO:CONVENTIONS -->
### 架构原则

- **依赖注入**: 所有模块通过 `TunnelServices` 接口接收依赖，禁止模块级 `export const` 单例
- **深模块优先**: 每个模块遵循"小接口、大实现"原则 —— 接口复杂度 < 实现复杂度
- **接缝验证**: 每个抽象至少要有两个适配器（生产运行时 + 测试 mock），否则视为假设接缝
- **单一职责**: 每个文件只做一件事（Transport 只管 HTTP、ContentProcessor 只管文本处理）

### 编码风格

- 函数命名：动词短语（`extractText`, `findById`）
- 类型优先：所有函数签名显式标注返回类型，禁止 `any`
- Guard Clauses 优先，嵌套 ≤ 3 层
- 注释只写 why，不写 how
- TypeScript strict 模式，ES2022 target，Node16 模块

### 模块分层

```
入口层:    index.ts（创建服务容器、装配、启动）
传输层:    http-server.ts, mcp-server.ts
工具层:    tools/*（MCP 工具注册）
业务层:    wire-client.ts, session-orchestrator.ts, workflow-engine.ts, session-watcher.ts
数据层:    message-queue.ts, workflow-template.ts, workflow-store.ts, session-log-reader.ts
类型层:    types.ts
```
<!-- AUTO:END -->

## 标准工作流

全自动 session 编排的标准流程：

### MCP 工具使用规则（必读）

> **核心原则**：向任务 session 提交 prompt 后，**必须使用 Bash 后台任务轮询等待回执**，绝不在当前 turn 内阻塞等待。

| 规则 | 说明 |
|------|------|
| **即发即返** | `execute_prompt` / `chat_with_session` / `run_flow` 默认 `wait=false`，立即返回 `{ submitted: true }` |
| **后台轮询** | 提交后用 `Bash(run_in_background=true)` 启动 `while` 循环，curl poll session status |
| **零 token 等待** | 后台 bash 进程由 OS 管理，不消耗当前 turn 的 token，退出时 runtime 注入 `<notification>` |
| **禁止阻塞** | 绝不用 `execute_prompt(wait=true)` 或同步 `while` 循环阻塞当前 turn——MCP 超时会截断 |
| **禁止重复查** | 不在同一 turn 内多次调用 `list_io_records` / `poll_session` 手动轮询——浪费 token |

### 推荐：Bash 后台 REST 轮询（零 token 等待）

```
① create_session(cwd, permission_mode="auto")
② execute_prompt(session_id, task, auto_mode=true)
   → { submitted: true }

③ Bash(run_in_background=true):
   PY=$(which python3 2>/dev/null || which python 2>/dev/null || echo python)
   while true; do
     STATUS=$(curl -s -H "Authorization: Bearer $KIMI_SERVER_TOKEN" \
       "http://127.0.0.1:5494/api/v1/sessions/$SID/status" | \
       $PY -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status',''))")
     if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then
       curl -s -H "Authorization: Bearer $KIMI_SERVER_TOKEN" \
         "http://127.0.0.1:5494/api/v1/sessions/$SID/messages?page_size=5&role=assistant" | \
         $PY -c "
import sys,json
data=json.load(sys.stdin)['data']
for m in data.get('items',[]):
  for b in m.get('content',[]):
    if b.get('type')=='text': print(b['text']); break
"
       break
     fi
     sleep 2
   done

④ 统筹 session 继续交互（不阻塞）
⑤ 后台进程完成 → 自动通知 → 读取输出拿到回复
```

**原理**：Kimi Code 后台任务基于操作系统进程退出信号，零 CPU 轮询开销。bash 进程 curl 等到 idle 后退出 → runtime 注入 `<notification>` 到统筹 session。

### 备选：MCP 内部工具（轻量场景）

```
③ watch_session(session_id)           ← tunnel WS/轮询监听
④ continue_watch(watch_id, next)     ← 拿回复+自动发下一步
   → { ready: true, result: "...", next_watch_id: "w2" }
```

### 工作流引擎（模板驱动多步编排）

```
① learn_workflow(name, cwd, from_session="...")
   → 从历史 session 提取步骤，生成 YAML 模板

② list_templates
   → 查看可用模板列表

③ execute_workflow(template_name, auto_mode=true)
   → 自动创建任务 session，逐步下发指令，自适应调整
   → WebSocket 实时推送进度到 workflow-console.html

④ continue_workflow(execution_id, decision="retry")
   → 对阻塞暂停的工作流执行决策
```

### 状态含义

| state | 含义 | 处理 |
|-------|------|------|
| `active` | 正常执行工具调用 | 继续轮询 |
| `swarm` | 并行子代理调度中 | 继续轮询 |
| `awaiting_approval` | 等待人工审批 | 检查 auto_mode |
| `done` | turn 完成 (end_turn) | 工作流结束 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲等待中 | 可能卡住 |

## Agent Skills

本项目配套 3 个 Agent skill，安装到 `~/.agents/skills/` 后自动生效：

| Skill | 用途 | 文件 |
|-------|------|------|
| `kimi-debug-tunnel` | MCP 工具完整使用规范——即发即返、后台轮询、工具速查、红线规则 | `skills/kimi-debug-tunnel.md` |
| `agent-session-monitor` | 通过 wire.jsonl 尾部日志推断 session 运行状态（无需 API 认证） | `skills/agent-session-monitor.md` |
| `mcp-async-tool` | MCP 异步工具设计模式——解决 >30s 任务被协议超时截断的问题 | `skills/mcp-async-tool.md` |

**安装**：将 `skills/*.md` 复制到 `~/.agents/skills/<name>/SKILL.md`，新 session 自动加载。
