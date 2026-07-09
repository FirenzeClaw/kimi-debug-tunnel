# Quickstart: Kimi Web UI 编排监控插件

**Feature**: `005-web-ui-extension`

---

## 方式一：Tampermonkey 用户脚本（推荐）

### 1. 安装 Tampermonkey

Chrome / Edge 扩展商店搜索 "Tampermonkey" 安装。

### 2. 构建用户脚本

```bash
cd kimi-session-orchestrator
npm run build
# 生成 dist/userscript/orchestrator.user.js
```

### 3. 安装脚本

1. 打开 Tampermonkey 管理面板 → 添加新脚本
2. 将 `dist/userscript/orchestrator.user.js` 内容粘贴进去
3. 保存（Ctrl+S）

### 4. 配置端口（如非默认 3456）

编辑脚本顶部：
```javascript
// 修改此行：GM_getValue("tunnelPort", 3456)
// 改为：GM_getValue("tunnelPort", 你的端口)
```

或通过 Tampermonkey 菜单 → 存储 → 添加键 `tunnelPort`，值设为你的端口。

### 5. 使用

启动 Kimi Server + Tunnel 后，打开 `https://localhost:5494`（或 `127.0.0.1:5494`）。

- Token 自动填入（首次启动）
- 左侧栏出现 `📁 Orchestrator` 组
- 5 秒一次自动刷新状态

---

## 方式二：Chrome 扩展

### 1. 构建

```bash
npm run build
# 生成 dist/ext/ 目录
```

### 2. 加载扩展

1. Chrome → `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/ext/` 目录

### 3. 配置端口

1. 点击扩展图标 → 选项
2. 设置 Tunnel 端口（默认 3456）
3. 保存

### 4. 使用

同方式一第 5 步。

---

## 前提条件

- Kimi Server 运行中（`kimi web --no-open --port 5494`）
- Tunnel 运行中（`npm start`）
- Node.js ≥ 22

---

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| 侧边栏无 Orchestrator 组 | Tunnel 未启动或端口错误 | 检查 `npm start` 是否运行，端口配置是否正确 |
| Token 未自动填入 | Tunnel 未启动或 `/api/token` 不可达 | 手动粘贴 token，然后检查 tunnel 日志 |
| 子 session 不显示 | PM session 未创建子 session | 通过 MCP 工具创建子 session 后自动出现 |
| 状态不更新 | Kimi Server API 不可达 | 检查 Kimi Server 端口是否与页面一致 |
