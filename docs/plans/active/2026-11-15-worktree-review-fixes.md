# Worktree 发现建议评审修复（PR #60）：Follower 授权、Files 手动入口与主 checkout 分支刷新

> 状态：**已实施并通过 CI 验收**（2026-11-15，分支 `feat/workspace-toast`，reviewed commit `eebde19`，验收 head `ab17638`，run [43702749353](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43702749353) 30/30 checks 全绿；P0–P5 见 §10；待 PR 合并后随计划归档）。本文件是本轮评审修复的核验账本、实施计划与退出机制。
>
> 关联：PR [#60](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/60)、[ADR-0039](../../decisions/ADR-0039-worktree-aware-root-suggestions.md)（第二十二次修订）、[Toast 实施计划](./2026-11-15-workspace-toast-implementation.md)、[Dialog 重构报告](./2026-11-15-worktree-dialog-redesign.md)。

## 1. 背景与目标

PR #60 的 reviewed commit `eebde19` 收到两个自动评审：

- Devin Review 提出 3 条（`src/worktrees.ts:493`、`src/client/index.ts:305`、`src/worktrees.ts:1185`）；
- Codex Review 提出 2 条（`src/worktrees.ts:493`、`src/client/index.ts:305`）。

两条评审的第 1、2 条互相同指，因此 **3 个独立问题**：

| 编号 | 问题 | 提出者 | 影响面 |
| --- | --- | --- | --- |
| R1 | Registry follower 的 `addNew` IPC 仍只接受 `inherit`，逐行选择的 `read-only` / `read-write` 在共享 Registry 部署中必然失败 | Devin + Codex | 功能不可用（共享 Host 部署） |
| R2 | Files 页签打开的 Workspace Folders 管理器没有透传 `worktrees` / `worktreePromptEnabled`，新增的「Worktree 建议」手动入口不出现 | Devin + Codex | 功能入口缺失（单一 UI 路径） |
| R3 | 主 checkout 切换分支后，提示仍显示旧分支；`refreshInventory` 按 expectation 相等复用整条候选记录，而 `mainHead` 是展示字段、不在 expectation 内 | Devin | 展示陈旧，且 `viewRevision` 不变导致重开/轮询不刷新 |

目标：核实三项均成立后，按本计划修复、补回归测试、同步 ADR/计划/索引与 PR 描述，跑通本机门禁，推送并由 CI 判定通过。

## 2. 核验结论（代码事实）

三项均**成立**（代码阅读 + 红测复现）。证据固定在 reviewed commit `eebde19`：

### V1（R1）成立：follower 的 `addNew` 被 owner 的 IPC schema 拒绝

- 浏览器契约与 host 服务已接受三档：`src/worktrees-contract.ts:177`（`accesses` 的 `access` = `z.enum(['inherit','read-only','read-write'])`）、`src/worktrees.ts:491-500`（`resolve('add')` 把每行 access 传给 `addNew`）。
- Owner 侧登记本身支持三档并写 grant 字段：`src/registry.ts:793-861`（`access` 进入 `grantFields`，只读写 `readOnlyRecordedPath`、读写写 `readWriteRecordedPath`）。
- **断点在 follower→owner 的第二套 IPC 契约**：follower `src/registry.ts:795-804` 以 `remoteValue('addNew', [primaryRoot, options])` 发送选项；owner 在 `src/registry.ts:2053-2054` 的 `dispatchShared` 里用 `parseArguments` 解析，而 `src/authority/protocol.ts:222` 的 `addNew` 参数 schema 复用 `src/worktrees/protocol.ts:38-43` 的 `addNewSchema`，其中 `access: z.literal('inherit').optional()`。
- 结论：owner Host 上三档可用；follower Host 上 `read-only` / `read-write` 在 owner 解析阶段被 Zod 拒绝，IPC 请求失败（不是降级为 inherit）。

### V2（R2）成立：Files 入口构造 Dialog 时丢掉了两个 props

- Files 页签占用者把两个 props 传给 `RootSwitcher`：`src/client/index.ts:305`。
- `RootSwitcher` 的 props 类型继承 `WorkspaceFoldersActionProps`（`src/client/RootSwitcher.tsx:69`），因此编译期拥有 `worktrees` / `worktreePromptEnabled`；但它在 `src/client/RootSwitcher.tsx:419-434` 构造 `WorkspaceFoldersDialog` 时只传了 panel / pickDirectory / sessionId / subscribeSession / t / onClose。
- Dialog 的手动入口门槛是 `props.worktrees !== undefined` 且功能未显式关闭（`src/client/WorkspaceFoldersAction.tsx:993-1009`）。因此从 Files 管理器打开时入口永远隐藏；footer / Hero / compact fallback 路径不受影响（它们直接构造 `WorkspaceFoldersAction` 并带齐 props）。

### V3（R3）成立：复用的候选记录保留旧 `mainHead`

- `refreshInventory` 用 `isDeepStrictEqual(previous.expected, expected)` 判断复用，复用即保留**整条**旧记录：`src/worktrees.ts:917-929`。
- `expectedFor` 构建的候选快照没有 `mainHead`（`src/worktrees.ts:1498-1521`），这是刻意的：`mainHead` 只用于展示，不参与授权或 owner 复验（ADR-0039 第二十二次修订；`src/worktrees/owner.ts:77-99` 的 A 复验也不比较它）。
- 但展示读取的是旧记录里的 candidate：`src/worktrees.ts:1183-1197` 的 `branch`、`src/worktrees.ts:1201-1219` 的 `viewRevision` 都从 `record.candidate.mainHead` 计算。
- 主 checkout 切分支后，`revalidate` 会刷新 `workspace.repo`（`src/worktrees.ts:845-866`），`commonCandidate` 得到新的 `mainHead`（`src/worktrees/common.ts:55-82`，值来自 `repo.commonHead`，见 `src/worktrees/repository.ts:227-241`），但 `expectedFor` 不含它 → expectation 相等 → 旧记录被复用 → 分支与 `viewRevision` 永久停在旧值，重开 Dialog / 轮询都不会刷新。

**结论**：三条均为真实缺陷，无一是「评审误报」。V1、V2 是功能不可用/入口缺失；V3 是授权正确但展示陈旧（不构成越权，因为 `mainHead` 不参与授权）。

## 3. 范围与非目标

**范围内**

- R1：把 owner 的 `addNew` IPC 参数 schema 扩展到三档，并加 follower→owner 集成测试（read-only / read-write 的持久 grant 字段与 effective access）。
- R2：`RootSwitcher` 向嵌套 Dialog 透传 `worktrees` / `worktreePromptEnabled`，并加组件回归测试。
- R3：复用候选记录时刷新**展示元数据**（candidate），保留 prompt id、discovery key 与授权 expectation；`viewRevision` 随分支更新；加回归测试。
- 文档：ADR-0039 第二十三次修订、本计划索引（中英）、PR 描述更新。

**非目标（本轮不做）**

- 不改授权模型、grant 语义、`verifyPromptExpected`、owner 串行写路径或 ADR-0013/0039 的安全边界。
- 不改触发、RPC 生命周期、Toast 落点、Dialog 布局与文案；不新增端点、不新增依赖。
- 不重做 `RootSwitcher` 的对话归属（它继续持有自己的本地 Dialog；footer 的 `dialogOwner` 不变）。
- 不清理与评审无关的既有警告或环境问题。

## 4. 修复设计

### R1：`addNewSchema.access` 接受三档

- `src/worktrees/protocol.ts`：`access` 从 `z.literal('inherit')` 改为与协议其余位置一致的三值枚举（`inherit` / `read-only` / `read-write`）；仍为 optional（缺省 = `inherit`，保留旧客户端/旧请求的语义）。
- 不改 owner 的 `addNew` 实现：它已按 `options.access ?? 'inherit'` 写 `grantFields`，本次只是让第二套 IPC 契约与它一致。
- 安全性：schema 放宽只放开「follower 可以请求 owner 已经支持的三档」，不绕过 owner 的 `reclassify` → `verifyPromptExpected` → `validateRootCandidate` → 上限/重复/受保护目录判断。

### R2：`RootSwitcher` 透传两个 props

- `src/client/RootSwitcher.tsx` 的 `WorkspaceFoldersDialog` 构造补上 `worktrees={props.worktrees}` 与 `worktreePromptEnabled={props.worktreePromptEnabled}`。
- Dialog 自身的门槛与行为不变：无 `worktrees` 或功能显式关闭时不显示入口；点击仍是「先关面板、再经 `worktree-prompt-bus` 请求 shell overlay 打开同一个 Dialog」。
- 不把 `dialogController` / `dialogOwner` 传给本地 Dialog：那是 footer 共享控制器的机制，Files 入口保持独立本地 Dialog（现有设计）。

### R3：复用记录时刷新展示元数据

- `refreshInventory` 的复用分支改为：expectation 相等时保留 `promptId` / `discoveryKey` / `expected`，但当新的 candidate 与旧 candidate 不同（例如主 checkout 换分支后的 `mainHead`）时，用新 candidate 生成记录；candidate 完全相等时保留原记录对象。
  - 这样授权判断（expectation）与 prompt 身份不变，只更新展示字段。
  - candidate 完全相等的判断避免无意义的记录对象更替：`beforeSubmit` / `seen` 以记录对象身份判断「当前队列记录」，稳定身份可避免无关刷新把确认打成 stale。
- `promptView` 的 `branch` 与 `viewRevision` 继续从 record.candidate 读取，因此自然跟随刷新；`viewRevision` 变化会驱动已挂起的 long-poll 重新下发视图。
- 不把 `mainHead`（或任何展示字段）加入 `expectedFor` / `PromptCandidateSnapshot` / owner 复验。

## 5. 回归测试计划（红 → 绿）

| 编号 | 测试 | 文件 | 断言 |
| --- | --- | --- | --- |
| T1a | owner IPC `addNew` schema 接受三档、拒绝未知值、缺省仍为 inherit | `tests/worktrees-contract.spec.ts`（新增 describe） | `addNewSchema` 对 `inherit`/`read-only`/`read-write` 成功；`full-access`/`bogus` 失败；不带 access 成功 |
| T1b | follower→owner 真实 IPC：两种 access 都能登记，并在 owner 持久化正确 grant | `tests/worktrees-owner.spec.ts`（native 守卫） | follower `addNew` 成功；owner 行 `access` 与 `readOnlyRecordedPath`/`readWriteRecordedPath` 正确、另一 grant 字段不存在；`effectiveRootAccess(row.access,'workspace-write')` 为 `read-only`/`read-write` |
| T2 | Files 入口打开管理器后出现手动 Worktree 建议入口 | `tests/client-worktree.spec.tsx`（新增 describe） | 直接渲染 `RootSwitcher`（带 worktree props）→ 打开 manage Dialog → 找到 `worktree.panelOpen`；修复前该断言失败 |
| T3 | 主 checkout 只换分支：展示分支与 `viewRevision` 更新、prompt id 不变 | `tests/worktrees-discovery.spec.ts`（新增用例） | 第一次 `prompt` 的 A 候选 branch = `main`；`git -C <main> checkout -b release` 后再次 `prompt`：branch = `release`、`viewRevision` 变化、prompt id 不变 |

补充回归：`tests/worktrees-common.spec.ts`（既有逐行 access owner 测试）、`tests/client-switcher.spec.tsx`、`tests/worktrees-channel.spec.ts`、`tests/worktrees-contract.spec.ts` 全绿。

## 6. 分阶段提交

| 阶段 | 提交 | 内容 | 门禁 |
| --- | --- | --- | --- |
| P0 | `docs(plan): record the PR #60 review findings and fix plan` | 本文件 + 计划索引（中英） | `pnpm docs:check` 绿 |
| P1 | `fix(worktrees): accept every grant on the follower addNew IPC` | R1 修复 + T1a/T1b | 对应 vitest 红→绿；lint/typecheck |
| P2 | `fix(client): pass the worktree props into the Files manager dialog` | R2 修复 + T2 | 对应 vitest 红→绿；lint/typecheck |
| P3 | `fix(worktrees): refresh reused prompt display metadata` | R3 修复 + T3 | 对应 vitest 红→绿；lint/typecheck |
| P4 | `docs(adr): record the review-fix behavior and evidence` | ADR 第二十三次修订；P/S 进度账本回填；PR 描述 | `docs:check`；全量门禁 |
| P5 | `chore(verify): push and track CI` | 推送分支，跟踪 CI 至全绿并记录 run URL | CI releases + verify 全绿 + gate |

## 7. 退出验收机制

**退出条件（全部满足才可结束本任务）**

| 门 | 内容 | 证据 |
| --- | --- | --- |
| E1 | 三个独立问题均有代码位置证据与红测复现；若任一条被证伪则在此记录并停止对应修复 | 本文件 §2 + 红测失败输出 |
| E2 | R1：schema 单位测试 + follower→owner 两种 access 的集成测试通过；grant 字段与 effective access 断言正确 | vitest 输出（native 测试在 CI 车道执行，或被批准的本地非沙箱运行执行） |
| E3 | R2：`RootSwitcher` 组件测试证明入口出现；无 worktrees/关闭时仍隐藏 | vitest 输出 |
| E4 | R3：只换分支后 branch 与 viewRevision 更新、prompt id 不变；expectation 不含展示字段（不新增授权输入） | vitest 输出 + diff 检查 |
| E5 | 受影响套件无回归：`worktrees-*`、`client-worktree`、`client-switcher`、`shared-registry` | vitest 输出 |
| E6 | 本机门禁：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check`，以及 `pnpm test` 全量；环境受限的 skip/既有失败必须与基线 `eebde19` 对照并说明 | 命令输出 |
| E7 | 文档：ADR 第二十三次修订、计划索引（中英）、本文件进度回填、PR 描述更新 | `docs:check` 输出 + PR 链接 |
| E8 | 推送 `feat/workspace-toast`；新 head 的 CI `releases` + 全部 `verify` + `gate` 通过，记录 run URL | `gh run view` 输出 |

**停止/回退条件（出现即暂停并报告，不硬推）**

- R1 的 schema 放宽导致 owner 端出现新的写入路径或绕过复验：立即停止，回退到只放开 schema 的最小改动，并补 owner 侧拒绝测试。
- R2 透传导致 footer 与 Files 入口争用同一个 Dialog/controller，或出现重复注册：停止，改为只在 Files 分支本地透传 props，不引入第二个 owner。
- R3 的展示刷新造成稳态下记录对象/ prompt id 抖动（同一视图重复 revalidate 时 id 变化或确认被误判 stale）：停止，收紧为仅当展示字段变化时替换 candidate；必要时改为从 `workspace.repo`/`workspace.inventory` 派生展示 branch。
- 全量本地测试出现与改动无关的失败：先用基线 `eebde19` 复跑同一用例对照；只允许既有环境限制（如本机沙箱下的 native IPC skip/contended）与基线一致，不允许修复引入新失败。
- CI 某 lane 失败：先定位是代码、平台差异还是 flaky infra；不盲目重跑；确认修复前不宣称通过。推送/网络被沙箱阻断时按 AGENTS.md 只做最窄的宿主提权重试，绝不放宽测试或产品沙箱。

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 放宽 IPC schema 扩大 follower 可请求的写入面 | 只放开 owner 已支持的三档；owner 的复验、上限、重复与受保护目录判断不变；补 follower 集成测试 |
| 展示元数据刷新改变 prompt 身份 | 复用分支只替换 candidate，保留 promptId/discoveryKey/expected；T3 断言 id 不变 |
| candidate 深度比较带来额外开销 | 每次 refreshInventory 本来就要逐候选做 `probeAdd` IPC；比较对象很小，可忽略 |
| 记录对象更替使并发确认变 stale | candidate 完全相等时保留原记录对象；只有真实展示变化才更替 |
| 三个修复混在一个提交难以回滚 | 按 P1/P2/P3 独立提交，各自可回退 |

## 9. Documentation Impact

- `docs/decisions/ADR-0039-worktree-aware-root-suggestions.md`：第二十三次修订——follower IPC 与浏览器契约同档、Files 管理器透传手动入口、复用记录刷新展示元数据（`mainHead` 仍不参与授权）。
- `docs/plans/README.md` / `docs/plans/README.en.md`：active 索引登记本计划。
- 本文件：进度与证据回填。
- PR #60 描述：记录评审核验、修复与 CI 证据。
- README 不需要改：用户可见行为与既有描述一致（三档权限与 Files 入口本来就已声明）。

## 10. 进度与证据（执行后回填）

| 阶段 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| P0 | 已完成 | `0fc29a6` | 本文件 + `docs/plans/README.md` / `README.en.md` 索引 + Dialog 报告的交叉链接；`pnpm docs:check` 0 errors |
| P1 | 已完成 | `593dc8b` | 红测：`addNewSchema` 拒绝 `read-only`（owner IPC 契约）；绿测：`tests/worktrees-contract.spec.ts`（18 tests）与 `tests/worktrees-owner.spec.ts`（15 tests，2 个 native 用例在本机沙箱下 skip）；follower 集成测试由 CI 非沙箱 runner 执行 |
| P2 | 已完成 | `c107b40` | 红测：Files 管理器经 `RootSwitcher` 打开时缺少 `worktree.panelOpen`；绿测：`tests/client-worktree.spec.tsx` 56 tests（含「关闭时不显示」对照） |
| P3 | 已完成 | `2f48f9d` | 红测：主 checkout 换到 `release` 后 A 候选仍显示 `main`；绿测：`tests/worktrees-discovery.spec.ts` 29 tests（prompt id 不变、branch 与 viewRevision 更新） |
| P4 | 已完成 | 本提交 | ADR-0039 第二十三次修订、本文件证据回填、PR 描述更新 |
| P5 | 已完成 | `ab17638`（验收 head） | CI run [43702749353](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43702749353)：`releases` + 28 条 `verify` + `gate` 共 30/30 success；本文件 CI 证据回填提交在其后（docs-only，另行重跑） |

## 11. 验证证据（2026-11-15）

- **红 → 绿**：三项修复前，新增回归测试分别失败在缺陷点（`read-only` 被 owner IPC schema 拒绝；Files 管理器没有 `worktree.panelOpen`；主 checkout 换分支后仍显示 `main`）；修复后同一测试全绿。
- **受影响套件**：`pnpm vitest run` 的 8 个文件（worktrees-contract / worktrees-discovery / worktrees-owner / worktrees-common / worktrees-channel / client-worktree / client-switcher / shared-registry）共 `168 passed | 33 skipped`；skip 全部是 native IPC 用例（本机 Host 被沙箱包裹，与既有 31 个 shared Registry 用例相同，CI 非沙箱 runner 执行）。
- **全量 `pnpm test`**：`1809 passed | 17 failed | 165 skipped`。17 个失败经与基线 `eebde19` 对照（`git stash` 后复跑同一批文件）**失败集合逐项相同**（`diff` 为空），均为本机环境限制：第二个 Host 得到 `contended` 而非 `follower`（shared IPC 拒绝沙箱内 peer）、seatbelt kernel runner `Operation not permitted`。修复未引入新失败。
- **门禁**：`pnpm lint`（0 warnings/0 errors）、`pnpm typecheck`（Host + Client + Auto Review）、`pnpm build`、`pnpm docs:check`（0 errors）、`pnpm compat:check`、`pnpm pack:check` 均通过。
- **CI**：验收 head `ab17638` 的 run [43702749353](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43702749353)，`releases` + 28 条 `verify`（4 OS × 分组） + `gate` 共 **30/30 success**；本文件证据回填后的 docs-only head 另行重跑同一工作流。

## 12. 第二轮审查报告（`a18c0ae`）

复审以 PR 对 `main` 的完整差异为范围，核对了客户端入口与 Dialog、Toast 测量、浏览器 RPC、共享 Registry IPC、owner 复验与展示刷新。上一轮三项已有实现和 CI 证据。本轮两条 PR 评论均成立，另有三项独立发现。

| 编号 | 优先级 | 来源与证据 | 修复与回归断言 |
| --- | --- | --- | --- |
| R4 | P1 | [PR 评审](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/60#discussion_r4578123948)。`src/client/notice-placement.ts` 持有上游 DOM 结构探针及 legacy Header 回退，违反 `AGENTS.md` 的兼容层约定。 | 上游探针和 DOM 观察移至 `src/compat/`，用新旧 DOM fixture 固定输出，客户端保留布局计算和 React 生命周期。 |
| R5 | P2 | [PR 评审](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/60#discussion_r4578123953)。`paneSessionId` 绑定 Files 页签，手动事件却不携带会话，overlay 使用全局会话，可能把建议及后续登记指向另一工作区。 | 手动事件携带管理器会话，overlay 只接受与当前会话相符的请求。拒绝时管理器保持打开。组件测试覆盖切走、拒绝、切回后打开。 |
| R6 | P2 | 本次审查。`ResizeObserver` 仅观察首次获取的会话根和输入卡，内容区独立调整尺寸或会话节点被替换时可能保持旧坐标。 | 观察当前内容区与 Header 回退节点，DOM 结构变化时重新绑定。测试覆盖后挂载、新尺寸和替换节点。 |
| R7 | P2 | 本次审查。长轮询的 `reconcileSelection` 会重新选中用户已取消的 worktree。列表缩成一项时，单行确认还会绕过勾选状态。 | 为仍存在的项保留选中与未选中状态，始终由勾选项构造提交。回归覆盖展示刷新、列表缩成一行与提交时的 id/权限。 |
| R8 | P2 | 本次审查。仅主 checkout 的展示分支变化也会替换候选记录，`resolve` 提交前按对象身份检查，等待 Registry 的同一 prompt 可能被错误判为过期。 | 从当前仓库快照派生展示分支。回归在 Registry 提交前刷新分支，断言 revision 更新、同一个 prompt 仍能提交。 |

R5–R8 的新增测试在修复前分别失败于管理器提前关闭、提示未跟随新会话节点、取消勾选被恢复和 Registry 提交被判过期。修复后 `client-notice-placement`、`client-worktree`、`worktrees-discovery` 共 102 项通过。当前设计见 [ADR-0039 第二十四次修订](../../decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十四次修订2026-11-15)。

本机 `lint`、`typecheck`、`build`、`docs:check`、`compat:check` 与 `pack:check` 通过。全量测试 1813 通过、165 跳过、17 失败。17 个失败的测试名与上一轮本机记录逐项相同，涉及沙箱内共享 IPC 与 Seatbelt runner。
