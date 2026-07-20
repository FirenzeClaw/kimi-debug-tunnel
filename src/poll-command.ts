/**
 * Generate a pure Python inline polling script (`python3 -c "..."`) that
 * waits for a session to become idle, then fetches and prints the assistant's
 * response. Wrapped in a single-line bash command with PYTHONIOENCODING=utf-8
 * for Windows emoji compatibility.
 *
 * Designed for `Bash(run_in_background=true)` — the OS process exits on completion,
 * timeout, or server disconnection, and the runtime injects a `<notification>`
 * into the coordinating session.
 *
 * Defenses:
 *   - Max N consecutive request failures → exit(2) "server unreachable"
 *   - Max total elapsed → exit(3) "timeout"
 *   - Lock file missing after retries → exit(4) "lock lost"
 *   - Context token threshold exceeded → warning printed but exit(0)
 *
 * Uses `python3` with `python` fallback in the shell wrapper for cross-platform
 * compatibility.
 *
 * Modification history:
 *   2026-07-20 | kimi-code (fix) | 0.24+ 适配：status 枚举 → busy/pending_interaction 双模型判定，消除 SERVER_OFFLINE 误报；busy=False 补查 pending_interaction 防审批中间态提前退出
 *   2026-07-16 | kimi-code (feat) | v2.16 预置脚本 + 降级：POLL_SCRIPT 常量、existsSync 短命令分支、fetch_result 写入 poll-result-{sid}.txt；路径规范化 \→/
 *   2026-07-16 | kimi-code (fix) | Bash→Python 重写：消除 node 依赖、LOCK_LOST 重试、退出码扩展 0/2/3/4
 *   2026-07-16 | kimi-code (feat) | v2.14 新增 parse_context() + CTX_HIGH 阈值检测
 *   2026-07-16 | kimi-code (feat) | 提取 POLL_SCRIPT 常量 + existsSync 文件检测分支（预置脚本优先）
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { detectKimiServerUrl } from "./server-lock.js";

export interface PollConfig {
  sessionId: string;
  baseUrl?: string;
  token?: string;
  maxWaitSeconds?: number;   // total timeout, default 300
  maxFailures?: number;       // consecutive curl failures to abort, default 3
}

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
  "                    text = b['text']",
  "                    print(text)",
  "                    # Write to fixed path for PM quick-read (sid isolates parallel sessions)",
  "                    result_path = os.path.expanduser(f'~/.kimi-tunnel/poll-result-{sid}.txt')",
  "                    try:",
  "                        with open(result_path, 'w', encoding='utf-8') as f:",
  "                            f.write(text)",
  "                    except Exception:",
  "                        pass",
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
  "        # 双模型兼容: 0.22.x status 枚举优先; 0.24+ 按 busy 推导（见 API.md §五）",
  "        if sdata.get('status'):",
  "            status = sdata['status']",
  "        elif sdata.get('busy') is True:",
  "            status = 'running'",
  "        elif sdata.get('busy') is False:",
  "            status = 'idle'",
  "            # 0.24+ 补查 pending_interaction: approval/question 暂停时 busy=false 但 turn 未完结",
  "            # （与 wire-client getSessionStatus 同一策略；取值 approval/question 为推断，未命中则保持 idle 兜底）",
  "            try:",
  "                req2 = make_req(f'/api/v1/sessions/{sid}')",
  "                d2 = json.load(urllib.request.urlopen(req2, timeout=10))",
  "                pi = d2.get('data', {}).get('pending_interaction', 'none')",
  "                if pi == 'approval':",
  "                    status = 'awaiting_approval'",
  "                elif pi == 'question':",
  "                    status = 'awaiting_question'",
  "            except Exception:",
  "                pass",
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

export function generatePollCommand(config: PollConfig): string {
  const { sessionId, token = "", maxWaitSeconds = 300, maxFailures = 3 } = config;
  const baseUrl = config.baseUrl || process.env.KIMI_SERVER_URL || detectKimiServerUrl();
  const effectiveToken = token || process.env.KIMI_SERVER_TOKEN || "";
  const safe = (v: string) => v.includes(" ") ? `"${v}"` : v;
  const args = `${safe(sessionId)} ${safe(baseUrl || "default")} ${safe(effectiveToken || "default")} ${maxWaitSeconds} ${maxFailures}`;

  const pollPyPath = `${homedir()}/.kimi-tunnel/poll.py`.replace(/\\/g, "/");

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
