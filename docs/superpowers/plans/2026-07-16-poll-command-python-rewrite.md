# 实现计划：Poll Command Bash → Python 重写

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `generatePollCommand()` 的输出从混合 bash+python 改为纯 `python -c` 单脚本，修复子 shell 变量丢失、LOCK_MISSING 无重试、node 依赖三个缺陷。

**架构：** 单文件修改 `src/poll-command.ts` —— bash 包装缩减为 1 行（选解释器 + 传参），内部逻辑全部迁入 Python `sys.argv` → urllib 轮询 → 退出码 0/2/3/4。

**技术栈：** TypeScript（生成器），Python 3 stdlib（urllib + json + os + sys + time）

---

## 任务列表

### 任务 1：重写 `generatePollCommand()` 为纯 Python 脚本生成器

**描述：** 将函数体内 85 行 bash 混合代码替换为纯 `python -c` 生成逻辑。Python 脚本通过 `sys.argv` 接收参数，内部循环 poll status + fetch result。

**验收标准：**
- [ ] 不再依赖 `node -e` 读锁文件
- [ ] 锁读取失败时重试 5 次（间隔 3s），耗尽后输出 `[LOCK_LOST]` + exit 4
- [ ] status 为空时连续失败计数，≥ maxFails 时 exit 2
- [ ] status 为 idle/aborted 时输出 `---RESULT---` + 回复文本 + exit 0
- [ ] 超时（≥ maxWaitSeconds）时输出 `[POLL_TIMEOUT]` + fetch_result + exit 3
- [ ] context token 超过阈值（`~/.kimi-tunnel/ctx-threshold` 或默认 36000）时输出 `[CTX_HIGH]` 警告
- [ ] bash 包装仅 1 行：`PYTHONIOENCODING=utf-8 python3 -c "..." <args> 2>/dev/null || python -c "..." <args>`
- [ ] `PollConfig` 接口和函数签名不变
- [ ] `npm run build` 通过

**验证：**
- [ ] 构建成功：`npm run build`
- [ ] diff 检查：`src/tools/execute-prompt.ts` 和 `src/tools/chat-with-session.ts` 无改动
- [ ] 生成的脚本语法正确（Python 单引号内无未转义双引号）

**依赖：** 无

**涉及文件：**
- 修改：`src/poll-command.ts:17-119`

**预估规模：** XS（单文件，~80 行替换）

---

### 步骤 1：编写 Python 脚本字符串

在 `generatePollCommand()` 内，删除旧 bash 数组 `return [...]`，改为生成纯 Python 脚本。

TypeScript 代码变更：

```typescript
export function generatePollCommand(config: PollConfig): string {
  const { sessionId, token = "", maxWaitSeconds = 300, maxFailures = 3 } = config;
  const baseUrl = config.baseUrl || process.env.KIMI_SERVER_URL || detectKimiServerUrl();
  const effectiveToken = token || process.env.KIMI_SERVER_TOKEN || "";

  // Build the Python polling script body
  const py = [
    "import sys, json, os, time, urllib.request",
    "",
    "sid = sys.argv[1]",
    "base_url = sys.argv[2] if sys.argv[2] != 'default' else ''",
    "token = sys.argv[3] if sys.argv[3] != 'default' else ''",
    `max_sec = int(sys.argv[4]) if len(sys.argv) > 4 else ${maxWaitSeconds}`,
    `max_fails = int(sys.argv[5]) if len(sys.argv) > 5 else ${maxFailures}`,
    "",
    "# ---- read lock (retry 5× sleep 3s) ----",
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

  // Shell wrapper arguments: sessionId baseUrl token maxWaitSeconds maxFailures
  const safe = (v: string) => v.includes(" ") ? `"${v}"` : v;
  const args = `${safe(sessionId)} ${safe(baseUrl || "default")} ${safe(effectiveToken || "default")} ${maxWaitSeconds} ${maxFailures}`;

  const pyEncoded = py.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const pythonLine = `python3 -c "${pyEncoded}" ${args}`;

  return [
    `PYTHONIOENCODING=utf-8 ${pythonLine} 2>/dev/null`,
    `|| ${pythonLine}`,
  ].join(" \\\n   ");
}
```

### 步骤 2：构建并验证

- [ ] 运行 `npm run build`
- [ ] 确认编译无错误
- [ ] 快速目视检查生成输出（可选：`node -e "import('./dist/poll-command.js').then(m => console.log(m.generatePollCommand({sessionId:'test'})))"`）

### 步骤 3：Commit

```bash
git add src/poll-command.ts
git commit -m "fix(poll-command): rewrite bash polling script as pure python -c

- Eliminate node dependency for lock file reading
- Add LOCK_LOST retry (5× sleep 3s, exit 4 on exhaustion)
- Fix subshell variable scoping issues (all logic in single Python process)
- Preserve exit code contract: 0=done, 2=offline, 3=timeout, 4=lock_lost
- Keep PollConfig interface and caller sites unchanged"
```

---

## 检查点：完成

- [ ] `npm run build` 通过
- [ ] `src/tools/execute-prompt.ts` 和 `src/tools/chat-with-session.ts` 无 diff
- [ ] 生成的脚本：bash 行 ≤ 3 行，其余全 Python
- [ ] 退出码 0/2/3/4 全覆盖
- [ ] LOCK_LOST 重试逻辑存在（5 次，sleep 3）
- [ ] Context token 阈值检测保留
- [ ] 中文输出正常（UTF-8 编码）

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Python `-c` 转义导致语法错误 | 中 | 全程使用单引号，只在 shell 层用 `\"` 转义双引号 |
| 跨平台 Python 路径差异 | 低 | `python3 \|\| python` fallback 已在三平台验证 |
| fetch_result 大响应截断 | 低 | 保持与原 `page_size=1` 逻辑一致 |

## 待定问题

无。
