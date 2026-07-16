# Poll Command: Bash → Python 重写

> 日期: 2026-07-16 | 状态: design

## 背景

`generatePollCommand()` 当前生成混合 bash+python 脚本，存在三个缺陷：

1. **子 shell 变量丢失**：bash 函数 `parse_status` 内的变量修改在子 shell 中，父 shell 不可见
2. **LOCK_MISSING 无重试**：锁文件暂时消失时直接 exit 2，无法自愈
3. **依赖 node 读锁**：`node -e` 读取 lock 文件，node 不一定可用

## 目标

将整个轮询脚本从 bash 改写为纯 `python -c` 单脚本，同时修复以上三个缺陷，不破坏现有功能。

## 设计

### 入口层：1 行 bash

```bash
python3 -c "..." <sessionId> <baseUrl> <token> <maxSec> <maxFails> 2>/dev/null || python -c "..." <sessionId> <baseUrl> <token> <maxSec> <maxFails>
```

bash 职责：选择 Python 解释器（python3 → python fallback）。其余全部在 Python `-c` 块中执行。

### Python 脚本流程

```
启动 → 读锁（重试5次，sleep 3）
         ↓ 成功                          ↓ 5次全部失败
    构建 BASE URL               输出 [LOCK_LOST] 结构化消息
         ↓                              exit 4
     主循环（max 300s）
     ├─ urllib.request poll status
     ├─ 空响应 → fail++ → ≥3 → exit 2
     ├─ 成功 → fail 归零
     ├─ idle/aborted → 检查 context tokens → fetch_result → exit 0
     └─ sleep 2
     超时 → fetch_result → exit 3
```

### 参数传递

Python 通过 `sys.argv` 接收参数，bash 包装传入，避免 `os.environ` 跨平台引号陷阱：

| sys.argv 索引 | 参数 | 默认 |
|:---:|---|--|
| 1 | `sessionId` | 必填 |
| 2 | `baseUrl` | 空则从锁文件读取 |
| 3 | `token` | 空则无 Auth header |
| 4 | `maxWaitSeconds` | 300 |
| 5 | `maxFailures` | 3 |

### 退出码协议

| 退出码 | 含义 | PM 行动 |
|:---:|------|---------|
| 0 | 正常完成（idle/aborted） | 读取回复，继续编排 |
| 2 | server 不可达（连续 3 次 curl 失败） | 检查 server 状态 |
| 3 | 超时（300s） | 检查 session 是否卡住 |
| 4 | 锁丢失（5 次重试耗尽） | 重启 server 或换新锁重跑 `poll_command` |

### 锁丢失回调

5 次重试全部失败时，Python 输出结构化消息到 stdout：

```
[LOCK_LOST] path=C:\Users\...\.kimi-code\server\lock retries=5 last_error=<异常信息>
```

随后 `exit 4`。runtime 检测到进程退出 → 注入 `<notification>` 到 PM 的统筹 session → PM 手动决策。

### 功能映射

| 现有 Bash 功能 | Python 等价 |
|---------------|------------|
| `PORT=$(node -e ...)` 读锁 | `json.load(open(lock_path))` —— 消除 node 依赖 |
| `parse_status` → curl + python 解析 | `urllib.request` → `json.loads` 单次 HTTP |
| `parse_context` → 同上 | `urllib.request` → 取 `context_tokens` / `max_context_tokens` |
| `fetch_result`（已是 Python urllib） | 保持不变 |
| `FAILS` 计数 / `ELAPSED` 计时 | `consecutive_fails` / `time.time()` — 无子 shell 问题 |
| Context 阈值检测 (`~/.kimi-tunnel/ctx-threshold`) | `open()` 读取，同上逻辑 |
| `sleep 2` 轮询间隔 | `time.sleep(2)` |
| `curl --max-time 10` | `urlopen(..., timeout=10)` |

### 不变项

- 输出格式：`---RESULT---` 分隔符 → fetch_result 文本
- context token 警告格式：`[CTX_HIGH] N / M tokens（阈值: T）— 建议 PM 评估退役`
- 超时提示：`[POLL_TIMEOUT] 等待 Ns 超时`
- `generatePollCommand()` 函数签名不变
- 调用方 `execute-prompt.ts` / `chat-with-session.ts` 无需改动
- 无新文件依赖，无外部 Python 包

### 实现范围

- **仅修改** `src/poll-command.ts` 中的 `generatePollCommand()` 函数
- `PollConfig` 接口不变
- 删除 bash 混合代码，替换为纯 `python -c` 生成逻辑

## 自检

| 检查项 | 状态 |
|--------|------|
| 占位符/TODO | 无 |
| 范围聚焦 | 单文件修改，不涉其他模块 |
| 模糊性 | 退出码/输出格式已明确约定 |
| 向后兼容 | 调用方无需改动，输出格式保持不变 |
| 跨平台 | python3 → python fallback 覆盖 Linux/macOS/Windows |
