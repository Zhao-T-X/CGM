# Audit Center Design

## Goal

Add an audit/activity center that answers who used which token, from which IP, when, and what Web or MCP operation was performed. This is an audit feature, not a task execution dashboard.

## Scope

### Recorded activity

Record business operations and all MCP calls:

- Repository clone, sync, analyze, remove, and worktree operations
- Provider, space, and token changes
- MCP `initialize`
- MCP `tools/list`
- MCP `tools/call`, including the tool name, repository, and branch when available
- Authentication failures, permission denials, out-of-scope requests, and business/MCP failures

Do not record ordinary page-loading reads such as `auth/me`, settings, or repository list reads. Do not audit the audit-log read endpoint itself.

### Sensitive data policy

Never store:

- Authorization headers or raw API tokens
- Provider credentials
- Webhook secrets
- Full MCP results or returned source code

For code searches, store only a bounded query preview. Error text and user-agent values must be bounded before persistence.

## Actor and scope model

Each event stores the resolved actor type and token identity when available:

- `admin`: configured admin token
- `env_mcp`: environment MCP token
- `token`: database token, storing its ID and display name
- `local`: loopback no-auth access
- `unknown`: unauthenticated or invalid token request

Store the client IP using the existing trusted-proxy-aware client address resolver and store a bounded user-agent string. IP is evidence of source, not proof of a human identity.

Visibility:

- Admin can view all audit events.
- A web token can view only its own events and events for repositories in its authorized spaces.
- MCP-only tokens cannot access the audit UI or API.
- Global Provider, space, token-management, and other actors' events are hidden from scoped web tokens.

## Storage

Add a SQLite `audit_logs` table with an immutable event row:

```text
id, created_at,
actor_type, actor_id, actor_name, source,
action, method, path, tool_name,
repo_id, repo_name, branch,
status_code, result, duration_ms,
client_ip, user_agent,
query_preview, error
```

Use bounded text lengths and indexes for `created_at`, `actor_id`, `action`, `repo_id`, `result`, and `client_ip`.

Audit cleanup is not enabled initially. Reserve settings for:

```text
auditAutoCleanup: false
auditRetentionDays: 90
```

No automatic deletion is implemented in the first release; manual cleanup can be added later.

## Capture flow

### HTTP API

The authenticated route layer creates an audit context after principal resolution, executes a business operation, and records status, result, duration, target, and error. Unauthorized requests create an `unknown` event with no token identity and only safe request metadata.

### MCP

Pass the resolved principal into the MCP message handler. Record MCP lifecycle calls and tool calls around execution. The MCP handler supplies tool name, target repository/branch where available, result, duration, and bounded query preview to the audit writer.

Audit writes must not cause the request itself to fail. Audit persistence errors are logged internally and ignored for the business response.

## Frontend: Token Activity Timeline

Add `Settings → Audit Logs` for admin and permitted web tokens.

The primary view is a token/activity timeline rather than a dense table:

1. Left rail: actors/tokens with activity counts and source-IP count.
2. Main panel: selected actor's chronological activity timeline.
3. Filters: all activity, Web, MCP, success, failed, repository, and time range.
4. Right detail panel: selected event's action, source, repository, branch, IP, user-agent, duration, status, and bounded query preview.
5. Actions: refresh and export the filtered safe fields.

Timeline events visibly distinguish success, queued/accepted, denied, and failed states with text labels as well as color. Responsive behavior collapses the three-column layout into actor list, timeline, and detail sections.

Empty, loading, error, and no-permission states must explain what happened and how to recover.

## API

Add an admin/scoped-web endpoint:

```text
GET /api/audit-logs
```

Supported query parameters:

```text
actorId, actorType, source, action, toolName,
repoId, result, ip, from, to, q, limit, cursor
```

The server applies authorization filtering before pagination and never relies on UI filtering for security. Responses omit sensitive fields and return safe display DTOs.

## Verification

Cover:

- API business success and failure audit events
- MCP initialize, tools/list, and tools/call events
- IP and user-agent capture, including trusted proxy behavior
- Unknown token and permission-denial events without token leakage
- Admin visibility across all events
- Scoped web-token visibility by own actor and authorized repository spaces
- MCP-only rejection from audit API
- Pagination/filtering and safe query preview truncation
- Audit write failure not breaking the original request
- UI timeline, event details, empty/loading/error/no-permission states
