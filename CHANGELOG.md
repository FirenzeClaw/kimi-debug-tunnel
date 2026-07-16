# Changelog

All notable changes to kimi-session-orchestrator.

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
