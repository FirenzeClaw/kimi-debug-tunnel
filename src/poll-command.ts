/**
 * Generate a bash polling script that waits for a session to become idle,
 * then fetches and prints the assistant's response.
 *
 * Designed for `Bash(run_in_background=true)` — the OS process exits on completion,
 * timeout, or server disconnection, and the runtime injects a `<notification>`
 * into the coordinating session.
 *
 * Defenses:
 *   - Max 3 consecutive curl failures → exit(2) "server unreachable"
 *   - Max 300s total elapsed → exit(3) "timeout"
 *   - Empty/malformed STATUS → counted as failure
 *
 * Auto-detects python3 vs python for cross-platform compatibility.
 */

import { detectKimiServerUrl } from "./server-lock.js";

export interface PollConfig {
  sessionId: string;
  baseUrl?: string;
  token?: string;
  maxWaitSeconds?: number;   // total timeout, default 300
  maxFailures?: number;       // consecutive curl failures to abort, default 3
}

export function generatePollCommand(config: PollConfig): string {
  const baseUrl = config.baseUrl || process.env.KIMI_SERVER_URL || detectKimiServerUrl();
  const token = config.token || process.env.KIMI_SERVER_TOKEN || "";
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : "";
  const maxSeconds = config.maxWaitSeconds || 300;
  const maxFails = config.maxFailures || 3;

  return [
    `SID="${config.sessionId}"`,
    `# 动态检测 Kimi Server 端口（每次轮询时读取 lock 文件，避免重启换端口后失效）`,
    `PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.kimi-code/server/lock','utf8')).port)}catch(e){console.log('')}" 2>/dev/null)`,
    `if [ -z "$PORT" ]; then`,
    `  echo "[LOCK_MISSING] Kimi Server lock 文件不存在或端口为空——Server 可能未启动"`,
    `  exit 2`,
    `fi`,
    `BASE="http://127.0.0.1:$PORT"`,
    `MAX_SEC=${maxSeconds}`,
    `MAX_FAILS=${maxFails}`,
    `PY=$(which python3 2>/dev/null || which python 2>/dev/null || echo python)`,
    `START_TS=$(date +%s)`,
    `FAILS=0`,
    ``,
    `parse_status() {`,
    `  curl -s --max-time 10 ${authHeader} "$BASE/api/v1/sessions/$SID/status" | \\`,
    `    $PY -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('status',''))"`,
    `}`,
    ``,
    `parse_context() {`,
    `  curl -s --max-time 10 ${authHeader} "$BASE/api/v1/sessions/$SID/status" | \\`,
    `    $PY -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('context_tokens',''),d.get('max_context_tokens',''))"`,
    `}`,
    ``,
    `fetch_result() {`,
    `  PYTHONIOENCODING=utf-8 $PY -c "`,
    `import urllib.request, json, sys`,
    `req=urllib.request.Request(f'$BASE/api/v1/sessions/$SID/messages?page_size=1&role=assistant')`,
    `req.add_header('Authorization','Bearer ${token}')`,
    `try:`,
    ` with urllib.request.urlopen(req,timeout=10) as r:`,
    `  data=json.loads(r.read()).get('data',{})`,
    `  for m in data.get('items',[]):`,
    `   for b in m.get('content',[]):`,
    `    if b.get('type')=='text' and b.get('text'):`,
    `     print(b['text']); break`,
    `except Exception as e:`,
    ` print(f'[fetch_result] {e}')`,
    `"`,
    `}`,
    ``,
    `while true; do`,
    `  NOW=$(date +%s)`,
    `  ELAPSED=$((NOW - START_TS))`,
    ``,
    `  # Guard: total timeout`,
    `  if [ $ELAPSED -ge $MAX_SEC ]; then`,
    `    echo "[POLL_TIMEOUT] 等待 \${MAX_SEC}s 超时，session 可能卡住或 server 离线"`,
    `    fetch_result`,
    `    exit 3`,
    `  fi`,
    ``,
    `  STATUS=$(parse_status)`,
    ``,
    `  # Guard: server unreachable (empty STATUS after curl failure)`,
    `  if [ -z "$STATUS" ]; then`,
    `    FAILS=$((FAILS + 1))`,
    `    if [ $FAILS -ge $MAX_FAILS ]; then`,
    `      echo "[SERVER_OFFLINE] 连续 \${FAILS} 次请求失败，Kimi Server 可能已离线"`,
    `      exit 2`,
    `    fi`,
    `    sleep 3`,
    `    continue`,
    `  fi`,
    ``,
    `  # Reset fail counter on successful request`,
    `  FAILS=0`,
    ``,
    `  if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then`,
    `    # Context length check (v2.14)`,
    `    CTX_INFO=$(parse_context)`,
    `    CTX_TOKENS=$(echo "$CTX_INFO" | awk '{print $1}')`,
    `    CTX_MAX=$(echo "$CTX_INFO" | awk '{print $2}')`,
    `    CTX_THRESHOLD=\${CTX_HIGH_THRESHOLD:-\$(cat "\$HOME/.kimi-tunnel/ctx-threshold" 2>/dev/null || echo 36000)}`,
    `    if [ -n "$CTX_TOKENS" ] && [ "$CTX_TOKENS" -gt "$CTX_THRESHOLD" ] 2>/dev/null; then`,
    `      echo "[CTX_HIGH] $CTX_TOKENS / \${CTX_MAX:-?} tokens（阈值: $CTX_THRESHOLD）— 建议 PM 评估退役"`,
    `    fi`,
    `    echo "---RESULT---"`,
    `    fetch_result`,
    `    exit 0`,
    `  fi`,
    ``,
    `  sleep 2`,
    `done`,
  ].join("\n");
}
