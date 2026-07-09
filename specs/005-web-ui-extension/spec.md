# Kimi Web UI 编排监控插件：浏览器扩展 + JS 脚本双版本

**Feature**: `005-web-ui-extension`
**Created**: 2026-07-09
**Status**: Draft
**Parent**: kimi-session-orchestrator v2.6

---

## 问题陈述

当前编排器的监控 UI 是 `http://localhost:3456` 上的两个独立 HTML 页面（`console.html` 和 `workflow-console.html`），存在以下问题：

### 1. 与 Kimi Web UI 割裂

用户需要在两个浏览器 tab 之间切换——一个 tab 是 Kimi Web UI（操作 session），另一个是编排器监控页面。编排器提供的 session 层级关系、工作流状态等无法在 Kimi Web UI 内直接查看。

### 2. HTML 页面需要独立维护

两个 HTML 文件（合计 ~1400 行）包含完整的 CSS 设计系统和 WebSocket 客户端逻辑。随着策略系统、记忆系统等功能迭代，这些页面需要同步更新，但实际已落后于后端功能（如 `session_health`、`attention_alert` 等事件仅为前端占位，后端从未发送）。

### 3. 部分后端推送数据无消费者

`messageQueue.broadcastJson()` 推送的 `workflow_progress`、`policy.block` 等事件仅在 workflow-console.html 中被消费。该页面需要用户主动打开浏览器 tab 才能看到——在 Kimi Web UI 中工作的用户不会频繁切换到该 tab。

### 4. 端口固定假设脆弱

当前 HTML 硬编码 `ws://${location.host}/ws`，默认端口 3456。端口冲突时 HTTP server 静默跳过（`EADDRINUSE`），前端无提示。

---

## 解决方案

废弃独立 HTML 监控页面，将编排器的可视化能力**注入到 Kimi Web UI 页面内**。提供两种分发形态：

- **浏览器扩展**：Chrome MV3 扩展，独立安装，独立配置入口
- **JS 脚本插件**：Tampermonkey 用户脚本，快速分发，零安装门槛

两版本共享一套核心逻辑（~70% 代码量），仅适配层不同。

### 注入效果

在 Kimi Web UI 左侧栏（`.sessions` 区域内）注入一个新的折叠工作区组：

```
📁 Orchestrator                   ← 新增的 group（折叠/展开）
   ├─ [spinner] PM: 统筹 session  ← 父 session，复用页面 se 条目样式
   ├─   T1: 子 session-1          ← 子 session，缩进展示
   ├─   T2: 子 session-2
   └─   T3: 子 session-3
```

每个条目复用页面原有的 spinner（`ui-spinner`）、标题截断、时间戳（`ts`）样式，不引入新设计元素。条目标题可点击，跳转到 Kimi Web UI 对应 session 的对话页面。

### 自动登录

插件/脚本启动时从 tunnel 获取 token，检测 Kimi Web UI 登录页面的 token 输入框并自动填入提交，实现"启动即登录"。

---

## 用户故事

1. **作为项目经理（PM）**，我希望在 Kimi Web UI 侧边栏中直接看到编排器的 session 层级结构——哪些是 PM session、哪些是它派生的子 session，无需切换到另一个浏览器 tab
2. **作为 PM**，我希望子 session 的状态标记（运行中/空闲/完成）与页面原有风格一致——通过 spinner 动画和已有的 UI 元素表达，不引入额外的视觉噪音
3. **作为 PM**，当我首次打开 Kimi Web UI 时，希望能够自动登录（token 自动填入），无需手动复制粘贴 token
4. **作为用户**，我希望插件端口的配置不硬编码——因为我本机的 tunnel 端口可能与默认不同

---

## 功能需求

### FR-1：Session 层级树展示

在 Kimi Web UI 左侧栏 `.sessions` 区域注入一个 `Orchestrator` 组，以现有工作区文件夹形式展示编排关系：

- 父 session（PM session）作为顶层条目
- 子 session 在父 session 下方缩进展示
- 条目样式（标题、时间戳、spinner）完全复用页面现有 CSS 类和 DOM 结构
- 点击条目跳转到对应 session 对话页面

### FR-2：双版本共享核心逻辑

核心逻辑（API 调用、状态管理、DOM 注入、渲染）编写一次，浏览器扩展和 Tampermonkey 脚本各自通过薄适配层引用：

- **`shared/`** 目录存放共享代码
- **`ext/`** 目录为 Chrome MV3 扩展，通过 `content_scripts` 注入 shared
- **`userscript/`** 目录为 Tampermonkey 脚本，内联 shared 代码

### FR-3：双数据源联合查询

插件/脚本同时使用两个数据源构建 session 层级树：

- **Tunnel API**（`localhost:<tunnelPort>`）：提供所有已知 PM session → 子 session 的编排关系（新增端点 `GET /api/orchestrations`，无需参数，tunnel 自动发现并返回所有编排关系）
- **Kimi Server API**（从 `window.location.origin` 获取）：提供 session 详情（标题、状态、更新时间）

### FR-4：Tunnel 端口可配置

Tunnel 端口不硬编码，默认 3456：

- 浏览器扩展：通过 `chrome.storage.local` 存储，提供 options 页面设置
- Tampermonkey 脚本：通过 `GM_setValue` / `GM_getValue` 存储，脚本顶部注释说明修改方式

### FR-5：自动 Token 填入

插件/脚本启动时执行：

1. 从 tunnel 请求 token（`GET /api/token`）
2. 检测页面 DOM 中是否存在 token 输入框
3. 若存在 → 自动填入并提交
4. 若不存在（已登录状态）→ 跳过

### FR-6：状态轮询

每 5 秒通过 Kimi Server API 刷新 session 状态。渲染层对比前后差异，仅更新变化的条目，不引起页面闪烁。

### FR-7：Tunnel 不可用降级

当 tunnel 不可达时（如未启动、端口错误），插件/脚本静默降级：
- 不展示 Orchestrator 组
- 不阻塞 Kimi Web UI 正常使用
- 在控制台输出一条诊断信息（`console.debug` 级别）

### FR-8：移除原有 HTML 页面

删除 `console.html` 和 `workflow-console.html`。`http-server.ts` 中移除对应的静态文件路由（`GET /` 和 `GET /workflow-console.html`），保留 REST API 和 WebSocket（插件依赖）。

### FR-9：Tunnel 新增编排关系 API

`http-server.ts` 新增端点：

- `GET /api/orchestrations`：无需参数，tunnel 自动发现所有已知 PM session 并返回其子 session 的层级关系
- `GET /api/token`：返回当前 tunnel 持有的 `KIMI_SERVER_TOKEN`（仅 localhost 可访问）

---

## 成功标准

| ID | 标准 | 度量方式 |
|----|------|---------|
| SC-1 | 用户在 Kimi Web UI 侧边栏中能看到编排器的 session 层级树 | 侧边栏出现 `Orchestrator` 组，包含正确的父子关系 |
| SC-2 | session 条目样式与页面原生条目不可区分 | 使用相同的 CSS 类和 DOM 结构，spinner / 时间戳行为一致 |
| SC-3 | 两种分发形态功能对等——JS 脚本和浏览器扩展提供相同的 session 树展示 | 两版本功能对比清单无差异 |
| SC-4 | 端口变更后无需修改代码即可生效 | 修改插件配置后，下次轮询自动使用新端口 |
| SC-5 | 首次打开 Kimi Web UI 时 token 自动填入（tunnel 已启动） | 页面加载后 3 秒内 token 输入框被填充并提交 |
| SC-6 | tunnel 未启动时 Kimi Web UI 功能不受影响 | 侧边栏无 Orchestrator 组，无报错弹窗，无控制台异常 |

---

## 关键实体

- **编排组（Orchestrator Group）**：注入到侧边栏的折叠文件夹，包含 PM session 及其所有子 session
- **编排关系（Orchestration Relation）**：PM session ID → 子 session ID 列表的映射，由 tunnel 的 `/api/orchestrations` 返回
- **Tunnel Token**：tunnel 启动时从环境变量 `KIMI_SERVER_TOKEN` 读取，通过 `/api/token` 暴露给 localhost 请求方

---

## 边界与约束

- 不修改 Kimi Web UI 页面的任何现有元素或行为——仅追加 DOM 节点
- 不引入新的视觉设计系统——完全复用页面 CSS 变量和组件类名
- Token 不离开本机——`/api/token` 仅响应来自 `127.0.0.1` / `::1` 的请求
- 浏览器扩展仅支持 Chromium 系（Chrome / Edge）——Firefox 待定
- Tampermonkey 脚本用 `@match` 限制仅 Kimi Web UI 页面生效
- 注入的 Orchestrator 组可被页面自身的"新建对话"按钮触发重新渲染时保持存在

---

## 假设

- Kimi Web UI 页面 DOM 结构（`.sessions`、`.group`、`.se` 等 CSS 类和 `ui-spinner` 组件）不频繁变化；若 Kimi Web UI 重构侧边栏，插件需同步适配
- 任务 session 的父子关系仅由 tunnel 维护和提供——Kimi Server 自身不记录此关系
- 用户本机 tunnel 端口在单次浏览器会话中不变
- Tampermonkey 用户理解如何安装用户脚本（`@match` 和 `GM_setValue` 基础概念）
- Chrome 扩展审核能通过 MV3 的 content_scripts 注入策略
