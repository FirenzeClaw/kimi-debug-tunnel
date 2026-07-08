# Ubuntu 部署：Wire Client 启动时序与端口发现问题

**状态**: 已修复 (2026-07-08)  
**修复方式**: 方案 D（指数退避）+ 定时重连 —— connect() 从 3×2s 改为 6 级指数退避（1s→32s，最长 ~63s）；index.ts 启动失败后调用 `wireClient.startHealthCheck()` 持续每 10s 重连；`startHealthCheck()` 改为 public 方法  
**修复文件**: wire-client.ts (+connecting 并发防护, +指数退避, startHealthCheck→public), index.ts (catch 块启动定时重连, +URL 提示)  
**发现日期**: 2026-07-08  
**严重度**: P0（部署阻断——首次启动成功率 0%）  
**影响范围**: Linux/macOS 首次部署，Windows 不受影响（固定端口 5494）

---

## 问题概述

在 Ubuntu 上部署 kimi-session-orchestrator 时，Wire Client 因三个连锁问题无法连接到 Kimi Server：

1. **端口不匹配**：`kimi web --no-open` 在 Linux 上使用随机端口（如 58627），而 orchestrator 硬编码默认 `http://127.0.0.1:5494`
2. **启动时序**：orchestrator 在 `index.ts:51` 启动时连接，若 kimi web 尚未就绪则永久失败
3. **无自动恢复**：connect() 失败后 `connected = false`，后续工具调用虽有 `if (!connected) connect()` 重试，但端口仍错

---

## 用户上报日志（Ubuntu 实测）

```
kimi web --no-open → 启动在端口 58627（随机）
orchestrator 启动 → Wire Client 尝试 127.0.0.1:5494 → 失败
  → "Cannot connect to Kimi server at http://127.0.0.1:5494"
  → "Falling back to basic tools (execute_prompt/chat_with_session will not work)"
```

后续即使 kimi web 已就绪，orchestrator 的 Wire Client 仍无法恢复——因为端口号不匹配。

---

## 根因分析

### 根因 1：端口不匹配（核心）

**文件**: `src/wire-client.ts:116-117`

```typescript
this.baseUrl =
  process.env.KIMI_SERVER_URL || "http://127.0.0.1:5494";
```

| 平台 | `kimi web --no-open` 端口行为 | orchestrator 默认 | 匹配？ |
|------|------------------------------|-------------------|:--:|
| **Windows** | 固定 5494（若被占用则报错） | 5494 | ✅ |
| **Linux** | 随机可用端口（如 58627） | 5494 | ❌ |

Linux 上 `kimi web` 选择随机端口的逻辑不在本项目控制范围内，但 orchestrator 的硬编码默认值只匹配 Windows。

### 根因 2：启动时序 + 无自动恢复

**文件**: `src/index.ts:50-56`

```typescript
try {
  await wireClient.connect();       // 仅启动时执行一次
  ...
} catch (err) {
  // fallback: basic tools only
}
```

**文件**: `src/tools/execute-prompt.ts:54-68`

```typescript
if (!wireClient.isConnected()) {
  try {
    await wireClient.connect();     // 每个工具调用时重试
  } catch {
    return { ..., isError: true };
  }
}
```

工具层（`execute_prompt` 等）有重试逻辑，但 `connect()` 使用的 `this.baseUrl` 在 constructor 中已固化——重试仍指向错误端口，永远无法成功。

### 根因 3：connect() 内重试次数有限

**文件**: `src/wire-client.ts:220-265`

```typescript
async connect(): Promise<void> {
  if (this.connected) return;
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 3 次重试，每次 2s 延迟
  }
  throw new Error(`Cannot connect to Kimi server at ${this.baseUrl}...`);
}
```

3 次 × 2s = 最多 6s 窗口。若 kimi web 启动需要 >6s（GPU 模型加载场景），connect() 永远赶不上。

### 根因 4：端口信息丢失

`kimi web --no-open` 将端口和 token 打印到 stderr，但 orchestrator 的启动脚本未捕获这些信息。用户需手动执行：

```bash
# 1. 终端 A：启动 kimi web，复制端口和 token
kimi web --no-open 2>&1 | tee /tmp/kimi.log

# 2. 终端 B：从日志中提取端口，设置环境变量
export KIMI_SERVER_URL="http://127.0.0.1:$(grep -oP 'localhost:\K\d+' /tmp/kimi.log)"
export KIMI_SERVER_TOKEN="$(grep -oP 'Token:\s+\K\S+' /tmp/kimi.log)"

# 3. 启动 orchestrator
npm start
```

这完全不可接受为用户体验。

---

## 影响评估

| 场景 | 修复前 | 修复后 |
|------|:--:|:--:|
| Ubuntu 首次部署（未设 `--port`） | ❌ 100% 失败 | ⚠️ 仍需 `kimi web --port 5494` 或设 `KIMI_SERVER_URL` |
| kimi web 先启动，orchestrator 后启动 | ❌ 端口随机未知 | ✅ 用户指定 `--port 5494` 后正常 |
| orchestrator 先启动，kimi web 后启动 | ❌ 永久失败 | ✅ 定时重连，kimi web 就绪后 ~10s 自动恢复 |
| kimi web 重启（端口不变） | ❌ 需手动重启 | ✅ 健康检查自动重连 |
| kimi web 重启（端口变化） | ❌ 需手动重启+改配置 | ⚠️ 仍需手动更新 `KIMI_SERVER_URL` |
| Windows | ✅ 不受影响 | ✅ 不受影响 |

**修复解决的是时序问题（先启动谁），不是端口发现问题**。Linux 用户仍需显式指定 `--port 5494` 或设置 `KIMI_SERVER_URL`。

## 已修复 vs 剩余限制

### ✅ 已修复（v2.6.1）

| 根因 | 修复 |
|------|------|
| connect() 仅 3×2s 重试 | 改为 6 级指数退避（1s→32s，最长 ~63s） |
| 启动失败后永不恢复 | `startHealthCheck()` 改为 public，index.ts 失败路径启动持续重连 |
| 并发 connect() 调用 | 新增 `connecting` 防护标志 |

### ⚠️ 剩余限制（非本项目可控）

**端口自动发现** 需要 Kimi Code CLI 侧支持。修改方案 A（Kimi Server 发现协议）：`kimi web` 启动时将端口写入 `~/.kimi-code/server.json`，orchestrator 启动时自动读取。此改动需 Kimi Code CLI 团队配合。

在此之前，Linux 用户的**唯一要求**：
```bash
kimi web --no-open --port 5494   # ← 必须显式指定端口
```

---

## 修复方案

### 方案 A：Kimi Server 发现协议（推荐）

在 `kimi web` 启动时写入一个 well-known 文件，orchestrator 启动时读取：

```bash
# kimi web --no-open 自动写入
~/.kimi-code/server.json  →  { "port": 58627, "token": "xxx" }
```

orchestrator 启动时优先读取此文件，fallback 到环境变量。

**优点**：零用户干预  
**缺点**：需 Kimi Code CLI 侧支持（非本项目可控）

### 方案 B：orchestrator 启动脚本封装（推荐 + 立即可行）

提供一个 `start.sh` 脚本，自动完成以下流程：

```bash
#!/bin/bash
# 1. 启动 kimi web，捕获输出
kimi web --no-open 2>&1 | tee /tmp/kimi-web.log &
sleep 3

# 2. 从日志中提取端口和 token
PORT=$(grep -oP 'localhost:\K\d+' /tmp/kimi-web.log)
TOKEN=$(grep -oP 'Token:\s+\K\S+' /tmp/kimi-web.log)

# 3. 等待就绪
while ! curl -s "http://127.0.0.1:$PORT/api/v1/meta" > /dev/null 2>&1; do sleep 1; done

# 4. 启动 orchestrator
export KIMI_SERVER_URL="http://127.0.0.1:$PORT"
export KIMI_SERVER_TOKEN="$TOKEN"
node dist/index.js
```

**优点**：立即可实施，跨平台  
**缺点**：依赖 kimi web 的 stderr 输出格式（脆弱）

### 方案 C：动态端口扫描 + connect() 增强

在 `connect()` 失败后，扫描常见端口范围（5494-5504），尝试 `/api/v1/meta` 端点：

```typescript
async discoverServer(): Promise<string | null> {
  const ports = [5494, 5495, 5496, 5497, 5498, 5499, 5500];
  for (const port of ports) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/v1/meta`);
      if (resp.ok) return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return null;
}
```

**优点**：自动发现  
**缺点**：端口范围不确定，可能误触其他服务

### 方案 D：增强 connect() 持续重试

当前 connect() 仅重试 3 次。改为持续重试（指数退避，最长等待 60s）：

```typescript
async connect(): Promise<void> {
  for (let delay = 1; delay <= 32; delay *= 2) {
    try { ... return; } catch {}
    await sleep(delay * 1000);
  }
  throw ...;
}
```

**优点**：改动最小  
**缺点**：只解决时序问题，不解决端口问题

---

## 建议实施顺序

1. **P0** — 方案 B：提供 `start.sh` 封装脚本（立即可用，README 同步更新）
2. **P0** — 方案 D：增强 `connect()` 持续重试（解决时序问题）
3. **P2** — 方案 C：动态端口发现作为 fallback
4. **P3** — 方案 A：提 feature request 给 Kimi Code CLI 团队

---

## 参考

- `src/index.ts:49-56` — connect() 调用点（仅启动时一次）
- `src/wire-client.ts:115-124` — constructor 中固化 baseUrl
- `src/wire-client.ts:220-265` — connect() 实现（3 次重试，2s 间隔）
- `src/tools/execute-prompt.ts:54-68` — 工具层重试（同样受困于错误端口）
- `src/wire-client.ts:102-105` — 健康检查（仅检测断连，不触发重连）
