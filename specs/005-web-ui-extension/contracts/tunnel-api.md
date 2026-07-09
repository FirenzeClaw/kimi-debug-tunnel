# API Contracts: Tunnel Server (新增)

**Feature**: `005-web-ui-extension`

---

## GET /api/orchestrations

获取所有已知 PM session 及其子 session 的编排关系。无需参数，tunnel 自动从 WorkflowEngine 发现。

### Request

`GET /api/orchestrations` — 无请求体，无查询参数。

### Response (200 OK)

```json
{
  "orchestrations": [
    {
      "pm_session_id": "ses_abc123",
      "cwd": "D:/code/my-project",
      "children": [
        {
          "session_id": "ses_child001",
          "cwd": "D:/code/my-project/src",
          "status": "active",
          "created_at": "2026-07-09T10:00:00Z"
        },
        {
          "session_id": "ses_child002",
          "cwd": "D:/code/my-project",
          "status": "done",
          "created_at": "2026-07-09T09:55:00Z"
        }
      ]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pm_session_id` | `string` | PM session ID |
| `cwd` | `string` | PM session 工作目录 |
| `children` | `array` | 子 session 列表 |
| `children[].session_id` | `string` | 子 session ID |
| `children[].cwd` | `string` | 子 session 工作目录 |
| `children[].status` | `string` | 状态：`active`, `idle`, `done`, `error`, `awaiting_approval` |
| `children[].created_at` | `string` | ISO 8601 创建时间 |

### Response (empty)

```json
{
  "orchestrations": []
}
```

### Error Responses

| Status | Condition | Body |
|:--:|------|------|
| 503 | Wire client 未连接 | `{"error": "Wire client not connected"}` |

---

## GET /api/token

获取 tunnel 持有的 Kimi Server token。**仅 localhost 可访问**。

### Request

`GET /api/token` — 无请求体。

### Response (200 OK)

```json
{
  "token": "kimi-session-token-string"
}
```

### Error Responses

| Status | Condition | Body |
|:--:|------|------|
| 403 | 非 localhost 请求 | `{"error": "Access restricted to localhost"}` |
| 404 | `KIMI_SERVER_TOKEN` 未设置 | `{"error": "KIMI_SERVER_TOKEN not configured"}` |

### Security

服务端校验逻辑：
```javascript
const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
if (!loopback.includes(req.ip)) return res.status(403).json({...});
```
