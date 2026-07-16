# 实现计划：Poll Command 预置脚本 + 降级回调

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 或 executing-plans 逐任务实现此计划。

**目标：** `execute_prompt` / `chat_with_session` 首次调用时将 Python 轮询脚本写入 `~/.kimi-tunnel/poll.py`，后续引用短路径；写入失败时降级为内联脚本，零阻塞。

**架构：** `poll-command.ts` 导出 `POLL_SCRIPT` 常量 + `generatePollCommand()` 检查文件是否存在；两个 MCP 工具入口在调用前 try-write 文件，失败时附加 `degraded: true`。

**技术栈：** TypeScript，Node.js `fs.writeFileSync` / `fs.existsSync` / `fs.mkdirSync`，`os.homedir()`

---

## 任务列表

### 任务 1：`poll-command.ts` 提取常量 + 文件检测分支

**描述：** 将 `generatePollCommand()` 中 `py` 数组的内容提取为模块级 `export const POLL_SCRIPT` 常量。函数内新增 `existsSync(~/.kimi-tunnel/poll.py)` 判断，存在则返回短引用命令，否则沿用内联路径。

**验收标准：**
- [ ] `POLL_SCRIPT` 常量内容与当前 `py.join("\n")` 完全一致（静态，不含 `maxWaitSeconds`/`maxFailures` 变量插值）
- [ ] 文件存在时返回: `PYTHONIOENCODING=utf-8 python3 ~/.kimi-tunnel/poll.py <sid> <url> <token> <maxSec> <maxFails> || python ~/.kimi-tunnel/poll.py <sid> <url> <token> <maxSec> <maxFails>`
- [ ] 文件不存在时返回原内联脚本（行为不变）
- [ ] `PollConfig` 接口和 `generatePollCommand()` 签名不变
- [ ] `npm run build` 通过

**验证：**
- [ ] 构建成功：`npm run build`

**依赖：** 无

**涉及文件：**
- 修改：`src/poll-command.ts`

**预估规模：** XS（单文件，提取常量 + 分支）

---

### 任务 1 · 步骤 1：提取 `POLL_SCRIPT` 常量

```typescript
// src/poll-command.ts — 在 PollConfig 接口之后，generatePollCommand 之前新增：

export const POLL_SCRIPT = [
  "import sys, json, os, time, urllib.request",
  "",
  "sid = sys.argv[1]",
  "base_url = sys.argv[2] if sys.argv[2] != 'default' else ''",
  "token = sys.argv[3] if sys.argv[3] != 'default' else ''",
  "max_sec = int(sys.argv[4]) if len(sys.argv) > 4 else 300",
  "max_fails = int(sys.argv[5]) if len(sys.argv) > 5 else 3",
  "",
  "# ---- read lock (retry 5x sleep 3s) ----",
  "lock_path = os.path.expanduser('~/.kimi-code/server/lock')",
  "port = None",
  "for i in range(5):",
  "    try:",
  "        port = json.load(open(lock_path))['port']",
  "        break",
  "    except Exception as e:",
  "        if i == 4:",
  "            print(f'[LOCK_LOST] path={lock_path} retries=5 last_error={e}')",
  "            sys.exit(4)",
  "        time.sleep(3)",
  "",
  "if not base_url:",
  "    base_url = f'http://127.0.0.1:{port}'",
  "",
  "# ---- build auth header helper ----",
  "def make_req(path):",
  "    req = urllib.request.Request(f'{base_url}{path}')",
  "    if token:",
  "        req.add_header('Authorization', f'Bearer {token}')",
  "    return req",
  "",
  "# ---- context threshold reader ----",
  "def read_ctx_threshold():",
  "    th_path = os.path.expanduser('~/.kimi-tunnel/ctx-threshold')",
  "    try:",
  "        return int(open(th_path).read().strip())",
  "    except:",
  "        return 36000",
  "",
  "# ---- fetch assistant reply ----",
  "def fetch_result():",
  "    try:",
  "        req = make_req(f'/api/v1/sessions/{sid}/messages?page_size=1&role=assistant')",
  "        data = json.load(urllib.request.urlopen(req, timeout=10))",
  "        for m in data.get('data', {}).get('items', []):",
  "            for b in m.get('content', []):",
  "                if b.get('type') == 'text' and b.get('text'):",
  "                    print(b['text'])",
  "                    return",
  "    except Exception as e:",
  "        print(f'[fetch_result] {e}')",
  "",
  "# ---- main polling loop ----",
  "start_ts = time.time()",
  "fails = 0",
  "while True:",
  "    elapsed = int(time.time() - start_ts)",
  "",
  "    # Guard: total timeout",
  "    if elapsed >= max_sec:",
  "        print(f'[POLL_TIMEOUT] 等待 {max_sec}s 超时，session 可能卡住或 server 离线')",
  "        fetch_result()",
  "        sys.exit(3)",
  "",
  "    # Poll session status",
  "    status = ''",
  "    ctx_tokens = ''",
  "    ctx_max = ''",
  "    try:",
  "        req = make_req(f'/api/v1/sessions/{sid}/status')",
  "        d = json.load(urllib.request.urlopen(req, timeout=10))",
  "        sdata = d.get('data', {})",
  "        status = sdata.get('status', '')",
  "        ctx_tokens = sdata.get('context_tokens', '')",
  "        ctx_max = sdata.get('max_context_tokens', '')",
  "    except Exception:",
  "        pass",
  "",
  "    # Guard: server unreachable (empty status)",
  "    if not status:",
  "        fails += 1",
  "        if fails >= max_fails:",
  "            print(f'[SERVER_OFFLINE] 连续 {fails} 次请求失败，Kimi Server 可能已离线')",
  "            sys.exit(2)",
  "        time.sleep(3)",
  "        continue",
  "",
  "    fails = 0  # reset on success",
  "",
  "    if status in ('idle', 'aborted'):",
  "        # Context token check",
  "        if ctx_tokens:",
  "            try:",
  "                threshold = read_ctx_threshold()",
  "                if int(ctx_tokens) > threshold:",
  "                    cm = ctx_max or '?'",
  "                    print(f'[CTX_HIGH] {ctx_tokens} / {cm} tokens（阈值: {threshold}）— 建议 PM 评估退役')",
  "            except:",
  "                pass",
  "        print('---RESULT---')",
  "        fetch_result()",
  "        sys.exit(0)",
  "",
  "    time.sleep(2)",
].join("\n");
```

### 任务 1 · 步骤 2：添加 `import { existsSync } from "node:fs"` 和 `import { homedir } from "node:os"`

```typescript
import { existsSync } from "node:fs";
import { homedir } from "node:os";
```

### 任务 1 · 步骤 3：重写 `generatePollCommand()` 函数体

```typescript
export function generatePollCommand(config: PollConfig): string {
  const { sessionId, token = "", maxWaitSeconds = 300, maxFailures = 3 } = config;
  const baseUrl = config.baseUrl || process.env.KIMI_SERVER_URL || detectKimiServerUrl();
  const effectiveToken = token || process.env.KIMI_SERVER_TOKEN || "";
  const safe = (v: string) => v.includes(" ") ? `"${v}"` : v;
  const args = `${safe(sessionId)} ${safe(baseUrl || "default")} ${safe(effectiveToken || "default")} ${maxWaitSeconds} ${maxFailures}`;

  const pollPyPath = `${homedir()}/.kimi-tunnel/poll.py`;

  if (existsSync(pollPyPath)) {
    // Prebuilt script available — short command
    return [
      `PYTHONIOENCODING=utf-8 python3 ${pollPyPath} ${args} 2>/dev/null`,
      `|| python ${pollPyPath} ${args}`,
    ].join(" \\\n   ");
  }

  // Degraded: inline full script
  const pyEncoded = POLL_SCRIPT.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const pythonLine = `python3 -c "${pyEncoded}" ${args}`;
  return [
    `PYTHONIOENCODING=utf-8 ${pythonLine} 2>/dev/null`,
    `|| ${pythonLine}`,
  ].join(" \\\n   ");
}
```

### 任务 1 · 步骤 4：构建验证

```bash
npm run build
```

---

### 任务 2：`execute-prompt.ts` 写入 poll.py + 降级标记

**描述：** 在 `generatePollCommand()` 调用前 try-write `POLL_SCRIPT` 到 `~/.kimi-tunnel/poll.py`。写入失败时在响应 JSON 中附加 `"degraded": true` 和提示文案。

**验收标准：**
- [ ] 首次调用自动创建 `~/.kimi-tunnel/poll.py`（目录不存在时自动 mkdir）
- [ ] 写入失败时返回完整内联脚本 + `"degraded": true` + 降级提示
- [ ] 不影响 `wait=true` 的同步路径（仅 `!wait` 分支改动）
- [ ] `npm run build` 通过

**依赖：** 任务 1（需 `POLL_SCRIPT` 导出和 `generatePollCommand` 新行为）

**涉及文件：**
- 修改：`src/tools/execute-prompt.ts`

**预估规模：** XS（单文件，新增 import + try-write 块）

---

### 任务 2 · 步骤 1：新增 import

```typescript
// src/tools/execute-prompt.ts — 在现有 import 后追加：
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { POLL_SCRIPT, generatePollCommand } from "../poll-command.js";
```

### 任务 2 · 步骤 2：修改 `!wait` 分支（第 70-82 行）

将现有的 `!wait` 分支替换为：

```typescript
if (!wait) {
  const { promptId } = await wireClient.submitPrompt(session_id, effectivePrompt, { autoApprove: auto_mode });

  // Try to persist poll.py for future short-command use
  let degraded = false;
  const pollPyDir = `${homedir()}/.kimi-tunnel`;
  const pollPyPath = `${pollPyDir}/poll.py`;
  try {
    mkdirSync(pollPyDir, { recursive: true });
    writeFileSync(pollPyPath, POLL_SCRIPT, "utf-8");
  } catch {
    degraded = true;
  }

  const result: Record<string, unknown> = {
    submitted: true, session_id, prompt_id: promptId,
    poll_command: generatePollCommand({ sessionId: session_id }),
  };

  if (degraded) {
    result.degraded = true;
    result.hint = "prompt 已提交。~/.kimi-tunnel/ 写入失败已降级。检查目录权限，或手动 mkdir ~/.kimi-tunnel 后重试即可启用记忆脚本。";
  } else {
    result.hint = "prompt 已提交。将 poll_command 以 Bash(run_in_background=true) 执行，等待回执。";
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
```

### 任务 2 · 步骤 3：构建验证

```bash
npm run build
```

---

### 任务 3：`chat-with-session.ts` 写入 poll.py + 降级标记

**描述：** 与任务 2 完全相同的 try-write 模式，在 `chat_with_session` 的 fire-and-forget 响应中生效。

**验收标准：**
- [ ] 首次调用自动创建 `~/.kimi-tunnel/poll.py`
- [ ] 写入失败时返回 `"degraded": true` + 降级提示
- [ ] `npm run build` 通过

**依赖：** 任务 1

**涉及文件：**
- 修改：`src/tools/chat-with-session.ts`

**预估规模：** XS（单文件）

---

### 任务 3 · 步骤 1：新增 import

```typescript
// src/tools/chat-with-session.ts — 修改现有 import 行：
import { POLL_SCRIPT, generatePollCommand } from "../poll-command.js";
// 并新增：
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
```

### 任务 3 · 步骤 2：修改响应体（第 35-43 行）

```typescript
try {
  const { promptId } = await wireClient.submitPrompt(session_id, effectivePrompt, { autoApprove: auto_mode });

  let degraded = false;
  const pollPyDir = `${homedir()}/.kimi-tunnel`;
  const pollPyPath = `${pollPyDir}/poll.py`;
  try {
    mkdirSync(pollPyDir, { recursive: true });
    writeFileSync(pollPyPath, POLL_SCRIPT, "utf-8");
  } catch {
    degraded = true;
  }

  const result: Record<string, unknown> = {
    submitted: true, session_id, prompt_id: promptId,
    poll_command: generatePollCommand({ sessionId: session_id }),
  };

  if (degraded) {
    result.degraded = true;
    result.hint = "任务已提交。~/.kimi-tunnel/ 写入失败已降级。检查目录权限，或手动 mkdir ~/.kimi-tunnel 后重试即可启用记忆脚本。";
  } else {
    result.hint = "任务已提交。将 poll_command 以 Bash(run_in_background=true) 执行，等待回执。";
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
} catch (err) {
  return { content: [{ type: "text", text: `提交失败: ${(err as Error).message}` }], isError: true };
}
```

### 任务 3 · 步骤 3：构建验证

```bash
npm run build
```

---

## 检查点：完成

- [ ] `npm run build` 通过
- [ ] `POLL_SCRIPT` 常量可从 `poll-command.js` 正确导入
- [ ] `generatePollCommand()` 在 poll.py 存在/不存在时分别返回短命令/内联命令
- [ ] 首次 `execute_prompt` 调用后 `~/.kimi-tunnel/poll.py` 文件生成
- [ ] 写入失败时响应含 `degraded: true`
- [ ] `wait=true` 同步路径不受影响

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 多 session 并发 writeFile 竞态 | 低 | `writeFileSync` 原子操作 + 内容为常量，最后写入胜出 |
| `~/.kimi-tunnel/` 权限不足 | 低 | try-catch + degraded 降级，不阻塞 PM |
| `POLL_SCRIPT` 与轮询逻辑不同步 | 中 | 常量与 `generatePollCommand` 内联代码同文件维护 |

## 待定问题

无。
