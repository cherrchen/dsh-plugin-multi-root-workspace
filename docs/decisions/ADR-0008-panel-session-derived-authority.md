# ADR-0008: Panel RPC 的主根由 host session 推导

## Status

Accepted

## Date

2026-09-15

## Context

[ADR-0005](./ADR-0005-out-of-tree-client-transport.md) 第 4 条把浏览器当成操作者自己的可信客户端：`PanelRequest` 允许客户端直接写 `primaryRoot`，host 校验它是已存在的目录后就按这个路径改注册表；没有路径时再回退 `session.header.cwd`，再回退 `sandboxPolicy.resolve()`（部署默认 workspace）。

这条链在当前通道上不成立：

1. Connection RPC 的授权就是 loopback / Host / Origin 栅栏（ADR-0005 自己的后果），浏览器里任何脚本都可以打 `/multi-root-workspace`。客户端指名主根等于让调用方选择改哪一份登记表——`session A` 可以给 `root B` 加根，而 host 无法区分"面板正在显示 B"和"伪造 B"。
2. 回退到 `sandboxPolicy.resolve()` 没有 session 语义。面板操作的对象是"当前会话的 workspace"，不是这台机器的部署默认目录。缺 session、假 session、会话在请求途中被删掉时，猜一个默认根会把 mutation 写进无关的主键。
3. 给 `list` 留宽松语义、只对 mutation 严格，会在同一条通道上维持两套权威规则。`list` 也会播种 scope（`registry.refresh()`），宽松读取同样会作用到错误的主根。

加一层"client `primaryRoot` 必须等于 session cwd"的 validation 解决不了问题：字段还在，伪造仍可表达，解析器仍有三条回退。正确做法是把客户端命名主根的能力从契约里删掉。

`/workspace-folders` 不在这条威胁模型里：它走 `invocation.agent.session`，那是 host 自己的命令上下文。

## Decision

1. **请求体删除 `primaryRoot`。** `PanelRequest` 变成：

   ```ts
   interface PanelRequest {
     sessionId: string
     entry?: RootEntryView
     id?: string
     path?: string
     alias?: string
     beforeEntry?: RootEntryView
     beforeId?: string
   }
   ```

   Zod schema 保持 `.strict()`。旧客户端若仍发送 `primaryRoot`，会得到 `panel/bad-request`，而不是被静默忽略。`session A + root B` 的伪造在契约上已经无法表达。

2. **每个端点（含 `list`）都要求有效 session。** 通道只有一套权威规则。

3. **host 只有一个 resolver：**

   ```ts
   resolvePanelPrimaryRoot(ctx, sessionId) → canonicalPath(session.header.cwd)
   ```

   实现通过 `ctx.get('sessions')?.get(sessionId)` 读可选兄弟服务（属性访问会触发 `without inject`，见 [面板 HTTP 405](../troubleshooting/panel-channel-http-405.md)）。服务不存在、id 对不上、会话已被删除：一律 `session-not-found`。不再回退 `sandboxPolicy.resolve()`。

4. **客户端没有当前 Session 时不调用 host。** 面板显示 "No active session" / "当前没有活动会话"，由操作者打开会话后再点重试。host 不替浏览器猜根。

5. **命令保持原样。** `/workspace-folders` 继续用 `ctx.sandboxPolicy.resolve({ session: invocation.agent.session })`。

本决策取代 ADR-0005 第 4 条；ADR-0005 其余条款（通道、落点、picker、失败码、client 制品形状）不变。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 保留 `primaryRoot`，校验它等于 session cwd | 伪造仍可表达；解析器仍有客户端路径分支；schema 无法把"已不可能"变成类型错误 |
| `list` 宽松、mutation 严格 | 双重语义；`list` 会 `refresh()` 并播种 scope，宽松读取同样打到错误主键 |
| 把 `sessions` 写进 command 行的 `inject` | headless 没有面板但仍要挂命令；session 对通道是必需、对命令行不是（命令已有 `invocation.agent.session`） |
| 无 session 时继续回退部署默认 workspace | 面板操作没有理由改那份登记表 |

## Consequences

- 旧面板若发送 `primaryRoot` 会立刻 `panel/bad-request`；这是有意的破坏性契约变更，发生在插件尚未发布的窗口内。
- 没有活动会话时面板不可用（正确）。Retry 在会话出现后重新走同一条 resolver。
- 通道单测必须把 `sessions` 做成兄弟插件（与真实组合相同），不能靠根 context `provide` 绕过 lookup，也不能再靠 `primaryRoot` 绕过会话分支。
- `smoke:journey` 的认证 `list` 已经只带 `{ sessionId: 'journey-web' }`，与 UI 一致。

## Related Documents

- [ADR-0005 出树 client 半部的通道与落点](./ADR-0005-out-of-tree-client-transport.md)（被本决策修订第 4 条）
- [架构文档 §7](../architecture/multi-root-workspace.md)
- [计划：Panel session-derived authority](../plans/completed/2026-09-15-panel-session-derived-authority.md)
- [故障排查：面板 HTTP 405](../troubleshooting/panel-channel-http-405.md)
