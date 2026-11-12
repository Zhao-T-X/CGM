# Audit Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-safe audit center that records meaningful Web/API and MCP activity with token, IP, outcome, and timing context, then presents it as a token activity timeline.

**Architecture:** Keep the existing zero-dependency Node HTTP server and SQLite storage. Add an immutable `audit_logs` table and a small audit writer/query layer inside `server.mjs`; pass the resolved principal into `mcp.mjs` so MCP lifecycle/tool calls use the same writer. Add one scoped `GET /api/audit-logs` endpoint and a Settings → Audit Logs timeline view in the single-file frontend.

**Tech Stack:** Node.js built-ins (`node:sqlite`, `crypto`, `URL`), native HTTP routing, SQLite, vanilla JavaScript/Tailwind-like utility classes already used by `public/index.html`, existing SSE refresh mechanism.

---

## File map

- Modify `server.mjs`: SQLite schema, bounded audit writer/query helpers, request metadata, API route, authorization filtering, and audit hooks for business operations.
- Modify `mcp.mjs`: accept principal/audit callback context and record MCP lifecycle/tool events without storing full results.
- Modify `public/index.html`: permission-aware Audit Logs navigation, actor list, timeline, filters, event detail panel, loading/empty/error states, and safe export.
- Modify `verify-mcp.mjs`: isolated-instance assertions for audit persistence, API/MCP events, IP capture, filtering, and permission boundaries.
- Modify `README.md` and `README.en.md`: document Audit Logs, recorded fields, and privacy limits.

## Task 1: Add the audit table and bounded writer

**Files:**
- Modify: `server.mjs:97-109` (SQLite schema)
- Modify: `server.mjs:414-430` (utility area)

- [ ] **Step 1: Write failing isolated assertions for storage behavior**

Extend the temporary-server verification setup in `verify-mcp.mjs` with checks that a business event can be persisted and that stored rows do not contain an Authorization header or full MCP result. Run `node verify-mcp.mjs` and confirm the new assertions fail before the table/writer exists.

- [ ] **Step 2: Add the SQLite schema and indexes**

Add:

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  tool_name TEXT,
  repo_id TEXT,
  repo_name TEXT,
  branch TEXT,
  status_code INTEGER,
  result TEXT NOT NULL,
  duration_ms INTEGER,
  client_ip TEXT,
  user_agent TEXT,
  query_preview TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_id, actor_type);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action, tool_name);
CREATE INDEX IF NOT EXISTS audit_logs_repo_idx ON audit_logs(repo_id);
CREATE INDEX IF NOT EXISTS audit_logs_result_idx ON audit_logs(result);
CREATE INDEX IF NOT EXISTS audit_logs_ip_idx ON audit_logs(client_ip);
```

- [ ] **Step 3: Implement bounded normalization and `writeAudit()`**

Add a helper that truncates strings before SQLite insertion (`actor_name` 120, path 300, user-agent 300, query preview 500, error 500). `writeAudit(event)` must insert one immutable row, catch/log persistence errors, and never reject or alter the original request.

- [ ] **Step 4: Run the focused verification**

Run `node verify-mcp.mjs`. Expected: the new storage/privacy assertions pass and all existing MCP assertions remain passing.

- [ ] **Step 5: Commit**

```bash
git add server.mjs verify-mcp.mjs
git commit -m "feat(audit): add immutable audit log storage"
```

## Task 2: Capture actors, IPs, and API business operations

**Files:**
- Modify: `server.mjs:448-516` (principal/request metadata)
- Modify: `server.mjs` HTTP route handlers for repo/provider/space/token operations

- [ ] **Step 1: Add an audit context helper**

Implement `auditContext(req, principal)` using `clientAddr(req)` and the user-agent header. Map principals to `admin`, `env_mcp`, `token`, `local`, or `unknown`; never include the raw extracted token. Keep `actor_id` only for database tokens.

- [ ] **Step 2: Add a business-operation helper**

Implement `auditBusiness(req, principal, event, work)` that records start time, awaits `work`, records success/failure and status, and rethrows/returns the original result. Use it only around meaningful mutations and repository operations, not ordinary list/auth/settings reads.

- [ ] **Step 3: Instrument the mutation and repository routes**

Record actions with stable names such as:

```text
repo.create, repo.clone, repo.sync, repo.analyze, repo.remove,
worktree.create, worktree.remove,
provider.create, provider.update, provider.delete,
space.create, space.update, space.delete, space.bind, space.unbind,
token.create, token.revoke
```

Include repo ID/name and branch when the route has them. Record 403/401 attempts, including out-of-scope and admin-required failures, before returning the response.

- [ ] **Step 4: Add the scoped audit query endpoint**

Implement `GET /api/audit-logs` after principal resolution. Permit admin and web-role principals only. Apply authorization in SQL/query construction before pagination:

- admin: all rows;
- database web token: own `actor_id` rows plus rows whose `repo_id` belongs to an allowed space;
- env MCP/local/unknown: deny this endpoint.

Support `actorId`, `actorType`, `source`, `action`, `toolName`, `repoId`, `result`, `ip`, `from`, `to`, `q`, `limit`, and cursor pagination. Cap `limit` at 100 and return safe DTO fields only.

- [ ] **Step 5: Verify actor/IP/permission behavior**

Add assertions for two requests using the same token from different client addresses where the test server allows a controlled address header through `TRUSTED_PROXIES`; verify the rows differ by `clientIp`. Verify admin sees all rows, scoped web sees only own/authorized repo rows, MCP-only receives 403, and invalid tokens never expose token text.

- [ ] **Step 6: Commit**

```bash
git add server.mjs verify-mcp.mjs
git commit -m "feat(audit): record API operations and scoped audit queries"
```

## Task 3: Record MCP lifecycle and tool activity

**Files:**
- Modify: `server.mjs` MCP routing call
- Modify: `mcp.mjs:135-220,306-484`
- Modify: `verify-mcp.mjs`

- [ ] **Step 1: Pass principal and audit callback into MCP handling**

Change the call to `handleMcpMessage(req, res, visibleRepos, principal, writeAudit)` while preserving existing external behavior. Keep the audit writer dependency narrow so `mcp.mjs` does not access the database directly.

- [ ] **Step 2: Record JSON-RPC lifecycle calls**

Record `mcp.initialize` and `mcp.tools_list` with status, duration, actor, IP, and user-agent. Record protocol errors as failed events.

- [ ] **Step 3: Record `tools/call` safely**

Record `mcp.tools_call` with `tool_name`, target repo/branch when resolvable, and a bounded `query_preview` for `search_code`. Do not store tool output, source code, Authorization, or complete arguments. Set result to success or failed based on the MCP response.

- [ ] **Step 4: Verify MCP audit rows**

Run the MCP protocol tests and assert rows exist for initialize, tools/list, and tools/call, including IP, tool name, duration, and no full result text.

- [ ] **Step 5: Commit**

```bash
git add server.mjs mcp.mjs verify-mcp.mjs
git commit -m "feat(audit): trace MCP lifecycle and tool calls"
```

## Task 4: Build the Token Activity Timeline UI

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add the permission-aware navigation entry**

Show `Audit Logs` for admin and web-role principals. Hide it for MCP-only tokens. If a scoped web token has no visible events, show the empty state rather than exposing global activity.

- [ ] **Step 2: Add the timeline data loader and filters**

Implement `loadAuditLogs(params)` against `/api/audit-logs`, keeping filters in local state. Use bounded page size and cursor pagination. Refresh on demand and on the existing SSE `repos-changed` channel only when the audit view is active.

- [ ] **Step 3: Render the B layout**

Build:

1. Actor rail with token name, actor type, event count, and distinct IP count.
2. Chronological timeline with Web/MCP badges and text status labels.
3. Filters for source, result, repository, IP, action, and time range.
4. Event detail panel with action, source, target, branch, IP, user-agent, duration, result, and bounded query preview.
5. Refresh and safe export of currently loaded DTO fields.

Use the existing black/white/accent visual language and responsive collapse at narrow widths. Do not rely on color alone for success, denied, or failed states.

- [ ] **Step 4: Add loading, empty, error, and no-permission states**

Show actionable messages: loading skeleton, “No activity in this range,” API error with Retry, and “Audit logs require a web or admin token.”

- [ ] **Step 5: Verify in the browser**

Run the isolated server with admin, scoped web, and MCP-only tokens. Confirm actor selection, filters, IP display, event detail, responsive layout, and permission hiding. Capture a screenshot of the final timeline for review.

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat(audit): add token activity timeline"
```

## Task 5: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `verify-mcp.mjs` if final assertions need consolidation

- [ ] **Step 1: Document the Audit Logs feature**

Document the page location, recorded operations, token/IP/User-Agent behavior, privacy exclusions, scoped web visibility, and MCP-only restriction in both README files.

- [ ] **Step 2: Run syntax and regression checks**

```bash
node --check server.mjs
node --check mcp.mjs
node --check verify-mcp.mjs
node verify-mcp.mjs
git diff --check
```

Expected: all checks pass and no Authorization/token/provider-secret values appear in audit rows or exported DTOs.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md README.en.md verify-mcp.mjs
git commit -m "docs: document audit center and verification"
```

## Self-review

- Spec coverage: storage/privacy is Task 1; actors/IP/API scope is Task 2; MCP calls are Task 3; B timeline and states are Task 4; docs and verification are Task 5.
- No automatic cleanup is implemented; the reserved settings are documented in Task 1 and the spec.
- API and MCP audit writes are isolated from business response failures.
- Scoped web visibility is applied server-side before pagination.
- The plan does not include task execution-center work, Webhook work, or automatic cleanup.
