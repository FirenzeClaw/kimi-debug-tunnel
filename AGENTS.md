<!--
修改记录（最近 — 完整历史见 CHANGELOG.md）:
  2026-07-16 | kimi-code (feat) | v2.16 预置脚本 + 降级回调：POLL_SCRIPT 常量 + existsSync 短命令分支（~/.kimi-tunnel/poll.py 存在时 ~4KB→~100 bytes）；execute_prompt/chat_with_session 自动 writeFile 写 poll.py，失败降级不阻塞；fetch_result 新增 poll-result-{sid}.txt 固定路径结果文件（PM Read 零 token）；路径 Win/Linux 规范化
  2026-07-16 | kimi-code (fix) | poll-command Bash→Python 重写（v2.15）：消除 node 依赖（换 Python json.load 读锁），新增 LOCK_LOST 重试（5×3s → exit 4），修复子 shell 变量丢失（单 Python 进程），退出码扩展为 0/2/3/4；shell wrapper 缩减为 1 行
  2026-07-16 | kimi-code (feat) | 上下文长度 Bash 监控 + Session 规范统一（v2.14）：poll-command 新增 parse_context() + CTX_HIGH_THRESHOLD 三级阈值（环境变量 > ~/.kimi-tunnel/ctx-threshold > 36000）；逐条注入/session 复用优先/context_tokens 监控三条铁律收敛到 2 个 SKILL.md 入口，4 个 sub-guide 冗余清扫；session-retire cwd 修正跨项目场景（cwd=退役 session 实际工作目录，非 projectRoot）
  2026-07-16 | kimi-code (feat) | 跨项目记忆双层注入（v2.13）：buildInjection() 消费 profile.cwd → 全局正文 + 子项目索引导航表；6 个 memory_* MCP 工具 project 参数路由 + resolveProjectRoot 守卫；skill Q1b + guide-cross-project-memory.md 新建；9/9 测试通过
  2026-07-16 | kimi-code (fix) | Server 断联自主恢复规范：8 个 skill 文件（kimi-session-orchestrator 5 + session-retire + xmind-orchestrated + xmind）统一添加 R1-R4 恢复流程
  2026-07-16 | kimi-code (docs) | README 架构图补全（SessionWatcher/MessageQueue/OrchestrationStore）+ 项目结构补全（session-watcher/poll-command/wire-transport）+ 新增 §行业痛点对照（8 类 24 条）；index.ts 版本号 v2.0.0→v2.12.3
  2026-07-16 | kimi-code (fix) | session-retire cwd 修复：Phase 1 标记 get_session_info.workdir 为内部标识符（非绝对路径），PM 应从任务上下文或 read_session_log 确定 cwd；避免接班 session 创建到错误目录
  2026-07-16 | kimi-code (fix) | memory 注入 MCP 去歧义：buildInjection() 加 ⛔ 前缀指定 kimi-session-orchestrator MCP（修复 task session 调错 knowledge-graph memory_get）；§9 Kimi Server 断连 4 步自主恢复写入 7 个 guide；poll_command 动态端口检测（Server 重启换端口后脚本不再 exit 2）
  2026-07-16 | kimi-code (fix) | Skill memory_* 调用格式修复：session-retire 7-block 模板中 memory_get 把 key 拼进 namespace 致接班 session 读取为空（3 次独立调用→1 次合并调用）；loop-orchestrator 5 文件 memory_get 位置参数→命名参数（防 MCP 工具名冲突）+ memory_set 拆分 key-in-ns（17 处）；部署到 ~/.kimi-code/skills/
  2026-07-15 | kimi-code (v2.12) | Loop Orchestrator v2 独立：loop-orchestrator skill 从 kimi-session-orchestrator 完全剥离（9 文件，含 6 阶段执行循环 + 注入防腐化 + 阻塞干预 + Memory 集成）；主 skill Q1 移除 Loop 入口；删除旧 guide-loop-*.md 7 文件；README/AGENTS 更新
  2026-07-15 | kimi-code (v2.11) | 架构深化第2轮：IWireClient → ISessionClient/IStatusClient/IPushClient 三接口拆分（20法→7/2/8）；消除 ambient sessionId 并发竞态（submitPrompt/sendPrompt/getSessionStatus 改为参数传递，8个save/restore块删除）；apiGet/apiPost → getSessionMessages/resolveApproval 语义方法；记忆注入 extract → tools/helpers.ts（injectMemoryIntoPrompt + setMemoryProfileWithExpiry，消除2处副本）；移除 WorkflowEngine || 回退分支（TunnelServices.workflowEngine 非可选）；tools/manifest.ts 桶文件；session-log-reader 共享 parseWireJsonl 解析流
  2026-07-15 | kimi-code (v2.10) | 架构深化：WireClient 上帝类拆分 → IWireClient 接口 + server-lock.ts；删除 memory-injector.ts（13行死代码）；新增 tools/helpers.ts（preparePrompt + ensureConnected 消除 4×重复样板）；记忆 profile 从 WireClient 移至 MemoryStore；WorkflowEngine/SessionWatcher 改用 IWireClient；workflow-store 手写 toYaml → js-yaml dump；/api/send 死端点移除
  2026-07-15 | kimi-code (docs) | README 全面核查：v2.9.0→v2.9.1 badge、4→6 skill 数量、28→29 工具数、Loop 场景行、参考文档表补 2 issue、新增 FAQ、wire 重连说明更新
  2026-07-15 | kimi-code (arch) | MCP stdio 优先启动：startMcpServer 移到 wireClient.connect 之前，connect 改为后台异步——修复 Kimi Server 离线时 MCP 进程假死（connect 阻塞 63s→stdio 未就绪→tools/list 超时）
  2026-07-15 | kimi-code (v2.9) | Loop Engineering 验证闭环：Q1 A入口 + 7分层guide + grade_step LLM评分工具 + loop指纹检测（workflow-engine自动blockage）；export KimiContentBlock；BlockageTypeEnum 追加 loop_detected
  2026-07-14 | kimi-code (arch) | 移除 approveAll 自动审批引擎：manual session 审批→Bash回调→PM手动决策；auto session 继承 permission_mode 零审批；deny_tool 重写支持 approval_id；approve_tool scope=session 修复
  2026-07-14 | kimi-code (fix) | poll_command fetch_result 彻底修复：curl 管道截断 → Python urllib 直连 HTTP；移除 2>/dev/null 静默吞错；Windows GBK emoji 乱码 → PYTHONIOENCODING=utf-8
  2026-07-14 | kimi-code (docs) | 背景轮询 fetch_result 脚本陷阱：bash 双引号 \n 不展开 + Python -c 语法错误 + 2>/dev/null 静默吞错 → 始终用 poll_command 自动生成版
  2026-07-14 | kimi-code (docs) | AGENTS.md 瘦身 22→14 KB + Bash 轮询示例修复（端口 lock 检测 + SID 赋值）
  2026-07-14 | kimi-code (fix) | Wire Client 过期 lock 自动清理：detectKimiServerUrl() PID 活性检测 + 自动删 lock；connect() 每次重连前重新检测 URL
  2026-07-12 | kimi-code (docs) | README 更新工具章节补全
  2026-07-11 | kimi-code (v2.8) | Skill 拆分加载 + xmind-orchestrated + 注入格式修正
  2026-07-10 | kimi-code (fix) | Wire Client 连接鲁棒性 5 项修复 + 项目命名统一
  2026-07-09 | kimi-code (v2.7) | session-retire skill + skills/ 3→4
  2026-07-08 | kimi-code | 记忆注入懒加载 + 跨项目注入修复 + 共享内存系统
  2026-07-07 | kimi-code | 权限策略系统 + coordinator-guide 升级 PM 视角 + spec 文档
  2026-07-06 | kimi-code | 自适应工作流引擎 + 即发即返 + WS 状态缓存 + 架构深化
  2026-07-05 | kimi-code (project-init) | 初始生成
-->

<!-- AUTO:PROJECT-META -->
## 项目元信息

- **项目**: kimi-session-orchestrator
- **仓库**: https://github.com/FirenzeClaw/kimi-session-orchestrator.git
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
├── types.ts                 # ISessionClient / IStatusClient / IPushClient / IMemoryStore / IWorkflowEngine 接口 + TunnelServices
├── mcp-server.ts            # MCP stdio 服务器，注册全部 29 个工具
├── http-server.ts           # Express + WebSocket 装配入口（薄层）
├── wire-client.ts           # Kimi Server REST + WS 推送客户端（实现 IWireClient 接口，v2.10 拆分）
├── message-queue.ts         # WebSocket 客户端注册 + pub/sub 广播（简化为 67 行）
├── session-log-reader.ts      # wire.jsonl 日志解析 + IO 提取 + sanitizeText
├── orchestration-store.ts    # PM→子 session 编排关系内存追踪
├── wire-transport.ts         # REST 底层 HTTP 传输
├── workflow-template.ts     # 模板类型定义 + YAML 解析 + Zod 校验
├── workflow-store.ts        # 模板持久化（CRUD：list/load/save/delete）
├── workflow-engine.ts       # 自适应工作流引擎：创建session→逐步驱动→阻塞处理→恢复
├── session-watcher.ts        # WS 事件驱动后台监听：每3s检查状态，完成时自动拉取回复
├── policy-types.ts          # 策略类型定义 + Zod schema + 已知工具清单
├── policy-builtins.ts       # 3个内置策略（read-only/safe-edit/full-access）
├── policy-store.ts          # YAML策略文件CRUD（.kimi-tunnel/policies/）+ 校验
├── policy-engine.ts         # 策略引擎：解析/检查/绑定/阻断消息
├── memory-store.ts          # SQLite 共享内存 CRUD + buildInjection() + 记忆profiles（v2.10：set/getMemoryProfile 移入）
├── server-lock.ts           # Kimi Server 端口自动检测 + stale lock 清理（v2.10：从 wire-client 提取）
├── poll-command.ts           # 纯 Python 内联轮询脚本生成（python -c，v2.15 重写）
├── tools/
│   ├── helpers.ts            # 共享工具辅助函数（v2.10：preparePrompt + ensureConnected, v2.11：injectMemoryIntoPrompt + setMemoryProfileWithExpiry）
│   ├── manifest.ts            # 工具注册桶文件 — 统一导入点（v2.11）
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
│   ├── list-policies.ts     # 列出内置+自定义策略（含验证状态）
│   ├── approve-tool.ts      # PM 放行被阻断的工具调用
│   ├── deny-tool.ts         # PM 拒绝被阻断的工具调用
│   ├── memory-set.ts        # 写入共享内存条目（SPEC 002）
│   ├── memory-get.ts        # 读取共享内存条目
│   ├── memory-list.ts       # 列出命名空间及键名
│   ├── memory-delete.ts     # 删除共享内存条目
│   ├── memory-status.ts     # 查看知识库整体状态
│   ├── memory-archive.ts    # 归档 session findings 为 learnings
│   ├── grade-step.ts         # Loop Engineering: LLM 自动评分验证（v2.9）
│   └── get-tunnel-status.ts # Wire 连接状态、客户端数、运行时间
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
1. Node.js ≥ 22 + Python ≥ 3.7（`poll_command` 纯 Python 后台轮询依赖 Python 运行时）
2. 启动 Kimi Server: `kimi web --no-open`（Tunnel 自动从 lock 文件检测端口）
3. 设置 token: `export KIMI_SERVER_TOKEN="<printed-at-startup>"`
4. 启动 Tunnel: `npm start`（或配置 `KIMI_SERVER_URL` 环境变量覆盖自动检测）
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
工具层:    tools/*（MCP 工具注册 + helpers.ts 共享辅助）
业务层:    wire-client.ts, session-orchestrator.ts, workflow-engine.ts, session-watcher.ts（v2.11：ISessionClient/IStatusClient/IPushClient 三接口拆分）
数据层:    message-queue.ts, workflow-template.ts, workflow-store.ts, session-log-reader.ts, memory-store.ts, server-lock.ts, poll-command.ts, orchestration-store.ts
类型层:    types.ts（ISessionClient / IStatusClient / IPushClient / IMemoryStore / IWorkflowEngine 接口 + TunnelServices）
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
① create_session(cwd, permission_mode="auto")     → 获得 sessionId
② execute_prompt(sessionId, task, auto_mode=true) → { submitted: true }

③ Bash(run_in_background=true):   # poll_command 自动生成纯 Python 轮询脚本
   # execute_prompt / chat_with_session 返回的 poll_command 字段即完整命令
   # 直接粘贴执行即可，Python 脚本内部：读锁→轮询 status→idle/aborted 时 fetch 回复
   # 退出码: 0=完成, 2=server离线, 3=超时, 4=锁丢失(需PM介入)

④ 统筹 session 继续交互（不阻塞）
⑤ 后台进程完成 → 自动通知 → 读取输出拿到回复
```

**原理**：Kimi Code 后台任务基于操作系统进程退出信号，零 CPU 轮询开销。Python 进程 urllib 轮询等到 idle 后退出 → runtime 注入 `<notification>` 到统筹 session。脚本内不依赖 node（锁读取用 Python json.load），单进程执行无子 shell 变量作用域问题。

> ⛔ **poll_command 使用规范（v2.15）**：`execute_prompt` 返回的 `poll_command` 是完整的 `python3 -c "..."` 内联脚本，**直接以 `Bash(run_in_background=true)` 执行即可，不要改写**。脚本纯 Python 实现：`sys.argv` 接收参数 → `json.load(open())` 读锁（5次重试）→ `urllib.request` 轮询 status → idle 时 fetch 回复。退出码 0/2/3/4 对应不同状态。原始陷阱（v2.8.4 修复）：bash 双引号 `\n` 不展开 + `2>/dev/null` 静默吞 `JSONDecodeError`；curl 管道大响应截断；node -e 读锁不可靠（v2.15 修复）。

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
   → WebSocket 实时推送进度（通过浏览器扩展插件或直接连接 ws://localhost:<TUNNEL_PORT>/ws 查看）

④ continue_workflow(execution_id, decision="retry")
   → 对阻塞暂停的工作流执行决策
```

### 状态含义

| state | 含义 | 处理 |
|-------|------|------|
| `active` | 正常执行工具调用 | 继续轮询 |
| `swarm` | 并行子代理调度中 | 继续轮询 |
| `awaiting_approval` | 等待 PM 审批 | Bash 检测→PM 手动 approve_tool/deny_tool |
| `done` | turn 完成 (end_turn) | 工作流结束 |
| `error` | 检测到错误 | 查看 log |
| `idle` | 空闲等待中 | 可能卡住 |

### 审批工作流（manual session + policy）

manual session 的工具调用由 PM 手动决策，流程：

```
① create_session(permission_mode="manual", policy="read-only")
② execute_prompt(sessionId, task)              → { submitted: true }

③ Bash(run_in_background=true):  # 监听审批事件
   while true; do
     STATUS=$(curl .../status | parse)
     if [ "$STATUS" = "awaiting_approval" ]; then
       curl .../approvals?status=pending | jq  # 查看待审批工具
       # → 通知 PM：tool=X, action=Y
       exit 0
     fi
     if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then exit 0; fi
     sleep 2
   done

④ PM 审查审批详情（工具名 + 操作描述），手动决策：
   approve_tool(approval_id, scope="session")  → 放行 + 解绑 policy
   deny_tool(approval_id)                      → 拒绝

⑤ auto session 零审批，无需此流程：
   create_session(permission_mode="auto")  → submitPrompt 自动继承
```

> **架构升级** `approveAll`：原自动裁决引擎（deny/allow/require_approval）替换为真正的三层架构第三层——Bash 回调通知 → PM 手动调用 `approve_tool` / `deny_tool`。决策权归 PM，流程自动化。

## 参考文档

| 文档 | 用途 |
|------|------|
| `API.md` | Kimi Server REST API 完整参考（51 端点） |
| `docs/coordinator-guide.md` | **统筹 Session 准入规范（PM视角 v2.8）**——角色定位、工作分解、注意力管理、Skill调度、越权控制、红线 |
| `docs/loop-engineering-analysis.md` | Loop Engineering 概念调研与项目对照——四层循环堆栈/三级 Agent Loop/逐项对齐/差距与改进方向 |
| `specs/001-adaptive-workflow-engine/` | 自适应工作流引擎——已实施 |
| `specs/002-session-memory-share/` | [DONE] Session 冷启动记忆共享——三层内存架构（MemoryStore + 6 MCP 工具 + 自动注入） |
| `specs/003-permission-policy/` | [DONE] 权限与策略管理——read-only/safe-edit/full-access + 自定义YAML策略 |
| `docs/issues/memory-init-timing.md` | [FIXED] MemoryStore 启动时 ensureDb 缺失导致管理工具无法独立使用 |
| `docs/issues/memory-cross-project-injection.md` | [FIXED] 跨项目 resolveProjectRoot 静默跳过 → 注入失效 |
| `docs/issues/ubuntu-wire-client-startup.md` | [FIXED] Ubuntu Wire Client 启动时序——指数退避 + 定时重连；Linux 仍需 `--port 5494` |
| `docs/issues/grade-step-empty-response.md` | [FIXED] grade_step 两项修复：grader 无数据评分 + JSON 截断容错 |
| `docs/issues/memory-call-namespace-mismatch.md` | [FIXED] memory_get/set 调用格式错误——两类：位置参数 → 命名参数 + key-in-namespace 拆分（17处，2个skill） |
| `docs/issues/mcp-wire-offline-freeze.md` | [FIXED] MCP 进程在 Kimi Server 离线时假死——stdio 优先启动 |
| `specs/004-memory-lazy-inject/` | [DONE] 记忆注入策略升级——全量预载 → 索引+按需自读（minimal/standard/full 三级格式） |
| `specs/005-web-ui-extension/` | 浏览器扩展+JS脚本双版本——废弃独立HTML监控，注入Kimi Web UI侧边栏 |

## Agent Skills

本项目配套 7 个 skill，安装后自动生效：

| Skill | 用途 | 文件 | 安装位置 |
|-------|------|------|---------|
| `kimi-session-orchestrator` | MCP 工具完整使用规范——按角色维度加载对应指南，按需 Read 以节省 token | `skills/kimi-session-orchestrator/SKILL.md` | `~/.agents/skills/` |
| `loop-orchestrator` | PM | Loop Engineering 自主编排——独立 skill。用户给定目标后 PM 全权统筹循环，里程碑汇报，不降级目标。`/loop-orchestrator` 激活 | `skills/loop-orchestrator/SKILL.md` | `~/.kimi-code/skills/` |
| `agent-session-monitor` | 通过 wire.jsonl 尾部日志推断 session 运行状态（无需 API 认证） | `skills/agent-session-monitor.md` | `~/.agents/skills/` |
| `mcp-async-tool` | MCP 异步工具设计模式——解决 >30s 任务被协议超时截断的问题 | `skills/mcp-async-tool.md` | `~/.agents/skills/` |
| `session-retire` | **PM 专用**——退役 task session + 自动化接班 pipeline：归档记忆 → 提取上下文 → 创建接班 session → 注入 7-block 模板 → 新 session 自举 | `skills/session-retire/SKILL.md` | `~/.kimi-code/skills/` |
| `xmind-orchestrated` | 困境分析升级版——task session 独立上下文 + 零认知污染过滤器 + 子 Agent 降级 | `skills/xmind-orchestrated/SKILL.md` | `~/.agents/skills/` |
| `xmind` | 本地子 Agent 困境分析（保留原版）——独立 Agent + zoom-out 宏观视角 | `skills/xmind/SKILL.md` | `~/.agents/skills/` |

**安装**：
```bash
# Agent 级 skill（新 session 自动加载）
cp -r skills/kimi-session-orchestrator ~/.agents/skills/kimi-session-orchestrator
cp -r skills/xmind-orchestrated ~/.agents/skills/xmind-orchestrated
cp -r skills/xmind ~/.agents/skills/xmind
cp skills/agent-session-monitor.md ~/.agents/skills/agent-session-monitor/SKILL.md
cp skills/mcp-async-tool.md ~/.agents/skills/mcp-async-tool/SKILL.md

# PM 级 skill（统筹 session 按需调用）
cp -r skills/session-retire ~/.kimi-code/skills/session-retire

# PM 级 skill — Loop Orchestrator
rm -rf ~/.kimi-code/skills/loop-orchestrator
cp -r skills/loop-orchestrator ~/.kimi-code/skills/loop-orchestrator
```
