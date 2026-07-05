<!--
修改记录:
  2026-07-05 | kimi-code (project-init) | 初始生成：项目元信息、目录结构、构建命令、架构约定
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
├── types.ts                 # TunnelServices 接口（wireClient, messageQueue, startTime）
├── mcp-server.ts            # MCP stdio 服务器，注册全部 7 个工具
├── http-server.ts           # Express + WebSocket 装配入口（薄层）
├── wire-client.ts           # Kimi Server prompt 执行器（使用 Transport + ContentProcessor）
├── kimi-api-transport.ts    # 纯 HTTP 传输适配器（GET/POST + auth + 错误解包）
├── content-processor.ts     # 纯函数：文本提取、思考过滤、完成检测
├── message-queue.ts         # WebSocket 客户端管理 + 响应广播
├── ws-handler.ts            # WebSocket 连接处理器（独立模块）
├── session-manager.ts       # Session 管理薄委托层（→ SessionStore + LogReader）
├── session-store.ts         # 文件系统扫描 + 缓存：listAll / findById / findPath
├── session-log-reader.ts    # wire.jsonl 日志解析器（独立模块）
├── session-orchestrator.ts  # 多轮任务编排引擎
├── routes/
│   ├── console.ts           # GET /   Web 调试控制台
│   ├── execute.ts           # POST /api/execute
│   ├── send.ts              # POST /api/send
│   └── status.ts            # GET /api/status
├── tools/
│   ├── execute-prompt.ts    # 发送 prompt 并等待完整回复
│   ├── chat-with-session.ts # 全自动多轮编排
│   ├── stream-response.ts   # 实时推送到所有 WebSocket 客户端
│   ├── list-sessions.ts     # 列出所有 session
│   ├── get-session-info.ts  # 查看 session 详情
│   ├── read-session-log.ts  # 读取对话日志
│   └── get-tunnel-status.ts # Wire 连接状态、客户端数、运行时间
└── public/
    └── console.html          # Web 调试控制台
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
传输层:    http-server.ts, mcp-server.ts, ws-handler.ts
路由层:    routes/*（Express 路由处理器）
工具层:    tools/*（MCP 工具注册）
业务层:    wire-client.ts, session-orchestrator.ts, session-manager.ts
数据层:    kimi-api-transport.ts, session-store.ts, session-log-reader.ts
工具层:    content-processor.ts, message-queue.ts
类型层:    types.ts
```
<!-- AUTO:END -->
