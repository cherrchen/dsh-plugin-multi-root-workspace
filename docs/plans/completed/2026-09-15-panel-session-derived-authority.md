# Panel RPC：主根由 host session 推导

> 编号口径：本计划是 `v0.1.1` 硬化批次的 **H2**（路线图未给它 M 编号）；批次总账见[路线图](../active/2026-09-12-multi-root-workspace.md#进度总账)。

## Goal

把面板通道从"浏览器指名 `primaryRoot`、host 校验并回退部署默认 workspace"改成真正的 host-derived authority：每个请求只带 `sessionId`，主根只来自 `sessions.get(sessionId).header.cwd`。

## Background

审查指出 wire contract 允许客户端直接命名 primary root。Connection RPC 只有 loopback / Host / Origin 栅栏，客户端路径加上 `sandboxPolicy.resolve()` 回退，等于让浏览器选择改哪一份登记表，并在没有会话时把 mutation 写进无关主键。加 validation 留不住这条字段——伪造仍可表达。详见 [ADR-0008](../../decisions/ADR-0008-panel-session-derived-authority.md)。

## Current State

本计划实施完成。M1–M4 行为保持不变；本变更只收紧面板通道的权威来源。`/workspace-folders` 仍用 `invocation.agent.session`。

## Scope

- `PanelRequest` 删除 `primaryRoot`，`sessionId` 改为必填；`.strict()` schema 让旧字段变成 `panel/bad-request`。
- `resolvePanelPrimaryRoot(ctx, sessionId)` 成为 host 唯一 resolver；失败码 `session-not-found`。
- `list` 与 mutation 遵守同一条规则。
- 客户端没有当前 Session 时显示 "No active session"，不调用 host。

## Non-goals

- 修改 `/workspace-folders`。
- 把 `sessions` 写进 command 行的硬 `inject`。
- 给 Connection 通道加额外鉴权令牌。

## Design

见 [ADR-0008](../../decisions/ADR-0008-panel-session-derived-authority.md)。权威链：

```text
Browser
  │
  │ sessionId
  ▼
Host
  │
  ├── sessions.get(sessionId)
  │
  └── session.header.cwd
          ↓
      canonicalPath
          ↓
      primaryRoot
```

## Implementation

- `src/contract.ts`、`src/command.ts` 的 `resolvePanelPrimaryRoot`、`src/roots.ts` 的 `session-not-found`。
- `src/client/WorkspaceFoldersAction.tsx` 的无会话空态与词典键 `panel.noSession`。

## Validation

- missing / empty `sessionId` → `panel/bad-request`
- fake `sessionId`、缺失 sessions 服务、请求途中删除会话 → `session-not-found`
- `primaryRoot` 字段 → `panel/bad-request`（session A + root B 已无法表达）
- 正常活动会话 → success
- 客户端无会话 → 不发 RPC，显示 No active session

## Risks

| 风险 | 处置 |
| --- | --- |
| 旧客户端仍发送 `primaryRoot` | 有意破坏；插件尚未发布 |
| 无会话时面板空白 | 正确；Retry 在会话出现后重新解析 |

## Documentation Impact

- ADR-0008（canonical）；ADR-0005 第 4 条标记为被取代
- 架构 §7、需求 §5.7.7、AGENTS.md 不变量、故障排查 405 条目
- 本计划（completed）

## Completion Criteria

- 上述测试全部通过
- `pnpm docs:check` 通过
- `/workspace-folders` 行为不变
