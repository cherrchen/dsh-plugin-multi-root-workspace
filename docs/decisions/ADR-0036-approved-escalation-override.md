# ADR-0036: 已批准的一次性 Full-access 提权覆盖只读根与 per-tool 封顶

## Status

Accepted：产品已批准的权限合同变更。修订 [ADR-0017](./ADR-0017-three-state-root-access-and-sandbox-modes.md) 九格矩阵中「显式 `read-only` 在 `danger-full-access` 下仍拒写」与 [ADR-0013](./ADR-0013-per-root-and-per-tool-access.md)「`toolAccess` 封顶只收窄、不可解除」两条规则——唯一例外是用户针对单次调用批准的一次性 `danger-full-access` 提权。

## Date

2026-11-08

## Context

上游 `approveEscalation`（`packages/sandbox/sandbox/src/escalation.ts`）为 `sandbox_permissions` 参数提供了真实的升级通道：模型在一次被拒后携带 `sandbox_permissions: 'danger-full-access'` 与 `justification` 重试同一调用时，工具在 `tools/execute` waterfall 内调用 `ctx.approval.request({ agent, toolName, callId: exec.callId, reason: \`escalate sandbox to ${mode}: ${justification}\` })`；返回 `'allowed-once'` 时该调用以 `{...standingPolicy, mode: approvedMode}` 继续执行。tool-bash、tool-pwsh、tool-fs（`resolvePolicy`）与 PTC `run_code` 全部如此，且该 reason 前缀在全部受支持版本（0.1.5-rc.2 → 0.2.2-rc.1）逐字节一致。

问题在于**升级后的 policy 对象不携带任何批准标记**：本插件的 scope 只看到 `mode: 'danger-full-access'`，无法区分「standing mode 本来就是 Full-access」与「这次调用被用户特批放行」。按既有合同，scope 对前者继续施加两条负授权——显式 `read-only` 附加根（含在 standing mode 下只读的 `inherit` 根）进入 `deniedRoots`，`toolAccess` 封顶（含非法配置的 cap-everything）拒写一切附加根——于是用户明明批准了 Full-access，写入仍被插件的负授权否决。批准语义与执行结果自相矛盾，属于合同缺口而非产品预期。

需要的信号只能从批准接缝取：`approval.request` 是本进程内唯一同时携带 callId、reason 前缀与结果的观测点。

## Decision

1. **批准标记落在派发自己的 tool-cap 存储上，按 callId + reason 前缀 + mode 三重判定。** `toolCapStore` 的值扩展为 `{ capped, callId, approvedFullAccess }`；`withToolCap(name, fn, callId)` 每次派发创建新存储，`approvedFullAccess` 恒以 `false` 开始、绝不继承父帧。scope 用 `wrapMethod` 包装 `ctx.get('approval').request`（软依赖：无 approval 服务的组合不会产生标记），在 `original` 返回后调用 `noteApproval(req, outcome)`；仅当 `outcome === 'allowed-once'`、`req.reason` 以 `escalate sandbox to danger-full-access: ` 开头、当前 ALS 存储存在且 `store.callId === req.callId`（均非 undefined）、**且请求的 Agent 所在会话的 standing mode 低于 `danger-full-access`** 时才置位——standing mode 的判定由包装器以 `req.agent.session` 经 `sandboxPolicy.resolve` 求得，无 agent 或无 `sandboxPolicy` 服务一律 fail closed 不置位；standing Full-access 的会话根本产生不了真实提权（上游无模式可再升），一个带着相同前缀与 callId 的 `allowed-once`（例如 `tools/pre-execute` hook 或 Auto Review 的 ask）不构成提权授权。reason 前缀是 `approveEscalation` 在全部受支持版本上唯一稳定的提权身份；callId 把授权钉在发起它的那一次派发上。

2. **override 只作用于该调用本次的 `danger-full-access` scope 投影。** `project()` 计算 `override = authority !== 'unavailable' && policy.mode === 'danger-full-access' && store?.approvedFullAccess === true`：
   - `writableRoots`：`authority === 'unavailable'` 或 `capped && !override` ⇒ `[]`；否则取成员中 `override || effectivelyWritable(mode, access)` 者——override 下每个成员均可写（**A：解除根 access 拒绝**）。
   - `deniedRoots`：`override ? [] : baseDenied`，其中 `baseDenied` 按既有规则（`capped || !effectivelyWritable`）原样计算（**B：解除 per-tool 封顶，含非法 `toolAccess`**）。
   - `protectedHome`：判定条件改用 **`baseDenied` 非空 或 authority 不可用**，命中后照常并入 `deniedRoots`——`$DSH_HOME` 恰好在「无 override 时本应被拒」的同一条件下保持拒绝（**C**）。
   - `authority === 'unavailable'` ⇒ override 不成立：`writableRoots` 为空、已知 deny 边界保留，主根钳制照旧（**D**）。

3. **`resolve()` 的准入快照路径同步豁免再封顶。** 快照匹配分支的 `this.capped()` 收窄改为 `this.capped() && !override`——准入快照本身已按 override 计算，再封顶会把已解除的拒绝加回来。

4. **范围恰好是「那一次调用」。** 标记存活在派发的 AsyncLocalStorage 动态域内：并发兄弟派发各有自己的存储；嵌套子派发（如 `run_code` 的子工具调用）由 `withToolCap` 新建存储，approved=false；派发 `fn` 落定（同步返回、reject 或 promise settle）时 `withToolCap` 把本帧标记清回 `false`——ALS 会把 store 保留给派发内创建的异步延续，不显式撤销的话一个 fire-and-forget 任务在调用结束后仍持有授权，那已不是「那一次调用」；下一次派发重新计算。已运行进程、持久终端、面板/用户 PTY 不受影响（它们本就在派发外，按启动时的 deny 集运行）。OPS（`ops_*`）派发逻辑完全不动：OPS 工具自身不发起 `approveEscalation`，其派发存储不可能获得匹配 callId 的提权标记。

5. **消费面不需要改动。** fs fence 的 `checkedTarget` 与进程围栏的 `prepare()` 只读 `deniedRoots`/`writableRoots`：override 后 deny 集为空时 `prepare()` 返回 `undefined` → 上游 ambient Full-access 直通；仅剩 `$DSH_HOME` 时 restricted runner 照常构建 [home] 拒绝集——这与「home 仍受保护」的合同一致，且在 Linux（Landlock 选 bwrap）/ Windows（broker runner）上 runner 不可构建时照旧失败关闭，绝不裸启动。

6. **共享 Registry 下提权调用到达「以提权 mode 计算的 scope」。** fs 写经 `registry.withOperation`、shell/PTC 经进程围栏的 `withRegistryAdmission` 各以**该调用自己的 policy** 开一个嵌套 admission；外层 `tools/execute` admission 用 standing policy，其 mode 不匹配时 `resolve()` 照旧落到钳制路径——嵌套 admission 的 `identity.mode === 'danger-full-access'` 恰好命中提权 policy，其快照由 `resolveSnapshot` 在派发 ALS 内计算，`approvedFullAccess` 可读。

7. **提示词只在陈述了可被覆盖的拒绝时补一句。** `renderWorkspaceRootsContext` 在 `workspace-write` 与 `read-only` 分支末尾（存在显式只读根、非空 cap 名单或非法 `toolAccess` 时）追加：`An approved one-shot danger-full-access escalation lifts the read-only-root and per-tool refusals for that call only.` Full-access 分支与 authority-unavailable 路径不加。

## Alternatives Considered

- **对一切 `danger-full-access` 调用解除两条负授权**：把 standing Full-access 会话的边界一并拆掉——合同缺口被放大为默认无边界，直接否决。
- **仅凭「调用 mode > standing mode」推断批准**：mode 不匹配确实只在提权后出现，但快照路径（`resolveSnapshot`、`withPrimaryOperation`）之外，`resolve()` 在 standing-policy admission 内被以提权 policy 调用时也会落入钳制分支，语义含糊；且「提权 policy 出现在派发中」不等于「用户批准过」——非 `'allowed-once'` 结果或伪造请求无法区分。批准事实是 approval 服务的状态，不是 policy 的形状。
- **观察 Session 事件流（`approval/decided` / `approval/asked`）**：事件按 Session 追加，但读取侧需要把持久化事件与当前派发重新关联——等于在另一个数据源上重建 callId 配对，且事件订阅不能保证先于派发内的 fs/process 强制点到达；包装 `approval.request` 在做出决定的原地取信号，无时序缺口。
- **把标记挂在 Agent/Session 上**：批准身份是「这一次调用」，挂到会话会让同会话的下一次调用继承授权——正是要避免的泄漏。

## Consequences

- 用户对单次调用批准 Full-access 后，该调用的 fs 写、shell/PTC spawn 与嵌套 admission 均按「附加根全可写、无 per-tool 封顶」执行；`$DSH_HOME` 与 authority-unavailable 降级不受影响。
- 批准与执行之间没有可观察的窗口：标记在 `approval.request` 返回后、工具继续执行的同一异步上下文中生效；不存在「批准了但 enforcement 还在旧世界」的状态。
- 一个未安装 `approval` 服务的组合不可能产生标记——软依赖天然 fail closed。
- `wrapMethod` 注册的还原器随 scope 行的 effect 生命周期释放；approval 服务卸载/重挂时包装自动还原并重装。
- Linux/Windows 推论不变：home 仍受保护时 restricted runner 仍是必需路径，构建失败则拒绝启动而非裸跑。
- 提示词只新增一句模型可见的例外说明；standing Full-access 会话的拓扑文案逐字节不变。
- 残余风险：模型可在同一调用内先提权、再以同一 callId 执行任意操作——这正是「一次性批准」的产品语义；callId 钉住的是授权对象（那一次调用），不是授权内容（模型参数）。

回归：`tests/escalation-override.spec.ts`（scope 单测全部正负例、fs fence、进程围栏、共享 Registry 嵌套 admission、approval 包装还原）；`tests/prompt-context.spec.ts`、`tests/scope.spec.ts` 的钉死文案同步更新。

## Related Documents

- [ADR-0013：Per-Root 访问级别与 Per-Tool 封顶](./ADR-0013-per-root-and-per-tool-access.md)（本 ADR 修订其「封顶不可解除」条款）
- [ADR-0017：三态 Root Access 与跨 Sandbox Mode 一致性](./ADR-0017-three-state-root-access-and-sandbox-modes.md)（本 ADR 修订其 Full-access 拒写条款）
- [ADR-0024：Registry 操作准入与撤权顺序](./ADR-0024-registry-operation-admission.md)
- [ADR-0025：共享 Registry 权威服务](./ADR-0025-shared-registry-authority.md)
