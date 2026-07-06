/**
 * Generate a bash polling script that waits for a session to become idle,
 * then fetches and prints the assistant's response.
 *
 * Designed for `Bash(run_in_background=true)` — the OS process exits when idle,
 * and the runtime injects a `<notification>` into the coordinating session.
 *
 * Auto-detects python3 vs python for cross-platform compatibility.
 */

export interface PollConfig {
  sessionId: string;
  baseUrl?: string;
  token?: string;
}

export function generatePollCommand(config: PollConfig): string {
  const baseUrl = config.baseUrl || process.env.KIMI_SERVER_URL || "http://127.0.0.1:5494";
  const token = config.token || process.env.KIMI_SERVER_TOKEN || "";
  const authHeader = token ? `-H "Authorization: Bearer ${token}"` : "";

  const parseStatus = (
    `PY=$(which python3 2>/dev/null || which python 2>/dev/null || echo python)\n` +
    `$PY -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('status',''))"`
  );

  const parseMessages = (
    `$PY -c "\n` +
    `import sys,json\n` +
    `data=json.load(sys.stdin).get('data',{})\n` +
    `for m in data.get('items',[]):\n` +
    `  for b in m.get('content',[]):\n` +
    `    if b.get('type')=='text' and b.get('text'):\n` +
    `      print(b['text']); break\n` +
    `"`
  );

  return [
    `SID="${config.sessionId}"`,
    `BASE="${baseUrl}"`,
    `PY=$(which python3 2>/dev/null || which python 2>/dev/null || echo python)`,
    `while true; do`,
    `  STATUS=$(curl -s ${authHeader} "$BASE/api/v1/sessions/$SID/status" | $PY -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('status',''))")`,
    `  if [ "$STATUS" = "idle" ] || [ "$STATUS" = "aborted" ]; then`,
    `    echo "---RESULT---"`,
    `    curl -s ${authHeader} "$BASE/api/v1/sessions/$SID/messages?page_size=5&role=assistant" | $PY -c "`,
    `import sys,json`,
    `data=json.load(sys.stdin).get('data',{})`,
    `for m in data.get('items',[]):`,
    `  for b in m.get('content',[]):`,
    `    if b.get('type')=='text' and b.get('text'):`,
    `      print(b['text']); break`,
    `"`,
    `    break`,
    `  fi`,
    `  sleep 2`,
    `done`,
  ].join("\n");
}
