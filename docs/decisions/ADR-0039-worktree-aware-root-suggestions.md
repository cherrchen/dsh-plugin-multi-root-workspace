# ADR-0039: Worktree 感知的附加根建议、Git 元数据授权与删除生命周期

## Status

Accepted（2026-11-14 第二十次修订；2026-11-10 第十九次修订；2026-11-09 第十八次修订与同日实施审计返工 R1–R6）。A 的目标是主 checkout 根，开关实验性、默认关闭；自动发现收敛为会话激活时一次只读检查 + 非模态 Toast，用户点「查看」后才打开单/多候选确认 Dialog。本文记录设计，实施与验证状态以[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)为准。

## 复审修正（2026-11-09）

`db50de6` 的复审补充了指针词法、持续换链、队列内异步边界、生命周期与线协议反例。保留原授权决策，现行实现边界以 §2.2、§2.4、§4.4、§7 与 §9 为准。验收证据见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#worktree-感知建议-ba-实施2026-11-09)。

## 首次实施审计修正（2026-11-09，历史）

独立审计在 `ceb708e` 上复现的六类缺陷不改变本 ADR 的决策，只把实现收回已经写明的边界；返工条目见[实施计划](../plans/active/2026-11-09-worktree-aware-root-suggestions.md#r1r6-审计返工2026-11-09完成)。这里固定五条容易再次偏离的判据：

- B 候选必须绑定**正在枚举的 common 与 admin 条目**，owner 也必须要求 primary/candidate 的 common 相同；仅比较 admin 名称不足以证明属于同一仓库。
- 指针目标先做**字面路径的逐段拒绝**，再做 `realpath`；`realpath` 结果还必须与拒绝前观察到的目录身份相同。admin/common 目标本身是 symlink 时一律 inactive。
- POSIX 路径只以 `/` 分段，文件名中的字面反斜杠不是分隔符；祖先 index 查找同样保留它。
- 开关与 live session 的提交边界：调用 Host 在**送交 owner 前**重读 primary/mode/开关/提示代次；owner 在**串行队列内、持久化前**重读自己的开关。只在入队前检查会放过已经排队的确认。
- 专用清理的最终资格在 owner 内复验：primary 仍激活、当前 sidecar 有匹配的 B 映射、路径确认缺失；调用端选择不构成删除授权。提示 ID 只在完整 expectation 相同时复用。

## 第十九次修订（2026-11-10）

按维护者决定调整三件事；A 的 owner 串行复验、“不启动 Git”与“用户显式确认才登记”的边界不变：

1. **A 的目标改为主 checkout 根 `<main>`**。登记路径从 canonical common（通常是 `<main>/.git`）改为 `dirname(common)`，候选 kind 从 `git-common` 改为 `main-checkout`。`<main>/.git` 必须仍是 canonical common 的真实目录（非 symlink）；owner 在队列内同时复验该回指、主根目录身份与既有 admin 快照。授权范围因此包含主 checkout 的源码树——这是刻意的范围扩大，取代第十八次修订“只登记 Git 元数据”的目标。
2. **默认 pool 不再提供 A**。pool primary 位于 `<main>` 内，`<main>` 包含 primary，Registry 的 `primary-overlap` 拒绝；pool 的 `git add` / `git commit` 会重新失败。外部 linked checkout 仍适用。`--separate-git-dir` 时 `dirname(common)` 只是 store 的父目录而非真正的主 checkout，且从 linked checkout 的元数据无法区分；A 提示必须显示该实际路径并明确“若使用 separate-git-dir，请核对”，用户确认的是所见路径（ADR §1）。
3. **开关改为实验性、默认关闭**。`multi-root-worktrees.enabled` 缺省 `false`；插件详情卡在标题旁显示“实验性”Tag。缺省设置、缺失 Settings 服务与 loader 未显式开启一律视为关闭；只有显式的持久化 `true` 或 loader `true` 才启用。插件行仍加载但完全惰性（无发现、提示、watcher 或清理）。

同时，提示模型按**可见候选数量**分流：恰好一个返回 `prompt`（原单确认对话框）；两个及以上返回 `prompts`（勾选列表，一次确认多个 id）。`seenPromptId` 由 `seenViewRevision` 取代：无 seen 时首次返回当前视图；seen 相同则继续等待；seen 不同时按新视图返回 `prompt` / `prompts`，视图为空则 `stale`。批量确认逐项保留 owner 复验，失效项通过 `skipped` 返回并保持未登记，不再让整批失败（authority/存储/开关关闭仍中止整批）。

## 第二十次修订（2026-11-14）

自动发现从**常驻长轮询 overlay** 收敛为**会话激活时一次只读检查 + 非模态 Toast + 显式确认 Dialog**，并新增按候选 key 的提醒延迟（snooze）。授权语义不变：不自动添加、不自动删除根，`addNew` 仍是唯一写入路径，owner 的完整复验与 `worktree/prompt-stale` 行为沿用前文。本节是 §1、§3.3、§4.2–§4.4、§7 与 §9 中**提示触发、呈现与提醒节奏**的现行规则；这些条款里与「客户端常驻长轮询」直接相关的表述由本节取代，其余边界继续有效。

### 20.1 触发收敛

- 自动检查只在「客户端当前 session 从空/其他变为一个有效 session」时发生一次：打开、切换、新建 session 后首次进入都算一次激活。
- 该次激活调用一次 `worktreePrompt(sessionId, { fresh: true })`：有 fresh 候选就显示 Toast，没有就什么都不显示。
- **不启动 `worktreePromptWait`**；只有用户点「查看」打开 Dialog 后才启动（见 20.8）。
- 同一 session 的页面重挂不重复检查：该 session 看过的候选已由 `seen` 写入 Host `offered` 认领，`fresh` 因此为空。

### 20.2 禁止的自动触发

下列事件都不得发起 fresh 检查、不得自动弹 Toast 或打开 Dialog：

| 触发点 | 本轮结论 |
| --- | --- |
| 页面重挂到同一 session | 不检查：该 session 的候选已由 `offered` 认领 |
| 切换设置开关重新开启 | 不检查：开关是能力门，不是提示时机 |
| Workspace Folders 面板 `list` | 不自动弹 Toast：面板 `list` 仍按 §4.4 承担显式恢复职责，但不发起 fresh 检查 |
| 面板 action 的 `worktrees.notify()` | 不自动唤醒：通知只服务面板自身刷新，不重挂自动检查或 wait |
| 新 worktree 的 `fs.watch` 事件 | 不检查、不提示 |
| 20 秒定时器、窗口 focus、重连退避 | 不检查：常驻轮询消失后不再有这些恢复源 |

**新 worktree 不要求即时提示**：它会在「下一次 session 激活」或用户显式「查看」时因 fresh 重新出现——未被 `offered` 认领的新 key 不在抑制集合里，因此立即可见。这是刻意的取舍：本功能是建议，不是实时通知。

### 20.3 UI：非模态 Toast 与显式 Dialog

- Toast 是**非模态**的：无 backdrop、无 focus trap、不阻塞页面和输入框；默认常驻、不自动消失。
- 文案 A/B 中性：「发现 {count} 个可添加的工作目录」。只有 A、只有 B 或 A/B 同时存在都用同一文案，不暴露候选类型。
- 操作：「查看」「稍后（下拉：直到出现新 worktree（默认）/ 7 天 / 30 天）」「×」。「×」只关闭 Toast；提醒延迟只来自「稍后」下拉，不打开 Dialog。
- 只有「查看」才打开现有 `WorktreePrompt` Dialog。
- A（主 checkout）与 B 走同一套 Toast + Dialog，不单独自动弹；Dialog 列表仍默认只勾选 `kind='worktree'`，A 保持显式勾选。类型、`effectiveAccess` 与共享元数据披露留在 Dialog 内。

### 20.4 `worktreePrompt` 的可选 `fresh`

端点形状：

```text
worktreePrompt { sessionId, fresh? } → { prompts, viewRevision }
```

- `fresh?: boolean`，缺省 `false`，strict：多余字段拒绝。
- `fresh: false`：返回全部可见候选（Dialog 用），行为与既有视图查询一致。
- `fresh: true`：只返回「不在本 Host `offered` 集合、且不被当前 snooze 覆盖」的候选；**纯查询、无副作用**——不写 sidecar、不写 Registry、不改变 `offered`/`prompted`/queue、不建 watcher、不延长 waiter。
- 该次调用触发的首次激活是**被动的（passive）**：只读`resolveRepo` 与 sidecar 读取、只重建候选队列；**不安装 watcher、不调度 owner 侧 `reconcile`、不改写 sidecar**。持久发现（watcher + 映射核对）只在首个显式请求（打开 Dialog 的 `prompt()`、`worktreePromptWait`、面板 `list`、reset）时开始，之后维持原行为。
- `prompt()` 内部的 `ensureWorkspace` 使用 `'first'`，不得用 `'explicit'`：自动检查不得复活 `lost`；`lost` 仍只由面板/命令显式 `list` 或显式检查恢复（§4.4 不变）。
- 返回形状仍是 `{ prompts, viewRevision }`；候选为空时 `prompts: []`，客户端不显示 Toast。

### 20.5 `worktreePromptSeen` 与 Host 内存 `offered`

```text
worktreePromptSeen { sessionId, promptIds: string[] } → { seen: number }
```

- 只把命中当前 queue 且仍 eligible 的候选的 discovery key 加入 Host 内存的 `WorkspaceState.offered`；失效 id 静默忽略。
- 不写 sidecar、不写 Registry、不改变授权；不要求 owner 队列（纯 Host 内存操作）。
- `offered` 按 workspace 共享；`reset` 清空；`disposeAll`（开关关闭/卸载）清空；Host 重启自然清空——允许重新提示一次，是可接受的降级；不持久化。
- 客户端在 Toast 显示后调用一次 `seen`，Dialog 打开后也调用一次（把 Dialog 中看到的候选一并认领）。

### 20.6 snooze：客户端与线协议

- 客户端新增 `client.snooze(sessionId, promptIds, choice, signal)`。
- `worktreePromptResolve` 扩展：`action: 'add' | 'dismiss' | 'snooze'`，`snooze?: { mode: 'until-new-worktree' | '7d' | '30d' }`。
- 双端校验：`snooze` 只能与 `action: 'snooze'` 同时出现；`action: 'snooze'` 必须带 `snooze`；`dontRemind` 只能与 `action: 'dismiss'` 同时出现。
- 客户端永远不发送 keys/path：keys 由宿主从 `promptIds` 对应的当前记录派生。
- 宿主仍按现有逻辑复验 session、mode、switch、queue 与候选是否仍 eligible；失效 id 进入 `skipped`。有效 id 派生 discovery keys 写入 sidecar `snooze`；不写 Registry、不加入 `prompted`——候选仍留在队列，用户之后还能在 Dialog 里添加。返回形状复用 `WorktreeResolveAnswerView`。
- sidecar 写失败时内存生效，Toast/Dialog 仍可关闭；降级与现有 `ignore` 一致（memory-only）。

### 20.7 sidecar `snooze` 与生效规则

文档形状（`version` 仍为 1，`emptySidecar` 默认没有该字段）：

```ts
interface WorktreeSnooze {
  mode: 'until-new-worktree' | 'until'
  until?: string   // ISO 时刻；仅 mode === 'until' 时存在
  keys: string[]   // 宿主从 promptIds 派生
  at: string       // 写入时刻
}
```

- `WorktreeSidecarDocument` 增加可选 `snooze`；`WorktreeSidecarView` 增加可选 `snooze`，`sidecarViewOf`/`parseSidecarView` 同步。
- `readSidecar` 解析失败时把它当作 `undefined`，不因一个可选 UI 字段损坏而拒绝整个 sidecar（否则会丢 `ignored`/`worktreeRoots`）。
- `worktreeSidecar` 增加 `{ op: 'snooze', snooze }`，只在 owner 串行队列内写，仍走 `requireWorktreeMutation`/`worktreeGate`；inactive/开关关闭/authority 不可用时拒绝且不写。
- `ignore`/`reconcile`/映射增删必须保留 `snooze`。
- sidecar 的 `reset` 同时清空 `ignored` 与 `snooze`；没有可清内容时仍不制造 revision。
- 生效规则：
  - `until`：`Date.now() < until` 时抑制 `keys` 覆盖的候选；
  - `until-new-worktree`：抑制 `keys` 里的 key；出现的新 key 不在 `keys` 中，故立即可见（旧 key 若已被 `offered` 也不会重复提示，不要求主动清除过期记录）；
  - 宿主把 `7d`/`30d` 用**宿主时钟**换算成 `until`，不使用浏览器时间。
  - **到期释放**：`until` 到期后，宿主在内存中丢弃该记录并把它的 keys 从 `offered` 释放，下一次自动检查会重新提示同一候选——操作者先被 `seen` 认领、再选「7/30 天后」的浏览器顺序不会让提醒永久沉默；sidecar 不因到期而写入（不要求主动清理），重启后按同样的到期规则生效。**释放与「谁先观察到到期」无关**：自动检查读内存记录、以及任何显式请求（面板 `list`、确认、cleanup）从 sidecar 读回该记录时，只要观察到已到期都必须先释放 keys 再丢弃记录；否则记录已被丢弃、下一次自动检查没有可到期的记录，候选会一直被 `offered` 隐藏到 reset 或 Host 重启。
  - `reset` 的「无内容不写」判断必须针对**原始文档**（同时看 `ignored` 与 `snooze`）：只清 snooze 的 reset 也必须落盘，否则重启后旧延迟复活。

### 20.8 `reset`、开关与 Dialog 生命周期

- `worktreePromptReset` 继续清空 `prompted`/`ignored`/queue/`evaluated` 并重新 inventory，并额外清空 `offered`/`snooze`（内存 + sidecar）；开关关闭或 workspace inactive 时仍不写 sidecar。
- Dialog 打开时调用 `worktreePrompt(sessionId)`（不带 `fresh`）拿全量可见候选，然后才启动 `worktreePromptWait(sessionId, { seenViewRevision })`。
- Dialog 关闭立即 abort；`prompt`/`prompts` 更新列表、`stale` 关闭、`lost`/`unactivated` 关闭并停止；X/ESC 关闭不写任何状态。
- 「添加所选」继续走 `resolve('add')`，owner 的完整复验不变。

### 20.9 不变的授权语义与非目标

- 不自动添加、不自动删除根；客户端永远不发送 path/key/`primaryRoot`。
- owner 的完整复验、`addNew` 唯一写路径、`worktree/prompt-stale` 行为保持不变。
- `danger-full-access` 不提示；A 仅 `workspace-write`；B 在 `read-only` 仍可见。
- 实验性开关默认关闭、缺失 Settings 视为关闭、空态 pass-through 不变。
- 非目标：不做 repo（common）级去重（状态仍按 `primaryKey`/workspace 存储）；不移除 `worktreePromptWait`（Dialog 打开时仍用）；不依赖 `ctx.worktrees` 或 forge 事件；不新增 DSH 版本分支、不改上游包与支持矩阵；不把 snooze/`offered` 用于授权、不写入 Registry 授权数据；不改 owner 的 `addNew`/`removeForDeletedWorktree`/`probeAdd` 校验。

### 20.10 契约清单变化

```text
worktreePrompt        { sessionId, fresh? }                                 → { prompts, viewRevision }
worktreePromptSeen    { sessionId, promptIds: string[] }                     → { seen }
worktreePromptResolve { sessionId, promptIds, action, dontRemind?, snooze? } → WorktreeResolveAnswerView
worktreePromptWait    { sessionId, seenViewRevision? }                       → WorktreePromptWaitResult   // 仅 Dialog 打开时
worktreePromptReset   { sessionId }                                          → { cleared }
```

- `worktreePrompt` 增加 `fresh`；新增 `worktreePromptSeen`；`worktreePromptResolve` 增加 `action: 'snooze'` 与 `snooze`。
- 双端 schema 同步：strict，拒绝多余字段；`promptIds` 必填、去重、上限 64。
- `worktreePromptReset`/`worktreeRootsCleanup` 形状不变；`WorktreePromptView` 不新增字段。

### 20.11 实施返工（2026-11-14，代码审查）

PR #55 的代码审查复现了四处实现偏离 §20.4/§20.7 的问题，全部已修复并各自留下回归：

1. **snooze-only 的 `reset` 不落盘。** `worktreeSidecar` 的 `reset` 用「去掉 snooze 的副本」做空态判断，判断永远通过，于是只有 snooze、没有 `ignored` 的工作区在 reset 时直接返回：内存清了，sidecar 仍留着延迟，重启后旧提醒复活。改为对**原始文档**判断 `ignored.length === 0 && snooze === undefined`；只清 snooze 也会写一次 revision，无内容时仍不写。回归：`tests/worktrees-sidecar.spec.ts` 的 snooze-only reset（写后重开 owner 读回为空、二次 reset 不再制造 revision）与 `tests/worktrees-discovery.spec.ts` 的服务层 reset 后重启不恢复。
2. **`fresh` 自动检查启动了持久发现。** `prompt(fresh)` 走完整 `activate`：安装 watcher、调度 owner 侧 `reconcile`（有映射时可能写 sidecar），违反「纯查询、无副作用」。改为**被动激活/被动 inventory**：只读 `resolveRepo` 与 sidecar、只重建候选队列，不装 watcher、不调度 reconcile、不写 sidecar；首个显式请求（Dialog 的 `prompt()`、`wait`、面板 list、reset）把工作区提升为持久发现一次（并恢复映射核对），统计/registry change 的 reconcile 也沿用当前姿态。回归：`tests/worktrees-discovery.spec.ts` 以 fresh 为第二个 Host 的首个调用，断言 `watching === false`、sidecar 操作只有 `read`、文件逐字不变、后台不发现新 worktree；打开 Dialog 后 watcher 与 reconcile 才出现。
3. **定时 snooze 到期后 `offered` 仍压制。** 浏览器顺序是「Toast 显示 → `seen` 认领 → 选 7/30 天」，单纯依赖 snooze 到期解除抑制不够：`offered` 会让候选在本 Host 生命周期内永久沉默（需重启/关开关/reset）。改为到期时在内存丢弃该记录并把 keys 从 `offered` 释放；sidecar 不主动写，重启后按到期规则处理。回归：`tests/worktrees-discovery.spec.ts` 覆盖 seen→7d→到期恢复。

4. **sidecar 读回先观察到到期会丢掉释放。** 到期后若先发生一次显式 sidecar 读取（面板 `list` / 命令 `list` → `describeRoots` → `loadSidecar`，或确认/cleanup 的 load），`liveSnooze` 直接把过期记录丢掉，却没有像 `expireSnooze` 那样把 keys 从 `offered` 释放；等下一次自动检查时内存里已没有记录可「到期」，`seen` 的认领便永久压制候选，直到 reset 或 Host 重启。改为统一的 `adoptSnooze`：任何来源（`loadSidecar`/`reconcileSidecar`/snooze 写入回读）在观察到过期记录时，**先释放 `offered` 中的 keys 再丢弃记录**；`expireSnooze` 复用同一释放 helper。回归：`seen` → 7d snooze → 到期 → 先 `describeRoots`（等价面板打开）→ 下一次 fresh 仍能重新提示。

四处都不改变授权语义：`addNew` 仍是唯一写路径，owner 复验与 `prompt-stale` 不变，`offered`/snooze 仍只是 UI 状态。

## 第十八次修订（2026-11-09）

第十七次修订接受了 B，并因无法证明 main checkout 身份而延后 A。本修订保留 B 的安全与生命周期边界，将 A 的目标收窄到 linked worktree 执行 Git 写操作所需的 common git dir，并新增 A/B 共用的插件设置开关。B 的 P0–P7 保留，A 从 P8 接续。此前复审中的「A 延后」属于历史决定，现行规则见 Decision §1 和 §9。

## 第十七次修订（2026-11-09）

本轮按维护者补充的需求接受设计；实现尚未开始。取代前稿的四项规则：非 Git/非 checkout 根（包括曾 active 后失效）结束发现并停止后台重查；`lost` 不再携带 retry 字段；sidecar 全部写入由既有 Registry owner 串行执行，取代跨 Host read-merge/CAS 假设；旧 epoch 映射按新 owner 当前完整快照重新核对，取代“只允许同 epoch 修剪”。该版的复审事实保留为历史依据。

## Date

2026-11-08

## Context

### 1. 问题

当 Session 的 workspace 本身是一个 Git linked worktree 时，`.git` 不是目录，而是指向主仓库的 `worktrees/<id>` 的文件：

```text
<workspace>/.git              → 文件：gitdir: <main>/.git/worktrees/<name>
<main>/.git/worktrees/<name>  → 目录：含 commondir，指向 <main>/.git
```

`git add` / `git commit` 会写 linked worktree 私有 admin 下的 `index`、`HEAD` 等数据，也会写 common git dir 下的 `objects`、`refs` 和共享 reflog。若 common 在 primary root 之外，模型可能反复申请 `danger-full-access`。[Git worktree 手册](https://git-scm.com/docs/git-worktree#_details)

同时，worktree 是临时目录：它会被 `git worktree remove`、`prune`、手动删除或移动。已经登记为附加根的 worktree 根随后会变成 `missing`，占用 `maxAdditionalRoots` 额度，并在面板中留下记录。

因此本决策同时覆盖两件事：

- **发现与授权**：何时提示登记共享 Git 元数据目录（A）或另一个 linked checkout（B）；
- **删除生命周期**：worktree 消失/移动后，已登记根如何呈现、如何清理，以及哪些清理**永远不自动发生**。

### 2. 现有模型与事实

- 本插件的 Workspace 模型是「一个 primary root + N 个 additional roots」。`validateRootCandidate` 双向拒绝候选与 primary root 的包含关系（`primary-overlap`，`src/roots.ts:421`），也拒绝附加根之间的嵌套。
- worktree 插件的默认 pool 是 `.agents/worktrees`（相对 repo root，`relativePath` 禁止 `..`），因此默认 pool 的 worktree 位于主 worktree 根内。把主 worktree 根登记到该 worktree 的 session 会被 `primary-overlap` 拒绝；而同仓库的 `<main>/.git` 与 pool checkout 互不包含，可以单独通过根几何校验。
- Registry 对消失的登记目录保留记录、标记 `missing`、从 scope 撤销授予，但**不自动删除**；只要目录以相同 canonical 路径回来，`recordedPath` 匹配后会**自动恢复授予**（ADR-0004）。这是路径级恢复，不区分“同一个 worktree 恢复”与“同路径换了一个新目录”。
- `maxAdditionalRoots` 统计所有存储记录，包括 `missing`（ADR-0014）。
- 没有“workspace 删除”事件；Registry 按 `primaryKey(primaryRoot)` 存整组记录。`primaryKey` 是 `path.resolve` + Windows 小写折叠的**上游 verbatim 拼写**，永不 canonical 化（ADR-0028）。
- ADR-0012 明确“外部 gitdir、逃逸 symlink、未登记 repository 或未授权的自定义 pool 不能通过扩大权限解决”。本决策不是静默扩大，而是**用户明确确认后的登记**；但它仍然不自动添加、不自动删除。
- 客户端没有可供普通插件随时弹出的全局 Dialog 服务；Connection RPC 是请求/响应，浏览器没有通用 host→client stream。`shell.overlay` 槽位与 `Modal`/`Checkbox` primitive 可复用。
- 上游 `dsh-experimental-worktree` 服务存在，但它只覆盖 DSH/插件创建的 worktree；用户可能用终端、IDE、forge 或其他 DSH 创建 worktree。A/B 均使用 Git 磁盘布局，因而也覆盖用终端、IDE 或其他 Host 创建的 checkout。开发 pin 的公开 `create()` 返回的是创建当下的 source checkout `repositoryRoot`，可以是 linked checkout，也没有按 primary 查询任意既有 worktree 的记录接口。
- Git 的磁盘布局是唯一能覆盖任意创建者的依据：`worktrees/<id>/gitdir` 指向 worktree 的 `.git` 文件，`worktree/.git` 反向指回 admin；linked worktree 的 admin 目录有 `commondir`，submodule 没有。`git worktree move` 只改 admin `gitdir` 的内容，`worktrees/` 目录本身不增删（macOS 原生探测确认）。

### 3. 复审二（2026-11-08）新增事实

复审用临时仓库验证了以下边界，均须进入本 ADR：

1. **伪 `.git` 会被 Git 拒绝。** 只有 `HEAD` + `config` 的 `.git` 目录、以及 `.git` 文件与 admin 互指但 admin 不是有效仓库的布局，`git rev-parse` 都返回 fatal；仅靠 `HEAD`/`config`/`commondir` 的文本条件会把它们误判为仓库。
2. **bare 仓库派生的 linked worktree 会被当前文字条件命中。** 实测 `git rev-parse --is-inside-work-tree` 返回 `true`、`--is-bare-repository` 返回 `false`，但 common 的 `core.bare` 为 `true`；文档声明排除 bare，必须显式检查 `core.bare`。
3. **普通仓库子目录与 linked worktree 子目录**的 `--show-toplevel` 都返回仓库/worktree 根，不等于 `session.header.cwd`；以 `--show-toplevel` 等于 primary root 作为“workspace 本身是 checkout 根”的判据，可以精确排除子目录。
4. **`--relative-paths` 下指针可以是相对路径。** 实测 `.git` 文件可写 `gitdir: ../repo/.git/worktrees/relwt`（相对包含 `.git` 的目录），admin `gitdir` 可写 `../../../../relwt/.git`（相对 admin 目录）；`commondir` 同样相对 admin 目录。解析基准必须写进契约。
5. **`fs.watch` 的 `filename` 可能为 `null`**，且逐 admin/父目录 watcher 有数量上限；不能让这些情况静默漏事件。

### 4. 复审三至复审十五（2026-11-09）新增事实

复审用临时仓库验证了以下边界，均须进入本 ADR：

1. **`--separate-git-dir` 的主 checkout 身份无法由 `dirname(common)`、`worktree list` 第一条、`ls-files` 或文件名匹配证明。** 实测在 `/unrelated` 放一个与索引同名的 `README.md` 后，上述检查全部通过；A 必须在没有宿主可信 `mainRoot` 记录时 inactive。
2. **admin 不在 `common/worktrees/` 下仍可能通过 `rev-parse`。** 必须显式校验 admin 归属。
3. **bare 的 `core.bare=true` 可被 worktree config 覆盖为 false。** 必须只读 common 的 local config 判定 bare。
4. **`<admin>/config.worktree` 是独立配置入口。** common config 干净时，`extensions.worktreeConfig=true` + `<admin>/config.worktree` 的 `include.path` 仍会被 `rev-parse` 读取；v1 直接拒绝启用 `extensions.worktreeConfig` 的布局。
5. **`addNew` 的复验必须分开 primary 与 candidate。** B 可以从主仓库发起（primary `.git` 是目录），不能把 primary 当 linked；候选被 `git worktree move` 移走后原路径重建普通目录时 canonical 不变，必须复验 candidate 的 `.git`/admin 指针。
6. **主仓库迁移 + `git worktree repair` 后旧 admin 消失、原 checkout 仍有效。** 清理不能以“旧 admin 缺失”为依据；必须先看 `record.path` 是否仍是一个有效 checkout。
7. **`worktreePromptWait` 只带 `sessionId` 无法区分首次取提示与已展示提示等失效。** 必须带 `seenPromptId`/`seenViewRevision`，并在该会话可见视图变化时返回。
8. **§3.2 的状态表与 §6.1–6.4 的清理资格冲突。** 删除信号只决定徽标；清理只看 `record.path` 缺失 + `addedAt`；路径存在时只提供普通 Remove。
9. **`git worktree list` 会跟随其他 admin 的 symlink。** 把另一个 worktree 的 `gitdir`/`locked` 指向仓库外文件时，`worktree list --porcelain -z` 会输出外部内容；v1 删除该命令，改为受控 inventory。
10. **双向指针不能证明 candidate 是有效 checkout。** 在 `common/worktrees/<id>` 构造 admin、与外部普通目录 `.git` 互指、`commondir` 正确，但没有 admin `HEAD`，仍能通过指针校验；必须在入队和 owner 提交时验证 `admin/HEAD` 是普通非 symlink 文件且非空。v1 不解析 commit 对象，避免读取外部对象库。
11. **旧式 submodule 的内嵌 `.git` 目录会通过主仓库根判据，且 `--show-superproject-working-tree` 会读取未预检的父仓库。** 父仓库 `include.path` 损坏时该命令退出 0 但省略 superproject，空输出不能当成“没有 superproject”。v1 改为受控 parent probe + index mode `160000`；父 config/探测失败 → 无法判定 → inactive。
12. **没有可验证的公开 main checkout 记录来源。** `ctx.worktrees` 只被测试用于 `create`，没有可依赖的 `repoRoot`；按复审建议，v1 延后 A，只做 B，避免继续猜 `mainRoot`。
13. **`rev-parse --verify HEAD^{commit}` 会读外部 alternates，并在 promisor remote 下按需 fetch、写 `.pack`。** 复审六还发现 `objects/<prefix>` 的 symlink 可绕过 `objects`/`info` 检查；v1 不启动 Git、取消 commit 对象解析，因此不读 `objects`，并保留 alternates 防御性拒绝。
14. **`--separate-git-dir` 派生的 linked checkout 能通过 B 检查。** 主 checkout 自身的 `.git` 文件没有 `commondir`，应 inactive；派生的 linked checkout（`.git` 文件 + `commondir`）明确支持 B，不重新引入 A。
15. **只检查直接父目录会漏掉多层路径下的旧式 submodule。** `repo/vendor/lib` 的 `vendor/.git` 不存在，但 `repo` 索引的 `vendor/lib` 是 `160000`；必须向上找最近祖先仓库，并用完整相对路径查询。
16. **`lstat` 与按路径复制之间仍有换链窗口。** 检查为普通文件后、复制前换成 symlink，按路径读取会拿到外部内容；v1 用 `O_NOFOLLOW` 打开源 index、对同一 fd `fstat` 并限量读取，不按路径二次打开/复制。
17. **实际 split/sparse index 可在配置未设置时启用，仍会读外部文件。** `link` 扩展会读 `sharedindex.*`（可被换成外部 symlink）；`sdir` 与 `040000` 目录条目会让 Git 展开并读取 tree 对象。v1 由插件解析器拒绝 `link`/`sdir`/`040000`/未知版本，不运行 `ls-files`。
18. **只拒绝 `sdir` 仍不足。** 删除 `sdir`、保留 `040000` 目录条目并关闭 sparse 配置的伪造 index 仍会被 Git 展开；格式门禁必须无条件拒绝任何 `040000` 条目。
19. **完整相对路径仍会被 Git 当作 pathspec magic。** 名为 `:lib` 的目录在 `ls-files -s -- :lib` 下返回空；v1 不运行 `ls-files`，插件解析器按字面完整路径精确匹配。
20. **`ls-files` 读取临时副本时仍会执行父仓库 `core.fsmonitor` 指定的程序。** v1 从已解析的 index 直接查 gitlink，不再运行 `ls-files`；验收断言 fsmonitor 脚本未被启动。
21. **`O_NOFOLLOW` 只保护最后一级，中间目录换链仍能读外部；FIFO 还会让 open 阻塞。** 复审九把 `.git` 换成外部 symlink、把 index 换成 FIFO 复现；v1 从可信目录句柄逐段打开、中间目录与最终文件都拒绝 symlink，`O_NONBLOCK` 打开后同 fd `fstat` 再读。
22. **配置预检后、后续 Git 命令仍会读取被替换的 config。** 复审九在 `config --no-includes` 通过后加入外部 `include.path`，`rev-parse` 仍打开了外部文件；owner 重跑预检也有同样窗口。v1 不启动任何 Git，config 只解析一次快照，后续不再读文件。
23. **`admin/HEAD` 只检查非空仍会接受无效候选。** 复审十把有效 admin 的 HEAD 写成 `definitely-not-a-head`，双向指针和 `commondir` 仍正确；v1 必须给 primary/common/admin 共用 HEAD 语法校验（`ref: refs/<refname>` 或 40/64 位 hex），入队与 owner 都执行。
24. **owner 只复验 primary `.git`/common 会漏掉祖先索引变化。** 内嵌 `.git` 的独立仓库可以先通过发现，再在等待 owner 期间被上级仓库登记为 `160000`；owner 必须重跑完整 primary 激活判据（含祖先 index），否则会错误登记。
25. **`--relative-paths` 会升到版本 1。** 该布局把 common 的 `core.repositoryformatversion` 升为 1 并设置 `extensions.relativeWorktrees=true`；v1 只支持版本 0，必须明确 inactive，而不是依赖相对指针解析。
26. **linked worktree 本身也可以是 submodule。** 复审十一在 `vendor/lib` 创建 linked worktree 后执行 `git submodule add`，Git 保留 `.git` 文件 + `commondir`，同时把父索引登记为 `160000`；只查 `.git` 目录的祖先索引会漏掉。v1 在本层 `.git` 门禁通过后，对 `.git` 目录和 `.git` 文件 + `commondir` 两种形态统一查祖先 gitlink。
27. **同路径删除重建可复用旧提示。** 删除 detached worktree 后用同一提交在原路径重建，canonical/adminId/指针/HEAD 都不变，但根目录 inode 改变；路径级 `expected` 无法区分。v1 在提示中绑定 root/admin 的 `{dev, ino}`（可用时含 birthtime），owner 提交前复验。
28. **primary 失效时缺少候选/对话框撤销。** 仅靠 owner 只能挡住提交；v1 在长轮询重挂和 primary/祖先 watcher 事件上复验完整判据，失效即清空候选、返回 `stale`、释放该 workspace 的 watcher；已登记根不自动删除。
29. **Git index 路径与文件系统 canonical 路径逐字比较会漏掉 Unicode 变体。** 复审十二在 macOS 用分解形式（NFD）的 `café` 创建内嵌 `.git` submodule，父索引在 `core.precomposeUnicode=true` 下保存预组合形式（NFC），mode 是 `160000`；逐字比较会误判为普通嵌套仓库。v1 必须按平台/config 做 Unicode 与大小写等价，无法可靠判定时 inactive。
30. **停用后没有恢复触发源，且 `evaluated` 会跳过未处理候选。** 客户端停掉重挂、宿主释放 watcher 后，primary 恢复也没有下一次调用；即使 `list` 触发，清空队列但保留 `evaluated` 也会跳过停用前已评估、未确认的候选。前稿曾增加慢速 recheck；第十七次修订按“不执行任何动作”要求取消后台恢复，改为显式重新检测；仍清空 transient `evaluated` 并保留明确 ignore。
31. **最近祖先阴性不能证明没有 superproject。** 复审十三构造 `outer/vendor/lib` 旧式 submodule，再在 `outer/vendor` 初始化独立仓库；`outer` 索引仍有 `vendor/lib` 的 `160000`，但最近 `vendor` 仓库没有 `lib`。只查最近祖先会放行；必须遍历所有祖先层，任一层命中即 inactive，无法排除即 inactive。
32. **首次门禁拒绝不应启动后台重查。** 对所有 `inactive` 返回 `retryAfterMs` 会让普通目录/仓库子目录持续轮询。v1 区分 `unactivated`（从未 active；本次发现结束、无后台）与 `lost`（曾 active 后失效；关闭旧提示并停止后台动作；第十七次修订取消前稿的慢速恢复）。
33. **首次拒绝与正常超时的 RPC 响应无法区分。** `{ prompt: undefined, viewRevision }` 同时表示 `unactivated` 和 `timeout`，客户端一个应停止、一个应立即重挂；前稿 §7 的恢复字段也不一致（第十七次修订已统一取消 retry 字段）。v1 用判别联合 `WorktreePromptWaitResult`（`prompt`/`timeout`/`unactivated`/`lost`/`stale`），宿主与客户端 schema 同时校验。
34. **authority 不可用的空列表不能作为删除映射的证据。** `refresh()` 在 authority 不可用时返回 `[]`，`list()` 无缓存也可能返回空；若面板兜底 prune 据此删除 `worktreeRoots`，authority 恢复后登记仍在但失去专用清理入口。v1 仅依据 owner 成功返回的完整快照 prune，并验收“authority 暂不可用 → 打开面板 → 恢复”后映射仍在。
35. **`registry.available` 与 `refresh()` 数组不是同一份 owner 快照证明。** follower 路径会应用远程快照后返回本地 `list()`；`available` 的当前状态与返回数组不能组合成“本次 owner 确认”。v1 消费带 `available`/`epoch`/`revision` 的 `RegistrySnapshotView`，follower 返回 owner 同一 envelope；`available=false` 的空保留映射，`available=true` 的空才删除。
36. **默认 pool 不是特殊排除项。** 主仓库作为 primary 时 `.agents/worktrees/a`/`b` 位于 primary 内，按包含规则过滤；以 `a` 为 primary 时 `b` 同 common、互不包含，会进入 B 候选。Plan/需求不能笼统写“默认 pool 一律无行为”，两种场景分别验收。
37. **`forget-workspace` 新入口当前源码不存在。** ADR 若把它算入 v1，Plan 必须单列 Registry 维护任务；v1 选择延期，ADR/需求/Plan 明确标注，专用 cleanup 不依赖它。
38. **P3/P4 不能在 owner 复验（P5）前接通写入。** 用户确认写 Registry 的时点必须晚于完整 primary/candidate 激活判据、HEAD 与目录身份实现；Plan 把首次可写 `addNew` 与 owner 复验放在 P4 同阶段，P3 只做只读预览，等待 owner 替换候选的验收断言 Registry 无写入。

### 5. 约束与非目标

- **先交付 B 的完整行为，再接入 A**。A 使用 §1 的 common 来源契约；A/B 都不依赖 `ctx.worktrees` 或默认 pool 路径。
- **不启动 Git、不运行 `git worktree list`**；候选由受控 inventory 逐个枚举；每个候选必须通过 2.4 的元数据快照（指针/config/HEAD/objects/refs）、primary/common/admin 的 HEAD 语法校验与 `admin/HEAD` 结构校验，并属于同一 common；**不解析 commit 对象**。
- **只支持 `core.repositoryformatversion=0`**：`extensions.relativeWorktrees=true`、`--relative-paths` 产生的版本 1、`sha256`/其他 objectFormat 都 inactive；`--relative-paths` 布局不在 v1 范围。
- **不支持 submodule（两种形态，以及“linked worktree 本身被登记为 submodule”）/ `--separate-git-dir` 主 checkout / bare repo / 启用 `extensions.worktreeConfig` 的布局**：`.git` 文件没有 `commondir` 时 inactive；旧式 `.git` 目录**与** `.git` 文件 + `commondir` 的 linked worktree 都用**所有祖先仓库 + 完整相对路径**的 index mode `160000` 判定，任一层命中即 inactive、阴性继续更外层；common 的 `core.bare` 为 true 时 inactive；extension 为 true 时 inactive。**从 `--separate-git-dir` 派生的 linked checkout（`.git` 文件 + `commondir`）支持 B**（但若被祖先登记为 `160000` 则 inactive）；主 checkout 自身 inactive，派生 checkout 的 A 资格另按 §1 判断。
- **对象/index 边界**：v1 不解析 commit 对象、不读 `objects`；`objects/info/alternates`/`http-alternates` 仍防御性拒绝；父 index 路径由指针/gitdir 直接得到（`<gitdir>/index`），用 `O_NOFOLLOW`/`O_NONBLOCK` 打开、同 fd `fstat`、限量读取，由插件解析 header/entries/extensions：`link`（split）/`sdir`（sparse）/`040000` 目录条目/version 非 2–4/解析失败 → inactive；`core.splitIndex`/`core.sparseCheckout`/`index.sparse` 也拒绝；**不运行 `ls-files`**，直接按字面完整路径查 `160000` 条目。
- **parent probe 边界**：从 `dirname(root)` 向上遍历**所有**祖先 `.git`；每层只读 `.git`/config/index；任一层 config include/core.worktree/extensions 或探测失败 → 无法排除 gitlink → inactive；用该层根到 root 的完整相对路径按 2.4 的平台等价规则查 index，命中 `160000` 即 inactive，阴性继续更外层。
- **workspace `.git` 门禁先执行**：普通仓库子目录/worktree 子目录在第一道门禁直接退出，不进入祖先探测。
- **不覆盖普通仓库子目录 workspace**：只有 `<primaryRoot>/.git` 本身存在（目录，或带 `commondir` 的文件）才启用；`.git` 只在祖先目录时整段 inactive。
- **不自动添加、不自动删除**；不改 `primary-overlap`；不改 `maxAdditionalRoots` 计数。
- **不修改上游包**，不新增 DSH 版本分支。

## Decision

### 1. 提示模型

#### A. Linked worktree 的主 checkout 授权（B 完成后）

A 为 **linked checkout 本身就是 session primary root** 的 `workspace-write` 会话提供一次显式确认，把**主 checkout 根 `<main> = dirname(canonical common)`** 登记为 `inherit` 附加根。`<main>/.git` 通常就是该 canonical common，因此主根同时覆盖源码树、当前 checkout 的 admin（`common/worktrees/<id>`）与 Git 共享写入。默认 pool 中 `<main>` 包含 primary，触发 `primary-overlap`，**不提示 A**；外部 linked checkout 适用。`--separate-git-dir` 时 `dirname(common)` 只是 store 的父目录而非真正的主 checkout，且无法从 linked checkout 元数据区分；提示必须显示实际路径并明确该歧义，用户确认的是所见路径。Session identity 始终来自 `session.header.cwd`，动态 cwd 切换只改变执行位置（ADR-0012）。

- **来源契约**：使用 §2.2–§2.4 的同一份受控快照。primary 的 `.git` 指向 `common/worktrees/<id>` 下的真实 admin，admin 的 `gitdir` 指回该 primary 的 `.git`，`commondir` 指向同一个 canonical common；复用全部 config/HEAD/祖先索引检查。A 只接受 `basename(common) === '.git'` 且 `<main>/.git` 是真实目录、canonical 等于该 common 的布局；主根目录身份（dev/ino/birthtime）与 admin 身份一并记录。文件名只是范围限制；双向绑定、完整快照和身份校验才证明候选；**不启动 Git、不解析 commit 对象**。其他命名或 `.git` 为文件的 common 不提示 A。
- **过滤**：主根已被 primary 或既有登记覆盖、根校验拒绝（含 `primary-overlap`、嵌套、受保护路径、额度）、ignore 命中或 Registry 不可用 → 不入队。默认 pool 的 primary 总在 `<main>` 内，因此 pool 永远没有 A；旧版 `.git` 根仍在时主根也会因嵌套被拒绝，用户需先手动移除旧根。既有只读、缺失、重定向等登记由原 Registry 规则处理，A 不修改权限或 revive。
- **确认**：对话框明确显示实际授权路径、`inherit`、workspace 级持久性，以及范围涵盖主 checkout 源码树、共享配置、hooks、refs/objects 和所有 worktree 的 admin 数据。普通附加根的权限同样适用于其他受允许的工具；这些数据可能影响同仓库的其他 checkout。用户确认后才可登记；仅打开设置开关不会授予权限。A 复用 B 的提示、忽略、重置和 owner 串行写路径，候选类型为 `main-checkout`，无需枚举兄弟 checkout 来证明 A。
- **失效与撤回**：resolve 与 owner 各重跑来源契约并核对 primary/admin/common 的文件系统身份及 admin HEAD 快照，owner 额外确认 `<main>/.git` 仍 canonical 指向该 common 且主根目录身份未变。路径移动、换链、替换、`.git` 变成文件/symlink、双重绑定失效或无法证明身份 → `worktree/prompt-stale`。成功登记后沿用普通根的路径级生命周期，可在工作区目录面板或命令中手动移除。A 不进入 B 的 `worktreeRoots`，linked worktree 删除也不触发 A 清理。
- Git 在各 sandbox mode 下仍走既有 fs / kernel dialect 与 per-tool cap；A 不拦截 Git、不放宽其他目录、不增加 full-access 兜底。产品验收在真实受限 shell 中执行 Git；发现、预检和确认仍不启动 Git 子进程。

#### B. worktree discovery（先实施）

从 `<common>/worktrees/<id>/gitdir` 枚举**所有** worktree，不区分创建者，包括 workspace 创建前已存在的、由终端/IDE/forge/其他 DSH 创建的。

B 的入队条件：

- 候选必须是**有效的 linked checkout 且属于同一 common**：`<candidate>/.git` 是普通文件、admin 在 `common/worktrees/<id>` 下、双向指针一致、`admin/HEAD` 与 common `HEAD` 通过 2.4 的 HEAD 快照语法校验，common 的 `config`/`objects`/`refs` 结构有效；失败 → 不入队、不提示、不写 registry。**不启动 Git、不解析 commit 对象**。
- primary、common、admin 的 `HEAD` 共用同一语法校验；`admin/HEAD` 写成 `definitely-not-a-head`、空文件、CR/多行、错误长度 hex 都不接受。
- v1 只接受 `core.repositoryformatversion=0`、`extensions.objectFormat` 缺省/`sha1`；`extensions.relativeWorktrees=true`、`git worktree add --relative-paths` 产生的版本 1、`sha256` 均 inactive。
- submodule（`.git` 文件且无 `commondir`；旧式内嵌 `.git` 目录）→ 不提示；**本层 `.git` 门禁通过后，两种形态（含 `.git` 文件 + `commondir` 的 linked worktree）都遍历所有祖先仓库查完整相对路径的 index mode `160000`**；任一层命中即 inactive，阴性继续更外层；祖先 config/index/探测失败 → 无法排除 → 不提示。linked worktree 本身也可以是 submodule，不能因 `.git` 是文件跳过。
- common 的 `objects/info/alternates`/`http-alternates` 非空 → 不提示；**不解析对象**，`objects/<prefix>` 的 symlink 不会被读取。
- 主 checkout 自身的 `.git` 文件没有 `commondir`（submodule main / `--separate-git-dir` main）→ inactive；从 `--separate-git-dir` 派生的 linked checkout（`.git` 文件 + `commondir`）→ B 支持；A 按 §1 单独判定。
- 等于/位于 `primaryRoot` 内、位于已授权根内、包含 `primaryRoot` → 不提示。**没有“默认 pool 特殊排除”规则**：主仓库作为 primary 时，`.agents/worktrees/<id>` 位于 primary 内，按包含规则过滤；primary 本身是 pool worktree 时，另一个 pool worktree 属于同一 common 且通常互不包含，会正常进入 B 候选（再受 registry/上限/ignore 约束）。两种场景分别验收。
- 已在 registry / 达到上限 / registry unavailable / 被 discovery ignore → 不提示。
- 其余 → 提示把 `worktreeRoot` 加为 `inherit`。

B 的授权范围是 worktree 的**源码树**；worktree 根里的 `.git` 只是指针文件，指针所指的共享元数据需要按 A 单独确认。

#### 模式规则

| 提示 | workspace-write | read-only | danger-full-access |
| --- | --- | --- | --- |
| A | 提示（读写） | 不提示 | 不提示 |
| B | 提示（读写） | 提示（只读） | 不提示 |

有效权限由 `effectiveRootAccess('inherit', mode)` 计算；对话框显示当前有效权限与**持久登记策略 `inherit`**。B 的文案必须同时说明：其他读写 session 可以通过同一登记获得写权限，因为登记是 workspace 级、不是 session 级。

### 2. 激活：路径防护 + Git 自身校验

#### 2.1 入口与 inactive

入口是 `session.header.cwd`（primary root）。非 Git 目录或仅为 Git 仓库子目录时，不执行本功能的发现、提示、清理追踪、sidecar 写入或后台重查；曾 active 后失效同样适用，只做一次旧提示/资源收尾。既有手动 Additional Root 管理不受影响。**不向祖先目录查找 `.git`**；只检查 `<primaryRoot>/.git`。以下一律 inactive，不挂 watcher、不写 sidecar、不产生提示：

- 主仓库子目录、linked worktree 子目录；
- 普通目录、伪 `.git` 目录、伪 admin；
- submodule（`.git` 文件无 `commondir`，或旧式 `.git` 目录 parent index `160000`）、`--separate-git-dir` 主 checkout（`.git` 文件无 `commondir`）、bare 仓库及其派生的 linked worktree；从 `--separate-git-dir` 派生的 linked checkout（`.git` 文件 + `commondir`）不在此列，B 支持；
- Windows 网络/设备路径（UNC、`\\?\`、`\\.\`、映射网络盘 canonical 后为 UNC）以及 POSIX `//server/share`；
- 元数据无法打开/解析、config 含 `include`/非空 `core.worktree`/启用 `extensions.worktreeConfig`、index 格式门禁失败、或指针与磁盘不一致。

#### 2.2 元数据 I/O 防护（P1-4）

在跟随任何指针之前先做路径防护，避免 `stat`/`realpath` 触发 SMB 认证：

1. 对 `<primaryRoot>/.git` 做 `lstat`：指针文件必须是**普通文件**，不得是 symlink；目录形态必须是**目录**，不得是 symlink。
2. 读取 `<primaryRoot>/.git`、`<admin>/gitdir`、`<admin>/commondir` 时：有界读取（4 KiB），拒绝 NUL，按 UTF-8 解码失败即 inactive；只接受普通文件。
3. 对原始 primary 和指针拼写先做词法防护。拒绝 UNC、设备、Windows 非完整盘符路径、POSIX `//` 和 NUL；相对指针以 §2.3 的基准拼接并保留各段。先验证每段再处理其后的 `..`，避免规范化把 Git 实际经过的 symlink 消掉。
4. 指针链上的 admin 目录、common 目录、指针文件都不得是 symlink；这不是 Git 的通用限制，而是本功能的保守边界：宁可 inactive，也不跟随可能指向网络的链接。
5. 通过防护后，才允许在 trusted fd 下读取/解析元数据；admin 必须是目录，common 必须是目录，`commondir` 必须指向目录，`gitdir` 必须指回 `<primaryRoot>/.git`；不启动 Git。

本地挂载的网络盘无法仅凭路径词法证明；Windows UNC/设备路径已拒绝，POSIX 网络挂载仍可能触发内核网络 I/O。这是平台限制，不作为本功能的安全承诺。

#### 2.3 指针解析基准（P2-2）

v1 只支持 `core.repositoryformatversion=0`；`git worktree add --relative-paths` 会生成版本 1 并设置 `extensions.relativeWorktrees=true`，该布局在 v1 直接 inactive。下表的相对基准仅用于版本 0 中出现的相对指针（手工/legacy），不表示支持 `--relative-paths`。

| 指针 | 解析基准 |
| --- | --- |
| `<primaryRoot>/.git` 的 `gitdir:` | 包含 `.git` 的目录，即 primaryRoot |
| `<admin>/gitdir` | admin 目录 |
| `<admin>/commondir` | admin 目录 |

相对路径按上表解析后再做 2.2 的防护；不允许用 `realpath` 结果反推基准。

#### 2.4 结构校验：不启动 Git，只消费元数据快照

v1 **不启动任何 Git 子进程**：`rev-parse`、`config`、`ls-files`、`worktree list` 都不运行。Git 命令会读父配置（`core.fsmonitor`）、展开 sparse index、跟随 pathspec/对象；这些副作用无法在预检与调用之间可靠封住。校验改为插件自己打开、验证、解析元数据快照；快照之后不再读文件，也不启动 Git。

**元数据 I/O（所有指针/config/HEAD/index）**：

- POSIX 从根目录句柄开始，逐级用 `openat` 和 `O_NOFOLLOW` 打开。相对于已打开的父目录检查最后一段的类型，读取和目录枚举使用得到的句柄。Darwin 用 `fstatat`，Linux 用 `statx`，能力缺失时判为 inactive。规范路径从内核句柄取得，再用独立的受控路径遍历核对身份。 [Darwin stat ABI](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/stat.h) · [Linux statx ABI](https://raw.githubusercontent.com/torvalds/linux/master/include/uapi/linux/stat.h)
- Windows 只接受可证明是本地卷的盘符。以卷 GUID 为遍历起点，持有每层目录的防重命名句柄，并拒绝同句柄报告的任何 reparse point；对已验证文件使用同一句柄读取。卷身份或句柄无法证明时判为 inactive。 [Windows 文件句柄](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) · [卷 GUID 路径](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumenameforvolumemountpointw)
- 最终文件用 `O_NOFOLLOW|O_NONBLOCK` 打开（FIFO 不会阻塞），对**同一 fd** `fstat`，确认普通文件后限量读取；不按路径二次打开/复制。
- 任何 symlink、非普通文件、FIFO/设备、读取超限、打开失败 → inactive。
- P0 覆盖：最终文件换链、中间目录换链、FIFO。

**config 快照**：

- 打开 `<common>/config`（主 repo 与 linked worktree 都读 common；同一 trusted fd；`O_NOFOLLOW|O_NONBLOCK`、bounded），解析 section/key；拒绝 `include.*`/`includeIf.*`（不跟随）、`core.worktree` 非空、`extensions.worktreeConfig=true`、`extensions.relativeWorktrees=true`、`core.splitIndex=true`、`core.sparseCheckout=true`、`index.sparse=true`；`core.repositoryformatversion` 必须为 0（**v1 不支持版本 1，包括 `git worktree add --relative-paths`**）；`extensions.objectFormat` 缺省/`sha1`；`core.bare` 从同一快照读；同时记录 `core.precomposeUnicode`/`core.ignorecase` 供祖先索引路径等价使用（不拒绝，只影响比较）。
- 每次校验只解析一份 config 快照，同一次校验内不再按路径重读；owner 提交时重新解析一份快照，仍不启动 Git。预检后替换 config 不会让 Git 打开外部 include；若 owner 的新快照含 include，直接拒绝。
- 无法解析/未知格式 → inactive。

**repository 结构**：

- `.git` 是目录：`HEAD` 通过下面的 HEAD 快照校验；`config`；`objects` 目录；`refs` 目录；否则 inactive。
- `.git` 是文件：`gitdir:` 指向 admin；admin 在 `common/worktrees/<id>` 下；admin `HEAD` 通过 HEAD 快照校验、`gitdir`/`commondir` 普通非 symlink；common 的 `config`/`HEAD`（通过 HEAD 快照校验）/`objects`/`refs` 有效；无 `commondir`（separate-git-dir main / submodule main）→ inactive；有 `commondir`（linked checkout，含 separate 派生）→ B 支持。
- bare：common config `core.bare=true` → inactive。
- submodule：`.git` 文件无 `commondir` → inactive（submodule main / separate main）。**本层 `.git` 门禁通过后，两种 checkout 形态都做祖先 gitlink 检查，并必须走完所有上级仓库，不能停在最近祖先**：`.git` 目录，以及 `.git` 文件 + `commondir` 的 linked worktree，都从 `dirname(root)` 向上逐级找祖先 `.git`；对每个祖先仓库读取 config/index 快照，用该祖先根到 root 的完整相对路径按平台等价规则查 index，解码路径时保留文件名开头的 U+FEFF：
  - 任一祖先的条目 mode `160000` → submodule → inactive；
  - 该层没有匹配 → **继续检查下一层更外层的祖先**，不能因最近祖先阴性就放行（近层独立仓库可能遮住外层真正的 superproject）；
  - 祖先 `.git` 是 symlink、无 `commondir` 的指针文件、config include/core.worktree/extensions、index `link`/`sdir`/`040000`/未知版本、或读取/判定失败 → **无法在读取边界内排除 gitlink → inactive**；
  - 直到没有更外层祖先 `.git` 且所有层都阴性 → 正常 repo。无祖先 → 正常 repo。
  **linked worktree 本身也可以是 submodule**，不能因 `.git` 是文件就跳过；普通仓库子目录仍在第一道 `.git` 门禁直接退出，不进入祖先链。
- A 直接复用 linked primary 的快照证明 common 身份，按 §1 过滤。

**HEAD 快照**：

- primary、common、admin 共用同一个 HEAD 校验器；`<gitdir>/HEAD` 用 trusted fd、`O_NOFOLLOW|O_NONBLOCK`、1 KiB 上限读取。
- 内容必须是单行（可有一个结尾 LF）：要么 `ref: refs/<refname>`，要么 40/64 位十六进制；不允许 CR/NUL/额外行/其他文本。`definitely-not-a-head` 这类内容直接 inactive。
- `ref:` 部分按 Git refname 语法校验（非空、`refs/` 前缀、无控制/空格/`~^:?*[`/反斜杠、无 `..`/`@{`/`//`、组件不以 `.` 开头或以 `.lock`/`.` 结尾）；不解析引用、不读对象。
- 十六进制长度必须匹配 `extensions.objectFormat`：v1 只接受 `core.repositoryformatversion=0` 且 objectFormat 缺省/`sha1`，即 40 位；`sha256`/其他格式 → inactive。hex 只做语法/长度校验，不解析对象。
- 入队和 owner 提交都执行同一校验；primary/common/admin 任一无效 → inactive/`prompt-stale`。

**父 index 快照**：

- index 文件用上面的 trusted fd/O_NOFOLLOW/O_NONBLOCK/bounded 读取；插件解析 v2/v3/v4 header/entries/extensions；拒绝 `link`（split）、`sdir`（sparse）、**任何 `040000` 目录条目**、未知版本/解析失败。
- 由解析器按 Git index 的 `/` 拼写匹配完整相对路径；**不能只做 UTF-8 字节逐字比较**。路径等价规则按平台与仓库 config 定义：
  - Linux：UTF-8 字节精确比较；`core.ignorecase=true` 时再按大小写不敏感比较。
  - macOS：相对路径与 index 路径都做 Unicode 归一化。`core.precomposeUnicode` 缺省为 true（NFC），false 时 NFD；为覆盖索引在另一种设置下写入的情况，同时接受 NFC/NFD 两种形式。`core.ignorecase` 为 true 或文件系统大小写不敏感时再做大小写折叠。
  - Windows：路径按大小写不敏感比较；不做 Unicode 归一化。
  - 索引路径或相对路径不是合法 UTF-8、同一等价键出现冲突 mode、或平台/config 无法可靠判定 → inactive。
- mode `160000` 必须精确；`:lib` 只是路径，无 pathspec magic。
- 不运行 `ls-files`；不读 sharedindex/tree/objects；不执行 `core.fsmonitor`。

**对象与外部程序**：

- v1 不解析 commit 对象、不读 `objects`；`objects/info/alternates`/`http-alternates` 非空仍防御性拒绝；不写 `.pack`。
- 不执行 hooks/fsmonitor/attributes/外部程序；没有 `GIT_*` 子进程环境需要净化。

#### 2.5 验收边界

必须显式断言以下布局**不挂 watcher、不写 sidecar、不产生提示**：普通目录、伪 `.git`（只有 `HEAD`+`config`，无 `objects`/`refs`）、伪 admin（互指但 common 无效）、admin 不在 `common/worktrees/` 下、主仓库子目录、linked worktree 子目录、submodule（`.git` 指针文件与旧式内嵌 `.git` 目录两种形态）、bare 派生的 linked worktree、`include`/非空 `core.worktree`/`extensions.worktreeConfig=true`、UNC/设备、FIFO/非普通文件。

v1 B 的专门验收：

- **不启动 Git**：父仓库设置 `core.fsmonitor` 脚本；v1 不运行任何 Git 子进程，断言脚本未被启动、标记文件不存在。
- **元数据 I/O**：最终 index 换成外部 symlink；中间 `.git` 换成外部 symlink；index 换成 FIFO。三种都必须在 trusted fd 的逐段 `O_NOFOLLOW`/`O_NONBLOCK` 下失败或拒绝，断言外部文件没有被读取、FIFO 没有阻塞。
- **config 快照**：先解析 config，再把同一份 config 换成含外部 `include.path` 的版本；初始快照不受影响；owner 提交时重新解析新快照，看到 include 即拒绝；**不启动 Git**，断言外部 include 没有被打开。
- **HEAD 语法**：primary/common/admin 分别写入 `definitely-not-a-head`、空文件、CR/多行、39/41 位 hex；入队与 owner 提交都拒绝，不提示、不登记。合法 `ref: refs/heads/...` 与 40 位 hex 必须通过；不解析引用/对象。
- **owner primary 祖先索引**：构造一个内嵌 `.git` 的独立仓库作为 primary，先通过发现；在等待 owner 队列期间把它在上级仓库索引中登记为 `160000`，此时 primary `.git`、common 与 B 候选都不变。owner 必须重跑完整 primary 判据（含祖先 index）→ `prompt-stale`，不能只凭 canonical/common 未变写入。
- **同路径删除重建**：删除一个 detached worktree，再用同一提交在原路径重建；canonical、adminId、`.git`/`gitdir`/`commondir`、HEAD 内容都相同，但根目录 inode 改变。owner 必须比对 `rootIdentity`/`adminIdentity` → `prompt-stale`；已登记根的路径级恢复策略不变。
- **`--relative-paths`/版本 1**：`git worktree add --relative-paths` 会把 common 升到 `core.repositoryformatversion=1` 并设置 `extensions.relativeWorktrees=true`；v1 只支持版本 0，断言这种布局不提示、不登记，而不是依赖相对指针解析。
- **伪 `.git`/伪 admin**：只有 `HEAD`+`config`、没有 `objects`/`refs` 的 `.git` → inactive；admin 与外部普通目录 `.git` 互指但 common 的 `HEAD`/`objects`/`refs` 无效 → inactive。
- **submodule 两形态**：`.git` 指针文件（无 `commondir`）直接排除；旧式内嵌 `.git` 目录用 `repo/vendor/lib`：`vendor/.git` 不存在，完整相对路径 `vendor/lib` 在祖先 `repo` index 中为 `160000` → inactive。`vendor/lib` 只是普通嵌套仓库 → active。再用 `:lib` 目录验证字面路径；祖先 config 换成外部 `include.path`、祖先 index 换成 symlink/FIFO、index 含 `link`/`sdir`/`040000` → 都无法判定 → inactive。
- **近层独立仓库遮蔽**：`outer/vendor/lib` 是旧式 submodule，`outer` 索引有 `vendor/lib` 的 `160000`；再在 `outer/vendor` 初始化独立仓库，使最近的 `vendor` 仓库对 `lib` 为阴性。必须继续检查更外层 `outer` 并命中 `160000` → inactive；不能因最近祖先阴性放行。linked worktree 版本同样覆盖；普通仓库子目录仍在第一道门禁直接退出。
- **linked worktree 本身是 submodule**：在 `repo/vendor/lib` 创建 linked worktree（`.git` 文件 + `commondir`），再由上级仓库执行 `git submodule add` 把 `vendor/lib` 登记为 `160000`；此时 `.git` 仍是文件、`commondir` 仍正确。primary 与 B 候选都必须在本地 `.git` 门禁通过后做祖先 gitlink 检查 → 均 inactive；owner 提交也 `prompt-stale`。没有祖先 gitlink 的普通 linked worktree 仍 active。
- **Unicode NFC/NFD**：macOS 上创建分解形式（NFD）的 `café` 内嵌 `.git` 子模块，父索引在 `core.precomposeUnicode=true` 下保存预组合形式（NFC）的 `café`，mode `160000`。按 2.4 的等价规则必须识别为 submodule → inactive；NFC/NFD 拼写不同但指向同一目录的用例不能因字节不同而放行。`core.precomposeUnicode=false`/NFD 形式同样覆盖；同一等价键出现冲突 mode → inactive。
- **对象扇出 symlink**：`objects`/`objects/info` 为真目录、无 alternates，但 `objects/<prefix>` 指向外部目录；v1 不解析 commit 对象，断言外部对象没有被读取。
- **`--separate-git-dir`**：主 checkout 自身的 `.git` 文件没有 `commondir` → inactive；从该仓库派生的两个 linked worktree（`.git` 文件 + `commondir`）→ **B active**，可相互发现/提示；不重新引入 A。
- **首次拒绝不后台重查（P2）**：普通目录、主仓库子目录、linked worktree 子目录在首次门禁失败 → `activation='unactivated'`；断言无 candidates/watcher/sidecar、`worktreePromptWait` 返回 `{ status:'unactivated', viewRevision }`（无 `retryAfterMs`）、客户端不启动后台重查；只有面板/命令 `list` 或用户显式重新检测能再次尝试。
- **wait 结果判别（P2）**：正常超时返回 `{ status:'timeout', viewRevision }` 并立即重挂；`unactivated`/`lost` 返回各自 status 与 viewRevision，停止重挂；`stale` 带 reason，用于 active workspace 的候选变化。所有分支均禁止 `retryAfterMs`；宿主/客户端 schema 同时验收。
- **RegistrySnapshotView 空快照（P2）**：authority 不可用时 `RegistrySnapshotView={available:false, roots:[], epoch, revision}` → 保留 `worktreeRoots` 映射；owner 确认登记为空时 `{available:true, roots:[], epoch, revision}` → 允许删除映射。follower 必须返回 owner 的同一 envelope，不能应用后回退本地 `list()`；`list()` 无缓存为空不参与 prune。验收分别覆盖“不可用返回空，映射保留”和“owner 确认空，映射删除”。
- **并发与跨 epoch 验收（P2）**：两个 Host 同时发起映射新增/删除/修剪，在 owner 队列外用 barrier 同时放行；断言 owner 逐项读取最新状态、无覆盖/复活。旧客户端空快照之后另一个 Host 新增根与映射，再提交 prune，必须在 owner 内重取完整快照并保留新增映射。owner 重启/接管后，旧 epoch 的匹配映射重新绑定，已移除根的映射删除；恢复前 unavailable 保留全部映射；旧 epoch 的在飞写请求拒绝且不自动重放。
- **默认 pool 两场景**：主仓库作为 primary 时，`.agents/worktrees/a`、`b` 都在 primary 内 → 不提示；以 `a` 为 primary 时，`b` 同 common、互不包含 → 进入 B 候选（受 registry/上限/ignore 约束）。没有 pool 特殊排除规则；两个场景分别验收。
- **active → lost（P2）**：移走 primary `.git`、使 workspace 成为仓库子目录或新增祖先 gitlink；复验失败后清空候选，返回 `{ status:'lost', viewRevision }`，关闭提示、释放 watcher、取消在飞等待及定时器。推进测试时钟，断言无自动 wait/recheck/inventory、无 sidecar/Registry 写入。
- **显式恢复（P2）**：primary 恢复后仍无后台动作；用户执行面板/命令 `list` 或显式重新检测才激活。旧 prompt ID 失效；未处理候选以新 ID 出现，明确忽略的候选不出现。
- 主仓库根正常添加 B（`primary.shape='main'`、`candidate.kind='worktree'`）必须 active；真实 linked worktree 根（B）必须 active。

A 的验收在 B 完成后进行：默认 pool 与外部 linked checkout 均可候选；伪指针、反向绑定失败或不可用身份均拒绝；`--separate-git-dir=/unrelated/.git` 加同名源码文件的反例也不得把 `/unrelated` 作为授权目标。

### 3. Inventory、候选身份与事件

#### 3.1 Inventory

workspace 创建/首次查询时做一次全量 inventory：受控枚举 `common/worktrees/*/gitdir`，按 2.2/2.3 解析并双向校验，包含所有已存在、任意创建者的 worktree。对每个候选先做对象库/submodule/index 防护，再做 `admin/HEAD` 与 common 结构校验；失败则跳过。**不启动 Git、不解析 commit 对象；不调用 `git worktree list`**。B 不依赖 A 的候选。

#### 3.2 候选身份与 move/rebuild（P2-2）

候选身份不是单一 `adminId`：

```ts
type CandidateKey = string
// = adminId + '\0' + canonical(worktreeRoot) + '\0' + canonical(adminGitdirTarget)
```

- `evaluated` 使用 `CandidateKey`；`prompted` 使用 discovery key（B 由 `CandidateKey` 派生，A 为 `main-checkout\0<canonical common>`）。A 候选在每次 primary 复验时重算，直接进入共享提示队列。
- 状态转换：

| 之前 | 事件 | 之后 | 动作 |
| --- | --- | --- | --- |
| active | admin dir 消失 | `unregistered` | 丢弃候选；映射保留；徽标；`cleanupEligible=false`（路径仍存在）；普通 Remove |
| active | worktree 根目录消失 | `directory-missing` | 丢弃候选；映射保留；`cleanupEligible=true`（路径确认缺失） |
| active | admin `gitdir` 指向新路径 | `moved` | 旧候选失效；旧路径缺失 → `cleanupEligible=true`；新路径按 B 重新评估 |
| 路径缺失（cleanupEligible） | 同路径同 adminId 重建 | `changed` | **不自动清除警告**；路径存在 → `cleanupEligible=false`；普通 Remove；旧登记仍在则 `addNew` duplicate |
| 路径缺失（cleanupEligible） | 同路径新 adminId 重建 | `changed` | 同上；新候选进入 inventory，但 `addNew` duplicate，直到旧根普通 Remove/清理 |
| 任意 | 无 watcher 时同路径重建 | 不可可靠区分 | 按 active 处理；L4 残余；面板仍提供手动 Remove |

- **删除信号只决定状态/徽标；清理资格只由 §6.1 的 `record.path` 确认缺失 + `addedAt` 决定。** admin 消失但路径仍存在不是 cleanup，只是 `unregistered` 徽标 + 普通 Remove；本表与 §6.1–§6.4 必须一致。

- 可可靠识别的是：admin 目录增删、根目录删除事件、admin `gitdir` 变更。**不可可靠识别**的是：宿主重启/无 client 期间同路径、同 adminId 的重建；此时 inventory 只看到路径存在，服务无法证明它换过；这是 L4 残余的一部分。

#### 3.3 事件与降级

| 监听点 | 过滤 | 用途 |
| --- | --- | --- |
| `<common>` | `filename === 'worktrees'` 或 `null` | `worktrees/` 出现/消失 |
| `<common>/worktrees` | 非递归；admin 增删；`null` 也 reconcile | 发现/删除信号 |
| 每个 `<admin>` | `gitdir`/`commondir`；忽略 `index`/`logs`/`locked`/`AUTO_MERGE.lock` | move/repair |
| 每个 B 根的父目录 | 过滤 `basename(worktreeRoot)`；`null` 也 reconcile | 手动删除（L8） |
| primary `.git`（dir/file） | 非递归；`null` 也 reconcile | primary 被移走/替换；触发 2.4 完整复验 |
| 祖先 `.git`/index（best-effort） | 祖先目录/index 变化 | 新增 gitlink/祖先索引变化 |
| watcher error/close | — | degraded；长轮询超时 reconcile |

- 去抖 150ms。
- `filename === null` 不是“忽略”，而是“无法定位条目，做一次 debounce reconcile”。
- admin watcher 上限 128；父 watcher 按父目录共享、按 basename 过滤。超过上限时标记 `degraded`，只保留 `worktrees` watcher + 超时/重连 reconcile，**不得声称逐 admin/父目录事件完整**。
- 不使用 `setInterval`，不做周期性 git 扫描。客户端用 `worktreePromptWait` 长轮询（≤20s）；正常路径由 `fs.watch` 事件唤醒；degraded 时才在超时重挂时 reconcile。

### 4. 状态、共享候选与按 session 展示

#### 4.1 `CommonState` / `WorkspaceState`

```ts
interface CommonState {
  common: string
  worktrees: Map<adminId, { path: string; adminGitdir: string; key: CandidateKey }>
  workspaces: Set<primaryKey>
  watchers: WatcherSet
}

interface WorkspaceState {
  primaryKey: string
  primaryRoot: string
  common: string
  candidates: Map<CandidateKey, WorktreeCandidate>   // 共享 inventory 派生
  evaluated: Set<CandidateKey>
  prompted: Set<string>                              // discovery ignore/dedupe key
  queue: WorktreePrompt[]                            // 共享候选池
  waiters: Map<sessionId, Set<Deferred>>
  activation: 'unactivated' | 'active' | 'lost'
}
```

- **不再保留 `WorkspaceState.known`**：admin→path 的唯一来源是 `CommonState.worktrees`；workspace 只记住评估过的 `CandidateKey`。
- 同一 workspace 的两个 session 共享 inventory、候选池、`prompted`、watcher；不会各建一套。
- `prompted`/sidecar ignore 是 workspace 级；一个 session 忽略的候选对整个 workspace 生效。

#### 4.2 共享候选，按 session 过滤（P2-1 / P2 长轮询）

- 候选池与去重是共享的；**展示与确认按请求 session 过滤**。
- `eligibleForSession(candidate, mode)`：A 仅 `workspace-write`；B 在 `workspace-write`/`read-only`；`danger-full-access` 无。
- `worktreePromptWait(sessionId, seenViewRevision?)` 返回**对该 session 可见的全部 eligible 候选**：恰好一个时用 `prompt`，两个及以上时用 `prompts`，并按该 session 的 mode 计算每项的 `effectiveAccess`；`remaining` 也是该 session 视角下剩余的 eligible 候选数。
- `viewRevision` 是该 session 的**可见视图**（可见候选集合与每项 prompt id、`effectiveAccess`、`prompted`）的稳定摘要，不是全局共享队头的版本。任何候选 id 替换、可见项或权限变化都会改变它。
- 所有 waiter 在候选池变化时都被唤醒，但各自重新过滤；只读 session 不会拿到 A，读写 session 会拿到；两个 session 不会因为“共享队头”而互相阻塞。
- resolve 时再次读取 session 的当前 primaryRoot/mode；候选已变化、不再 eligible、或已从池中移除 → `worktree/prompt-stale`。
- `prompted` 共享：一个 session 忽略 B 会让整个 workspace 不再提示 B；这是 Q3“以 workspace 为单位”的取舍。A 对只读 session 不可见，因此只读 session 不会把它标记为 prompted。

#### 4.3 waiter 唤醒与 `seen`

- waiter 请求只携带 `seenViewRevision`（首次取提示时为空）。无 `seen` 时等同一次查询：可见列表非空立即返回，否则等待。
- 宿主在该 workspace 的候选池变化、或该 session 的可见视图变化时唤醒所有 waiter；每个 waiter 返回自己视角的当前视图或空。
- **`worktreePromptWait` 返回判别联合 `WorktreePromptWaitResult`，不得用 `prompt: undefined` 猜行为**：
  - `{ status: 'prompt', prompt: WorktreePromptView, viewRevision }`：恰好一个可见候选，打开/更新单确认对话框；
  - `{ status: 'prompts', prompts: WorktreePromptView[], viewRevision }`：两个及以上可见候选，打开/更新勾选列表；
  - `{ status: 'timeout', viewRevision }`：正常超时，客户端**立即重挂**；
  - `{ status: 'unactivated', viewRevision }`：首次门禁拒绝，客户端**停止重挂**，不启动后台重查；后续由面板/命令 `list` 或新的显式 wait 触发；
  - `{ status: 'lost', viewRevision }`：曾 active 后失效；关闭对话框并停止重挂，不安排后台恢复。
  - `{ status: 'stale', viewRevision, reason: 'seen-missing' | 'resolved' | 'candidate-changed' }`：seen 视图非空而当前可见列表为空，关闭对话框，不附 `retryAfterMs`。
- 所有分支都带 `viewRevision`，均禁止 `retryAfterMs`。宿主与客户端 schema 同时拒绝缺字段/多余 retry 字段。`lost` 表示 workspace 激活条件失效，`stale` 仅表示 active workspace 的旧候选失效；前者优先判定。
- 客户端在**对话框打开期间也保持一个带 `seen` 的 wait**；提示被 resolve/remove/权限变化时，宿主返回 `stale` 或新的 `viewRevision`，客户端主动关闭/更新，而不是等用户点按钮才报 stale。
- session mode 变化若没有专属事件，最迟在下一次 20s 重挂时通过重新计算的 `viewRevision` 返回；若 `sandbox/mode` 事件可用，宿主应在事件上唤醒该 session 的 waiter。
- 批量 resolve 逐项复验：已被处理/移除或 expect 变化的 id 进入 `skipped`（`worktree/prompt-stale`）且不写入；authority、存储或开关关闭中止整批。
- `reset` 清空该 `primaryKey` 的 `evaluated`/`prompted`/queue 并重新 inventory；`forget` 删除整个 workspace 状态。

#### 4.4 Primary 失效与撤销（P2）

- 每个 workspace 有 `activation: 'unactivated' | 'active' | 'lost'`；只有 primary 的完整激活判据（2.4，含两种 checkout 形态的祖先链）通过时才是 active。
- `worktreePromptWait` 每次重挂/超时，以及 primary `.git` 或祖先 `.git`/index 的 watcher 事件，都先复验 primary 完整判据；不依赖事件是否覆盖全部条件。
- 首次门禁失败（普通目录、仓库/worktree 子目录、伪 `.git`、祖先链无法排除等）→ `activation='unactivated'`：不建 candidates/watcher、不写 sidecar、不启动后台重查；`worktreePromptWait` 返回 `{ status:'unactivated', viewRevision }`，本次发现结束。后续只有面板/命令 `list` 或新的显式 wait 可以重新尝试。
- 曾经 active 后复验失败（primary `.git` 被移走、变成普通目录、祖先索引新增 `160000`、祖先链探测无法判定等）：
  - `activation='lost'`；清空该 workspace 的 candidates/queue/当前 prompt；**清空 transient `evaluated`**；递增 `viewRevision`；
  - 关闭并释放该 workspace 持有的 watcher 订阅（primary/ancestor/admin/父目录），不再产生新提示；
  - 所有 waiter 返回 `{ status:'lost', viewRevision }`；客户端关闭对话框、停止重挂并取消定时器；宿主取消剩余 waiter 和 activation recheck，不安排 one-shot 或周期恢复。
  - **已登记的附加根与 sidecar 不受影响**：不自动删除、不自动撤销授权；`primaryState` 仍独立表示根目录 missing/inaccessible；清理策略不变。
- 恢复触发源：
  - `lost`：只允许用户面板/命令 `list` 或显式重新检测触发；已有 waiter、自动重挂、超时、one-shot 和设置开关重启的轮询都不能触发恢复。开关和激活代次使在途发现失效，旧任务无法发布候选或重建 watcher。
  - `unactivated`：不后台重查，只由面板/命令 `list` 或新的显式 wait 触发。
- 重新激活：primary 完整判据恢复 → `activation='active'`，重建 inventory/watcher，**重新评估所有未在 `prompted` 中的候选**（包括停用前已 `evaluated` 但尚未处理的）；只保留用户明确忽略/处理的 `prompted` 决定，旧 prompt ID 失效，新候选以新 prompt ID 出现；`viewRevision` 递增；旧对话框不会自动复活。
- `lost`/`unactivated` 不订阅该 workspace 的 Registry change 来触发发现或映射核对；已排队但尚未执行的本功能任务失效。专用 cleanup/ignore/reset/reconcile 同样先检查 primary 激活门禁，失败仅返回 inactive/not-eligible，不写 sidecar；既有普通 Remove 仍可使用。新 owner 只在 workspace 显式重新激活后核对其映射，不遍历非 Git workspace 启动任务。
- owner 提交时若 primary/candidate 激活判据已失效 → `worktree/prompt-stale`，不写入。

### 5. 宿主持久化：按 primaryKey 分文件

```text
$DSH_HOME/storages/multi_root_workspace.worktree-prompts/
  <sha256(primaryKey)>.json
```

```json
{
  "version": 1,
  "revision": 0,
  "primaryKey": "<verbatim primaryKey>",
  "primaryRoot": "<verbatim>",
  "ignored": [
    { "key": "main-checkout\u0000<path>", "kind": "main-checkout", "path": "<path>", "addedAt": "..." }
  ],
  "worktreeRoots": [
    {
      "rootId": "<registry root id>",
      "adminId": "<worktrees/<id>>",
      "common": "<common git dir>",
      "path": "<worktreeRoot>",
      "rootAddedAt": "<registry record addedAt at creation>",
      "addedAt": "<mapping write time>",
      "mapRevision": 0,
      "registryEpoch": "<owner snapshot epoch>",
      "registryRevision": 0
    }
  ]
}
```

- 文件名 `sha256(primaryKey)`；文件内保留 `primaryKey`/`primaryRoot` 便于诊断。不同 workspace 的写隔离，修复单文件跨 Host 丢失其他 workspace 映射的问题。
- `revision` 是 sidecar 文档的单调版本；每次映射新增/删除/修剪都递增。每条 `worktreeRoots` 记录写入时的 `mapRevision`，以及 `addNew` 返回的 owner `registryEpoch`/`registryRevision`。
- **映射修剪的并发边界**：唯一 owner 在既有 Registry 串行队列内读取最新 sidecar 与完整 Registry 快照，再修改并落盘；具体规则唯一见 §6.8。follower 只发操作请求，不提交文件快照或删除清单作为真源。
- `ignored` 只服务于 A/B **发现**；`kind` 覆盖 `main-checkout` 与 `worktree`。清理/删除流程从不读取它。
- `worktreeRoots` 只记录**本功能通过 `addNew` 新建的 B 根**；A 根与用户手动添加/revive 的根不进入。每条含 `rootId`、`adminId`、`common`、`path`、`rootAddedAt`；`common` 用于诊断/展示，清理复验以 `record.path` 的存在性与 `addedAt` 绑定为准。
- **唯一写者**：只有持有既有 store-wide kernel lease 的 Registry owner 能读写 sidecar；owner 本地请求和 follower IPC 请求进入与 Registry mutation 相同的串行队列。队列内读取最新文件 → 应用操作 → 临时文件 + `fsync` + `rename`，完成后才释放队列；rename 只保证完整文件替换，跨 Host 排序由 owner 保证，不依赖文件 CAS。内部使用已持队列的 helper，禁止嵌套排队死锁。
- ignore/reset、映射新增/删除/prune 全部走该 owner 路径。`promptsRoot` 绑定同一 store 的固定 sidecar 目录，不能由 follower 指定；共享握手核对配置，不匹配拒绝。旧 owner 拆除时先 drain sidecar 写入再释放既有 lease；不新增第二把 lease。旧 epoch 请求拒绝，结果不明先对账，不自动重放。
- 写入顺序固定：owner 在同一队列操作内完成 `addNew` 的 Registry 持久化，再写 B 映射，最后返回；不允许 follower 事后补写。不是跨文件事务：崩溃窗口仍是“根已登记但无映射”，按手动根处理、cleanup 拒绝。删除/ignore 清除也在该队列内按顺序执行。
- `promptsRoot` 不可写/损坏：owner memory-only + warning，follower 不另建可写副本；owner 重启/接管后 ignore 与映射可能丢失，根按手动根处理。authority 不可用时保留只读投影，不受理 sidecar mutation；恢复后先对账。
- `workspaceForget` 的未来实现将删除对应文件（v1 延期）；当前文件为空时由 owner 在队列内删除。

### 6. 发现、确认与删除生命周期

#### 6.1 删除信号与清理资格（L1 / P1-4）

- `<common>/worktrees/<id>` 消失（`git worktree remove` / `prune`）→ `unregistered`。
- B 根的 worktree 目录缺失（手动 `rm -rf` 等）→ `directory-missing`。
- admin `gitdir` 指向新路径（`git worktree move`）→ `moved` / `changed`。
- 三者任一且映射存在 → 状态为 deletion 信号；三者都正常 → `active`。
- **清理资格收窄为 `record.path` 被确认缺失**（`ENOENT`/`ENOTDIR`），或 `moved` 且旧路径缺失。仅 admin 缺失而 `record.path` 仍存在（`unregistered` / orphan / changed）**不是** cleanup-eligible：它可能是一个被 `git worktree repair` 修好的有效 checkout，或无法判定的目录；面板只提供普通 Remove。
- 这是对 L1 “两者都算删除信号”的细化：两者都改变状态，但清理动作只对“路径本身已确认缺失”开放，避免误删活跃 checkout。

#### 6.2 面板显示，不弹窗，不自动清理（L2/L3/L7）

- Workspace Folders 对话框对 deletion 状态的 B 根显示徽标/副行：“Worktree deleted” / “Worktree directory missing” / “Worktree moved” / “Worktree unregistered”。
- 只有 `cleanupEligible`（路径确认缺失）的行显示 `...` → “Clean up additional root”；批量“Clean up deleted worktree roots (N)”也只统计这些行。`cleanupEligible` = 映射存在 + `record.path` 确认缺失 + `rootAddedAt` 与当前 `addedAt` 一致；`unregistered` / `changed` 且路径仍存在、或 addedAt 不一致的行保留普通 Remove，由用户显式确认。
- 点击后可在面板内做一次**用户主动的**确认（不是自动弹窗），再调用清理端点。
- **没有 overlay 清理对话框**；“不再提醒” checkbox 只存在于 A/B 发现对话框。
- **永远不自动清理**：服务不会在删除事件上调用 `registry.removeForDeletedWorktree`；只有用户点清理按钮（或显式命令）才删除。
- 清理只允许删除 mapped、`cleanupEligible` 的 B 根；A 根与用户手动添加/revive 的根永不进入。

#### 6.3 提示的确认必须复验（P1-2 / P1-3）

- 每个 prompt 保存快照，primary 与 candidate 分开：

  ```ts
  interface PromptSnapshot {
    primaryKey: string
    primaryRoot: string
    primary: {
      shape: 'main' | 'linked'
      canonical: string
      common: string
      adminId?: string
      adminGitdir?: string
      adminHead?: string // A 绑定 primary 的 admin HEAD
      rootIdentity?: FileIdentity
      adminIdentity?: FileIdentity
    }
    candidate: {
      kind: 'main-checkout' | 'worktree'
      canonical: string
      common: string
      adminId?: string
      adminGitdir?: string
      adminHead?: string
      rootIdentity?: FileIdentity
      adminIdentity?: FileIdentity
    }
    promptKey: string
  }
  ```

  B 的 `promptKey` 是 `CandidateKey`；A 的 `promptKey` 是 `main-checkout\0<canonical common>`。B 可以从普通主仓库发起（`primary.shape='main'`），所以不能要求 `<primaryRoot>/.git` 指向 admin。

- **checkout 文件系统身份（P1，复审十一）**：`FileIdentity = { dev, ino, birthtimeMs? }`。enqueue 时用 trusted fd 以 `O_DIRECTORY|O_NOFOLLOW` 打开 canonical root 目录与 admin 目录（`shape='main'` 的 admin 为 common `.git`；A candidate 的 `rootIdentity` 为主 checkout 根目录身份，admin 身份来自 linked primary），对同一 fd `fstat` 记录 `rootIdentity`/`adminIdentity`。owner 提交前重新打开同一 canonical 目录并比对；目录缺失、变成 symlink/非目录、或 `dev/ino`（可用时含 `birthtimeMs`）变化 → `prompt-stale`。这能区分“删除后在同一路径用同一提交/同一 adminId/同一 HEAD 重建”的 worktree；检查仅限提交前，不改变已登记根的路径级恢复策略。平台无法提供稳定 file ID（如 Windows 无 `ino`）时使用原生 file ID；取不到则不发提示/直接 `prompt-stale`，不回退到仅路径比较。
- resolve 时：
  1. 重新解析 session 的 primaryRoot 与 mode；
  2. 重新 `resolveRepo`，B 重算 inventory，A 重算 §1 的主 checkout 候选（`dirname(common)`，并要求 `<main>/.git` 仍 canonical 指向该 common）；
  3. 按 `promptKey` 找到候选；`primary` 或 `candidate` 任一变化 → `worktree/prompt-stale`；
  4. 候选不再 eligible → `worktree/prompt-stale`；
  5. 只有全部一致才进入 `addNew`。
- **只新建，不 revive**：Registry 新增内部方法 `addNew(primaryRoot, { path, access, expected })`，在 owner 串行队列内先复验 `expected` 再校验/写入：
  - `expected` 含 `primary` 与 `candidate` 两部分；`primary` 描述 session 的 primary root（`shape`/canonical/common/admin/`rootIdentity`/`adminIdentity`），`candidate` 描述用户确认的目标（`kind`/canonical/common/admin/`rootIdentity`/`adminIdentity`，以及 B 在 enqueue 时读取的 `adminHead`）。A 的 `adminHead` 属于 linked primary；A 的 `candidate.canonical` 是主 checkout 根，`common` 仍是身份锚，owner 额外复验 `<main>/.git` 与主根目录身份。
  - primary 复验：owner 必须重跑**完整的 primary 激活判据**（2.4），而不是只看 canonical/common。包括 `shape='main'/'linked'`、primary/common/admin 的 HEAD 语法、config/index、以及祖先 submodule probe；**两种 checkout 形态都查祖先 gitlink**（linked worktree 本身也可能是 submodule）；若等待期间 primary 被上级仓库登记为 `160000`，或祖先探测无法判定 → `worktree/prompt-stale`。primary `.git`/common/candidate 未变化不构成通过。
  - B candidate 复验：`candidate.canonical` 仍等于当前 canonical；`kind='worktree'` 时 `<candidate>/.git` 仍是普通文件、指向 `candidate.adminId`（admin 在 `candidate.common/worktrees` 下、`commondir` == `candidate.common`、`gitdir` 指回 `<candidate>/.git`），admin `HEAD` 与 common `HEAD` 通过 HEAD 语法校验，且 admin HEAD 内容 == `expected.adminHead`；**owner 重新打开 canonical root/admin 目录并比对 `rootIdentity`/`adminIdentity`**：目录缺失、变成 symlink/非目录、或 `dev/ino`（可用时含 `birthtimeMs`）变化 → `worktree/prompt-stale`（同路径删除重建会被抓住）；**owner 同时重跑 candidate 激活判据（含祖先 gitlink）**：candidate 在等待期间被上级索引登记为 `160000` 或祖先探测无法判定 → `worktree/prompt-stale`。
  - A candidate 复验按 §1 重跑来源契约：candidate `canonical` 必须等于当次快照的 `dirname(common)`、`common` 仍等于该快照的 common、`<main>/.git` 仍是 canonical 指向该 common 的真实目录，并比对主根目录身份及 primary 的 admin HEAD。
  - owner 在串行队列内重新读取一份元数据快照（config/HEAD/admin 指针；不启动 Git），重跑上述 primary 和对应类型的 candidate 判据。失败或 owner 看不到候选路径 → `worktree/prompt-stale`。
  - 任一变化 → `worktree/prompt-stale`，不写入。
  - **校验与写入使用同一个 canonical 值**：owner 只 canonical 化一次，把该值作为 `addNew` 的 `path` 与最终记录路径，不在复验后从客户端/字符串重新解析；`recordedPath` 就是这个值。
  - 复验通过后使用与 `add` 相同的校验（protected paths、`primary-overlap`、nested、limit）；若已存在同路径记录（按 canonical 或 stored 拼写任一命中，任何状态）→ `duplicate`/`already-registered`，**不 revive、不改 access、不更新既有记录**；
  - 成功时返回实际新建的记录与 owner 快照代次 `{ id, path, addedAt, registryEpoch, registryRevision }`；B 的 sidecar 条目记录该 owner 快照代次，供后续核对与跨 epoch 诊断。
- 服务只用 `addNew` 为 A/B 建根；`duplicate` 视为“已存在，按手动根处理”，**不写** `worktreeRoots` 映射。这样 cleanup 永远只追踪本功能新建的 B 根，不会误删手动记录或 revive 的记录。
- **确认与提交之间的竞态**：即使服务侧已复验，owner 队列仍可能被阻塞；`addNew` 的 `expected` 复验必须在 owner 串行队列内执行。验收覆盖：
  - **主仓库正常添加 B**：`primary.shape='main'`，`candidate.kind='worktree'`；owner 分别复验 primary `.git` 目录与 candidate `.git`/admin，成功。
  - **等待 owner 队列时移走 B、原路径重建普通目录**：`candidate.canonical` 不变，但 `<candidate>/.git` 消失；candidate 复验失败 → `prompt-stale`，不添加。
  - **无效 admin（无 HEAD）**：admin 与外部普通目录 `.git` 互指、`commondir` 正确但无 `HEAD`；inventory 的 `admin/HEAD` 结构校验失败，不入队；若 owner 前被删除/替换，`admin/HEAD` 复验失败 → `prompt-stale`。
  - **index/对象 symlink**：父 `.git/index` symlink 或 `objects/<prefix>` symlink；index 用 `O_NOFOLLOW` 打开、同 fd `fstat`、插件解析，拒绝 `link`/`sdir`/`040000`；**不运行 `ls-files`**，因此 `core.fsmonitor` 不执行；v1 不解析 commit 对象，`objects` symlink 不读取；断言外部文件没有被读取。
  - **等待 owner 队列时把候选替换为指向另一目录的 symlink**：candidate canonical 变化 → `prompt-stale`。
  - **A 的来源变化**：等待期间切换 common、替换同路径 common/admin，或使 admin 不再指回 primary → `prompt-stale`；无 Registry 写入。
- `add` 仍保留给命令/面板的显式 revive 语义。

#### 6.4 清理资格的 owner 复验（复审三 P1-4 / 复审四 P2）

- `removeAt()` 只按引用删除，没有“必须仍符合清理条件”的判断；临时离线的 worktree 在用户点击前恢复、或主仓库迁移后 `git worktree repair` 让旧 admin 消失但原 checkout 仍有效时，都会被误删。新增内部方法：

  ```ts
  removeForDeletedWorktree(primaryRoot, {
    rootId, expectedPath, expectedAddedAt
  })
  ```

- 在 owner 串行队列内：
  1. 重新分类；按 `rootId` 找到记录，要求 `samePath(record.path, expectedPath)` 且 `record.addedAt === expectedAddedAt`；不匹配 → `not-eligible`（revive 会保留 id/path、只更新 addedAt，因此必须绑定 addedAt）。
  2. 对 `record.path` 做路径防护后 `lstat`：
     - 确认缺失（`ENOENT`/`ENOTDIR`）→ 进入删除；
     - 无法访问（`EACCES`/`EPERM`/网络/设备）→ `not-eligible`，不把“无法访问”当作“已删除”；
     - 存在 → **不删除**；读取 `record.path/.git`（带 2.2 防护）判断它是否仍是有效 checkout：
       - `.git` 文件/目录仍指向有效 admin 与 common，或无法判定 → `not-eligible`；面板保留普通 Remove；
       - 只有 `record.path` 不存在才允许清理。
  3. **旧 admin 缺失本身不是清理依据**：主仓库迁移 + `git worktree repair` 后，旧 admin 可以消失而原 checkout 仍有效并指向新的 common；必须以 `record.path` 的存在性为准。
  4. 通过后才删除记录。
- 如果 worktree 已恢复、或路径存在但 `.git` 无法判定，owner 返回 `not-eligible`；面板提供普通 Remove，由用户显式确认。`changed` 状态不自动清除，也不自动转为 `active`。
- `worktreeRootsCleanup` 的 `rootIds` **必填**（面板先列出待清理条目，再提交精确 id 集合）；Host 逐个复验，返回每个 id 的结果（removed / skipped + code）。批量确认对应明确的条目，不做隐式“清理所有”。
- sidecar 映射参与决定“哪些登记可以清理”，但不构成删除授权：owner 仍按 `rootId + path + addedAt + 最新 record.path 状态` 复验；rootId 不存在、path 不匹配或 addedAt 不一致 → `not-eligible` 并 prune。
- 普通面板 Remove 继续用 `removeAt`；清理按钮用 `removeForDeletedWorktree`。两者都是用户显式操作。

#### 6.5 清理后与路径复用（L4 残余）

- 用户点清理 → 删除 B 根 + 移除映射 + 清除 discovery ignore。
- 之后同路径再出现 worktree → 重新走 B 提示。
- **残余**：因为清理永不自动，在用户点清理之前旧 B 根仍在；如果同路径出现新目录/worktree，Registry 的 `recordedPath` 路径级恢复仍可能把它标为 `available` 并授权。面板必须显著提示：
  > “该 worktree 已不存在。清理前，同一路径的新目录可能继承此授权。”
- 要彻底消除，只能自动清理或给 Registry 增加 worktree 身份字段；两者均不在本次范围。这是本决策显式接受的残余。

#### 6.6 ignore 只关发现（L5）

- sidecar `ignored` 只在 A/B 发现入队前检查。
- 删除 worktree 时清除该路径的 ignore，使清理后重建的 worktree 能重新提示。
- 删除流程从不读取 ignore；“不再提醒”不是删除策略。

#### 6.7 workspace 本身被删除（P2-3 / L6）

- `primaryState` 是独立宿主事实，不是从附加根状态推导：

  ```ts
  primaryState?: 'present' | 'missing' | 'inaccessible'
  ```

  - `present`：primaryRoot 的 `stat` 成功；
  - `missing`：`ENOENT`/`ENOTDIR`；
  - `inaccessible`：`EACCES`/`EPERM`/其他错误；
  - 不复用 `unavailable`（store 打不开）。
- A 根可能仍 `available`（主仓库目录还在）而 primary 已 `missing`；`forget` 正是为这种 workspace 级清理服务。
- 面板只在 `primaryState === 'missing'` 时显示 “Forget this workspace”；`inaccessible` 显示错误、不提供 forget。
- `workspaceForget` 在 owner 串行队列内重新 `stat` primaryRoot：`present` → `workspace/not-missing`；`inaccessible` → `workspace/inaccessible`；registry 不可用 → `workspace/registry-unavailable`；只有 `missing` 才删除该 `primaryKey` 的全部记录 + sidecar 文件。
- 命令 `/workspace-folders forget-workspace [path] --yes` 用于非当前/dead workspace；路径按 verbatim 拼写检查；不在当前 session 也可用；`--yes` 是唯一确认。
- **v1 交付边界**：本功能**不交付** `forget-workspace` 的新命令/RPC/owner 删除路径；它是 ADR 记录的未来 Registry maintenance，必须单独计划/需求排期。v1 的删除生命周期只包含 `removeForDeletedWorktree`（B 根清理），不依赖 forget；Plan 与需求必须显式标注该延期。
- **永不自动**；不影响其他 workspace。
- `primaryKey` 是 verbatim 拼写；symlink 创建的 workspace 必须用原 symlink 拼写，不能用 realpath；命令 help 必须写明。

#### 6.8 上限与映射修剪（L9 / P2）

- `maxAdditionalRoots` 继续统计所有存储记录，包括 `missing`/deleted B 根；清理后释放额度。不改 ADR-0014 的计数规则。
- **只能在 owner 同一次队列操作的完整快照上 prune**：active workspace 的服务订阅 `registry.onChange`，durable change 仅触发 owner reconcile；该操作内部取 `RegistrySnapshotView`（展示查询使用只读适配器）：
  - `RegistrySnapshotView = { roots: RootStatus[], available: boolean, epoch: string, revision: number }`；`available=true` 表示 owner（或 owner 经 IPC 确认的 follower 代理）返回的完整快照；epoch/revision 来自同一次响应。
  - follower 路径必须返回**owner 的同一份快照 envelope**（应用后也返回该 envelope），不能应用后回退到本地 `list()`；`registry.available` 的当前状态与返回数组不是同一证明，不得组合使用。
  - 只有当前 owner 队列内成功获取 `available=true` 的完整快照才可 prune；不可用、读取失败、请求 epoch 与当前 owner 不符则不修改。客户端/follower 的旧快照只能用于展示，不能作为提交依据。
  - `registry.list()` 只是内存读取；无缓存/authority 不可用时可能返回空，**不得据此 prune**。面板 `list` 的兜底也必须消费上述完整 envelope。
  - **空 roots 的两种语义**：`available=false` + 空 → 保留映射；`available=true` + 空（owner 确认登记为空）→ 允许删除映射。二者必须分别验收。
  - **队列内核对**：读取当前 sidecar，重新分类并取得本次 owner 完整快照，按 `rootId + path + rootAddedAt` 与登记匹配。匹配则保留（包括 missing 根）；rootId 不存在或 path/addedAt 不一致则仅移除旧映射，不删除 Registry 根。新建、清理、普通 Registry mutation 与本操作共用队列，因此快照与落盘之间不能插入新映射。
  - **跨 epoch**：owner 重启/接管生成新 epoch，revision 从新代次开始，禁止跨 epoch 比较数值。旧映射不是陈旧请求：当前 owner 在上述完整快照下核对，匹配条目重绑当前 `registryEpoch`/`registryRevision`，不匹配条目 prune；更新 sidecar `revision`/`mapRevision`。当前快照不可证明完整则全量保留，不因 epoch 不同删除。旧 epoch 在飞请求仍按 IPC 协议拒绝。
  - `registry.onChange` 只入队合并后的核对任务；核对不写 Registry、不反向触发 Registry change。完全相同的映射不重复写入/递增，避免通知反馈循环。
- authority 从不可用恢复后，下一次 `available=true` 的完整快照再做 prune；期间 `worktreeRoots` 映射保留，专用清理入口不丢。
- 映射 prune 不删除 Registry 根；仍匹配但 missing 的登记保留映射，已删除或已被 revive/替换的旧登记映射按上述三元组核对。

### 7. 契约

- owner IPC 增加 sidecar 查询及 ignore/reset/reconcile 操作；严格 schema、store/epoch/配置绑定和既有内核认证均保留。能力协商及去重答复见[共享 Registry 线协议](../architecture/registry-authority-service.md#3-授权与版本协议)。映射新增/清理由 owner 的 Registry 操作内部完成，不暴露任意文件写入或客户端映射导入接口。
- 新增独立 `WORKTREE_ENDPOINTS` + `worktreeRequestSchema`，在 dispatch 中像 `SKILLS_ENDPOINTS` 一样先分支处理；**不修改** `panelRequestSchema` 的 `.strict()`。
- 新增 `WorktreeResponseMap` 并并入 `WorkspaceResponseMap`；`expectShape` 增加 worktree 分支，不再把所有非 `reveal` 端点按 `RootsView` 解析。
- `RootView` 增加可选 `worktree`：

  ```ts
  worktree?: {
    adminId: string
    path: string
    state: 'active' | 'directory-missing' | 'unregistered' | 'moved' | 'changed'
    cleanupEligible: boolean
  }
  ```

- `RootsView` 增加可选 `primaryState` 与 `worktreeCleanupCount`；`rootViewSchema` 保持非 strict，旧客户端忽略。`worktreeCleanupCount` 只统计 `cleanupEligible`（`record.path` 确认缺失）的行；`RootView.worktree.cleanupEligible` 为 false 时面板只显示普通 Remove。
- 端点：

  ```text
  worktreePrompt        { sessionId }                                            → { prompts, viewRevision }
  worktreePromptWait    { sessionId, seenViewRevision? }                          → WorktreePromptWaitResult   // ≤20s
  worktreePromptResolve { sessionId, promptIds: string[], action, dontRemind? }   → { viewRevision, prompts, resolved, skipped }
  worktreePromptReset   { sessionId }                                             → { cleared }
  worktreeRootsCleanup  { sessionId, rootIds: string[] }                          → { removed, skipped, roots }
  ```

  `prompts` 在单候选时也可以用来查询完整视图；`wait` 才是单/列表分流的地方。`resolved` 项含 `id`/`key`/`path` 与（add 成功时的）`rootId`；`skipped` 项含 `id`/可选 `key`/`path` 与稳定 code。`promptIds` 必填、1–64 个、去重。

- **v1 端点不包含 `workspaceForget`**：该命令/RPC/owner 删除路径延期，见 §6.7；未来单独计划/需求排期。v1 删除只走 `worktreeRootsCleanup` / `removeForDeletedWorktree`。
- **面板 RPC 只在 `connection` + `webServer` 存在的 Web 组合挂载**；headless 不新增浏览器入口，也不要求面板 RPC 路由。Web 验收覆盖宿主/客户端 schema、确认和清理；headless 验收只覆盖组合启动、现有命令与 Registry 行为。
- `WorktreePromptView` 含 `id`、`key`、`kind`、`path`、`primaryRoot`、`access`、`effectiveAccess`、`remaining`、`viewRevision`；`kind` 为 `worktree` 或 `main-checkout`；`path` 在 B 为候选 checkout 路径，在 A 为主 checkout 根；`viewRevision` 是该 session 可见视图的摘要（见 4.2）。
- `WorktreePromptWaitResult` 是判别联合：`prompt`（单候选）、`prompts`（多候选，schema 至少 2 项）、`timeout`（viewRevision，重挂）、`unactivated`/`lost`（viewRevision，停止）、`stale`（viewRevision/reason，seen 视图非空而当前为空）。所有分支禁止 `retryAfterMs`，schema 双端一致；失效 workspace 不走 timeout/stale 自动重挂。
- 客户端只发送 `sessionId`/`promptIds`/`action`/`dontRemind`/`rootIds`/`seenViewRevision`；不发送路径。
- `worktreePromptWait` 在 `seenViewRevision` 变化或 activation 变化时返回；视图从非空变为空返回 `{ status:'stale', viewRevision, reason }`，客户端关闭对话框；正常超时返回 `{ status:'timeout', viewRevision }` 并立即重挂。
- `rootIds` 必填且必须命中 sidecar 映射；否则 `worktree/not-eligible`。不做隐式“全部清理”；Host 在 owner 内用映射的 `path`/`rootAddedAt` 作为 `expectedPath`/`expectedAddedAt` 复验。
- `workspaceForget` 延期，不在 v1 端点清单；其未来契约见 §6.7 的交付边界。
- `worktreePromptWait` 的 `AbortSignal` 由 Connection 透传；客户端断开即移除 waiter。
- `addNew`、`removeForDeletedWorktree` 是 Registry 内部方法，进入 owner 串行队列；follower 经既有 authority IPC 提交。`addNew` 的 `expected` 分开 `primary` 与 `candidate`（`shape`/`kind`/canonical/common/admin/`rootIdentity`/`adminIdentity`/`adminHead`），owner 重跑完整 primary 激活判据（含祖先索引）、candidate 激活判据（含祖先 gitlink）、primary/common/admin HEAD 语法与文件系统身份，**不启动 Git**，通过后才写（不解析 commit 对象）；`removeForDeletedWorktree` 绑定 `rootId + path + addedAt`。新增方法随本包发布，不与旧版插件混用；混装/协议不兼容按 ADR-0009/ADR-0025 的 fail-closed 原则处理，不静默降级。
- `probeAdd` 是 **advisory only**：只用于入队前过滤，不发布 scope、不写存储；`addNew` 仍是唯一权威校验；probe→resolve 之间的 race 由 `addNew` 在串行队列内兜底。`probeAdd` 留在 registry 内，因为 `knownProtectedPaths()` 私有。

### 8. 安全

- 不自动添加、不自动删除；cleanup 只删 mapped、`cleanupEligible`（路径确认缺失）的 B 根。
- 路径只来自宿主；客户端只回传 id。`primary-overlap`、`protected-path`、`nested`、`root-limit-reached` 全部保留。
- 元数据 I/O 先做 2.2 的路径防护，再按 2.4 的 trusted fd/`O_NOFOLLOW`/`O_NONBLOCK` 打开、`fstat`、限量读取；指针文件只接受普通文件；相对路径按 2.3 的基准解析；不启动 Git。
- A 的主 checkout（源码树 + 共享 Git 元数据）与 B 的源码树授权分别披露，并复用现有面板身份边界。用户通过面板明确确认；owner cookie 的身份边界与 BYP-01 一致。[根授权安全修复计划](../plans/completed/2026-11-05-root-authorization-security-fixes.md#byp-01-两条入口与-cookie-链)
- `fs.watch` 事件只是提示；每次事件后重新解析、`probeAdd`、用户确认。
- sidecar 不是授权数据；损坏/丢失只影响提示与清理追踪。
- 不把“无法访问”当作“已删除”：cleanup 在 owner 内复验，inaccessible → not-eligible。

### 9. 失败方向、兼容与默认

- 新增 additive、compat-gated 行 `multi-root-worktrees`；`package.json` 增加 `./worktrees` export；`tsdown` 增加 entry；`cordis.patch.yml` 插入；不静态 import 到 `src/index.ts`。
- 不新增可选 peer；不新增 DSH 版本分支；支持矩阵不变。
- inactive 时零 watcher、零 sidecar、零 scope 变化，保持空态 pass-through。
- 失败方向：
  - `addNew` 成功但 sidecar 映射写入前崩溃 → 根按手动根处理，cleanup 拒绝；安全侧。
  - sidecar memory-only → 重启丢失 ignore/映射；B 根变手动根；授权不变。
  - watcher 失效/超限/`filename null` → degraded reconcile；授权不变。
  - `fs.watch` 事件伪造/丢失 → 最多多一次提示/漏一次提示；每次仍走 registry 校验与用户确认。
  - 元数据打开/解析失败、config 含 `include`/非空 `core.worktree`/启用 `extensions.worktreeConfig` → inactive；不启动 Git、不猜测。
  - 祖先索引路径等价无法可靠判定（非 UTF-8、冲突 mode、平台/config 未知）→ inactive；不把 Unicode 变体当普通嵌套仓库。
  - `worktreePromptWait` 结果必须按 `status` 分支；把 `unactivated` 当 `timeout` 会让首次拒绝持续后台重查，客户端/宿主 schema 均应拒绝歧义形状。
  - authority 不可用或完整快照失败时保留映射；所有写入/修剪由唯一 owner 排序。恢复和跨 epoch 核对见 §6.8，不使用客户端空列表或过期文件覆盖当前映射。
  - primary 激活判据失效 → 曾 active 返回 `lost`，否则 `unactivated`；二者都停止后台动作，释放资源、不写 sidecar、不改既有授权。仅显式操作重新检测，重新评估未处理候选。
  - primary 完整判据失败（含等待期间被上级仓库登记为 `160000`、祖先链探测无法判定）、candidate 元数据快照/HEAD 语法失败、index `O_NOFOLLOW`/格式门禁失败（`link`/`sdir`/`040000`/未知版本）、`objects/info/alternates`/`http-alternates` 非空、submodule 祖先链任一层无法判定或 mode `160000`、`core.repositoryformatversion=1`/`relativeWorktrees`/非 sha1、或 `.git`/admin 指针不一致 → 跳过/`prompt-stale`，不提示、不写 registry；**不启动 Git、不解析 commit 对象、不读外部 index/object**。
  - `addNew` 的 `expected` 在 owner 队列内变化（primary 或 candidate 任一，含 checkout/admin 文件身份与祖先索引）→ `prompt-stale`，不写入；candidate 路径被移走并重建普通目录、同路径删除重建、或 admin `HEAD` 消失/变化也走这条。
  - cleanup 时 worktree 恢复、`record.path` 仍存在但无法判定、旧 admin 缺失但 checkout 仍有效、不可访问 → `not-eligible`；不删除。
- 默认：`promptsRoot` 必填（绝对路径）；父 watcher 开启；删除时清除 ignore；没有自动清理开关。

#### 插件级开关

- 「设置 → 插件 → Multi-root Workspace → 插件详情」新增 **启用 Worktree 附加根建议**（**Enable worktree root suggestions**），与「启用附属根 Skills」同一张配置卡、同样的 Switch 交互，标题旁显示**实验性** Tag（与多根 Auto Review 一致）。独立使用 `multi-root-worktrees.enabled`，**缺省 `false`**，A 与 B 共用；只有显式的持久化 `true` 或 loader `true` 才启用，缺失 Settings 服务视为关闭。Settings 接缝复用 [ADR-0023](./ADR-0023-multi-root-skill-discovery-and-invocation.md) 的现代行 Config / 旧版 namespace 适配。插件行仍加载但关闭时完全惰性。
- 关闭即时停止当前 Host 的发现、后台 watcher、重查和专用清理，唤醒 waiter、关闭提示并作废旧 ID。关闭后的新 worktree 请求返回 `worktree/not-enabled`，客户端停止重挂；宿主和客户端同时处理该结果。已确认的普通 Registry 根与 sidecar 决定保留；普通根管理始终可用。各客户端通过现有 Settings form 订阅同一设置变化。重新开启后按当前 live session 重新探测并使用新 ID。先前因 primary 失效进入 `lost` 的 workspace 仍须按 §4.4 显式恢复。
- 调用 Host 在权威恢复之后、实际发送 IPC 前复查本地开关、提示代次、live session 和候选快照。Registry owner 在队列内完成最后一次异步 Registry 读取之后、开始持久化之前复查自己的开关和提交条件。跨 Host 已送交 owner 的确认按 owner 队列结果对账。关闭当前 Host 的设置不会回滚已提交的确认，也不会更改其他 profile 的配置。B 的 P3 只读预览仍遵循实施计划中的写入门禁。
- **客户端信号区分“未知”与“关闭”**：`installSkillsSettingsCard()` 返回的 `enabled()` 只在已绑定、`status === 'ready'` 且已发布布尔值的 form 上按值抑制 overlay；没有 form（例如 loader `enabled: true` 但浏览器组合没有 `configForms`/`settingsScope`）、form 未 ready 或 unavailable 一律视为未知，照常轮询，由宿主的 `worktree/not-enabled` 结束循环。缺失的浏览器 form 不得被读成“关闭”。
- **owner 开关 fail closed**：`multi-root-worktrees` 行在 init 时安装 `setWorktreeGateProvider()`、dispose 时清除；provider 缺失（行未挂载或已销毁）一律按**关闭**处理，只有显式 `true` 才允许 `addNew`、`removeForDeletedWorktree` 与 sidecar mutation。read 形状的 sidecar 操作不受此门禁影响。缺少 owner 开关不是放宽授权的理由。

## Alternatives Considered

- **只用文本条件（`HEAD` + `config`/`commondir`）做激活，不解析结构。** 复审已验证会把伪 `.git`、伪 admin、bare 派生的 linked worktree 误判为仓库；否决。v1 用插件的元数据快照（config parser + `HEAD`/`objects`/`refs` + admin/common 指针 + parent index parser）交叉校验，不启动 Git。
- **用 `dirname(common)`、`worktree list` 第一条、`ls-files` 或文件名匹配推断 mainRoot。** `--separate-git-dir` + `/unrelated/README.md` 可让这些检查全部通过；否决（复审四 P1-1）。A 只登记经 §1 证明并经用户确认的 common。
- **A 登记整个主 checkout。** 其身份缺少可验证来源，且默认 pool 会触发 `primary-overlap`。A 只登记 Git 写入所需的 common，不以扩大授权绕开重叠校验。
- **用 `git -C <primaryRoot> config --bool core.bare` 判定 bare。** worktree config 可以把 `core.bare` 覆盖为 false；否决（复审三 P1-1）。v1 解析 common 的 config 快照，不启动 Git。
- **只检查 common config、仍允许 `extensions.worktreeConfig=true`。** `<admin>/config.worktree` 的 `include.path` 会被 Git 读取；否决（复审四 P1-2）。v1 由插件解析 common config 快照并直接拒绝启用该 extension 的布局，不启动 Git。
- **只靠调用方复验后把 `{path, access}` 交给 owner。** 确认与提交之间候选可被 symlink 替换；否决（复审三 P1-3）。`addNew` 携带 expected 并在 owner 队列内复验。
- **`addNew` 只复验 primary，或只复验 candidate。** B 可以从主仓库发起（primary `.git` 是目录），而 candidate 被 move 后原路径可重建普通目录；否决（复审四 P1-3）。`expected.primary` 与 `expected.candidate` 分开复验，校验与写入使用同一个 canonical 值。
- **以旧 admin 缺失作为清理依据。** 主仓库迁移 + `git worktree repair` 后旧 admin 可消失而原 checkout 仍有效；否决（复审三 P1-4）。只按 `record.path` 确认缺失清理，并绑定 addedAt。
- **admin 消失即把 `unregistered` 标为 cleanup-eligible。** 与 §6.1–§6.4 冲突；否决（复审四 P2）。删除信号只决定徽标；清理资格只看 `record.path` 缺失 + `addedAt`，路径存在时只提供普通 Remove。
- **把 A 改为授权 common git dir。** 能覆盖默认 pool，且授权最小；但本决策按用户选择 B（主 worktree 根），并显式接受默认 pool 的 gap。若未来要覆盖默认 pool，这是唯一不改 `primary-overlap` 的自动方案。
- **自动添加。** 违反“用户明确确认”的前提；否决。
- **删除时自动移除。** 违反 Registry “nothing is deleted on the operator's behalf”；暂时缺失/网络盘会被误删；否决（L2/L3）。
- **清理弹窗/overlay。** 用户要求面板内处理；且非当前 workspace 的清理弹窗无法正确定位；否决（L7）。
- **客户端 localStorage 存“不再提醒”。** 不符合“宿主持久化、以 workspace 为单位”；否决（Q3）。
- **单个全局 sidecar 文件 + merge-on-write。** 跨 Host 不同 workspace 的写仍会互相覆盖；否决（P1）。改为按 `primaryKey` 分文件。
- **session 级状态。** 同一 workspace 的两个 session 各建 watcher、各提示一次；否决（P3）。按 `primaryKey` 共享，session 只做 waiter/鉴权。
- **依赖 `ctx.worktrees` 做发现/包装其 `create`/`restore`。** 只覆盖 DSH 创建的 worktree，漏掉终端/IDE/forge/其他 Host；A/B 均用各自的磁盘快照判据。
- **用 `git worktree list` 做激活/发现（任何频率）。** 它会遍历并跟随其他 admin 的 `gitdir`/`locked` symlink，输出仓库外文件；否决（复审五 P1-1）。v1 不运行该命令，候选由受控 inventory 逐个枚举。
- **只靠双向 `.git`/`gitdir`/`commondir` 判断 candidate。** 没有 admin `HEAD` 的伪 admin 仍能通过；否决（复审五 P1-2）。候选必须额外通过元数据快照与 `admin/HEAD`、common 结构校验；不启动 Git。
- **只排除 `.git` 指针文件形态的 submodule。** 旧式内嵌 `.git` 目录会通过主仓库根判据；否决（复审五 P2-1 / 复审六 P1-1）。`.git` 文件无 `commondir` 的形态直接排除；`.git` 目录的形态用受控 parent probe + index mode `160000`；父仓库 config/include/探测失败 → 无法判定 → inactive。
- **信任 Git 的对象解析或 `rev-parse`。** 会读外部 alternates、promisor fetch、跟随 `objects/<prefix>` symlink；否决（复审六 P1-2）。v1 不启动 Git、不解析 commit 对象、不读 `objects`；alternates 仅作防御性拒绝。
- **整体拒绝 `--separate-git-dir`，包括派生的 linked checkout。** 这会把两个合法 linked worktree 也挡掉；否决（复审六 P2）。只拒绝主 checkout（`.git` 文件无 `commondir`）；派生的 linked checkout 支持 B，A 另按 §1 判定 common。
- **直接对原 index 运行 `ls-files`，或复制后仍运行它。** split index 的 `sharedindex.*`、sparse index 的 tree 对象会被读取；副本调用还会执行父 `core.fsmonitor` 脚本；否决（复审七/九 P1）。v1 用 `O_NOFOLLOW` 打开源 index、同 fd 读取并由插件解析，不运行 `ls-files`。
- **只拒绝 `sdir`/`core.sparseCheckout`。** 删除 `sdir`、保留 `040000` 目录条目的伪造 index 仍会被 Git 展开；否决（复审九 P1）。格式门禁无条件拒绝任何 `040000` 条目。
- **`lstat` 后再按路径复制 index。** 检查与复制之间可换成 symlink；否决（复审九 P1）。用 `O_NOFOLLOW` 打开源文件，对同一 fd `fstat`、限量读取。
- **只检查 `core.splitIndex`/`core.sparseCheckout` 配置。** 实际 split/sparse 可由 index 扩展启用而配置未设置；否决。必须解析 index 的 `link`/`sdir` 扩展。
- **把完整相对路径直接当 pathspec。** `:lib` 会被解释成 magic；否决（复审七 P1-2）。固定 `--literal-pathspecs`，并按返回路径逐字匹配。
- **放宽 `primary-overlap` 允许主根包含 primary。** 会把父目录整棵树纳入写集合，等于任何权限问题都能靠加祖先解决；否决。
- **给 Registry 增加 worktree 身份字段。** 可消除 L4 路径复用残余，但需要 schema/scope/协议改动；本次不做，作为已知残余记录。
- **让 `add` 继续承担提示的提交（含 revive）。** 会把手动记录/其他 session 的记录 revive 成“本功能追踪的 B 根”；否决（P1-2）。新增 `addNew` 只新建。
- **用 `removeAt` 做清理。** 只按引用删除，无法拒绝“已恢复/不可访问”的 worktree；否决（P1-3）。新增 `removeForDeletedWorktree` 在 owner 内复验，复审三进一步收窄为 `record.path` 确认缺失 + addedAt 绑定。
- **长轮询只带 `sessionId`。** 宿主无法区分首次取提示与已展示提示等失效，也无法在共享队头未变但会话可见项变化时返回；否决（复审三 P2）。改用 `seenPromptId`/`seenViewRevision` + `viewRevision`/`stale`。
- **WebSocket 推送代替长轮询。** 需要 `webServer.registerUpgrade` + `connection.openWebSocket` 的鉴权/帧协议；v1 不做，长轮询足够。
- **`forget-workspace` 自动清理 dead primary key。** 会把暂时不可用的 workspace 误删；否决（L6）。

## Consequences

- 外部/预存在/移动/修复的 worktree 都能被 **B** 识别，不依赖 DSH worktree 服务。A 在 B 后接入相同的提示流程。
- 激活以**插件的元数据快照**为准，不启动 Git：伪 `.git`、伪 admin、admin 不在 `common/worktrees/`、bare 派生 worktree、普通/worktree 子目录、submodule 两种形态、`include`/非空 `core.worktree`/`extensions.worktreeConfig=true`、`--separate-git-dir` 主 checkout、非法 `HEAD` 都 inactive；**v1 只接受 `core.repositoryformatversion=0`**，`--relative-paths`/`extensions.relativeWorktrees=true` 的版本 1 也 inactive；代价是插件要维护 config/index/HEAD 解析器，解析失败即 inactive。
- **对象/index 边界**：v1 不解析 commit 对象、不读 `objects`；`objects/info/alternates`/`http-alternates` 非空仍拒绝；父 index 路径由指针/gitdir 直接得到，`O_NOFOLLOW`/`O_NONBLOCK` 打开、同 fd `fstat`、限量读取，由插件解析并拒绝 `link`/`sdir`/`040000`/未知版本；**不运行 `ls-files`/Git**，因此不执行 `core.fsmonitor`、不读 sharedindex/tree；promisor remote 不补对象、不写 `.pack`。
- **submodule 祖先链 probe**：从 `dirname(root)` 向上遍历**所有**祖先 `.git`，每层用完整相对路径按 2.4 的平台等价规则查 index，任一层 mode `160000` 即 inactive，阴性继续更外层；只读祖先 `.git`/config/index；任一层 config include/core.worktree/extensions 或探测失败 → 无法排除 → inactive；不使用 `--show-superproject-working-tree`，空输出不等于“没有 superproject”。
- **`--separate-git-dir`**：主 checkout（`.git` 文件无 `commondir`）inactive；从同一分离式仓库派生的 linked checkout（`.git` 文件 + `commondir`）支持 B，可相互发现/提示；A 的候选只取符合 §1 的 common。
- **不运行 `git worktree list`/任何 Git 子进程**：v1 用受控 inventory 逐个枚举，每个候选通过元数据快照、`admin/HEAD`、祖先链 probe 与 index 守卫；**不解析 commit 对象**，无效候选不提示、不登记。
- A 经确认后覆盖默认 pool 和外部 linked checkout 的 Git 元数据写入。B 授权兄弟 checkout 源码树。专用清理仍只在面板由用户显式触发，并且只针对 B 根。
- 清理资格在 owner 串行队列内复验：只有 `record.path` 确认缺失才清理；worktree 恢复、路径存在但无法判定、旧 admin 缺失但 checkout 仍有效 → `not-eligible`，保留普通 Remove；批量只认显式 `rootIds`，并绑定 `id + path + addedAt`。
- 提示确认在 owner 内 `addNew`，分别携带 primary/candidate 的 Git 身份与 candidate `admin/HEAD`；symlink 替换、candidate 被 move 后原路径重建普通目录、admin `HEAD` 消失/变化、primary/candidate 任一变化、index/对象扇出 symlink → `prompt-stale`；**不解析 commit 对象**，校验与写入使用同一个 canonical 值；不会 revive 手动记录；只追踪本功能新建的 B 根。
- L4 残余：清理前同路径新目录可能继承旧 B 根授权；同路径重建在无 watcher 时不可可靠区分；面板警告 + 本 ADR 记录；不引入自动清理/身份字段。
- 永不自动清理意味着 deleted 根会占 `maxAdditionalRoots`，直到用户点清理/手动删除；面板必须显眼；`unregistered` 但路径仍存在的行只能普通 Remove。
- sidecar memory-only 降级会丢失清理追踪；B 根变手动根；授权不受影响。
- sidecar 全部写入由既有 owner 串行处理；follower 不写文件。跨 epoch 映射重新核对，规则见 §5 / §6.8。
- `forget-workspace` 的键是 verbatim 拼写；symlink 创建的 workspace 必须用原拼写；`primaryState` 区分 missing/inaccessible，inaccessible 不提供 forget。
- 长轮询带 `seenViewRevision`；共享队头未变但该 session 的可见项/权限变化也会返回；对话框打开时保持 seen wait，`stale` 时主动关闭。
- 父 watcher 有成本；网络盘可能不可靠；watcher 超限/`filename null` 降级为 reconcile，不声称完整事件覆盖。
- 宿主重启/无 client 时，发现靠下次 workspace 创建时的 inventory；删除状态靠 refresh/list 重算。
- `git worktree move` 后旧根不自动迁移；旧根 cleanup、新路径 B 提示；不自动转移授权。
- 不覆盖普通仓库子目录、submodule（两种形态）、`--separate-git-dir` 主 checkout、worktree 子目录、bare 派生 worktree；派生的 linked checkout 仍支持 B。
- A 仅在 `workspace-write` 提示；B 在 `read-only` 仍可显示只读提示。
- 没有 TUI/headless 对话框；面板/命令可用。
- 不修改上游、不新增 DSH 版本；inactive 时与未安装本功能一致。
- `addNew`/`removeForDeletedWorktree` 是 Registry 的新内部操作；共享 authority 的协议方法随包发布，不与旧版插件混用（ADR-0009/ADR-0025 的 fail-closed 原则）。

## 第十七次修订的复审落定（历史）

本表保留 B 验收及当时延后 A 的记录。A 的现行决策见 §1。

| 复审项 | 落定 |
| --- | --- |
| 激活判定（复审二 P1-1 / 复审三 P1-1 / 复审四 P1-1 / 复审五 P1-1 / 复审六 P1-1 / 复审七 P1-1 / 复审九 P1 / 复审十 P1 / 复审十三 P1） | v1 只做 B；A 延后。B 用插件元数据快照（指针/config/HEAD/objects/refs）证明 primary/candidate，**不启动 Git、不运行 `git worktree list`**；候选由受控 inventory 逐个枚举；admin 必须在 `common/worktrees/` 下；bare 看 common config 快照的 `core.bare`；旧式 submodule 走**完整祖先链** probe；伪 `.git`/伪 admin/子目录/无 trusted A 全部 inactive |
| HEAD 语法（复审十 P1-1） | primary/common/admin 共用同一校验器：单行 `ref: refs/<refname>` 或 40/64 位 hex；refname 按 Git 规则；v1 版本 0/sha1 即 40 位；`definitely-not-a-head`/空/CR/多行/错误长度都拒绝；入队与 owner 都执行，不解析引用/对象 |
| owner primary 祖先（复审十 P1-2） | owner 必须重跑**完整 primary 激活判据**（含祖先 index），不能只看 primary `.git`/common/canonical。等待期间内嵌 `.git` 的独立仓库被上级索引登记为 `160000` → `prompt-stale`，即使 primary `.git`、common 与 B 候选都没变 |
| `relativeWorktrees`（复审十 P2） | `git worktree add --relative-paths` 会把 common 升到 `core.repositoryformatversion=1` 并设置 `extensions.relativeWorktrees=true`；v1 只支持版本 0，明确 inactive；不依赖相对指针解析 |
| `worktree list` 移除（复审五 P1-1） | `git worktree list` 会跟随其他 admin 的 `gitdir`/`locked` symlink 并输出仓库外文件；v1 删除该命令及所有 Git 子进程。inventory 只读 `<common>/worktrees/*/gitdir`，读取前按 2.2 拒绝 symlink |
| candidate 有效性（复审五 P1-2 / 复审六 P1-2 / 复审七 P1-2 / 复审九 P1 / 复审十 P1-1） | 双向指针之外，候选必须通过元数据快照、primary/common/admin 的 HEAD 语法、`admin/HEAD` 结构校验且属于同一 common；inventory 入队与 owner 提交都检查；owner 只重读快照，不启动 Git。**不解析 commit 对象**；无 HEAD 的伪 admin、外部 index/object symlink、promisor 按需 fetch 都不提示、不登记 |
| submodule 两形态（复审五 P2-1 / 复审六 P1-1 / 复审七 P1-1 / 复审八 P1-2 / 复审九 P1 / 复审十一 P1-1 / 复审十二 P1 / 复审十三 P1） | `.git` 指针文件（无 `commondir`）直接排除；旧式内嵌 `.git` 目录，以及 `.git` 文件 + `commondir` 的 linked worktree，都在本层 `.git` 门禁通过后从 `dirname(root)` 向上遍历**所有**祖先 `.git`，用完整相对路径按**平台等价规则**查解析后的 index；任一层 mode `160000` 即 inactive，阴性继续更外层。**不使用 `--show-superproject-working-tree`/`ls-files`/Git**；祖先 config/include/探测失败 → 无法排除 → inactive |
| 近层仓库遮蔽（复审十三 P1） | `outer/vendor/lib` 是旧式 submodule，`outer/vendor` 又是独立仓库且对 `lib` 阴性；最近祖先阴性不代表没有 superproject，必须继续检查 `outer` 的 `vendor/lib` `160000`。linked worktree 版本同样覆盖；无法在读取边界内排除 → inactive |
| Unicode 索引路径（复审十二 P1） | macOS 下 NFD `café` 目录 + NFC `café` 的 `160000` 索引不能再按字节逐字比较；Linux 字节精确（`core.ignorecase` 时可大小写折叠），macOS 同时接受 NFC/NFD 并按 `core.precomposeUnicode`/`core.ignorecase` 归一化/折叠，Windows 大小写不敏感；非法 UTF-8/冲突 mode/不可靠平台 → inactive |
| linked worktree 本身是 submodule（复审十一 P1-1） | `vendor/lib` 先建 linked worktree（`.git` 文件 + `commondir`），再由上级 `git submodule add` 登记 `160000`；Git 保留原指针，所以只查 `.git` 目录会漏。primary 与 B 候选都必须做祖先 gitlink 检查，owner 也重跑 candidate 激活判据；普通 linked worktree 无祖先 gitlink 时仍 active |
| 祖先链探测（复审七 P1-1 / 复审八 P1-1/P1-2 / 复审九 P1 / 复审十三 P1） | 从 `dirname(root)` 向上遍历**所有**祖先 `.git`，不能停在最近一层；每层用完整相对路径按平台等价规则查 index，任一层 `160000` 即 inactive，阴性继续更外层；存在但 symlink/config include/core.worktree/extensions、或读取/判定失败 → 无法排除 gitlink → inactive；全部阴性且无更外层祖先才 active |
| index 格式/执行/换链（复审七 P1-2 / 复审八 P1-1/P1-2 / 复审九 P1） | **不运行 Git/`ls-files`**：split index 的 `sharedindex.*`、sparse index 的 tree 对象、父 `core.fsmonitor` 脚本都不会被触发；从可信目录句柄逐段打开 index，中间目录/最终文件都 `O_NOFOLLOW`，FIFO 用 `O_NONBLOCK`；同 fd `fstat`、限量读取；插件解析并拒绝 `link`/`sdir`/`040000`/未知版本；验收覆盖最终文件换链、中间目录换链、FIFO、config 替换 |
| 对象库/按需 fetch（复审六 P1-2） | `objects/info/alternates`/`http-alternates` 非空拒绝；v1 不启动 Git、不解析 commit 对象，promisor/partial clone 不 fetch、不写 `.pack` |
| `--separate-git-dir`（复审六 P2） | 主 checkout 自身的 `.git` 文件没有 `commondir` → inactive；从同一分离式仓库派生的 linked checkout（`.git` 文件 + `commondir`）→ **B active**，可相互发现/提示；不重新引入 A |
| A 延后与来源契约（复审五 P2-2） | v1 不启用 A；没有可验证的公开 main checkout 记录来源。未来 A 必须有公开 `repoRoot`/main-checkout 记录、与 worktree path/common/admin 绑定、明确失效条件；否则继续保持延后，不阻塞 B |
| 配置读取（复审三 P1-2 / 复审四 P1-2 / 复审九 P1 / 复审十 P2 / 复审十二 P1） | 不启动 Git；插件用 trusted fd 打开 common config 快照并解析；拒绝 `include.*`/`includeIf.*`/非空 `core.worktree`；**`extensions.worktreeConfig=true` 直接 inactive**；只支持 `core.repositoryformatversion=0`，拒绝 `extensions.relativeWorktrees=true`/版本 1/非 sha1 objectFormat；记录 `core.precomposeUnicode`/`core.ignorecase` 供索引路径等价；每次校验解析一份快照，owner 提交时重新解析，仍不启动 Git |
| 提示确认（复审二 P1-2 / 复审三 P1-3 / 复审四 P1-3 / 复审五 P1-2 / 复审十 P1-2 / 复审十一 P1-2） | prompt 快照分开 `primary`（shape/canonical/common/admin/rootIdentity/adminIdentity）与 `candidate`（kind/canonical/common/admin/adminHead/rootIdentity/adminIdentity）；`addNew.expected` 分开复验：owner 重跑完整 primary 激活判据（含祖先 index）、candidate 激活判据（含祖先 gitlink）并验证 `admin/HEAD` 与文件系统身份；候选被 move 后原路径重建普通目录、同路径删除重建、admin HEAD 缺失/语法错误/变化、primary 祖先新增 `160000` 也都失败；校验与写入使用同一个 canonical 值；`addNew` 只新建、不 revive、返回实际记录；`duplicate` 不写映射 |
| checkout 文件系统身份（复审十一 P1-2） | enqueue 记录 root/admin 目录的 `{dev, ino, birthtimeMs?}`；owner 重新打开同一 canonical 目录比对，缺失/换 symlink/非目录/身份变化 → `prompt-stale`。同路径同提交同 adminId/HEAD 的删除重建靠 inode 区分；检查仅限提交前，已登记根的路径级恢复不变 |
| 首次拒绝不重查（复审十三 P2 / 复审十四 P2） | 普通目录/仓库/worktree 子目录首次门禁失败 → `activation='unactivated'`；无 candidates/watcher/sidecar、`worktreePromptWait` 返回 `{status:'unactivated', viewRevision}`（无 `retryAfterMs`）、无后台重查；只有面板/命令 `list` 或新的显式 wait 再尝试 |
| wait 结果判别（第十七次修订） | `lost`/`unactivated` 停止重挂；所有分支禁止 `retryAfterMs`；`stale` 只用于 active workspace 的候选变化；契约与验收一致 |
| 写入口时序（复审十五 P1） | P3 只读预览，生产 `worktreePromptResolve`/确认在 P4 前禁用；P4 把 `addNew` 与完整 owner 复验（primary/candidate 激活、HEAD、目录身份）同阶段接通；P5 只做竞态/平台验收。等待 owner 时替换候选必须 Registry 无写入 |
| 默认 pool（复审十五 P2） | 没有特殊排除：主仓库 primary 时 `.agents/worktrees/<id>` 位于 primary 内按包含规则过滤；primary 本身是 pool worktree 时兄弟 pool worktree 仍可成为 B 候选。两种场景分别验收；Plan/需求不得写“一律无行为” |
| active → lost（第十七次修订） | 返回 lost，清候选/evaluated，释放 watcher、waiter、定时器；无后台恢复；既有登记不自动修改 |
| 恢复触发/重新评估（第十七次修订） | lost/unactivated 都只经用户显式操作重新检测；重建时未处理候选用新 ID，保留明确 ignore |
| owner sidecar 核对（第十七次修订） | 全部写入进入唯一 owner 队列；完整快照的两种空语义、并发交错和跨 epoch 核对见 §5 / §6.8；follower 不按旧快照覆盖文件 |
| `forget-workspace` 交付（复审十五 P2） | v1 **不交付**新命令/RPC/owner 删除路径；仅 ADR 记录为未来 Registry maintenance，单独计划/需求排期。v1 删除只走 `removeForDeletedWorktree`，不依赖 forget |
| 清理复验（复审二 P1-3 / 复审三 P1-4 / 复审四 P2） | 新增 `removeForDeletedWorktree`；资格收窄为 `record.path` 确认缺失；路径存在时若是有效 checkout 或无法判定 → `not-eligible` + 普通 Remove；**旧 admin 缺失不是依据**；owner 内绑定 `rootId + path + addedAt`（`rootAddedAt`/`expectedAddedAt`）；`rootIds` 必填，逐 id 返回 removed/skipped；inaccessible 不删除 |
| 状态表一致性（复审四 P2） | §3.2 与 §6.1–§6.4 统一：删除信号只决定状态/徽标；清理资格只由 `record.path` 确认缺失 + `addedAt` 决定；`unregistered` 且路径存在只提供普通 Remove |
| 指针路径防护（复审二 P1-4 / 复审九 P1 / 复审十 P1-1） | 跟随 `.git`/`gitdir`/`commondir` 前做词法防护；拒绝 UNC/设备/`//`/NUL；指针只接受普通文件、拒绝 symlink；从 trusted fd 逐段 `O_NOFOLLOW`/`O_NONBLOCK` 读取；相对路径按固定基准解析；primary/common/admin 的 HEAD 语法在入队与 owner 都校验 |
| 共享候选 / 长轮询（复审二 P2-1 / 复审三 P2 / 复审十四 P2，第十九次修订更新） | inventory、候选池、去重共享；展示/确认按 session 的 mode 过滤并计算 `effectiveAccess`；`worktreePromptWait` 只带 `seenViewRevision`，按可见数量返回 `prompt`（1）或 `prompts`（≥2），其余为 `timeout`/`unactivated`/`lost`/`stale`，宿主与客户端 schema 同时校验；对话框打开时保持 seen wait；`promptIds` 批量确认，逐项 stale 进 `skipped` |

| move/重建/漏事件（复审二 P2-2） | 候选 key = adminId + canonical path + admin `gitdir`；move 换 key、旧候选失效；同路径重建保留警告不自动清除；无 watcher 时不可可靠区分；`filename null` reconcile；超限 degraded；相对路径基准写入契约 |
| primaryState/forget（复审二 P2-3） | `primaryState` 独立于附加根状态；`missing`/`inaccessible` 分离；面板只对 `missing` 提供 forget；owner 内复验；inaccessible/registry unavailable 拒绝；forget 删除该 primaryKey 全部记录 + sidecar，仍不自动 |

| 范围 / 永不自动（Q1–Q5 / L1–L9） | **v1 仅 B**；A 延后（无公开可信 mainRoot 记录），worktree session 的 git 提权缺口由手动 add 兜底；B 是 worktree discovery（源码树，外部/预存在均可）；`inherit`；普通仓库子目录/submodule 两形态/separate/bare 派生/`extensions.worktreeConfig` inactive；默认 pool 无特殊排除（主仓库 primary 时由包含规则过滤；primary 本身是 pool worktree 时兄弟仍可成为 B 候选）；删除只在面板清理、永不自动；forget 仅 registry maintenance |

## Related Documents

- [ADR-0004：Registry 持久化与校验](./ADR-0004-root-registry-persistence-and-validation.md)
- [ADR-0008：面板主根由 host session 推导](./ADR-0008-panel-session-derived-authority.md)
- [ADR-0012：Session 原始项目与 effective cwd](./ADR-0012-session-origin-and-effective-cwd.md)
- [ADR-0014：根数量上限与 provider 冲突](./ADR-0014-root-limit-and-provider-conflict.md)
- [ADR-0025：共享 Registry Authority](./ADR-0025-shared-registry-authority.md)
- [ADR-0027：revive 目标与受保护路径](./ADR-0027-revive-target-and-protected-paths.md)
- [ADR-0028：上游主根身份与共享模式](./ADR-0028-upstream-primary-identity-and-shared-only-registry.md)
- [需求文档](../requirements/multi-root-workspace.md#7-行为约束)（§7.16–§7.18）
- [实施计划](../plans/active/2026-11-09-worktree-aware-root-suggestions.md)
- [路线账本](../plans/active/2026-09-12-multi-root-workspace.md)
