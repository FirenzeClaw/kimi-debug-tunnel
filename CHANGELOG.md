# Changelog

All notable changes to kimi-session-orchestrator.

## v2.17.1 — 2026-07-20

**P1 实测闭环：审批态映射修正 + 测试基建**

- fix: 状态映射 `pending_interaction` 优先于 `busy`——0.27 实测审批/提问等待期间 `busy` 仍为 `true`，原规则（busy 优先）把审批态误判为 `running`，PM 审批监听漏报；`normalizeSessionStatus` 重排 + `getSessionStatus` 新模型下恒取 session 详情（`wire-client.ts`、`status-normalize.ts`，+3 单测锁定）
- 实测确认：`pending_interaction` 枚举 `none|approval|question`（manual session 真实审批 + AskUserQuestion 场景）；审批决策 `POST approvals/{id} {decision:"approved"}` 全链路通；问题回答 `answers` 为 record 非数组
- 实测确认：0.27 已修复 0.22.3「未加载 session `/status` 50001」问题
- feat: `npm test` script（`node --test tests/*.test.mjs`，23 例）
- docs: API.md approvals/questions 结构实测回填

## v2.17 — 2026-07-20

**Web 引擎 0.24+/0.27 适配（Kimi Server Web 重构）**

- fix: `wire-client.ts` WS 握手补 `Authorization: Bearer` 头——0.27 起 WS 升级强制鉴权（`missing_credential` 拒绝），修复 `wsConnected=false` 导致的事件驱动瘫痪
- fix: `handleDirectEvent` 并行处理 `event.session.work_changed`——0.24+ 该事件取代 `event.session.status_changed`（实测整个 turn 周期无一次旧事件），提取共享方法 `applySessionStatus()`，状态缓存与 waitForStatus resolver 恢复事件驱动
- fix: prompt body 恒带 `model`——0.27 静默忽略 `agent_config.model`（创建/profile 均无效），空 model 的 turn 必败 `model.not_configured` 且不回落默认模型；三级解析：createSession 显式 model > server `/auth` default_model > 省略；model 有 session 级粘性（实测 `kimi-code/k3`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`）
- feat: 状态归一化层 `src/status-normalize.ts`——0.22.x `status` 枚举与 0.24+ `busy`/`pending_interaction` 双模型统一映射，`getSessionStatus()` 单点接入（新模型空闲时补取 session 详情），上层零改动
- fix: `POLL_SCRIPT` 状态判定双模型兼容 + `busy=False` 时补查 `pending_interaction`——消除 0.24+ 下 `SERVER_OFFLINE` 误报（exit 2）与审批中间态提前退出
- docs: `API.md` 重写为 0.27.0 实测版——v2 channels 自省（37 个）、11 项破坏性变更清单、事件表/响应结构全部实测标注；新增 `docs/issues/web-engine-027-adaptation.md` 影响面分析
- test: node:test 单测 20 例（归一化映射 / work_changed 事件 + resolver 唤醒 / model 解析链）；0.27 真实环境生产链路端到端回归通过（创建 → 注入 → 后台轮询 → 真实回复，wsConnected=true）
- 实现计划: `docs/superpowers/plans/2026-07-20-web-engine-027-adaptation.md`、`2026-07-20-web-engine-027-runtime-fixes.md`

## v2.16 — 2026-07-16

**Loop Engineering skill 套件 + Cron 调度规范**

- 新增 `docs/loop-engineering-reference.md`：16 章 Loop Engineering 全面参考，聚合 7 篇行业来源并补本项目成熟度对照
- 新增 SPEC 006 `cross-model-grader`：`grade_step` 支持 maker/checker 模型分离，推荐 deepseek-v4-pro + gpt-5.5 交叉评分
- 新增 SPEC 007 `cron-scheduler-skill`：`cron.yaml` 文件+memory 双写、`run_lock` 防重叠、`one-shot-chain` 续期、`external_actions` 外部副作用门控
- 新增 PM 级 skill：`loop-contract-from-docs`、`loop-contract-from-idea`、`cron-scheduler`
- Loop Contract 共享模板补齐 `operational_brakes`、`harness`、12 项 QA 门控和 `<must-differ-from-pm-model>` 交叉验证占位

**Poll Command 预置脚本 + 降级 + 固定路径结果文件**

- `poll-command.ts`: 提取 `POLL_SCRIPT` 模块级常量；`generatePollCommand()` 新增 `existsSync(~/.kimi-tunnel/poll.py)` 检测 —— 存在则返回短命令 `python3 ~/.kimi-tunnel/poll.py <args>`（~100 bytes），不存在降级为内联脚本（行为不变）
- `execute-prompt.ts` / `chat-with-session.ts`: 首次调用自动 `writeFile` 写入 `poll.py`，失败时追加 `degraded: true` + 降级提示，零阻塞
- `fetch_result()`: 新增 `poll-result-{sid}.txt` 文件写入（`~/.kimi-tunnel/`），PM 可用 `Read` 固定路径直接获取结果，零 token 消耗；sid 隔离并行 session 无竞态
- 路径规范化：Windows `\` → `/`（Win/Linux 兼容）
- 设计文档: `docs/superpowers/specs/2026-07-16-poll-py-prebuilt-degraded-design.md`
- 实现计划: `docs/superpowers/plans/2026-07-16-poll-py-prebuilt-degraded.md`

## v2.15 — 2026-07-16

**Poll Command Bash → Python 重写**

- `poll-command.ts`: `generatePollCommand()` 从混合 bash+curl 改为纯 `python -c` 内联脚本
  - 消除 node 依赖：锁读取改用 `json.load(open(lock_path))`
  - 新增 LOCK_LOST 重试：锁文件暂时消失时重试 5 次（间隔 3s），耗尽后输出 `[LOCK_LOST]` 并 exit 4
  - 修复子 shell 变量丢失：bash 函数 `parse_status` 在子 shell 中修改变量父 shell 不可见 → 单 Python 进程彻底解决
  - 退出码协议扩展：0=完成, 2=server离线, 3=超时, 4=锁丢失
  - Shell wrapper 缩减为 1 行：`PYTHONIOENCODING=utf-8 python3 -c "..." || python -c "..."`
- 设计文档: `docs/superpowers/specs/2026-07-16-poll-command-python-rewrite-design.md`
- 实现计划: `docs/superpowers/plans/2026-07-16-poll-command-python-rewrite.md`

## v2.14 — 2026-07-16

**上下文长度 Bash 监控 + Session 规范统一**

- `poll-command.ts`: 新增 `parse_context()` 函数，session 完成时自动检查 `context_tokens`，超阈值输出 `[CTX_HIGH]` 提醒退役。三级阈值优先级：`CTX_HIGH_THRESHOLD` 环境变量 > `~/.kimi-tunnel/ctx-threshold` 配置文件 > 默认 36000
- 两条核心规范（逐条注入、session 复用优先）+ context_tokens 监控铁律收敛到 `kimi-session-orchestrator` 和 `loop-orchestrator` 两个 SKILL.md 入口，4 个 sub-guide 冗余清扫
- `session-retire` cwd 修正：跨项目场景 cwd 改为退役 session 实际工作目录（v2.13 双层记忆自动按 cwd 路由），不再强制用 projectRoot
- 设计文档: `docs/superpowers/specs/2026-07-16-context-tokens-monitoring-design.md`

## v2.13 — 2026-07-16

**跨项目记忆双层注入**

- `buildInjection()` 消费 `profile.cwd` 生成双层注入：全局正文 + 子项目索引导航表
- 6 个 `memory_*` MCP 工具添加 `project` 可选参数，支持跨项目 DB 路由
- `else` 分支防状态泄漏 + `resolveProjectRoot` 守卫
- skill Q1b 子项目路径分离确认 + `guide-cross-project-memory.md` 新建
- Server 断联 R1-R4 恢复规范部署到 8 个 skill 文件
- README 架构图补全 + 项目结构补全 + 行业痛点对照

## v2.12.3 — 2026-07-16

**MCP 去歧义 + 断连恢复 + 轮询动态端口**

- `buildInjection()` 注入 ⛔ 前缀指定 `kimi-session-orchestrator` MCP——修复 task session 调错 `memory` 知识图谱 MCP
- loop-orchestrator 新增 §9 Kimi Server 断连 4 步自主恢复 (R1-R4)，5 个 guide 引用
- `poll_command` 改为每次轮询动态读 lock 文件——Server 重启换端口后脚本不再失效
- 确认 Kimi Server OOM 崩溃为断连根因（~20h 运行后堆耗尽）

## v2.12.2 — 2026-07-16

**Loop 自循环协议序列化**

- §3 执行循环从箭头流程图重构为 7 步编号门控协议（STEP 1-7，每步门控 + 阻断点）
- execute_prompt→Bash 从建议变为不可跳过步骤，SKILL.md 新增 4 项自检清单
- verify/implement/parallel 统一引用核心 STEP 编号

## v2.12.1 — 2026-07-16

**Skill memory 调用格式修复**

- `session-retire` 7-block 模板 `memory_get` namespace 拼写错误修复
- `loop-orchestrator` 5 文件 17 处修复：`memory_get` 位置参数→命名参数 + `memory_set` key-in-namespace 拆分

## v2.12 — 2026-07-15

**Loop Orchestrator v2**

- Loop Engineering 独立为 `loop-orchestrator` skill（9 文件），从 `kimi-session-orchestrator` 完全剥离
- PM 硬边界（仅 MCP 工具）、6 阶段自主循环、注入防腐化（单次 ≤3 项/≤500 字）
- 主 skill Q1 移除 Loop 入口，删除旧 guide-loop-*.md 7 文件

## v2.11 — 2026-07-15

**架构深化第2轮**

- IWireClient → ISessionClient/IStatusClient/IPushClient 三接口拆分（20 法→7/2/8）
- 消除 ambient sessionId 并发竞态（8 个 save/restore 块删除）
- apiGet/apiPost → getSessionMessages/resolveApproval 语义方法
- 记忆注入统一到 helpers.ts，移除 WorkflowEngine `||` 回退
- tools/manifest.ts 桶文件，session-log-reader 共享 parseWireJsonl
- 净 -150 行重复代码

## v2.10 — 2026-07-15

**架构深化第1轮**

- WireClient 上帝类拆分 → IWireClient 接口 + server-lock.ts
- 删除 memory-injector.ts（死代码），新增 tools/helpers.ts
- 记忆 profile 从 WireClient 移至 MemoryStore
- workflow-store 手写 toYaml → js-yaml dump，移除 /api/send 死端点

## v2.9.1 — 2026-07-15

**grade_step 修复 + MCP stdio 优先启动**

- grade_step: 评分前拉取目标 session IO 产出 + JSON 截断容错
- MCP stdio 优先启动：startMcpServer 移到 wireClient.connect 之前（修复 Kimi Server 离线时 MCP 进程假死）

## v2.9.0 — 2026-07-15

**Loop Engineering 验证闭环**

- Q1 A 入口 + 7 分层 guide + `grade_step` LLM 评分工具 + loop 指纹检测
- PM 可选实施/验收模式、单/并行策略，guide 按需加载节省 56-60% token

## v2.8.5 — 2026-07-15

**修复 fromSession handoff 注入被空守卫截断**

- project 知识库为空时过早返回，handoff 数据被静默丢弃
- 修复：handoff 提前收集 + 联合判空 + handoff-only 分支 + 去重

## v2.8.4 — 2026-07-14

**poll_command fetch_result 彻底修复**

- curl 管道截断 → Python urllib 直连 HTTP
- 移除 2>/dev/null，错误不再静默吞
- Windows GBK emoji 乱码 → PYTHONIOENCODING=utf-8

## v2.8.3 — 2026-07-14

**过期 lock 自动清理**

- detectKimiServerUrl() PID 活性检测 + 自动删 lock
- connect() 每次重连前重新检测 URL

## v2.8.1 — 2026-07-12

**更新工具章节补全**

- 新增更新前检查（kimi web 运行 + token 校验）+ 孤儿进程清理 + /reload 原理说明

## v2.8 — 2026-07-11

**Skill 拆分加载**

- kimi-session-orchestrator skill 按角色维度按需加载 guide
- xmind-orchestrated: task session 隔离困境分析
- 注入格式修正 + poll-command 离线检测 + 全文档重构

## v2.7 — 2026-07-09

**session-retire skill + PM Dashboard 迁移**

- 退役→接班自动化 pipeline（memory_archive + 7-block + 自举协议）
- PM Dashboard 迁移至浏览器扩展

## v2.6 — 2026-07-08

**记忆注入策略升级**

- 全量预载 → 索引+按需自读（三级格式）
- 注入文本 ~600B→~200B

## v2.5 — 2026-07-08

**三层共享内存系统**

- MemoryStore + 6 个 memory_* MCP 工具 + 自动注入

## v2.4 — 2026-07-07

**三层权限系统**

- 策略引擎 + 3 内置策略 + 自定义 YAML

## v2.3 — 2026-07-07

**PM Dashboard 重写**

- coordinator-guide v2.3（PM 范式/Skill 调度/注意力管理）

## v2.0 — 2026-07-06

**自适应工作流引擎**

- 即发即返模式 + WS 状态缓存

## v1.0 — 2026-07-05

初始版本
